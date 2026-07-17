import type { RateLimitInfo, SessionUsage, StreamEvent } from '../../shared/types'

export interface ParsedResult {
  events: StreamEvent[]
  costUsd?: number
  numTurns?: number
  resultText?: string
  /** claude CLI conversation id (from system/result events) — used for --resume */
  agentSessionId?: string
  /** this turn's token usage (claude assistant events) — accumulated per session */
  usage?: SessionUsage
  /** resolved model id from the init event — pricing source for cost estimates */
  model?: string
  /** plan rate-limit status (claude rate_limit_event) — latest wins app-wide */
  rateLimit?: RateLimitInfo
}

function toCount(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0
}

/**
 * Normalizes one NDJSON line from `claude -p --output-format stream-json`
 * or `codex exec --json` into display events. Unknown shapes degrade to raw
 * lines instead of crashing — CLI minor versions add event kinds.
 */
export function parseLine(line: string): ParsedResult {
  const ts = Date.now()
  const trimmed = line.trim()
  if (!trimmed) return { events: [] }

  let obj: Record<string, unknown>
  try {
    obj = JSON.parse(trimmed)
  } catch {
    return { events: [{ kind: 'raw', text: trimmed, ts }] }
  }

  const type = obj.type as string | undefined

  const agentSessionId = typeof obj.session_id === 'string' ? obj.session_id : undefined

  // --- claude stream-json ---
  if (type === 'system') {
    const subtype = obj.subtype as string | undefined
    return {
      events: [{ kind: 'init', text: `session ${subtype ?? 'event'}`, ts }],
      agentSessionId,
      model: typeof obj.model === 'string' ? obj.model : undefined
    }
  }
  if (type === 'assistant' || type === 'user') {
    const message = obj.message as
      { content?: Array<Record<string, unknown>>; usage?: Record<string, unknown> } | undefined
    // per-turn usage: summing these across the session gives total spend even
    // when the session is killed before the CLI's final cost report
    const rawUsage = type === 'assistant' ? message?.usage : undefined
    const usage: SessionUsage | undefined = rawUsage
      ? {
          in: toCount(rawUsage.input_tokens),
          out: toCount(rawUsage.output_tokens),
          cacheRead: toCount(rawUsage.cache_read_input_tokens),
          cacheWrite: toCount(rawUsage.cache_creation_input_tokens)
        }
      : undefined
    const events: StreamEvent[] = []
    for (const block of message?.content ?? []) {
      if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
        events.push({ kind: type === 'assistant' ? 'text' : 'raw', text: block.text, ts })
      } else if (block.type === 'tool_use') {
        const name = block.name as string
        const input = block.input as Record<string, unknown> | undefined
        const hint =
          (input?.command as string) ??
          (input?.file_path as string) ??
          (input?.pattern as string) ??
          ''
        events.push({ kind: 'tool', text: `${name} ${String(hint).slice(0, 200)}`.trim(), ts })
      } else if (block.type === 'tool_result') {
        // tool results are noisy; skip in the normalized stream (raw log keeps them)
      }
    }
    return { events, usage }
  }
  if (type === 'result') {
    const resultText = typeof obj.result === 'string' ? obj.result : undefined
    return {
      events: [
        {
          kind: 'result',
          text: resultText ?? `finished (${(obj.subtype as string) ?? 'unknown'})`,
          ts
        }
      ],
      costUsd: typeof obj.total_cost_usd === 'number' ? obj.total_cost_usd : undefined,
      numTurns: typeof obj.num_turns === 'number' ? obj.num_turns : undefined,
      resultText,
      agentSessionId
    }
  }

  if (type === 'rate_limit_event') {
    const info = obj.rate_limit_info as Record<string, unknown> | undefined
    const status = info?.status
    if (status === 'allowed' || status === 'allowed_warning' || status === 'rejected') {
      return {
        events: [], // status strip material, not session log material (raw log keeps it)
        rateLimit: {
          status,
          utilization: typeof info?.utilization === 'number' ? info.utilization : undefined,
          resetsAt: typeof info?.resetsAt === 'number' ? info.resetsAt : undefined,
          rateLimitType: typeof info?.rateLimitType === 'string' ? info.rateLimitType : undefined,
          isUsingOverage:
            typeof info?.isUsingOverage === 'boolean' ? info.isUsingOverage : undefined,
          observedAt: ts
        }
      }
    }
    return { events: [] }
  }

  // --- codex exec --json (JSONL events with a `msg` payload) ---
  const msg = obj.msg as
    { type?: string; message?: string; last_agent_message?: string } | undefined
  if (msg?.type) {
    if (msg.type === 'agent_message' && msg.message) {
      return { events: [{ kind: 'text', text: msg.message, ts }] }
    }
    if (msg.type === 'task_complete') {
      const text = msg.last_agent_message ?? 'task complete'
      return { events: [{ kind: 'result', text, ts }], resultText: text }
    }
    if (msg.type === 'task_started') {
      return { events: [{ kind: 'init', text: 'codex task started', ts }] }
    }
    return { events: [{ kind: 'tool', text: msg.type, ts }] }
  }

  // recognized-as-JSON but unknown event kind — show compactly instead of
  // dumping the full payload
  if (typeof type === 'string') {
    return { events: [{ kind: 'raw', text: `[${type}]`, ts }] }
  }
  return { events: [{ kind: 'raw', text: trimmed.slice(0, 500), ts }] }
}

/** Incremental line splitter for a stdout stream. */
export class LineBuffer {
  private buf = ''

  push(chunk: string): string[] {
    this.buf += chunk
    const lines = this.buf.split('\n')
    this.buf = lines.pop() ?? ''
    return lines
  }

  flush(): string[] {
    const rest = this.buf
    this.buf = ''
    return rest ? [rest] : []
  }
}
