import { useEffect, useState, type ReactElement } from 'react'
import type { PlanUsageWindow, RateLimitInfo, Session } from '@shared/types'
import { estimateCostUsd } from '@shared/pricing'
import { useApp } from '../store'
import { cn } from '../lib/utils'

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`
  return String(n)
}

function fmtClock(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

/** costUsd once the CLI reports it; a live pricing estimate while streaming */
function sessionCost(s: Session): number {
  return s.costUsd ?? estimateCostUsd(s) ?? 0
}

// status thresholds shared with the rest of the app: sage ok, brass warning, terra critical
function fillColor(pct: number): string {
  if (pct >= 90) return 'bg-terra-400'
  if (pct >= 75) return 'bg-brass-400'
  return 'bg-sage-500'
}

function windowTip(name: string, w: PlanUsageWindow): string {
  const left = `${Math.max(0, 100 - Math.round(w.utilization))}% left`
  const resets = w.resetsAt ? ` · resets ${fmtClock(new Date(w.resetsAt).getTime())}` : ''
  return `${name}: ${Math.round(w.utilization)}% used · ${left}${resets}`
}

function Meter({ label, window: w }: { label: string; window: PlanUsageWindow }): ReactElement {
  const pct = Math.round(w.utilization)
  return (
    <span className="flex items-center gap-1.5">
      <span className="text-ink-400">{label}</span>
      <span className="h-[5px] w-16 overflow-hidden rounded-full bg-ink-700">
        <span
          className={cn(
            'block h-full rounded-full transition-[width] duration-500',
            fillColor(pct)
          )}
          style={{ width: pct > 0 ? `${Math.max(pct, 8)}%` : 0 }}
        />
      </span>
      <span className="text-ink-200">{pct}%</span>
    </span>
  )
}

const RATE_DOT: Record<RateLimitInfo['status'], string> = {
  allowed: 'bg-sage-400',
  allowed_warning: 'bg-brass-400',
  rejected: 'bg-terra-400'
}

function rateLabel(rl: RateLimitInfo): string {
  if (rl.status === 'rejected')
    return `limit reached${rl.resetsAt ? ` · resets ${fmtClock(rl.resetsAt * 1000)}` : ''}`
  if (rl.utilization !== undefined) return `${Math.round(rl.utilization * 100)}% used`
  return 'limits ok'
}

/** Claude plan usage meters (5h + weekly windows) and today's spend, in the main pane title bar. */
export default function UsageBar(): ReactElement | null {
  const sessions = useApp((s) => s.sessions)
  const rateLimit = useApp((s) => s.rateLimit)
  const planUsage = useApp((s) => s.planUsage)

  // render-stable clock, ticked periodically so "today" and staleness roll over
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(t)
  }, [])

  const midnight = new Date(now)
  midnight.setHours(0, 0, 0, 0)
  const today = Object.values(sessions).filter(
    (s) => new Date(s.startedAt).getTime() >= midnight.getTime()
  )
  const costToday = today.reduce((sum, s) => sum + sessionCost(s), 0)
  const tokens = today.reduce(
    (acc, s) => {
      if (s.usage) {
        acc.in += s.usage.in
        acc.out += s.usage.out
        acc.cache += s.usage.cacheRead + s.usage.cacheWrite
      }
      return acc
    },
    { in: 0, out: 0, cache: 0 }
  )
  const anyEstimated = today.some((s) => s.costUsd === undefined || s.costIsEstimate)

  // stream-parsed status: instant fallback until the first poll lands; a
  // reading from a window that has since reset is meaningless
  const rl =
    !planUsage && rateLimit && (!rateLimit.resetsAt || rateLimit.resetsAt * 1000 > now)
      ? rateLimit
      : undefined

  if (!planUsage && !rl && today.length === 0) return null

  const tooltip = [
    planUsage?.fiveHour && windowTip('5-hour window', planUsage.fiveHour),
    planUsage?.sevenDay && windowTip('Weekly window', planUsage.sevenDay),
    planUsage && `As of ${fmtClock(planUsage.fetchedAt)}`,
    today.length > 0 &&
      `Today: ${today.length} session${today.length === 1 ? '' : 's'} · ` +
        `${fmtTokens(tokens.in)} in · ${fmtTokens(tokens.out)} out · ${fmtTokens(tokens.cache)} cached`
  ]
    .filter(Boolean)
    .join('\n')

  return (
    <div
      className="titlebar-no-drag flex items-center gap-3 font-mono text-[11px] text-ink-300"
      title={tooltip}
    >
      {planUsage?.fiveHour && <Meter label="5h" window={planUsage.fiveHour} />}
      {planUsage?.sevenDay && planUsage.sevenDay.utilization >= 1 && (
        <Meter label="wk" window={planUsage.sevenDay} />
      )}
      {rl && (
        <span className="flex items-center gap-1.5">
          <span className={cn('h-[7px] w-[7px] rounded-full', RATE_DOT[rl.status])} />
          {rateLabel(rl)}
        </span>
      )}
      {today.length > 0 && (
        <span>
          {anyEstimated ? '~' : ''}${costToday.toFixed(2)} today
        </span>
      )}
    </div>
  )
}
