import { getLinearApiKey } from '../credentials'

const ENDPOINT = 'https://api.linear.app/graphql'

export class LinearError extends Error {
  constructor(
    message: string,
    public readonly rateLimited = false
  ) {
    super(message)
  }
}

let backoffUntil = 0

/**
 * GraphQL request with variables (never string interpolation) and 429 backoff.
 * Steady state is ~1 request per orchestrator poll, well under Linear's limit.
 */
export async function linearRequest<T>(
  query: string,
  variables: Record<string, unknown> = {}
): Promise<T> {
  const key = getLinearApiKey()
  if (!key) throw new LinearError('Linear API key not configured')
  if (Date.now() < backoffUntil) {
    throw new LinearError('Linear rate limited — backing off', true)
  }

  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: key },
    body: JSON.stringify({ query, variables })
  })

  if (res.status === 429) {
    const reset = Number(res.headers.get('X-RateLimit-Requests-Reset'))
    backoffUntil = Number.isFinite(reset) && reset > 0 ? reset : Date.now() + 5 * 60_000
    throw new LinearError('Linear rate limited (429)', true)
  }
  if (!res.ok) throw new LinearError(`Linear API ${res.status}: ${await res.text()}`)

  const body = (await res.json()) as { data?: T; errors?: Array<{ message: string }> }
  if (body.errors?.length) throw new LinearError(body.errors.map((e) => e.message).join('; '))
  if (!body.data) throw new LinearError('Linear API returned no data')
  return body.data
}
