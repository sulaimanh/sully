import { getPosthogApiKey } from '../credentials'

// Minimal PostHog Query API client, authed with a personal API key
// (needs query:read scope). Mirrors the Linear client's shape.

export class PosthogError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PosthogError'
  }
}

export function normalizeHost(host: string): string {
  return host.trim().replace(/\/+$/, '') || 'https://us.posthog.com'
}

interface HogQLQueryResponse {
  results?: unknown[][]
}

export async function posthogHogQL(
  host: string,
  projectId: string,
  query: string
): Promise<unknown[][]> {
  const key = getPosthogApiKey()
  if (!key) throw new PosthogError('PostHog personal API key not configured')

  const res = await fetch(
    `${normalizeHost(host)}/api/projects/${encodeURIComponent(projectId)}/query/`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ query: { kind: 'HogQLQuery', query } })
    }
  )

  if (!res.ok) {
    let detail = ''
    try {
      const body = (await res.json()) as { detail?: string; error?: string }
      detail = body.detail || body.error || ''
    } catch {
      // non-JSON error body — the status code is enough
    }
    throw new PosthogError(`PostHog request failed (${res.status})${detail ? `: ${detail}` : ''}`)
  }

  const body = (await res.json()) as HogQLQueryResponse
  return body.results ?? []
}
