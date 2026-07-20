import { useEffect, useState, type ReactElement } from 'react'
import type { Session } from '@shared/types'
import { sessionList, useApp } from '../store'
import { Vu } from '../lib/ui'
import { cn, elapsed, statusColor } from '../lib/utils'

const kindLabel: Record<Session['kind'], string> = {
  planning: 'planning',
  plan_feedback: 'plan feedback',
  coding: 'coding',
  create_pr: 'create pr',
  reprompt: 'reprompt',
  pr_review: 'pr review',
  fetch_comments: 'fetch gh comments',
  error_investigation: 'error investigation',
  probe: 'probe'
}

/** Sessions that are actively occupying a slot right now. */
function isActive(s: Session): boolean {
  return s.status === 'running' || s.status === 'queued' || s.status === 'orphaned'
}

function SessionItem({ session, onOpen }: { session: Session; onOpen: () => void }): ReactElement {
  return (
    <button
      onClick={onOpen}
      className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left transition-colors hover:bg-ink-800"
    >
      <span className="w-4 shrink-0 text-center">
        {session.status === 'running' ? (
          <Vu />
        ) : (
          <span className={cn('font-mono text-[11px]', statusColor[session.status])}>
            {session.status === 'queued' ? '·' : '–'}
          </span>
        )}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-1.5">
          <span className="truncate text-[12px] font-semibold text-ink-50">
            {session.issueIdentifier ??
              (session.prUrl ? session.prUrl.split('/').slice(-3).join(' #') : 'session')}
          </span>
          <span className="rounded bg-ink-700 px-1 py-px font-mono text-[9px] uppercase text-ink-200">
            {kindLabel[session.kind]}
          </span>
        </span>
        {session.lastText && (
          <span className="mt-0.5 block truncate font-mono text-[10px] text-ink-400">
            {session.lastText}
          </span>
        )}
      </span>
      <span className={cn('shrink-0 font-mono text-[10px]', statusColor[session.status])}>
        {elapsed(session.startedAt, session.finishedAt)}
      </span>
    </button>
  )
}

/** Titlebar indicator for in-flight work: shows the active count, reveals a
 *  dropdown of each running/queued session (and what type of work it is) on hover. */
export default function SessionsMenu(): ReactElement | null {
  const sessions = useApp((s) => s.sessions)
  const setView = useApp((s) => s.setView)
  const [open, setOpen] = useState(false)

  // tick so elapsed times keep counting up while the menu is open
  const [, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!open) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [open])

  const active = sessionList(sessions).filter(isActive)
  const running = active.filter((s) => s.status === 'running').length

  return (
    <div
      className="titlebar-no-drag relative"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      <button
        onClick={() => setView('sessions')}
        className="flex items-center gap-1.5 rounded-lg px-2 py-1 font-mono text-[11px] text-ink-300 transition-colors hover:bg-ink-800 hover:text-ink-100"
      >
        {running > 0 ? <Vu /> : <span className="h-[7px] w-[7px] rounded-full bg-ink-500" />}
        <span>{active.length > 0 ? `${active.length} running` : 'idle'}</span>
      </button>

      {open && (
        <div className="hairline absolute right-0 top-full z-50 mt-1.5 w-80 rounded-xl border bg-ink-900 p-1.5 shadow-xl">
          <p className="px-2.5 pb-1 pt-1 text-[10px] uppercase tracking-wide text-ink-400">
            Active sessions
          </p>
          {active.length > 0 ? (
            <div className="max-h-96 overflow-y-auto">
              {active.map((s) => (
                <SessionItem key={s.id} session={s} onOpen={() => setView('sessions')} />
              ))}
            </div>
          ) : (
            <p className="px-2.5 pb-2 pt-0.5 text-[11px] text-ink-400">No sessions running.</p>
          )}
        </div>
      )}
    </div>
  )
}
