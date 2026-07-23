import { useMemo, type ReactElement } from 'react'
import { ScrollText, Square } from 'lucide-react'
import type { Session } from '@shared/types'
import { call, sessionList, useApp } from '../store'
import { Button, EmptyState, Vu } from '../lib/ui'
import { cn, elapsed, statusColor } from '../lib/utils'
import LogViewer from '../components/LogViewer'

const kindLabel: Record<Session['kind'], string> = {
  planning: 'planning',
  plan_feedback: 'plan feedback',
  coding: 'coding',
  create_pr: 'create pr',
  commit_push: 'commit & push',
  reprompt: 'reprompt',
  pr_review: 'pr review',
  fetch_comments: 'fetch gh comments',
  error_investigation: 'error investigation',
  probe: 'probe'
}

function SessionRow({ session, onOpen }: { session: Session; onOpen: () => void }): ReactElement {
  const active = session.status === 'running' || session.status === 'orphaned'
  return (
    <div
      className={cn(
        'hairline group flex items-center gap-3.5 rounded-xl border bg-ink-850 px-4 py-3 transition-colors hover:border-ink-600',
        session.status === 'running' && 'border-brass-500/30'
      )}
    >
      <div className="w-5 shrink-0 text-center">
        {session.status === 'running' ? (
          <Vu />
        ) : (
          <span className={cn('font-mono text-[14px]', statusColor[session.status])}>
            {session.status === 'done'
              ? '✓'
              : session.status === 'error' || session.status === 'timeout'
                ? '✕'
                : '–'}
          </span>
        )}
      </div>

      <div className="selectable min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="text-[13px] font-bold text-ink-50">
            {session.issueIdentifier ??
              (session.prUrl ? session.prUrl.split('/').slice(-3).join(' #') : 'session')}
          </span>
          <span className="rounded bg-ink-700 px-1.5 py-px font-mono text-[10px] uppercase text-ink-200">
            {kindLabel[session.kind]}
          </span>
          <span className="font-mono text-[10px] text-ink-400">
            {session.agent}
            {session.model ? ` · ${session.model}` : ''}
          </span>
        </div>
        <p className="mt-0.5 truncate font-mono text-[10.5px] text-ink-400">
          {session.lastText ?? session.command.join(' ').slice(0, 140)}
        </p>
      </div>

      <div className="shrink-0 text-right">
        <p className={cn('font-mono text-[11px] uppercase', statusColor[session.status])}>
          {session.status}
        </p>
        <p
          className="font-mono text-[10.5px] text-ink-400"
          title={
            session.costIsEstimate
              ? 'Estimated from token usage (session was cut short)'
              : undefined
          }
        >
          {elapsed(session.startedAt, session.finishedAt)}
          {session.costUsd !== undefined
            ? ` · ${session.costIsEstimate ? '~' : ''}$${session.costUsd.toFixed(2)}`
            : ''}
        </p>
      </div>

      <div className="flex shrink-0 items-center gap-1">
        <Button onClick={onOpen} title="View log">
          <ScrollText size={12} />
        </Button>
        {active && (
          <Button
            variant="danger"
            onClick={() => void call(window.sully.stopSession(session.id))}
            title="Stop session"
          >
            <Square size={11} />
          </Button>
        )}
      </div>
    </div>
  )
}

export default function SessionsView(): ReactElement {
  const sessions = useApp((s) => s.sessions)
  const logSessionId = useApp((s) => s.logSessionId)
  const logView = useApp((s) => s.logView)
  const openLog = useApp((s) => s.openLog)
  const closeLog = useApp((s) => s.closeLog)
  const list = useMemo(() => sessionList(sessions), [sessions])
  const running = list.filter((s) => s.status === 'running' || s.status === 'orphaned')
  const past = list.filter((s) => s.status !== 'running' && s.status !== 'orphaned')

  return (
    <div className="fade-up">
      <div className="mb-6">
        <h1 className="font-display text-[26px] text-ink-50">Sessions</h1>
        <p className="text-[12px] text-ink-400">
          every headless command Sully runs, live and stoppable
        </p>
      </div>

      {list.length === 0 && (
        <EmptyState
          title="The studio is quiet."
          hint="When the orchestrator or PR watcher spawns a claude/codex session, it appears here with live output."
        />
      )}

      {running.length > 0 && (
        <div className="mb-6 flex flex-col gap-2.5">
          <h2 className="font-mono text-[11px] uppercase tracking-[0.18em] text-brass-400">
            running ({running.length})
          </h2>
          {running.map((s) => (
            <SessionRow key={s.id} session={s} onOpen={() => openLog(s.id)} />
          ))}
        </div>
      )}

      {past.length > 0 && (
        <div className="flex flex-col gap-2.5">
          <h2 className="font-mono text-[11px] uppercase tracking-[0.18em] text-ink-400">
            history
          </h2>
          {past.slice(0, 50).map((s) => (
            <SessionRow key={s.id} session={s} onOpen={() => openLog(s.id)} />
          ))}
        </div>
      )}

      {logView === 'sessions' && logSessionId && sessions[logSessionId] && (
        <LogViewer session={sessions[logSessionId]} onClose={closeLog} />
      )}
    </div>
  )
}
