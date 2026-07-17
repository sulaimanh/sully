import type { ErrorSource, ErrorTrackingIssue } from '../../shared/types'
import { settingsStore } from '../settings'
import { normalizeHost, posthogHogQL, PosthogError } from './client'

// Aggregates $exception events by PostHog's error-tracking issue id via HogQL
// over the events table (the stable API surface, unlike the internal
// ErrorTrackingQuery kind). Falls back to the flat $exception_types/_values
// arrays for events missing $exception_list.

function toIso(v: unknown): string {
  const d = new Date(String(v ?? '').replace(' ', 'T'))
  return Number.isNaN(d.getTime()) ? '' : d.toISOString()
}

export async function fetchErrorIssues(
  source: ErrorSource,
  days: number
): Promise<ErrorTrackingIssue[]> {
  const { host, frontendProjectId, backendProjectId } = settingsStore.get().errorTracking
  const projectId = (source === 'frontend' ? frontendProjectId : backendProjectId).trim()
  if (!projectId) {
    throw new PosthogError(
      source === 'backend'
        ? 'Backend errors are not in PostHog yet — set the backend project ID in Settings once the migration lands'
        : 'No PostHog project ID configured for frontend errors — set it in Settings'
    )
  }

  const windowDays = Math.min(90, Math.max(1, Math.floor(days) || 7))
  const rows = await posthogHogQL(
    host,
    projectId,
    `SELECT
       coalesce(properties.$exception_issue_id, '') AS issue_id,
       any(coalesce(nullIf(JSONExtractString(properties.$exception_list, 1, 'type'), ''), nullIf(JSONExtractString(properties.$exception_types, 1), ''), 'Error')) AS type,
       any(coalesce(nullIf(JSONExtractString(properties.$exception_list, 1, 'value'), ''), nullIf(JSONExtractString(properties.$exception_values, 1), ''), '')) AS message,
       count() AS occurrences,
       count(DISTINCT distinct_id) AS users,
       min(timestamp) AS first_seen,
       max(timestamp) AS last_seen
     FROM events
     WHERE event = '$exception' AND timestamp >= now() - INTERVAL ${windowDays} DAY
     GROUP BY issue_id
     ORDER BY occurrences DESC
     LIMIT 100`
  )

  const base = normalizeHost(host)
  return rows.map((r) => {
    const id = String(r[0] ?? '')
    return {
      id,
      type: String(r[1] ?? 'Error'),
      message: String(r[2] ?? ''),
      occurrences: Number(r[3] ?? 0),
      users: Number(r[4] ?? 0),
      firstSeen: toIso(r[5]),
      lastSeen: toIso(r[6]),
      url: id
        ? `${base}/project/${projectId}/error_tracking/${id}`
        : `${base}/project/${projectId}/error_tracking`
    }
  })
}
