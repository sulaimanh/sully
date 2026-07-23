import { useState, type ReactElement } from 'react'
import { ExternalLink, RotateCcw, ScrollText, Square, Trash2 } from 'lucide-react'
import type { ActiveReview } from '@shared/types'
import { call, useApp } from '../store'
import { Button, EmptyState, Toggle, Vu } from '../lib/ui'
import { cn, statusColor, timeAgo } from '../lib/utils'
import LogViewer from '../components/LogViewer'

const verdictStyle: Record<string, string> = {
  APPROVED: 'bg-sage-500/15 text-sage-400',
  CHANGES_REQUESTED: 'bg-terra-500/15 text-terra-400',
  COMMENTED: 'bg-mist-400/15 text-mist-400',
  DISMISSED: 'bg-ink-700 text-ink-300'
}

function ReviewRow({ review, onLog }: { review: ActiveReview; onLog: () => void }): ReactElement {
  return (
    <div
      className={cn(
        'hairline group flex items-center gap-3.5 rounded-xl border bg-ink-850 px-4 py-3 transition-colors hover:border-ink-600',
        review.status === 'reviewing' && 'border-brass-500/30'
      )}
    >
      <div className="w-5 shrink-0 text-center">
        {review.status === 'reviewing' ? (
          <Vu />
        ) : (
          <span className={cn('font-mono text-[14px]', statusColor[review.status])}>
            {review.status === 'done' ? '✓' : '✕'}
          </span>
        )}
      </div>

      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <button
            className="truncate text-[13px] font-bold text-ink-50 hover:text-brass-300"
            onClick={() => useApp.getState().openBrowser(review.url)}
          >
            {review.title}
          </button>
        </div>
        <p className="selectable mt-0.5 font-mono text-[10.5px] text-ink-400">
          {review.repository} #{review.number} · by {review.author} · {timeAgo(review.startedAt)}
          {review.error ? ` · ${review.error}` : ''}
        </p>
      </div>

      {review.verdict && (
        <span
          className={cn(
            'shrink-0 rounded px-2 py-0.5 font-mono text-[10px] font-bold uppercase',
            verdictStyle[review.verdict] ?? 'bg-ink-700 text-ink-200'
          )}
        >
          {review.verdict.replace('_', ' ')}
        </span>
      )}

      <div className="flex shrink-0 items-center gap-1">
        <Button onClick={() => useApp.getState().openBrowser(review.url)} title="Open PR">
          <ExternalLink size={12} />
        </Button>
        {review.sessionId && (
          <Button onClick={onLog} title="View review log">
            <ScrollText size={12} />
          </Button>
        )}
        {review.status === 'reviewing' ? (
          <Button
            variant="danger"
            onClick={() => void call(window.sully.stopReview(review.key))}
            title="Stop review"
          >
            <Square size={11} />
          </Button>
        ) : (
          <Button
            onClick={() =>
              void call(window.sully.retriggerReview(review.key), 'Review re-run started')
            }
            title="Re-run review"
          >
            <RotateCcw size={12} />
          </Button>
        )}
        <Button
          onClick={() => void call(window.sully.removeReview(review.key), 'Review removed')}
          title="Remove — won't be auto-reviewed again"
        >
          <Trash2 size={12} />
        </Button>
      </div>
    </div>
  )
}

export default function ReviewsView(): ReactElement {
  const { reviews, settings, sessions } = useApp()
  const [logSessionId, setLogSessionId] = useState<string | null>(null)
  const enabled = settings?.prWatcher.enabled ?? false

  const logSession = logSessionId ? sessions[logSessionId] : null

  return (
    <div className="fade-up">
      <div className="mb-6 flex items-end justify-between">
        <div>
          <h1 className="font-display text-[26px] text-ink-50">PR Reviews</h1>
          <p className="text-[12px] text-ink-400">
            auto-reviews PRs where you&apos;re requested or assigned — in your configured repos
          </p>
        </div>
        <div className="flex items-center gap-2.5">
          <span className={cn('text-[12px]', enabled ? 'text-brass-300' : 'text-ink-400')}>
            {enabled ? 'watching' : 'paused'}
          </span>
          <Toggle
            checked={enabled}
            onChange={(v) => void window.sully.reviewsSetEnabled(v)}
            label="Auto reviews"
          />
        </div>
      </div>

      {reviews.length === 0 ? (
        <EmptyState
          title={enabled ? 'Nothing needs your eyes.' : 'The watcher is paused.'}
          hint={
            enabled
              ? 'Open PRs where you are a requested reviewer or assignee will be reviewed automatically as they appear.'
              : 'Flip the toggle to start watching for PRs assigned to you. Reviews land directly on GitHub.'
          }
        />
      ) : (
        <div className="flex flex-col gap-2.5">
          {reviews.map((r) => (
            <ReviewRow key={r.key} review={r} onLog={() => setLogSessionId(r.sessionId ?? null)} />
          ))}
        </div>
      )}

      {logSession && <LogViewer session={logSession} onClose={() => setLogSessionId(null)} />}
    </div>
  )
}
