import { useRef, useState, type ReactElement, type ReactNode } from 'react'
import { PanelBottom, PanelLeft, PanelRight, PanelTop } from 'lucide-react'
import { cn } from '../lib/utils'
import { DragHandle } from './DockablePanel'

export type DockSide = 'top' | 'right' | 'bottom' | 'left'

export interface DockLayout {
  side: DockSide
  /** px when docked left/right */
  width: number
  /** px when docked top/bottom */
  height: number
}

function loadLayout(key: string, fallback: DockLayout): DockLayout {
  try {
    const raw = localStorage.getItem(key)
    if (raw) return { ...fallback, ...(JSON.parse(raw) as Partial<DockLayout>) }
  } catch {
    // corrupt entry — fall back to defaults
  }
  return { ...fallback }
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v))

const SIDES = [
  { side: 'top', icon: PanelTop, label: 'Move the pane to the top' },
  { side: 'right', icon: PanelRight, label: 'Move the pane to the right' },
  { side: 'bottom', icon: PanelBottom, label: 'Move the pane to the bottom' },
  { side: 'left', icon: PanelLeft, label: 'Move the pane to the left' }
] as const

/**
 * Dockable side pane for dialogs: wraps the dialog's main content and, when
 * open, attaches `pane` to its top, right, bottom, or left. The side switcher
 * lives in the pane's own header bar and the edge facing the content
 * drag-resizes. Side + sizes persist per storageKey in localStorage.
 */
export default function Dock({
  open,
  label,
  storageKey,
  fallback,
  headerActions,
  pane,
  children
}: {
  open: boolean
  label: string
  storageKey: string
  fallback: DockLayout
  /** extra buttons rendered in the pane header, before the side switcher */
  headerActions?: ReactNode
  pane: ReactNode
  children: ReactNode
}): ReactElement {
  const [layout, setLayout] = useState<DockLayout>(() => loadLayout(storageKey, fallback))
  const dragFrom = useRef(layout)

  const update = (patch: Partial<DockLayout>): void =>
    setLayout((prev) => {
      const next = { ...prev, ...patch }
      try {
        localStorage.setItem(storageKey, JSON.stringify(next))
      } catch {
        // quota/private-mode failures just lose persistence, not the resize
      }
      return next
    })

  const { side } = layout
  const horizontal = side === 'left' || side === 'right'
  const before = side === 'top' || side === 'left'

  const resize = (dx: number, dy: number): void => {
    const from = dragFrom.current
    if (horizontal)
      update({
        width: clamp(side === 'left' ? from.width + dx : from.width - dx, 280, window.innerWidth)
      })
    else
      update({
        height: clamp(side === 'top' ? from.height + dy : from.height - dy, 160, window.innerHeight)
      })
  }

  return (
    <div className={cn('flex min-h-0 min-w-0 flex-1', horizontal ? 'flex-row' : 'flex-col')}>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">{children}</div>
      {open && (
        <div
          style={horizontal ? { width: layout.width } : { height: layout.height }}
          className={cn(
            'hairline relative flex shrink-0 flex-col overflow-hidden',
            // the modal itself is resizable — never let the pane squeeze the
            // content out entirely
            horizontal ? 'max-w-[75%]' : 'max-h-[75%]',
            before ? 'order-first' : 'order-last',
            side === 'bottom' && 'border-t',
            side === 'top' && 'border-b',
            side === 'right' && 'border-l',
            side === 'left' && 'border-r'
          )}
        >
          <div className="hairline flex shrink-0 items-center justify-between border-b bg-ink-900 px-3 py-1.5">
            <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-400">
              {label}
            </span>
            <div className="flex items-center gap-1.5">
              {headerActions}
              <div className="hairline flex overflow-hidden rounded-lg border">
                {SIDES.map(({ side: s, icon: Icon, label: sideLabel }) => (
                  <button
                    key={s}
                    onClick={() => update({ side: s })}
                    title={sideLabel}
                    className={cn(
                      'px-2 py-1 transition-colors duration-150',
                      side === s
                        ? 'bg-ink-700 text-ink-50'
                        : 'text-ink-400 hover:bg-ink-800 hover:text-ink-100'
                    )}
                  >
                    <Icon size={12} strokeWidth={1.8} />
                  </button>
                ))}
              </div>
            </div>
          </div>
          <div className="relative min-h-0 min-w-0 flex-1">{pane}</div>
          <DragHandle
            className={cn(
              'absolute z-10',
              side === 'bottom' && 'inset-x-0 top-0 h-[5px] cursor-row-resize',
              side === 'top' && 'inset-x-0 bottom-0 h-[5px] cursor-row-resize',
              side === 'right' && 'inset-y-0 left-0 w-[5px] cursor-col-resize',
              side === 'left' && 'inset-y-0 right-0 w-[5px] cursor-col-resize'
            )}
            onStart={() => (dragFrom.current = layout)}
            onMove={resize}
          />
        </div>
      )}
    </div>
  )
}
