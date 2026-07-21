import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactElement,
  type ReactNode
} from 'react'
import { createPortal } from 'react-dom'
import { AppWindow, Maximize2, Minimize2, PanelBottom, PanelRight } from 'lucide-react'
import { cn } from '../lib/utils'
import { useApp } from '../store'

export type DockMode = 'modal' | 'sidebar' | 'bottom'

interface PanelLayout {
  mode: DockMode
  sidebarWidth: number
  bottomHeight: number
  /** null = the dialog's default CSS size, until the user drags the corner */
  modalWidth: number | null
  modalHeight: number | null
}

/** docked panels default to half the window; sized at open, px once dragged */
const fallbackLayout = (): PanelLayout => ({
  mode: 'modal',
  sidebarWidth: Math.round(window.innerWidth / 2),
  bottomHeight: Math.round(window.innerHeight / 2),
  modalWidth: null,
  modalHeight: null
})

const layoutKey = (id: string): string => `sully:panel-layout:${id}`

function loadLayout(id: string): PanelLayout {
  const fallback = fallbackLayout()
  try {
    const raw = localStorage.getItem(layoutKey(id))
    if (raw) {
      const stored = JSON.parse(raw) as Partial<PanelLayout>
      // the pre-half-view defaults were fixed pixels and got persisted on any
      // layout write (e.g. a mode switch) — treat them as never customized
      if (stored.sidebarWidth === 480) delete stored.sidebarWidth
      if (stored.bottomHeight === 360) delete stored.bottomHeight
      return { ...fallback, ...stored }
    }
  } catch {
    // corrupt entry — fall back to defaults
  }
  return fallback
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v))

const DockContext = createContext<{
  mode: DockMode
  setMode: (m: DockMode) => void
  fullscreen: boolean
  toggleFullscreen: () => void
} | null>(null)

const MODES = [
  { mode: 'modal', icon: AppWindow, label: 'Modal' },
  { mode: 'sidebar', icon: PanelRight, label: 'Dock to the right' },
  { mode: 'bottom', icon: PanelBottom, label: 'Dock to the bottom' }
] as const

/** Mode switcher for a dialog header — must live inside a DockablePanel. */
export function DockControls(): ReactElement | null {
  const ctx = useContext(DockContext)
  if (!ctx) return null
  return (
    <div className="flex shrink-0 items-center gap-2">
      <div className="hairline flex overflow-hidden rounded-lg border">
        {MODES.map(({ mode, icon: Icon, label }) => (
          <button
            key={mode}
            onClick={() => ctx.setMode(mode)}
            title={label}
            className={cn(
              'px-2 py-1.5 transition-colors duration-150',
              !ctx.fullscreen && ctx.mode === mode
                ? 'bg-ink-700 text-ink-50'
                : 'text-ink-400 hover:bg-ink-800 hover:text-ink-100'
            )}
          >
            <Icon size={13} strokeWidth={1.8} />
          </button>
        ))}
      </div>
      <button
        onClick={ctx.toggleFullscreen}
        title={ctx.fullscreen ? 'Exit full screen' : 'Full screen'}
        className={cn(
          'rounded-lg p-1.5 transition-colors duration-150',
          ctx.fullscreen
            ? 'bg-ink-700 text-ink-50'
            : 'text-ink-400 hover:bg-ink-800 hover:text-ink-100'
        )}
      >
        {ctx.fullscreen ? (
          <Minimize2 size={13} strokeWidth={1.8} />
        ) : (
          <Maximize2 size={13} strokeWidth={1.8} />
        )}
      </button>
    </div>
  )
}

export function DragHandle({
  className,
  onStart,
  onMove
}: {
  className: string
  onStart: () => void
  /** deltas are from the pointer-down position */
  onMove: (dx: number, dy: number) => void
}): ReactElement {
  const start = useRef({ x: 0, y: 0 })
  const [dragging, setDragging] = useState(false)
  return (
    <>
      <div
        className={cn(
          'transition-colors duration-150 hover:bg-brass-400/60 active:bg-brass-400',
          className
        )}
        onPointerDown={(e) => {
          e.preventDefault()
          start.current = { x: e.clientX, y: e.clientY }
          onStart()
          setDragging(true)
          e.currentTarget.setPointerCapture(e.pointerId)
        }}
        onPointerMove={(e) => {
          if (!e.currentTarget.hasPointerCapture(e.pointerId)) return
          onMove(e.clientX - start.current.x, e.clientY - start.current.y)
        }}
        onPointerUp={() => setDragging(false)}
        onLostPointerCapture={() => setDragging(false)}
      />
      {dragging &&
        // webview guests swallow pointer events routed over their bounds (the
        // embedder's pointer capture never sees them), freezing the drag the
        // moment the cursor crosses a webview — shield the app while dragging
        createPortal(<div className="fixed inset-0 z-[999]" />, document.body)}
    </>
  )
}

/**
 * Frame for the app's dialogs: renders its children as a centered modal, a
 * right-docked sidebar, or a bottom-docked bar, switched live via
 * <DockControls /> in the dialog's header. Every mode is drag-resizable and
 * the chosen mode + sizes persist per panel id in localStorage (deliberately
 * not in AppSettings — writing settings kicks an orchestrator poll).
 *
 * Docked modes portal into the #dock-right / #dock-bottom slots in App.tsx so
 * the board shrinks instead of being covered. Modal mode portals to
 * document.body: ancestors animate with transforms, which would otherwise
 * become the containing block for the fixed overlay and collapse its height.
 */
export default function DockablePanel({
  id,
  modalClassName,
  minWidth = 480,
  minHeight = 360,
  onClose,
  children
}: {
  /** stable key the panel's layout is persisted under */
  id: string
  /** default modal sizing classes, used until the user resizes the modal */
  modalClassName: string
  minWidth?: number
  minHeight?: number
  /** dismiss on backdrop click — modal mode only, docked modes have no backdrop */
  onClose?: () => void
  children: ReactNode
}): ReactElement {
  const [layout, setLayout] = useState<PanelLayout>(() => loadLayout(id))
  const dragFrom = useRef<PanelLayout>(layout)
  const panelRef = useRef<HTMLDivElement>(null)

  const isFullscreen = useApp((s) => s.fullscreen === id)
  const setFullscreen = useApp((s) => s.setFullscreen)

  // if this panel is closed while still maximized, clear the global fullscreen
  // flag it owns — otherwise the sidebar stays pinned shut after it unmounts
  useEffect(() => {
    return () => {
      if (useApp.getState().fullscreen === id) useApp.getState().setFullscreen(null)
    }
  }, [id])

  const update = (patch: Partial<PanelLayout>): void =>
    setLayout((prev) => {
      const next = { ...prev, ...patch }
      try {
        localStorage.setItem(layoutKey(id), JSON.stringify(next))
      } catch {
        // quota/private-mode failures just lose persistence, not the resize
      }
      return next
    })

  const ctx = {
    mode: layout.mode,
    // picking a dock mode also restores from full screen into that mode
    setMode: (mode: DockMode) => {
      update({ mode })
      if (isFullscreen) setFullscreen(null)
    },
    fullscreen: isFullscreen,
    toggleFullscreen: () => setFullscreen(isFullscreen ? null : id)
  }
  const body = <DockContext.Provider value={ctx}>{children}</DockContext.Provider>

  // full screen wins over the dock mode: a borderless overlay filling the
  // window below the 52px titlebar and right of the collapsed sidebar rail
  if (isFullscreen) {
    return createPortal(
      <div className="fixed bottom-0 left-[72px] right-0 top-[52px] z-[60] flex flex-col overflow-hidden bg-ink-900">
        {body}
      </div>,
      document.body
    )
  }

  if (layout.mode === 'sidebar') {
    return createPortal(
      <div
        // flex-basis (not width) + shrink: several docked panels must share the
        // window instead of pushing each other offscreen
        style={{ flexBasis: Math.min(layout.sidebarWidth, window.innerWidth * 0.75) }}
        className="hairline-strong relative flex h-full min-h-0 min-w-[320px] shrink flex-col overflow-hidden border-l bg-ink-900"
      >
        <DragHandle
          className="absolute inset-y-0 left-0 z-10 w-[5px] cursor-col-resize"
          onStart={() => (dragFrom.current = layout)}
          onMove={(dx) =>
            update({
              sidebarWidth: clamp(dragFrom.current.sidebarWidth - dx, 320, window.innerWidth * 0.75)
            })
          }
        />
        {body}
      </div>,
      document.getElementById('dock-right') ?? document.body
    )
  }

  if (layout.mode === 'bottom') {
    return createPortal(
      <div
        style={{ flexBasis: Math.min(layout.bottomHeight, window.innerHeight * 0.8) }}
        className="hairline-strong relative flex w-full min-h-[160px] min-w-0 shrink flex-col overflow-hidden border-t bg-ink-900"
      >
        <DragHandle
          className="absolute inset-x-0 top-0 z-10 h-[5px] cursor-row-resize"
          onStart={() => (dragFrom.current = layout)}
          onMove={(_dx, dy) =>
            update({
              bottomHeight: clamp(dragFrom.current.bottomHeight - dy, 160, window.innerHeight * 0.8)
            })
          }
        />
        {body}
      </div>,
      document.getElementById('dock-bottom') ?? document.body
    )
  }

  return createPortal(
    <div
      // pointerdown (not click) so a drag that starts inside the panel and
      // ends on the backdrop — e.g. selecting text — doesn't dismiss it
      onPointerDown={(e) => {
        if (onClose && e.target === e.currentTarget) onClose()
      }}
      className="fixed inset-0 z-[60] flex items-center justify-center bg-ink-950/80 p-10 backdrop-blur-sm"
    >
      <div
        ref={panelRef}
        style={{
          width: layout.modalWidth ? `min(${layout.modalWidth}px, 92vw)` : undefined,
          height: layout.modalHeight ? `min(${layout.modalHeight}px, 92vh)` : undefined
        }}
        className={cn(
          'fade-up hairline-strong relative flex flex-col overflow-hidden rounded-2xl border bg-ink-900 shadow-2xl',
          modalClassName
        )}
      >
        {body}
        <DragHandle
          className="absolute bottom-0 right-0 z-10 h-4 w-4 cursor-nwse-resize rounded-tl-lg"
          onStart={() => {
            const rect = panelRef.current?.getBoundingClientRect()
            dragFrom.current = {
              ...layout,
              modalWidth: rect?.width ?? minWidth,
              modalHeight: rect?.height ?? minHeight
            }
          }}
          onMove={(dx, dy) =>
            // the modal is centered, so each edge moves at half the pointer
            // speed — scale by 2 to keep the corner under the cursor
            update({
              modalWidth: clamp(
                (dragFrom.current.modalWidth ?? minWidth) + dx * 2,
                minWidth,
                window.innerWidth - 80
              ),
              modalHeight: clamp(
                (dragFrom.current.modalHeight ?? minHeight) + dy * 2,
                minHeight,
                window.innerHeight - 80
              )
            })
          }
        />
      </div>
    </div>,
    document.body
  )
}
