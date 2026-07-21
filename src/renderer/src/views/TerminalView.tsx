import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react'
import { Maximize2, Minimize2, Plus, X } from 'lucide-react'
import { useApp } from '../store'
import { EmptyState } from '../lib/ui'
import { cn } from '../lib/utils'
import SplitTerminal from '../components/SplitTerminal'

/**
 * Embedded terminal tabs. Ptys live in the main process and tab state lives in
 * the store (adopted on init, pruned on exit), so terminals survive renderer
 * reloads and can be opened from anywhere (e.g. a ticket's "Open terminal").
 * The view stays mounted in App while hidden so xterm state persists.
 */
export default function TerminalView(): ReactElement {
  const settings = useApp((s) => s.settings)
  const tabs = useApp((s) => s.termTabs)
  const activeId = useApp((s) => s.activeTermId)
  const setActiveTerm = useApp((s) => s.setActiveTerm)
  const isFullscreen = useApp((s) => s.fullscreen === 'terminal')
  const toggleFullscreen = useApp((s) => s.toggleFullscreen)
  const [showPicker, setShowPicker] = useState(false)
  const pickerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!showPicker) return undefined
    const close = (e: MouseEvent): void => {
      if (!pickerRef.current?.contains(e.target as Node)) setShowPicker(false)
    }
    window.addEventListener('mousedown', close)
    return () => window.removeEventListener('mousedown', close)
  }, [showPicker])

  const createTerminal = useCallback(async (cwd?: string) => {
    setShowPicker(false)
    try {
      const info = await window.sully.termCreate(cwd)
      useApp.getState().termOpened(info)
    } catch (err) {
      useApp.getState().pushToast('error', err instanceof Error ? err.message : String(err))
    }
  }, [])

  const closeTab = (id: string): void => {
    // kills every split pane in the tab; onTermExit prunes it once the ptys die
    useApp.getState().closeTermTab(id)
  }

  const repos = settings?.repoMappings ?? []

  const newButton = (
    <div className="relative" ref={pickerRef}>
      <button
        onClick={() => (repos.length > 0 ? setShowPicker((v) => !v) : void createTerminal())}
        title="New terminal"
        className="flex h-[26px] w-[26px] items-center justify-center rounded-md text-ink-300 transition-colors duration-150 hover:bg-ink-700 hover:text-ink-50"
      >
        <Plus size={14} strokeWidth={2} />
      </button>
      {showPicker && (
        <div className="hairline-strong absolute right-0 top-[30px] z-10 min-w-[180px] rounded-lg border bg-ink-850 p-1 shadow-lg">
          <button
            onClick={() => void createTerminal()}
            className="block w-full rounded-md px-2.5 py-1.5 text-left text-[12px] text-ink-200 hover:bg-ink-700 hover:text-ink-50"
          >
            Home
          </button>
          {repos.map((r) => (
            <button
              key={r.id}
              onClick={() => void createTerminal(r.repoPath)}
              className="block w-full rounded-md px-2.5 py-1.5 text-left text-[12px] text-ink-200 hover:bg-ink-700 hover:text-ink-50"
            >
              {r.label || r.repoPath}
            </button>
          ))}
        </div>
      )}
    </div>
  )

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center gap-1 pb-2">
        <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
          {tabs.map((t) => (
            <div
              key={t.id}
              onClick={() => setActiveTerm(t.id)}
              title={t.cwd}
              className={cn(
                'group flex shrink-0 cursor-pointer items-center gap-1.5 rounded-md py-1 pl-2.5 pr-1.5 font-mono text-[11.5px] transition-colors duration-150',
                t.id === activeId
                  ? 'bg-ink-700 text-ink-50'
                  : 'text-ink-300 hover:bg-ink-800 hover:text-ink-100'
              )}
            >
              <span>{t.title}</span>
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  closeTab(t.id)
                }}
                title="Close terminal"
                className="rounded p-0.5 opacity-0 transition-opacity duration-150 hover:bg-ink-600 group-hover:opacity-100"
              >
                <X size={11} strokeWidth={2} />
              </button>
            </div>
          ))}
        </div>
        {newButton}
        <button
          onClick={() => toggleFullscreen('terminal')}
          title={isFullscreen ? 'Exit full screen' : 'Full screen'}
          className="flex h-[26px] w-[26px] items-center justify-center rounded-md text-ink-300 transition-colors duration-150 hover:bg-ink-700 hover:text-ink-50"
        >
          {isFullscreen ? (
            <Minimize2 size={14} strokeWidth={2} />
          ) : (
            <Maximize2 size={14} strokeWidth={2} />
          )}
        </button>
      </div>

      <div className="hairline min-h-0 flex-1 overflow-hidden rounded-xl border bg-term p-2">
        {tabs.length === 0 ? (
          <EmptyState
            title="no terminals"
            hint="Open a shell in your home directory or straight into a mapped repo with the + button."
          />
        ) : (
          tabs.map((t) => <SplitTerminal key={t.id} rootId={t.id} active={t.id === activeId} />)
        )}
      </div>
    </div>
  )
}
