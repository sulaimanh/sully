import { useEffect, useRef, useState, type ReactElement } from 'react'
import { X, FileText, Square } from 'lucide-react'
import type { Session, StreamEvent } from '@shared/types'
import { useApp } from '../store'
import { Button, Vu } from '../lib/ui'
import { cn, elapsed, statusColor } from '../lib/utils'
import DockablePanel, { DockControls } from './DockablePanel'

// stable fallback: a fresh [] per selector call makes zustand's
// useSyncExternalStore loop forever and crash the renderer
const EMPTY_EVENTS: StreamEvent[] = []

const kindStyle: Record<StreamEvent['kind'], string> = {
  init: 'text-mist-400',
  text: 'text-ink-50',
  tool: 'text-ink-300',
  result: 'text-sage-400',
  raw: 'text-ink-400',
  stderr: 'text-terra-400'
}

/** Live session log: normalized stream events, or raw NDJSON tail on demand. */
export default function LogViewer({
  session,
  onClose
}: {
  session: Session
  onClose: () => void
}): ReactElement {
  const liveEvents = useApp((s) => s.sessionEvents[session.id] ?? EMPTY_EVENTS)
  const live = useApp((s) => s.sessions[session.id] ?? session)
  const [raw, setRaw] = useState(false)
  const [rawContent, setRawContent] = useState('')
  const [backfill, setBackfill] = useState<StreamEvent[] | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const stick = useRef(true)

  // sessions that streamed in a previous app run have no live events in the
  // store — rebuild the pretty view once from the on-disk log
  useEffect(() => {
    if (liveEvents.length > 0 || live.status === 'running') return
    let cancelled = false
    void window.sully.readSessionEvents(session.id).then((evs) => {
      if (!cancelled) setBackfill(evs)
    })
    return () => {
      cancelled = true
    }
  }, [liveEvents.length, live.status, session.id])

  const events = liveEvents.length > 0 ? liveEvents : (backfill ?? EMPTY_EVENTS)

  // raw mode: poll the log file (also covers orphaned sessions with no live events)
  useEffect(() => {
    if (!raw) return
    let offset = 0
    let cancelled = false
    const tick = async (): Promise<void> => {
      const { content, size } = await window.sully.readSessionLog(session.id, offset)
      if (cancelled) return
      if (content) {
        offset = size
        setRawContent((prev) => (prev + content).slice(-400_000))
      }
    }
    void tick()
    const t = setInterval(() => void tick(), 2000)
    return () => {
      cancelled = true
      clearInterval(t)
    }
  }, [raw, session.id])

  useEffect(() => {
    const el = scrollRef.current
    if (el && stick.current) el.scrollTop = el.scrollHeight
  }, [events, rawContent])

  const running = live.status === 'running'

  return (
    <DockablePanel
      id="session-log"
      modalClassName="h-[min(920px,90vh)] w-[min(1200px,92vw)] min-h-[420px] min-w-[560px]"
      minWidth={560}
      minHeight={420}
      onClose={onClose}
    >
      <header className="hairline flex items-center gap-3 border-b px-5 py-3.5">
        {running ? <Vu /> : null}
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13.5px] font-bold text-ink-50">
            {live.issueIdentifier ?? live.prUrl?.split('/').slice(-3).join('/') ?? live.kind}
            <span className="ml-2 font-normal text-ink-300">{live.kind.replace('_', ' ')}</span>
          </p>
          <p className="truncate font-mono text-[10.5px] text-ink-400">
            {live.command.join(' ').slice(0, 160)}
          </p>
        </div>
        <span className={cn('font-mono text-[11px] uppercase', statusColor[live.status])}>
          {live.status} · {elapsed(live.startedAt, live.finishedAt)}
        </span>
        {(running || live.status === 'orphaned') && (
          <Button variant="danger" onClick={() => void window.sully.stopSession(live.id)}>
            <Square size={11} /> Stop
          </Button>
        )}
        <Button
          onClick={() => {
            setRawContent('')
            setRaw((v) => !v)
          }}
          title="Toggle raw NDJSON"
        >
          <FileText size={12} /> {raw ? 'Pretty' : 'Raw'}
        </Button>
        <DockControls />
        <button onClick={onClose} className="text-ink-300 hover:text-ink-50">
          <X size={17} />
        </button>
      </header>

      <div
        ref={scrollRef}
        onScroll={(e) => {
          const el = e.currentTarget
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60
        }}
        className="selectable min-h-0 flex-1 overflow-y-auto px-5 py-4 font-mono text-[11.5px] leading-relaxed"
      >
        {raw ? (
          <pre className="whitespace-pre-wrap break-all text-ink-200">
            {rawContent || 'reading log…'}
          </pre>
        ) : events.length === 0 ? (
          <p className="italic text-ink-400">
            {running
              ? 'waiting for output…'
              : backfill === null
                ? 'reading log…'
                : 'No output in the log file for this session.'}
          </p>
        ) : (
          events.map((ev, i) => (
            <div key={i} className={cn('mb-1 whitespace-pre-wrap break-words', kindStyle[ev.kind])}>
              {ev.kind === 'tool' ? (
                <span>
                  <span className="text-brass-500">▸ </span>
                  {ev.text}
                </span>
              ) : (
                ev.text
              )}
            </div>
          ))
        )}
      </div>

      <footer className="hairline flex items-center justify-between border-t px-5 py-2.5">
        <button
          className="font-mono text-[10.5px] text-ink-400 hover:text-ink-200"
          onClick={() => void window.sully.revealFile(live.logFile)}
        >
          {live.logFile}
        </button>
        {live.costUsd !== undefined && (
          <span
            className="font-mono text-[10.5px] text-ink-300"
            title={
              live.costIsEstimate ? 'Estimated from token usage (session was cut short)' : undefined
            }
          >
            {live.costIsEstimate ? '~' : ''}${live.costUsd.toFixed(2)} · {live.numTurns ?? '?'}{' '}
            turns
          </span>
        )}
      </footer>
    </DockablePanel>
  )
}
