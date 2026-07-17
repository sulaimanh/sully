import { useEffect, type ReactElement } from 'react'
import { useApp } from '../store'

const GROUPS: Array<{ title: string; shortcuts: Array<{ keys: string[]; label: string }> }> = [
  {
    title: 'General',
    shortcuts: [
      { keys: ['⌘', 'B'], label: 'Collapse / expand the sidebar' },
      { keys: ['⌘', 'W'], label: 'Close focused terminal pane or browser tab, else close Sully' },
      { keys: ['⌘', 'Q'], label: 'Quit Sully (asks to confirm)' }
    ]
  },
  {
    title: 'Browser panel',
    shortcuts: [
      { keys: ['⌘', '⇧', 'B'], label: 'Toggle the browser panel' },
      { keys: ['⌘', 'T'], label: 'New browser tab (while the panel is open)' }
    ]
  },
  {
    title: 'Terminal',
    shortcuts: [
      { keys: ['⌘', 'D'], label: 'Split pane side by side' },
      { keys: ['⌘', '⇧', 'D'], label: 'Split pane stacked' },
      { keys: ['⇧', '↩'], label: 'Insert a newline instead of submitting' }
    ]
  }
]

function Keycap({ children }: { children: string }): ReactElement {
  return (
    <kbd className="hairline inline-flex h-[22px] min-w-[22px] items-center justify-center rounded-md border bg-ink-800 px-1.5 font-sans text-[11px] text-ink-100">
      {children}
    </kbd>
  )
}

/** Reference sheet for every keyboard shortcut — opened from the sidebar. */
export default function ShortcutsModal(): ReactElement {
  const setShortcutsOpen = useApp((s) => s.setShortcutsOpen)
  const close = (): void => setShortcutsOpen(false)

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setShortcutsOpen(false)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [setShortcutsOpen])

  return (
    <div
      onClick={close}
      className="fixed inset-0 z-[80] flex items-center justify-center bg-ink-950/80 p-10 backdrop-blur-sm"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="fade-up hairline-strong w-[440px] rounded-2xl border bg-ink-900 p-5 shadow-2xl"
      >
        <p className="font-display text-[17px] text-ink-50">Keyboard shortcuts</p>
        <div className="mt-3 flex flex-col gap-4">
          {GROUPS.map(({ title, shortcuts }) => (
            <div key={title}>
              <p className="text-[10.5px] font-bold uppercase tracking-wider text-ink-400">
                {title}
              </p>
              <div className="mt-1.5 flex flex-col">
                {shortcuts.map(({ keys, label }) => (
                  <div
                    key={label}
                    className="flex items-center justify-between gap-4 py-[5px] text-[12.5px] text-ink-200"
                  >
                    <span>{label}</span>
                    <span className="flex shrink-0 items-center gap-1">
                      {keys.map((k) => (
                        <Keycap key={k}>{k}</Keycap>
                      ))}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
