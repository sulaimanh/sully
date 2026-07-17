import { EventEmitter } from 'events'
import { execFile } from 'child_process'
import { promisify } from 'util'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import type { PlanUsage, PlanUsageWindow } from '../shared/types'

// Drives the title-bar usage meter: polls the claude.ai OAuth usage endpoint
// (the numbers `claude /usage` shows) with the user's own Claude Code login.
// Failures are silent — the meter just keeps the last good reading.

const pexecFile = promisify(execFile)
const INTERVAL_MS = 60_000
const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'

/**
 * The claude CLI keeps its OAuth blob in the login keychain (item
 * "Claude Code-credentials"), or in ~/.claude/.credentials.json on setups
 * without keychain access. Read per poll so CLI token refreshes are picked up.
 */
async function readOauthToken(): Promise<string | undefined> {
  let raw: string | undefined
  try {
    const { stdout } = await pexecFile(
      '/usr/bin/security',
      ['find-generic-password', '-s', 'Claude Code-credentials', '-w'],
      { timeout: 5000 }
    )
    raw = stdout.trim()
  } catch {
    try {
      raw = fs.readFileSync(path.join(os.homedir(), '.claude', '.credentials.json'), 'utf8')
    } catch {
      return undefined
    }
  }
  try {
    const token = (JSON.parse(raw) as { claudeAiOauth?: { accessToken?: unknown } }).claudeAiOauth
      ?.accessToken
    return typeof token === 'string' && token ? token : undefined
  } catch {
    return undefined
  }
}

function parseWindow(v: unknown): PlanUsageWindow | undefined {
  const w = v as { utilization?: unknown; resets_at?: unknown } | null | undefined
  if (typeof w?.utilization !== 'number' || !Number.isFinite(w.utilization)) return undefined
  return {
    utilization: Math.min(100, Math.max(0, w.utilization)),
    resetsAt: typeof w.resets_at === 'string' ? w.resets_at : undefined
  }
}

async function fetchPlanUsage(): Promise<PlanUsage | null> {
  const token = await readOauthToken()
  if (!token) return null
  const res = await fetch(USAGE_URL, {
    headers: {
      Authorization: `Bearer ${token}`,
      'anthropic-beta': 'oauth-2025-04-20'
    },
    signal: AbortSignal.timeout(10_000)
  })
  if (!res.ok) return null
  const body = (await res.json()) as { five_hour?: unknown; seven_day?: unknown }
  const fiveHour = parseWindow(body.five_hour)
  const sevenDay = parseWindow(body.seven_day)
  if (!fiveHour && !sevenDay) return null
  return { fiveHour, sevenDay, fetchedAt: Date.now() }
}

class PlanUsageMonitor extends EventEmitter {
  private usage: PlanUsage | null = null
  private timer: NodeJS.Timeout | null = null
  private inFlight: Promise<PlanUsage | null> | null = null

  start(): void {
    if (this.timer) return
    void this.runNow()
    this.timer = setInterval(() => void this.runNow(), INTERVAL_MS)
  }

  current(): PlanUsage | null {
    return this.usage
  }

  runNow(): Promise<PlanUsage | null> {
    if (this.inFlight) return this.inFlight
    this.inFlight = (async () => {
      try {
        const next = await fetchPlanUsage()
        if (next) {
          this.usage = next
          this.emit('updated', next)
        }
      } catch {
        // offline / token expired — keep the last good reading
      } finally {
        this.inFlight = null
      }
      return this.usage
    })()
    return this.inFlight
  }
}

export const planUsageMonitor = new PlanUsageMonitor()
