import { useEffect, useState, type ReactElement } from 'react'
import { ExternalLink, Microscope, RefreshCw, ScrollText } from 'lucide-react'
import type { ErrorSource, ErrorTrackingIssue, Session } from '@shared/types'
import { useApp } from '../store'
import { Button, EmptyState, Vu } from '../lib/ui'
import { cn, statusColor, timeAgo } from '../lib/utils'
import LogViewer from '../components/LogViewer'

const SOURCES: Array<{ id: ErrorSource; label: string }> = [
  { id: 'frontend', label: 'Frontend' },
  { id: 'backend', label: 'Backend' }
]

const RANGES = [
  { days: 1, label: '24h' },
  { days: 7, label: '7d' },
  { days: 14, label: '14d' },
  { days: 30, label: '30d' }
]

function when(iso: string): string {
  return iso ? timeAgo(iso) : '—'
}

function ErrorRow({
  issue,
  session,
  onInvestigate,
  onLog
}: {
  issue: ErrorTrackingIssue
  session?: Session
  onInvestigate: () => void
  onLog: () => void
}): ReactElement {
  const investigating = session?.status === 'running'
  return (
    <div
      className={cn(
        'hairline group flex items-center gap-3.5 rounded-xl border bg-ink-850 px-4 py-3 transition-colors hover:border-ink-600',
        investigating && 'border-brass-500/30'
      )}
    >
      <div className="min-w-0 flex-1">
        <button
          className="block max-w-full truncate font-mono text-[13px] font-bold text-ink-50 hover:text-brass-300"
          onClick={() => void window.sully.openExternal(issue.url)}
        >
          {issue.type}
        </button>
        <p className="selectable mt-0.5 truncate text-[12px] text-ink-300">
          {issue.message || 'no message'}
        </p>
        <p className="selectable mt-0.5 font-mono text-[10.5px] text-ink-400">
          first seen {when(issue.firstSeen)} · last seen {when(issue.lastSeen)}
          {session && !investigating && (
            <span className={cn('ml-1.5', statusColor[session.status])}>
              · investigation {session.status}
            </span>
          )}
        </p>
      </div>

      <div className="w-[64px] shrink-0 text-right">
        <p className="font-mono text-[15px] font-bold text-terra-400">
          {issue.occurrences.toLocaleString()}
        </p>
        <p className="text-[10px] uppercase tracking-wide text-ink-400">events</p>
      </div>
      <div className="w-[64px] shrink-0 text-right">
        <p className="font-mono text-[15px] font-bold text-ink-100">
          {issue.users.toLocaleString()}
        </p>
        <p className="text-[10px] uppercase tracking-wide text-ink-400">users</p>
      </div>

      <div className="flex shrink-0 items-center gap-1">
        {investigating ? (
          <Vu />
        ) : (
          <Button onClick={onInvestigate} title="Spawn an agent to root-cause this error">
            <Microscope size={12} />
          </Button>
        )}
        {session && (
          <Button onClick={onLog} title="View investigation log">
            <ScrollText size={12} />
          </Button>
        )}
        <Button onClick={() => void window.sully.openExternal(issue.url)} title="Open in PostHog">
          <ExternalLink size={12} />
        </Button>
      </div>
    </div>
  )
}

interface FetchResult {
  key: string
  issues: ErrorTrackingIssue[]
  error: string | null
}

/** error identity for tracking investigations — issue id when grouped, else type+message */
function errKey(issue: ErrorTrackingIssue): string {
  return issue.id || `${issue.type}|${issue.message}`
}

export default function ErrorsView(): ReactElement {
  const {
    settings,
    credentials,
    setView,
    sessions,
    pushToast,
    logSessionId,
    logView,
    openLog,
    closeLog
  } = useApp()
  const [source, setSource] = useState<ErrorSource>('frontend')
  const [days, setDays] = useState(7)
  const [result, setResult] = useState<FetchResult | null>(null)
  const [refreshSeq, setRefreshSeq] = useState(0)
  // error key -> spawned investigation session id (this app run only)
  const [investigations, setInvestigations] = useState<Record<string, string>>({})

  const keySet = credentials?.posthogKeySet ?? false
  const cfg = settings?.errorTracking
  const projectId =
    (source === 'frontend' ? cfg?.frontendProjectId : cfg?.backendProjectId)?.trim() ?? ''
  const configured = keySet && projectId !== ''

  // one fetch per key; a stale key means the fetch for the current view is in flight
  const key = `${source}:${days}:${projectId}:${refreshSeq}`

  useEffect(() => {
    if (!configured) return
    let stale = false
    window.sully
      .listErrors(source, days)
      .then((issues) => {
        if (!stale) setResult({ key, issues, error: null })
      })
      .catch((err: unknown) => {
        if (stale) return
        const raw = err instanceof Error ? err.message : String(err)
        // strip electron's invoke wrapper so the user sees the actual reason
        const error = raw.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
        setResult({ key, issues: [], error })
      })
    return () => {
      stale = true
    }
  }, [configured, source, days, key])

  const current = result?.key === key ? result : null
  const loading = configured && !current
  const issues = current?.issues ?? []
  const error = current?.error ?? null

  const rangeLabel = RANGES.find((r) => r.days === days)?.label ?? `${days}d`

  async function investigate(issue: ErrorTrackingIssue): Promise<void> {
    try {
      const session = await window.sully.investigateError(source, issue)
      setInvestigations((m) => ({ ...m, [errKey(issue)]: session.id }))
      pushToast('success', `Investigating ${issue.type}`)
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err)
      pushToast('error', raw.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))
    }
  }

  const logSession = logView === 'errors' && logSessionId ? sessions[logSessionId] : null

  return (
    <div className="fade-up">
      <div className="mb-6 flex items-end justify-between">
        <div>
          <h1 className="font-display text-[26px] text-ink-50">Errors</h1>
          <p className="text-[12px] text-ink-400">
            error tracking from PostHog — top issues by volume, {rangeLabel} window
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="hairline flex items-center gap-0.5 rounded-lg border bg-ink-900 p-0.5">
            {RANGES.map((r) => (
              <button
                key={r.days}
                onClick={() => setDays(r.days)}
                className={cn(
                  'rounded-md px-2 py-1 font-mono text-[11px] transition-colors',
                  days === r.days ? 'bg-ink-700 text-ink-50' : 'text-ink-400 hover:text-ink-200'
                )}
              >
                {r.label}
              </button>
            ))}
          </div>
          <Button
            onClick={() => setRefreshSeq((n) => n + 1)}
            disabled={loading || !configured}
            title="Refresh"
          >
            <RefreshCw size={12} className={cn(loading && 'animate-spin')} />
          </Button>
        </div>
      </div>

      <div className="mb-4 flex items-center gap-1.5">
        {SOURCES.map((s) => (
          <button
            key={s.id}
            onClick={() => setSource(s.id)}
            className={cn(
              'rounded-lg px-3 py-1.5 text-[12.5px] font-bold transition-colors',
              source === s.id
                ? 'bg-ink-700 text-ink-50'
                : 'text-ink-400 hover:bg-ink-800 hover:text-ink-200'
            )}
          >
            {s.label}
          </button>
        ))}
      </div>

      {!keySet ? (
        <>
          <EmptyState
            title="PostHog is not connected."
            hint="Add a PostHog personal API key (with query read access) under Settings → Credentials to pull error tracking in."
          />
          <div className="flex justify-center">
            <Button variant="primary" onClick={() => setView('settings')}>
              Open Settings
            </Button>
          </div>
        </>
      ) : !projectId && source === 'backend' ? (
        <EmptyState
          title="Backend errors are not here yet."
          hint="The backend is still migrating to PostHog error tracking. Once it lands, add the backend project ID under Settings → Error tracking and this tab lights up."
        />
      ) : !projectId ? (
        <EmptyState
          title="No frontend project configured."
          hint="Set the frontend PostHog project ID under Settings → Error tracking."
        />
      ) : error ? (
        <div className="hairline rounded-xl border border-terra-500/30 bg-terra-500/5 px-4 py-3">
          <p className="text-[12.5px] font-bold text-terra-400">Could not load errors</p>
          <p className="selectable mt-0.5 font-mono text-[11px] text-ink-300">{error}</p>
        </div>
      ) : loading ? (
        <p className="breathe py-16 text-center font-display text-[18px] text-ink-300">
          listening for trouble…
        </p>
      ) : issues.length === 0 ? (
        <EmptyState
          title="No errors in this window."
          hint={`Nothing hit ${source === 'frontend' ? 'the frontend' : 'the backend'} in the last ${rangeLabel}. Either it's a good day or nobody's using it.`}
        />
      ) : (
        <div className="flex flex-col gap-2.5">
          {issues.map((i) => {
            const sessionId = investigations[errKey(i)]
            return (
              <ErrorRow
                key={errKey(i)}
                issue={i}
                session={sessionId ? sessions[sessionId] : undefined}
                onInvestigate={() => void investigate(i)}
                onLog={() => sessionId && openLog(sessionId)}
              />
            )
          })}
        </div>
      )}

      {logSession && <LogViewer session={logSession} onClose={closeLog} />}
    </div>
  )
}
