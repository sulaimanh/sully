import { execFile } from 'child_process'
import { promisify } from 'util'
import { binaryPath, spawnEnv } from '../env'
import { getGhToken } from '../credentials'

const pexecFile = promisify(execFile)

function ghEnv(): NodeJS.ProcessEnv {
  const token = getGhToken()
  return spawnEnv(token ? { GH_TOKEN: token } : {})
}

async function gh(args: string[], cwd?: string): Promise<string> {
  const bin = binaryPath('gh')
  if (!bin) throw new Error('gh CLI not found — install it with `brew install gh`')
  const { stdout } = await pexecFile(bin, args, {
    env: ghEnv(),
    cwd,
    maxBuffer: 16 * 1024 * 1024,
    timeout: 60_000
  })
  return stdout
}

let cachedUser: string | null = null

export async function currentGhUser(): Promise<string> {
  if (cachedUser) return cachedUser
  cachedUser = (await gh(['api', 'user', '--jq', '.login'])).trim()
  return cachedUser
}

export async function ghAuthStatus(): Promise<{ ok: boolean; detail: string }> {
  try {
    const user = await currentGhUser()
    return { ok: true, detail: `authenticated as @${user}` }
  } catch (err) {
    return { ok: false, detail: (err as Error).message.split('\n')[0] }
  }
}

export interface PrCandidate {
  number: number
  title: string
  url: string
  nameWithOwner: string
  author: string
  isDraft: boolean
}

async function searchPrs(flag: string): Promise<PrCandidate[]> {
  try {
    const out = await gh([
      'search',
      'prs',
      flag,
      '--state=open',
      '--json',
      'number,title,url,repository,author,isDraft'
    ])
    const rows = JSON.parse(out) as Array<{
      number: number
      title: string
      url: string
      repository: { nameWithOwner: string }
      author: { login: string }
      isDraft: boolean
    }>
    return rows.map((r) => ({
      number: r.number,
      title: r.title,
      url: r.url,
      nameWithOwner: r.repository.nameWithOwner,
      author: r.author?.login ?? '',
      isDraft: r.isDraft
    }))
  } catch {
    return []
  }
}

/** Union of review-requested + assigned, deduped by URL, drafts and own PRs excluded. */
export async function findReviewCandidates(): Promise<PrCandidate[]> {
  const me = await currentGhUser()
  const [requested, assigned] = await Promise.all([
    searchPrs('--review-requested=@me'),
    searchPrs('--assignee=@me')
  ])
  const seen = new Set<string>()
  const out: PrCandidate[] = []
  for (const pr of [...requested, ...assigned]) {
    if (!pr.url || pr.isDraft || pr.author === me || seen.has(pr.url)) continue
    seen.add(pr.url)
    out.push(pr)
  }
  return out
}

export interface PrStatus {
  myReviewState: string // APPROVED | CHANGES_REQUESTED | COMMENTED | DISMISSED | PENDING | NONE
  /** submittedAt of my latest review, ISO — lets a re-review distinguish new from old */
  myReviewSubmittedAt?: string
  merged: boolean
  title: string
  /** current head commit SHA — undefined when the API call failed */
  headRefOid?: string
  /** added + deleted lines — undefined when the API call failed */
  changedLines?: number
}

export async function prStatus(owner: string, repo: string, num: number): Promise<PrStatus> {
  const me = await currentGhUser()
  try {
    const out = await gh([
      'api',
      'graphql',
      '-f',
      'query=query($o:String!,$r:String!,$n:Int!){repository(owner:$o,name:$r){pullRequest(number:$n){title merged headRefOid additions deletions reviews(last:100){nodes{author{login} state submittedAt}}}}}',
      '-f',
      `o=${owner}`,
      '-f',
      `r=${repo}`,
      '-F',
      `n=${num}`
    ])
    const pr = JSON.parse(out)?.data?.repository?.pullRequest
    const mine = (pr?.reviews?.nodes ?? []).filter(
      (n: { author?: { login: string } }) => n.author?.login === me
    )
    const latest = mine.length ? mine[mine.length - 1] : null
    return {
      myReviewState: latest ? latest.state : 'NONE',
      myReviewSubmittedAt: latest?.submittedAt ?? undefined,
      merged: Boolean(pr?.merged),
      title: pr?.title ?? '',
      headRefOid: pr?.headRefOid ?? undefined,
      changedLines:
        typeof pr?.additions === 'number' && typeof pr?.deletions === 'number'
          ? pr.additions + pr.deletions
          : undefined
    }
  } catch {
    return { myReviewState: 'NONE', merged: false, title: '' }
  }
}

export async function prForBranch(
  repoPath: string,
  branch: string
): Promise<{ url: string; number: number; state: string } | null> {
  try {
    const out = await gh(['pr', 'view', branch, '--json', 'url,number,state'], repoPath)
    const pr = JSON.parse(out)
    return pr?.url ? pr : null
  } catch {
    return null
  }
}

export interface PrCheckFailure {
  name: string
  link?: string
}

export interface PrChecksResult {
  state: 'OPEN' | 'MERGED' | 'CLOSED'
  headSha: string
  /** 'pending' while ANY check is unfinished — failures are only acted on once the run settles */
  overall: 'pass' | 'fail' | 'pending' | 'none'
  failed: PrCheckFailure[]
  /** empty string when the repo requires no reviews */
  reviewDecision: 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED' | ''
  /** GitHub mergeability; 'BEHIND' means the head must be synced with base before merge */
  mergeStateStatus: string
}

interface RollupNode {
  __typename?: string
  // CheckRun
  name?: string
  status?: string
  conclusion?: string
  detailsUrl?: string
  // StatusContext
  context?: string
  state?: string
  targetUrl?: string
}

/**
 * CI state of the branch's PR via `gh pr view` (never `gh pr checks`, which
 * exits non-zero on failing/pending checks). null when the branch has no PR
 * or the API call failed.
 */
export async function prChecks(repoPath: string, branch: string): Promise<PrChecksResult | null> {
  try {
    const out = await gh(
      [
        'pr',
        'view',
        branch,
        '--json',
        'state,headRefOid,statusCheckRollup,reviewDecision,mergeStateStatus'
      ],
      repoPath
    )
    const pr = JSON.parse(out)
    if (!pr?.headRefOid) return null
    const nodes: RollupNode[] = pr.statusCheckRollup ?? []
    let pending = false
    const failed: PrCheckFailure[] = []
    for (const n of nodes) {
      if (n.__typename === 'StatusContext' || n.state !== undefined) {
        // StatusContext (CircleCI, Vercel, …)
        if (n.state === 'PENDING' || n.state === 'EXPECTED') pending = true
        else if (n.state === 'FAILURE' || n.state === 'ERROR')
          failed.push({ name: n.context ?? 'status', link: n.targetUrl ?? undefined })
      } else {
        // CheckRun (GitHub Actions et al). ACTION_REQUIRED = awaiting workflow
        // approval, not code-fixable; CANCELLED is usually a superseded run.
        if (n.status !== 'COMPLETED' || n.conclusion === 'ACTION_REQUIRED') pending = true
        else if (
          n.conclusion === 'FAILURE' ||
          n.conclusion === 'TIMED_OUT' ||
          n.conclusion === 'STARTUP_FAILURE'
        )
          failed.push({ name: n.name ?? 'check', link: n.detailsUrl ?? undefined })
      }
    }
    const overall =
      nodes.length === 0 ? 'none' : pending ? 'pending' : failed.length ? 'fail' : 'pass'
    return {
      state: pr.state,
      headSha: pr.headRefOid,
      overall,
      failed,
      reviewDecision: pr.reviewDecision ?? '',
      mergeStateStatus: pr.mergeStateStatus ?? ''
    }
  } catch {
    return null
  }
}

interface CommentAuthor {
  __typename?: string
  login?: string
}

export interface PrComment {
  /** GraphQL node id — stable across refetches */
  id: string
  author?: string
  /** file path + line the comment targets (review threads only) */
  file?: string
  line?: number
  /** the comment body (markdown); thread replies appended inline */
  comment: string
  /** when the comment (or thread's first comment) was posted */
  createdAt?: string
}

/**
 * Open human comments on a PR: conversation comments plus unresolved review
 * threads, excluding bots and the viewer's own thread-starters. null when
 * the API call failed (so callers keep their last known list).
 */
export async function prReviewComments(
  owner: string,
  repo: string,
  num: number
): Promise<PrComment[] | null> {
  try {
    const me = await currentGhUser()
    const out = await gh([
      'api',
      'graphql',
      '-f',
      'query=query($o:String!,$r:String!,$n:Int!){repository(owner:$o,name:$r){pullRequest(number:$n){comments(first:100){nodes{id author{__typename login} body createdAt}} reviewThreads(first:100){nodes{id isResolved path line comments(first:10){nodes{author{__typename login} body createdAt}}}}}}}',
      '-f',
      `o=${owner}`,
      '-f',
      `r=${repo}`,
      '-F',
      `n=${num}`
    ])
    const pr = JSON.parse(out)?.data?.repository?.pullRequest
    if (!pr) return null
    const isHuman = (a?: CommentAuthor): boolean =>
      a?.__typename !== 'Bot' && a?.login !== me && a?.login !== undefined
    const items: PrComment[] = []
    const threads = (pr.reviewThreads?.nodes ?? []) as Array<{
      id: string
      isResolved?: boolean
      path?: string
      line?: number
      comments?: { nodes?: Array<{ author?: CommentAuthor; body?: string; createdAt?: string }> }
    }>
    for (const t of threads) {
      const first = t.comments?.nodes?.[0]
      if (t.isResolved || !isHuman(first?.author)) continue
      const replies = (t.comments?.nodes ?? [])
        .slice(1)
        .map((c) => `\n\n> ${c.author?.login ?? 'reply'}: ${c.body ?? ''}`)
        .join('')
      items.push({
        id: t.id,
        author: first?.author?.login,
        file: t.path ?? undefined,
        line: t.line ?? undefined,
        comment: (first?.body ?? '') + replies,
        createdAt: first?.createdAt
      })
    }
    const conversation = (pr.comments?.nodes ?? []) as Array<{
      id: string
      author?: CommentAuthor
      body?: string
      createdAt?: string
    }>
    for (const c of conversation) {
      if (!isHuman(c.author)) continue
      items.push({
        id: c.id,
        author: c.author?.login,
        comment: c.body ?? '',
        createdAt: c.createdAt
      })
    }
    return items
  } catch {
    return null
  }
}

/**
 * Truncated failed-step logs for the GitHub Actions runs behind these check
 * links, best effort — non-Actions checks (CircleCI, Vercel) yield nothing.
 */
export async function failedRunLogs(
  repoPath: string,
  links: Array<string | undefined>,
  maxBytes = 30_000
): Promise<string> {
  const runIds = [
    ...new Set(links.map((l) => l?.match(/\/actions\/runs\/(\d+)/)?.[1]).filter(Boolean))
  ].slice(0, 2) as string[]
  if (runIds.length === 0) return ''
  const perRun = Math.floor(maxBytes / runIds.length)
  const parts: string[] = []
  for (const id of runIds) {
    try {
      const log = await gh(['run', 'view', id, '--log-failed'], repoPath)
      if (!log.trim()) continue
      // keep the tail — that's where the error is
      const tail = log.length > perRun ? `…(truncated)\n${log.slice(-perRun)}` : log
      parts.push(`### run ${id}\n${tail.trim()}`)
    } catch {
      // in-progress run or log expired — the prompt degrades to names + links
    }
  }
  return parts.join('\n\n')
}

export async function createPr(
  repoPath: string,
  branch: string,
  title: string,
  body: string,
  draft = false,
  base?: string
): Promise<string> {
  const args = ['pr', 'create', '--head', branch, '--title', title, '--body', body]
  if (base) args.push('--base', base)
  if (draft) args.push('--draft')
  const out = await gh(args, repoPath)
  const url = out.trim().split('\n').pop() ?? ''
  if (!url.startsWith('http')) throw new Error(`gh pr create returned no URL: ${out}`)
  return url
}

export async function mergePr(repoPath: string, branch: string): Promise<void> {
  await gh(['pr', 'merge', branch, '--squash', '--delete-branch'], repoPath)
}

/** Sync the PR's head branch with its base (GitHub "Update branch"). */
export async function updatePrBranch(repoPath: string, branch: string): Promise<void> {
  await gh(['pr', 'update-branch', branch], repoPath)
}

/** Map owner/repo -> local path for configured repos (parsed from git origin). */
export async function buildRepoMap(repoPaths: string[]): Promise<Map<string, string>> {
  const git = binaryPath('git')
  const map = new Map<string, string>()
  if (!git) return map
  await Promise.all(
    repoPaths.map(async (p) => {
      try {
        const { stdout } = await pexecFile(git, ['-C', p, 'remote', 'get-url', 'origin'], {
          env: spawnEnv(),
          timeout: 10_000
        })
        const nwo = stdout
          .trim()
          .replace(/^git@github\.com:/, '')
          .replace(/^https:\/\/github\.com\//, '')
          .replace(/\.git$/, '')
          .replace(/\/$/, '')
        if (nwo) map.set(nwo, p)
      } catch {
        // repo missing or no origin — skip
      }
    })
  )
  return map
}
