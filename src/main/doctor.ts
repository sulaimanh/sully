import { execFile } from 'child_process'
import { promisify } from 'util'
import type { DoctorCheck, DoctorReport } from '../shared/types'
import { binaryPath, spawnEnv } from './env'
import { getFigmaToken, getLinearApiKey } from './credentials'
import { ghAuthStatus } from './github/gh'
import { fetchViewer } from './linear/operations'
import { settingsStore } from './settings'

const pexecFile = promisify(execFile)

async function checkLinear(): Promise<DoctorCheck> {
  if (!getLinearApiKey()) {
    return {
      id: 'linear',
      label: 'Linear API',
      ok: false,
      detail: 'no API key set — create one at linear.app/settings/account/security'
    }
  }
  try {
    const viewer = await fetchViewer()
    return {
      id: 'linear',
      label: 'Linear API',
      ok: true,
      detail: `authenticated as ${viewer.name} (${viewer.email})`
    }
  } catch (err) {
    return { id: 'linear', label: 'Linear API', ok: false, detail: (err as Error).message }
  }
}

async function checkGithub(): Promise<DoctorCheck> {
  const gh = await ghAuthStatus()
  return { id: 'github', label: 'GitHub', ok: gh.ok, detail: gh.detail }
}

// Sessions read Figma comments via the REST API, which needs a PAT — the Figma
// MCP's OAuth covers design context/screenshots but not comments.
export async function checkFigmaToken(): Promise<DoctorCheck> {
  const id = 'figma-token'
  const label = 'Figma API token'
  const token = getFigmaToken()
  if (!token) {
    return {
      id,
      label,
      ok: false,
      detail: 'no token set — paste a figd_… token under Settings → Credentials'
    }
  }
  try {
    const res = await fetch('https://api.figma.com/v1/me', {
      headers: { 'X-Figma-Token': token },
      signal: AbortSignal.timeout(10_000)
    })
    if (res.ok) {
      const me = (await res.json()) as { handle?: string; email?: string }
      return { id, label, ok: true, detail: `authenticated as ${me.email ?? me.handle}` }
    }
    return {
      id,
      label,
      ok: false,
      detail:
        res.status === 401 || res.status === 403
          ? 'token expired or invalid — create a new one at figma.com/settings'
          : `unexpected response ${res.status}`
    }
  } catch (err) {
    return { id, label, ok: false, detail: `check failed — ${(err as Error).message}` }
  }
}

/**
 * Auth status of the MCP servers headless sessions rely on, via
 * `claude mcp list` (lines look like `name: url - ✔ Connected`).
 */
export async function checkMcpServers(watch: string[]): Promise<DoctorCheck[]> {
  const names = watch.map((n) => n.trim()).filter(Boolean)
  if (names.length === 0) return []
  const mk = (name: string, ok: boolean, detail: string): DoctorCheck => ({
    id: `mcp-${name}`,
    label: `MCP: ${name}`,
    ok,
    detail
  })
  const claudeBin = binaryPath('claude')
  if (!claudeBin) return names.map((n) => mk(n, false, 'claude CLI not found'))

  let stdout: string
  try {
    ;({ stdout } = await pexecFile(claudeBin, ['mcp', 'list'], {
      env: spawnEnv(),
      timeout: 90_000,
      maxBuffer: 4 * 1024 * 1024
    }))
  } catch (err) {
    const msg = (err as Error).message.slice(0, 120)
    return names.map((n) => mk(n, false, `\`claude mcp list\` failed — ${msg}`))
  }

  const status = new Map<string, string>()
  for (const line of stdout.split('\n')) {
    const nameEnd = line.indexOf(': ')
    const statusStart = line.lastIndexOf(' - ')
    if (nameEnd <= 0 || statusStart <= nameEnd) continue
    status.set(line.slice(0, nameEnd).trim(), line.slice(statusStart + 3).trim())
  }

  return names.map((n) => {
    const s = status.get(n)
    if (!s) return mk(n, false, 'not configured — check `claude mcp list`')
    if (s.includes('Connected')) return mk(n, true, 'connected')
    if (s.includes('Needs authentication')) {
      return mk(n, false, 'needs authentication — run `claude` and use /mcp to log in')
    }
    return mk(n, false, s.replace(/^[✔✘!]\s*/, ''))
  })
}

/**
 * Re-authenticate one MCP server via `claude mcp login <name>` (opens the
 * browser OAuth flow) and return its fresh check. Never rejects — failures
 * come back as a failing check so the settings UI shows them inline. The CLI
 * exits 0 even when login fails, so the post-login `claude mcp list` probe is
 * the source of truth and the login output only supplies the error detail.
 */
export async function loginMcpServer(name: string): Promise<DoctorCheck> {
  const mk = (ok: boolean, detail: string): DoctorCheck => ({
    id: `mcp-${name}`,
    label: `MCP: ${name}`,
    ok,
    detail
  })
  const claudeBin = binaryPath('claude')
  if (!claudeBin) return mk(false, 'claude CLI not found')

  let loginOutput = ''
  try {
    const { stdout, stderr } = await pexecFile(claudeBin, ['mcp', 'login', name], {
      env: spawnEnv(),
      timeout: 180_000,
      maxBuffer: 4 * 1024 * 1024
    })
    loginOutput = `${stdout}\n${stderr}`.trim()
  } catch (err) {
    return mk(
      false,
      (err as { killed?: boolean }).killed
        ? 'login timed out — browser authorization was not completed'
        : `login failed — ${(err as Error).message.slice(0, 120)}`
    )
  }

  const [check] = await checkMcpServers([name])
  if (!check) return mk(false, 'login ran but status is unknown — check `claude mcp list`')
  // a failed login leaves the old status; the CLI's own message says why
  if (!check.ok && loginOutput) return mk(false, loginOutput.split('\n')[0].slice(0, 160))
  return check
}

/**
 * Everything except the headless claude probe — cheap enough for the
 * background tool-health monitor to run periodically.
 */
export async function runQuickChecks(): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = []

  for (const bin of ['claude', 'gh', 'git'] as const) {
    const p = binaryPath(bin)
    checks.push({
      id: `bin-${bin}`,
      label: `${bin} CLI`,
      ok: Boolean(p),
      detail: p ?? `not found — install ${bin === 'claude' ? 'Claude Code' : bin}`
    })
  }

  const [linear, github, figma, mcp] = await Promise.all([
    checkLinear(),
    checkGithub(),
    checkFigmaToken(),
    checkMcpServers(settingsStore.get().toolHealth.mcpServers)
  ])
  checks.push(linear, github, figma, ...mcp)
  return checks
}

export async function runDoctor(): Promise<DoctorReport> {
  const checks = await runQuickChecks()

  const codexPath = binaryPath('codex')
  checks.push({
    id: 'bin-codex',
    label: 'codex CLI (optional)',
    ok: true,
    detail: codexPath ?? 'not installed — only needed if a phase uses the codex agent'
  })

  // Headless claude probe — catches Keychain/auth issues that only appear for
  // spawned children (e.g. claude never run in a terminal yet).
  const claudeBin = binaryPath('claude')
  if (claudeBin) {
    try {
      const { stdout } = await pexecFile(
        claudeBin,
        ['-p', 'Reply with exactly: ok', '--output-format', 'json'],
        {
          env: spawnEnv(),
          timeout: 90_000,
          maxBuffer: 4 * 1024 * 1024
        }
      )
      const parsed = JSON.parse(stdout)
      const ok = parsed?.subtype === 'success'
      checks.push({
        id: 'claude-headless',
        label: 'claude headless probe',
        ok,
        detail: ok ? 'headless sessions work' : `unexpected result: ${stdout.slice(0, 150)}`
      })
    } catch (err) {
      checks.push({
        id: 'claude-headless',
        label: 'claude headless probe',
        ok: false,
        detail: `failed — run \`claude\` once in a terminal to log in (${(err as Error).message.slice(0, 120)})`
      })
    }
  }

  return { checks, ranAt: new Date().toISOString() }
}
