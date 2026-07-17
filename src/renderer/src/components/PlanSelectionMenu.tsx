import { useEffect, useRef, useState, type ReactElement, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { Eraser, ListPlus, MessageCircleQuestion, Send, Trash2 } from 'lucide-react'
import { cn } from '../lib/utils'

export interface PlanSelectionAction {
  /** The highlighted plan text, verbatim. */
  selection: string
  /** What the agent should do with it — a quick action or the user's own words. */
  instruction: string
}

const QUICK_ACTIONS = [
  {
    icon: MessageCircleQuestion,
    label: 'Explain',
    instruction:
      'Explain this section — what it means, why it is in the plan, and any risks. This is a question, not a change request.'
  },
  {
    icon: ListPlus,
    label: 'Expand',
    instruction:
      'Expand this section with more specific detail — exact files, concrete steps, and edge cases.'
  },
  {
    icon: Eraser,
    label: 'Simplify',
    instruction:
      'Simplify this section — make it tighter and clearer without losing anything necessary.'
  },
  {
    icon: Trash2,
    label: 'Remove',
    danger: true,
    instruction: 'Remove this section from the plan, and clean up anything that references it.'
  }
] as const

const MENU_WIDTH = 440

/**
 * Floating toolbar over the rendered plan: highlight any passage and act on
 * it — quick CRUD-ish actions or a freeform instruction — without losing the
 * context of what you selected. Renders nothing until a selection inside
 * `containerRef` exists; the parent decides where the composed prompt goes.
 */
export default function PlanSelectionMenu({
  containerRef,
  disabled,
  onAction
}: {
  containerRef: RefObject<HTMLDivElement | null>
  disabled: boolean
  onAction: (action: PlanSelectionAction) => void
}): ReactElement | null {
  const [sel, setSel] = useState<{
    text: string
    x: number
    y: number
    below: boolean
    range: Range
  } | null>(null)
  const [custom, setCustom] = useState('')
  const menuRef = useRef<HTMLDivElement>(null)

  // becoming disabled (edit mode, phase change) dismisses an open menu
  const [wasDisabled, setWasDisabled] = useState(disabled)
  if (disabled !== wasDisabled) {
    setWasDisabled(disabled)
    if (disabled && sel) setSel(null)
  }

  useEffect(() => {
    if (disabled) return
    const capture = (): void => {
      const container = containerRef.current
      const s = window.getSelection()
      if (!container || !s || s.isCollapsed || s.rangeCount === 0) return
      const range = s.getRangeAt(0)
      const within =
        container.contains(range.startContainer) && container.contains(range.endContainer)
      const text = s.toString().trim()
      if (!within || text.length < 3) return
      const rect = range.getBoundingClientRect()
      const half = MENU_WIDTH / 2 + 12
      // flip under the selection when there's no room for the menu above it
      const below = rect.top < 200
      setSel({
        text,
        x: Math.min(Math.max(rect.left + rect.width / 2, half), window.innerWidth - half),
        y: below ? rect.bottom + 10 : rect.top - 10,
        below,
        range: range.cloneRange()
      })
      setCustom('')
    }
    const onMouseUp = (e: MouseEvent): void => {
      if (menuRef.current?.contains(e.target as Node)) return
      // let the browser settle the selection before reading it
      window.setTimeout(capture, 0)
    }
    const onMouseDown = (e: MouseEvent): void => {
      // clicking anywhere outside the menu starts a new selection (or none)
      if (!menuRef.current?.contains(e.target as Node)) setSel(null)
    }
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setSel(null)
    }
    // shift+arrow selections finish on keyup, not mouseup
    const onKeyUp = (e: KeyboardEvent): void => {
      if (e.shiftKey) window.setTimeout(capture, 0)
    }
    document.addEventListener('mouseup', onMouseUp)
    document.addEventListener('mousedown', onMouseDown)
    document.addEventListener('keydown', onKeyDown)
    document.addEventListener('keyup', onKeyUp)
    return () => {
      document.removeEventListener('mouseup', onMouseUp)
      document.removeEventListener('mousedown', onMouseDown)
      document.removeEventListener('keydown', onKeyDown)
      document.removeEventListener('keyup', onKeyUp)
    }
  }, [containerRef, disabled])

  // clicking into the menu's input steals focus and collapses the native
  // selection — repaint the captured range so it stays highlighted while the
  // menu is open
  useEffect(() => {
    if (!sel) return
    CSS.highlights.set('plan-selection', new Highlight(sel.range))
    return () => {
      CSS.highlights.delete('plan-selection')
    }
  }, [sel])

  // the menu is pinned to viewport coordinates — scrolling the plan under it
  // would leave it floating over the wrong text
  useEffect(() => {
    const el = containerRef.current
    if (!el || !sel) return
    const onScroll = (): void => setSel(null)
    el.addEventListener('scroll', onScroll)
    return () => el.removeEventListener('scroll', onScroll)
  }, [containerRef, sel])

  if (!sel) return null

  const submit = (instruction: string): void => {
    const action = { selection: sel.text, instruction }
    window.getSelection()?.removeAllRanges()
    setSel(null)
    setCustom('')
    onAction(action)
  }

  return createPortal(
    <div
      ref={menuRef}
      className="fade-up hairline-strong fixed z-[80] rounded-xl border bg-ink-900 p-2 shadow-2xl"
      style={{
        width: MENU_WIDTH,
        left: sel.x,
        top: sel.y,
        transform: sel.below ? 'translateX(-50%)' : 'translate(-50%, -100%)'
      }}
    >
      <p className="truncate px-1.5 pb-1.5 pt-0.5 font-mono text-[10px] text-ink-400">
        <span className="text-brass-400">re:</span> “{sel.text.replace(/\s+/g, ' ')}”
      </p>
      <div className="flex items-center gap-1">
        {QUICK_ACTIONS.map((a) => (
          <button
            key={a.label}
            // preventDefault keeps the text selection highlighted through the click
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => submit(a.instruction)}
            className={cn(
              'flex items-center gap-1.5 rounded-md px-2 py-1 text-[11.5px] text-ink-200 transition-colors hover:bg-ink-700 hover:text-ink-50',
              'danger' in a && a.danger && 'hover:text-terra-400'
            )}
          >
            <a.icon size={12} className="text-ink-400" />
            {a.label}
          </button>
        ))}
      </div>
      <div className="mt-1.5 flex items-center gap-1.5">
        <input
          value={custom}
          onChange={(e) => setCustom(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && custom.trim()) submit(custom.trim())
          }}
          placeholder="Or tell the agent what to do with it…"
          spellCheck={false}
          className="hairline min-w-0 flex-1 rounded-lg border bg-ink-950/40 px-2.5 py-1.5 text-[12px] text-ink-100 outline-none placeholder:text-ink-500 focus:border-brass-500/40"
        />
        <button
          onClick={() => custom.trim() && submit(custom.trim())}
          disabled={!custom.trim()}
          title="Send to the agent"
          className="rounded-lg p-1.5 text-brass-300 transition-colors hover:bg-ink-700 disabled:opacity-40"
        >
          <Send size={14} />
        </button>
      </div>
    </div>,
    document.body
  )
}
