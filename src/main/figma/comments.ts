import { getFigmaToken } from '../credentials'
import type { FigmaCommentItem, FigmaLink } from '../../shared/types'

/** figma.com/design/:key/:name and figma.com/file/:key/:name, with optional query */
const FIGMA_URL_RE =
  /https:\/\/(?:www\.)?figma\.com\/(?:design|file)\/([A-Za-z0-9]{10,})(?:\/([^\s?#)\]>"']*))?(?:\?[^\s)\]>"']*)?/g

const NODE_ID_RE = /[?&]node-id=([0-9]+(?:-|%3A|:)[0-9]+)/i

/**
 * Figma file links found in markdown text (ticket description or a Linear
 * comment body), deduped by file key — the first URL for a key wins.
 */
export function parseFigmaLinks(text: string, source: FigmaLink['source']): FigmaLink[] {
  const links: FigmaLink[] = []
  const seen = new Set<string>()
  for (const m of text.matchAll(FIGMA_URL_RE)) {
    const [url, fileKey, slug] = m
    if (seen.has(fileKey)) continue
    seen.add(fileKey)
    const node = NODE_ID_RE.exec(url)?.[1]
    links.push({
      fileKey,
      fileName: slug ? decodeURIComponent(slug).replace(/-/g, ' ') || undefined : undefined,
      nodeId: node ? node.replace(/-|%3A/i, ':') : undefined,
      url,
      source
    })
  }
  return links
}

/** Deep link to a comment's pin — falls back to the node's frame if the fragment format drifts. */
export function figmaCommentUrl(c: Pick<FigmaCommentItem, 'fileKey' | 'nodeId' | 'id'>): string {
  const node = c.nodeId ? `?node-id=${c.nodeId.replace(':', '-')}` : ''
  return `https://www.figma.com/design/${c.fileKey}${node}#${c.id}`
}

interface FigmaApiComment {
  id: string
  message?: string
  user?: { handle?: string }
  created_at?: string
  resolved_at?: string | null
  parent_id?: string
  order_id?: string | null
  client_meta?: { node_id?: string } | null
}

/** One comments fetch per file per TTL window, however many tickets share the file. */
const cache = new Map<string, { data: FigmaCommentItem[]; fetchedAt: number }>()
const CACHE_TTL_MS = 5 * 60_000
const MAX_ITEMS = 100

interface FigmaNode {
  id: string
  children?: FigmaNode[]
}

const subtreeCache = new Map<string, { ids: Set<string>; fetchedAt: number }>()

/**
 * All node ids inside a node's subtree — used to filter a file's comments to
 * the frame a link's node-id points at (the comments endpoint is file-wide).
 * Same TTL cache as comments. null on failure, so callers can fall back to
 * the unfiltered list instead of showing nothing.
 */
export async function fetchNodeSubtreeIds(
  fileKey: string,
  nodeId: string,
  force = false
): Promise<Set<string> | null> {
  const key = `${fileKey}:${nodeId}`
  const hit = subtreeCache.get(key)
  if (!force && hit && Date.now() - hit.fetchedAt < CACHE_TTL_MS) return hit.ids
  const token = getFigmaToken()
  if (!token) return null
  try {
    const res = await fetch(
      `https://api.figma.com/v1/files/${fileKey}/nodes?ids=${encodeURIComponent(nodeId)}`,
      // node payloads can be large for page-sized frames — allow a longer wait
      { headers: { 'X-Figma-Token': token }, signal: AbortSignal.timeout(30_000) }
    )
    if (!res.ok) return null
    const body = (await res.json()) as {
      nodes?: Record<string, { document?: FigmaNode } | null>
    }
    const root = body.nodes?.[nodeId]?.document
    if (!root) return null
    const ids = new Set<string>()
    const walk = (n: FigmaNode): void => {
      ids.add(n.id)
      for (const c of n.children ?? []) walk(c)
    }
    walk(root)
    subtreeCache.set(key, { ids, fetchedAt: Date.now() })
    return ids
  } catch {
    return null
  }
}

/**
 * Top-level comment threads on a Figma file, newest-first, replies flattened
 * into the root message as "> handle: text" blockquotes (same shape as
 * prReviewComments, so the addressedAt merge semantics match). null on a
 * missing token or fetch failure, so callers keep their last known list.
 */
export async function fetchFigmaComments(
  fileKey: string,
  force = false
): Promise<FigmaCommentItem[] | null> {
  const hit = cache.get(fileKey)
  if (!force && hit && Date.now() - hit.fetchedAt < CACHE_TTL_MS) return hit.data
  const token = getFigmaToken()
  if (!token) return null
  try {
    const res = await fetch(`https://api.figma.com/v1/files/${fileKey}/comments`, {
      headers: { 'X-Figma-Token': token },
      signal: AbortSignal.timeout(15_000)
    })
    if (!res.ok) return null
    const body = (await res.json()) as { comments?: FigmaApiComment[] }
    const all = body.comments ?? []
    const roots = all.filter((c) => !c.parent_id)
    const items: FigmaCommentItem[] = roots.map((root) => {
      const replies = all
        .filter((c) => c.parent_id === root.id)
        .map((c) => `\n\n> ${c.user?.handle ?? 'reply'}: ${c.message ?? ''}`)
        .join('')
      return {
        id: root.id,
        fileKey,
        author: root.user?.handle,
        message: (root.message ?? '') + replies,
        createdAt: root.created_at,
        resolvedAt: root.resolved_at ?? undefined,
        orderId: root.order_id ?? undefined,
        nodeId: root.client_meta?.node_id ?? undefined
      }
    })
    items.sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''))
    const data = items.slice(0, MAX_ITEMS)
    cache.set(fileKey, { data, fetchedAt: Date.now() })
    return data
  } catch {
    return null
  }
}
