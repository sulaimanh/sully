import type { TerminalInfo } from '@shared/types'

export type SplitDirection = 'row' | 'column'

/**
 * Binary split tree behind a terminal tab. A tab starts as a single leaf;
 * ⌘D/⌘⇧D replaces the focused leaf with a split holding it and a fresh pty.
 * Trees live in the store keyed by the tab's root terminal id, so the same
 * layout renders wherever that terminal appears.
 */
export type SplitNode =
  | { type: 'leaf'; info: TerminalInfo }
  | {
      type: 'split'
      id: string
      direction: SplitDirection
      /** fraction of the container given to the first child (0..1) */
      ratio: number
      children: [SplitNode, SplitNode]
    }

let splitSeq = 0

export function leafNode(info: TerminalInfo): SplitNode {
  return { type: 'leaf', info }
}

export function findLeaf(node: SplitNode, id: string): TerminalInfo | undefined {
  if (node.type === 'leaf') return node.info.id === id ? node.info : undefined
  return findLeaf(node.children[0], id) ?? findLeaf(node.children[1], id)
}

export function leafInfos(node: SplitNode): TerminalInfo[] {
  if (node.type === 'leaf') return [node.info]
  return [...leafInfos(node.children[0]), ...leafInfos(node.children[1])]
}

/** Replace the target leaf with a split of [target, new pane]. */
export function splitLeaf(
  node: SplitNode,
  targetId: string,
  direction: SplitDirection,
  newInfo: TerminalInfo
): SplitNode {
  if (node.type === 'leaf') {
    if (node.info.id !== targetId) return node
    return {
      type: 'split',
      id: `split-${++splitSeq}`,
      direction,
      ratio: 0.5,
      children: [node, leafNode(newInfo)]
    }
  }
  return {
    ...node,
    children: [
      splitLeaf(node.children[0], targetId, direction, newInfo),
      splitLeaf(node.children[1], targetId, direction, newInfo)
    ]
  }
}

/** Remove a leaf; a split left with one child collapses to the sibling. Null when the last leaf goes. */
export function removeLeaf(node: SplitNode, targetId: string): SplitNode | null {
  if (node.type === 'leaf') return node.info.id === targetId ? null : node
  const a = removeLeaf(node.children[0], targetId)
  const b = removeLeaf(node.children[1], targetId)
  if (a && b)
    return a === node.children[0] && b === node.children[1] ? node : { ...node, children: [a, b] }
  return a ?? b
}

export function setRatio(node: SplitNode, splitId: string, ratio: number): SplitNode {
  if (node.type === 'leaf') return node
  if (node.id === splitId) return { ...node, ratio }
  return {
    ...node,
    children: [
      setRatio(node.children[0], splitId, ratio),
      setRatio(node.children[1], splitId, ratio)
    ]
  }
}
