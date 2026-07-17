import { execFile } from 'child_process'
import { promisify } from 'util'
import * as os from 'os'
import * as path from 'path'
import * as fs from 'fs'
import { getFigmaToken } from './credentials'

const pexecFile = promisify(execFile)

// GUI apps on macOS get a bare PATH (/usr/bin:/bin:...). Resolve the user's
// real PATH once from a login shell so spawned CLIs (claude, gh, codex) resolve.
const FALLBACK_DIRS = [
  '/opt/homebrew/bin',
  '/usr/local/bin',
  path.join(os.homedir(), '.local', 'bin'),
  path.join(os.homedir(), 'bin'),
  path.join(os.homedir(), '.claude', 'local')
]

let resolvedPath: string | null = null
const binaries: Record<string, string | null> = {}

export async function initEnv(): Promise<void> {
  try {
    const { stdout } = await pexecFile('/bin/zsh', ['-lic', 'echo -n "$PATH"'], {
      timeout: 10_000
    })
    if (stdout.trim()) resolvedPath = stdout.trim()
  } catch {
    // login shell failed (e.g. broken rc file) — fall back below
  }
  const parts = new Set((resolvedPath ?? process.env.PATH ?? '').split(':').filter(Boolean))
  for (const d of FALLBACK_DIRS) parts.add(d)
  for (const d of (process.env.PATH ?? '').split(':')) if (d) parts.add(d)
  resolvedPath = Array.from(parts).join(':')
  process.env.PATH = resolvedPath

  await Promise.all(['claude', 'codex', 'gh', 'git'].map((b) => resolveBinary(b)))
}

async function resolveBinary(name: string): Promise<string | null> {
  for (const dir of resolvedPath?.split(':') ?? []) {
    const candidate = path.join(dir, name)
    try {
      fs.accessSync(candidate, fs.constants.X_OK)
      binaries[name] = candidate
      return candidate
    } catch {
      // keep looking
    }
  }
  binaries[name] = null
  return null
}

export function binaryPath(name: string): string | null {
  return binaries[name] ?? null
}

export function envPath(): string {
  return resolvedPath ?? process.env.PATH ?? ''
}

/**
 * Environment for spawned sessions. Always strips CLAUDECODE so nested claude
 * invocations don't think they run inside another Claude Code session.
 * Exposes the stored Figma PAT as FIGMA_TOKEN so sessions (and skills like
 * figma:comments) pick up rotations from Settings without editing files.
 */
export function spawnEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: envPath(), ...extra }
  const figmaToken = getFigmaToken()
  if (figmaToken && !('FIGMA_TOKEN' in extra)) env.FIGMA_TOKEN = figmaToken
  delete env.CLAUDECODE
  delete env.CLAUDE_CODE_ENTRYPOINT
  return env
}
