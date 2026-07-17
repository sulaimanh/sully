import type { Session } from './types'

// $ per million tokens. Cache reads bill at 0.1x input; cache writes at 1.25x
// (5-minute TTL, which is what the claude CLI uses). Matched by substring so
// both aliases ("opus") and resolved ids ("claude-opus-4-8") price correctly.
// Update when Anthropic pricing changes — last checked 2026-07.
const PRICING: Array<{ match: string; inPerM: number; outPerM: number }> = [
  { match: 'fable', inPerM: 10, outPerM: 50 },
  { match: 'mythos', inPerM: 10, outPerM: 50 },
  { match: 'opus', inPerM: 5, outPerM: 25 },
  { match: 'sonnet', inPerM: 3, outPerM: 15 },
  { match: 'haiku', inPerM: 1, outPerM: 5 }
]

/**
 * Estimate a session's cost from its accumulated token usage. Used when the
 * CLI's authoritative final cost report hasn't arrived — either the session is
 * still running (live spend in the usage bar) or it was cut short (stopped,
 * timeout, crashed). Returns undefined when the model can't be priced or
 * there's no usage.
 */
export function estimateCostUsd(session: Session): number | undefined {
  const u = session.usage
  if (!u || session.agent !== 'claude') return undefined
  if (u.in + u.out + u.cacheRead + u.cacheWrite === 0) return undefined
  const model = (session.resolvedModel ?? session.model ?? '').toLowerCase()
  const p = PRICING.find((row) => model.includes(row.match))
  if (!p) return undefined
  return (
    (u.in * p.inPerM +
      u.cacheRead * p.inPerM * 0.1 +
      u.cacheWrite * p.inPerM * 1.25 +
      u.out * p.outPerM) /
    1_000_000
  )
}
