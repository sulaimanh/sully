import { execFile } from 'child_process'
import { promisify } from 'util'
import * as fs from 'fs'
import * as path from 'path'
import { binaryPath, spawnEnv } from '../env'
import { settingsStore } from '../settings'

const pexecFile = promisify(execFile)

async function git(repoPath: string, args: string[]): Promise<string> {
  const bin = binaryPath('git')
  if (!bin) throw new Error('git not found')
  const { stdout } = await pexecFile(bin, ['-C', repoPath, ...args], {
    env: spawnEnv(),
    timeout: 120_000,
    maxBuffer: 8 * 1024 * 1024
  })
  return stdout
}

async function defaultBranch(repoPath: string): Promise<string> {
  try {
    const out = await git(repoPath, ['symbolic-ref', 'refs/remotes/origin/HEAD'])
    return out.trim().replace('refs/remotes/origin/', '')
  } catch {
    const out = await git(repoPath, ['remote', 'show', 'origin'])
    const line = out.split('\n').find((l) => l.includes('HEAD branch'))
    return line?.split(':').pop()?.trim() ?? 'main'
  }
}

/** Best-effort fetch so branch decisions are made against fresh remote refs. */
async function fetchOrigin(repoRoot: string): Promise<void> {
  try {
    await git(repoRoot, ['fetch', 'origin', '--prune'])
  } catch {
    // offline or no remote — proceed with local state
  }
}

/**
 * Fast-forward a checked-out branch to its upstream. Safe by construction:
 * --ff-only never merges or rewrites, and git aborts (caught) if the branch
 * has diverged or local changes conflict with the update.
 */
async function fastForwardToUpstream(wtPath: string): Promise<void> {
  try {
    await git(wtPath, ['merge', '--ff-only', '@{u}'])
  } catch {
    // no upstream, diverged, or dirty — leave the worktree as it is
  }
}

/**
 * Create (or reuse) a git worktree for a branch and make it ready to work in:
 * dependencies are installed up front so every phase (planning, coding, dev
 * server) starts from a runnable tree.
 */
export async function ensureWorktree(repoPath: string, branch: string): Promise<string> {
  const wtPath = await createWorktree(repoPath, branch)
  await installDeps(wtPath)
  return wtPath
}

/**
 * Create (or reuse) a git worktree for a branch in a sibling `<repo>-worktrees`
 * directory. TS port of dashboard-skills/bin/gwt, plus freshness guarantees:
 * fetches origin first, cuts new branches from origin/<default> (not the
 * possibly-stale local checkout), and fast-forwards existing branches.
 */
async function createWorktree(repoPath: string, branch: string): Promise<string> {
  const repoRoot = (await git(repoPath, ['rev-parse', '--show-toplevel'])).trim()
  const repoName = path.basename(repoRoot)
  const wtBase = path.join(path.dirname(repoRoot), `${repoName}-worktrees`)
  const wtPath = path.join(wtBase, branch.replace(/\//g, '-'))
  fs.mkdirSync(wtBase, { recursive: true })

  await fetchOrigin(repoRoot)

  const porcelain = await git(repoRoot, ['worktree', 'list', '--porcelain'])
  const entries: Array<{ worktree?: string; branch?: string }> = []
  let current: { worktree?: string; branch?: string } = {}
  for (const line of porcelain.split('\n')) {
    if (line.startsWith('worktree ')) {
      if (current.worktree) entries.push(current)
      current = { worktree: line.slice(9) }
    } else if (line.startsWith('branch refs/heads/')) {
      current.branch = line.slice(18)
    }
  }
  if (current.worktree) entries.push(current)

  // exact path already registered
  if (entries.some((e) => e.worktree === wtPath)) {
    await fastForwardToUpstream(wtPath)
    return wtPath
  }
  // branch checked out in another worktree (not the main checkout)
  const existing = entries.find((e) => e.branch === branch && e.worktree !== repoRoot)
  if (existing?.worktree) {
    await fastForwardToUpstream(existing.worktree)
    return existing.worktree
  }
  // stale/manual directory
  if (fs.existsSync(wtPath)) return wtPath

  // an explicit per-repo base branch wins over origin/HEAD auto-detection
  const configured = settingsStore
    .get()
    .repoMappings.find((r) => r.repoPath === repoPath || r.repoPath === repoRoot)
    ?.baseBranch?.trim()
  const defBranch = configured || (await defaultBranch(repoRoot))

  // branch checked out in the main repo? move main repo off it first
  const currentBranch = (await git(repoRoot, ['branch', '--show-current'])).trim()
  if (currentBranch === branch) {
    await git(repoRoot, ['checkout', defBranch])
  }

  const local = (await git(repoRoot, ['branch', '--list', branch])).trim()
  let remote = ''
  try {
    remote = (await git(repoRoot, ['ls-remote', '--heads', 'origin', branch])).trim()
  } catch {
    // offline — treat as no remote branch
  }

  if (local || remote) {
    await git(repoRoot, ['worktree', 'add', wtPath, branch])
    await fastForwardToUpstream(wtPath)
  } else {
    // cut fresh branches from the remote-tracking default so work always
    // starts from the true latest, regardless of the local checkout's age.
    // --no-track: the ticket branch must not treat origin/<default> as its
    // upstream, or a bare `git push` / later ff-merges would target it.
    let baseRef = defBranch
    try {
      await git(repoRoot, ['rev-parse', '--verify', `origin/${defBranch}`])
      baseRef = `origin/${defBranch}`
    } catch {
      // no remote-tracking ref — fall back to the local default branch
    }
    await git(repoRoot, ['worktree', 'add', '--no-track', '-b', branch, wtPath, baseRef])
  }

  symlinkEnvFiles(repoRoot, wtPath)
  return wtPath
}

/**
 * Install node dependencies if the worktree has a package.json but no
 * node_modules yet (fresh worktrees start without one). Best effort: a failed
 * install must not block planning — the dev server or coding session will
 * surface the problem if it matters.
 */
export async function installDeps(wtPath: string): Promise<void> {
  if (!fs.existsSync(path.join(wtPath, 'package.json'))) return
  if (fs.existsSync(path.join(wtPath, 'node_modules'))) return
  const pm = fs.existsSync(path.join(wtPath, 'pnpm-lock.yaml'))
    ? 'pnpm'
    : fs.existsSync(path.join(wtPath, 'yarn.lock'))
      ? 'yarn'
      : fs.existsSync(path.join(wtPath, 'bun.lock')) ||
          fs.existsSync(path.join(wtPath, 'bun.lockb'))
        ? 'bun'
        : 'npm'
  try {
    await pexecFile(pm, ['install'], {
      cwd: wtPath,
      env: spawnEnv(),
      timeout: 10 * 60_000,
      maxBuffer: 32 * 1024 * 1024
    })
  } catch {
    // best effort — see docblock
  }
}

/** Symlink the main repo's untracked .env files into the worktree. */
function symlinkEnvFiles(repoRoot: string, wtPath: string): void {
  let files: string[] = []
  try {
    files = fs.readdirSync(repoRoot).filter((f) => f === '.env' || f.startsWith('.env.'))
  } catch {
    return
  }
  for (const f of files) {
    const target = path.join(wtPath, f)
    if (!fs.existsSync(target)) {
      try {
        fs.symlinkSync(path.join(repoRoot, f), target)
      } catch {
        // best effort
      }
    }
  }
}

export async function removeWorktree(repoPath: string, worktreePath: string): Promise<void> {
  await git(repoPath, ['worktree', 'remove', '--force', worktreePath])
}

/** Current HEAD sha of a worktree, or null if it can't be resolved. */
export async function headSha(worktreePath: string): Promise<string | null> {
  try {
    return (await git(worktreePath, ['rev-parse', 'HEAD'])).trim()
  } catch {
    return null
  }
}

/** Sha of the branch tip on origin, or null if offline or the branch isn't there. */
export async function remoteBranchSha(
  worktreePath: string,
  branch: string
): Promise<string | null> {
  try {
    const out = await git(worktreePath, ['ls-remote', 'origin', `refs/heads/${branch}`])
    return out.trim().split(/\s/)[0] || null
  } catch {
    return null
  }
}
