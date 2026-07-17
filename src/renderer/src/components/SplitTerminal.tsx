import { useState, type KeyboardEvent, type PointerEvent, type ReactElement } from 'react'
import { useApp } from '../store'
import { cn } from '../lib/utils'
import {
  findLeaf,
  leafInfos,
  leafNode,
  type SplitDirection,
  type SplitNode
} from '../lib/splitTree'
import TerminalPane from './TerminalPane'

/**
 * A terminal tab's split layout: one pty, or a tree of panes built with
 * ⌘D (side by side) and ⌘⇧D (stacked) on the focused pane. Layouts live in
 * the store keyed by the root terminal id, so the same splits render wherever
 * that terminal appears (Terminal view tab, ticket panel, chat dialog).
 */
export default function SplitTerminal({
  rootId,
  active
}: {
  rootId: string
  active: boolean
}): ReactElement | null {
  const stored = useApp((s) => s.splitLayouts[rootId])
  const rootInfo = useApp((s) => s.termTabs.find((t) => t.id === rootId))
  const layout = stored ?? (rootInfo ? leafNode(rootInfo) : null)
  const [wantedFocus, setFocusedId] = useState(rootId)

  if (!layout) return null

  // the focused pane can exit (or the root can be promoted away) under us
  const paneIds = leafInfos(layout).map((i) => i.id)
  const focusedId = paneIds.includes(wantedFocus) ? wantedFocus : (paneIds[0] ?? rootId)

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (!e.metaKey || e.ctrlKey || e.altKey || e.key.toLowerCase() !== 'd') return
    e.preventDefault()
    e.stopPropagation()
    const direction: SplitDirection = e.shiftKey ? 'column' : 'row'
    void useApp
      .getState()
      .splitTerm(rootId, findLeaf(layout, focusedId) ? focusedId : rootId, direction)
      .then((newId) => {
        if (newId) setFocusedId(newId)
      })
  }

  return (
    <div className={active ? 'h-full w-full' : 'hidden'} onKeyDown={onKeyDown}>
      <NodeView
        node={layout}
        rootId={rootId}
        visible={active}
        focusedId={focusedId}
        onFocusPane={setFocusedId}
      />
    </div>
  )
}

function NodeView({
  node,
  rootId,
  visible,
  focusedId,
  onFocusPane
}: {
  node: SplitNode
  rootId: string
  visible: boolean
  focusedId: string
  onFocusPane: (id: string) => void
}): ReactElement {
  if (node.type === 'leaf') {
    return (
      <div
        className="h-full w-full min-h-0 min-w-0"
        onFocusCapture={() => onFocusPane(node.info.id)}
      >
        <TerminalPane
          id={node.info.id}
          visible={visible}
          focused={visible && focusedId === node.info.id}
        />
      </div>
    )
  }
  const isRow = node.direction === 'row'
  return (
    <div className={cn('flex h-full w-full min-h-0 min-w-0', isRow ? 'flex-row' : 'flex-col')}>
      <div className="min-h-0 min-w-0" style={{ flexBasis: 0, flexGrow: node.ratio }}>
        <NodeView
          node={node.children[0]}
          rootId={rootId}
          visible={visible}
          focusedId={focusedId}
          onFocusPane={onFocusPane}
        />
      </div>
      <Divider
        direction={node.direction}
        onRatio={(r) => useApp.getState().setSplitRatio(rootId, node.id, r)}
      />
      <div className="min-h-0 min-w-0" style={{ flexBasis: 0, flexGrow: 1 - node.ratio }}>
        <NodeView
          node={node.children[1]}
          rootId={rootId}
          visible={visible}
          focusedId={focusedId}
          onFocusPane={onFocusPane}
        />
      </div>
    </div>
  )
}

function Divider({
  direction,
  onRatio
}: {
  direction: SplitDirection
  onRatio: (ratio: number) => void
}): ReactElement {
  const isRow = direction === 'row'
  const onPointerMove = (e: PointerEvent<HTMLDivElement>): void => {
    if (!e.currentTarget.hasPointerCapture(e.pointerId)) return
    const parent = e.currentTarget.parentElement
    if (!parent) return
    const rect = parent.getBoundingClientRect()
    const ratio = isRow
      ? (e.clientX - rect.left) / rect.width
      : (e.clientY - rect.top) / rect.height
    onRatio(Math.min(0.85, Math.max(0.15, ratio)))
  }
  return (
    <div
      className={cn(
        'shrink-0 rounded-full bg-ink-700/60 transition-colors duration-150 hover:bg-brass-400/60 active:bg-brass-400',
        isRow ? 'mx-1 w-[3px] cursor-col-resize' : 'my-1 h-[3px] cursor-row-resize'
      )}
      onPointerDown={(e) => {
        e.preventDefault()
        e.currentTarget.setPointerCapture(e.pointerId)
      }}
      onPointerMove={onPointerMove}
    />
  )
}
