import { useEffect, useState, type ReactElement } from 'react'
import {
  Columns3,
  ListVideo,
  GitPullRequest,
  Bug,
  SquareTerminal,
  Settings2,
  Sun,
  Moon,
  Globe,
  Keyboard,
  PanelLeftClose,
  PanelLeftOpen
} from 'lucide-react'
import type { AppSettings } from '@shared/types'
import { call, useApp, sessionList, type View } from './store'
import { Toggle, Vu } from './lib/ui'
import { cn } from './lib/utils'
import BoardView from './views/BoardView'
import SessionsView from './views/SessionsView'
import ReviewsView from './views/ReviewsView'
import ErrorsView from './views/ErrorsView'
import TerminalView from './views/TerminalView'
import SettingsView from './views/SettingsView'
import OnboardingView from './views/OnboardingView'
import ToolHealthBanner from './components/ToolHealthBanner'
import UsageBar from './components/UsageBar'
import SessionsMenu from './components/SessionsMenu'
import Toasts from './components/Toasts'
import BrowserPanel from './components/BrowserPanel'
import QuitConfirm from './components/QuitConfirm'
import ShortcutsModal from './components/ShortcutsModal'

/* the bar mark from resources/icon.svg, transparent and theme-aware */
function SullyMark({ className }: { className?: string }): ReactElement {
  return (
    <svg viewBox="0 0 364 424" fill="currentColor" className={className} aria-label="Sully">
      <rect x="0" y="122" width="104" height="284" rx="52" />
      <rect x="130" y="0" width="104" height="424" rx="52" />
      <rect x="260" y="170" width="104" height="140" rx="52" />
    </svg>
  )
}

const NAV: Array<{ id: View; label: string; icon: typeof Columns3 }> = [
  { id: 'board', label: 'Board', icon: Columns3 },
  { id: 'sessions', label: 'Sessions', icon: ListVideo },
  { id: 'reviews', label: 'PR Reviews', icon: GitPullRequest },
  { id: 'errors', label: 'Errors', icon: Bug },
  { id: 'terminal', label: 'Terminal', icon: SquareTerminal }
]

export default function App(): ReactElement {
  const {
    loaded,
    view,
    setView,
    settings,
    sessions,
    reviews,
    init,
    applySettings,
    browserOpen,
    toggleBrowser,
    confirmQuitOpen,
    sidebarCollapsed,
    toggleSidebar,
    shortcutsOpen,
    setShortcutsOpen,
    fullscreen,
    setFullscreen
  } = useApp()

  const [sidebarHovered, setSidebarHovered] = useState(false)
  const inFullscreen = fullscreen !== null
  // full screen keeps the sidebar pinned to its icon rail, hover and all
  const sidebarExpanded = (!sidebarCollapsed || sidebarHovered) && !inFullscreen

  useEffect(() => {
    void init()
  }, [init])

  useEffect(() => {
    document.documentElement.classList.toggle('light', settings?.theme === 'light')
  }, [settings?.theme])

  // Escape leaves full screen, unless the user is typing (e.g. the browser url
  // bar uses Escape to blur)
  useEffect(() => {
    if (!inFullscreen) return undefined
    const onKey = (e: KeyboardEvent): void => {
      const el = document.activeElement
      const editing =
        el instanceof HTMLElement &&
        (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)
      if (e.key === 'Escape' && !editing) setFullscreen(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [inFullscreen, setFullscreen])

  if (!loaded || !settings) {
    return (
      <div className="atmosphere flex h-full items-center justify-center">
        <p className="breathe font-display text-xl text-ink-300">tuning up…</p>
      </div>
    )
  }

  if (!settings.onboarded) {
    return (
      <>
        <OnboardingView />
        {confirmQuitOpen && <QuitConfirm />}
      </>
    )
  }

  const runningCount = sessionList(sessions).filter((s) => s.status === 'running').length
  const reviewingCount = reviews.filter((r) => r.status === 'reviewing').length

  const saveOrchestrator = (patch: Partial<AppSettings['orchestrator']>): void => {
    const next = { ...settings, orchestrator: { ...settings.orchestrator, ...patch } }
    applySettings(next)
    void call(window.sully.setSettings(next))
  }

  return (
    <div className="atmosphere flex h-full flex-col">
      {/* full-width titlebar: the traffic lights (18,18) live in this strip,
          fully above the sidebar and content */}
      <div className="titlebar-drag hairline flex h-[52px] shrink-0 items-center justify-end gap-3 border-b px-7">
        <SessionsMenu />
        <UsageBar />
        <button
          onClick={() => {
            const theme = settings.theme === 'light' ? ('dark' as const) : ('light' as const)
            const next = { ...settings, theme }
            applySettings(next)
            void call(window.sully.setSettings(next))
          }}
          title={settings.theme === 'light' ? 'Switch to dark mode' : 'Switch to light mode'}
          className="rounded-lg p-1.5 text-ink-300 transition-colors duration-150 hover:bg-ink-800 hover:text-ink-100"
        >
          {settings.theme === 'light' ? (
            <Moon size={15} strokeWidth={1.8} />
          ) : (
            <Sun size={15} strokeWidth={1.8} />
          )}
        </button>
      </div>

      <div className="flex min-h-0 flex-1">
        {/* sidebar */}
        <aside
          onMouseEnter={() => setSidebarHovered(true)}
          onMouseLeave={(e) => {
            // drag regions swallow mouse events, so a leave can fire while the
            // pointer is still inside the rail; only collapse on a real exit
            const r = e.currentTarget.getBoundingClientRect()
            const inside =
              e.clientX >= r.left &&
              e.clientX < r.right &&
              e.clientY >= r.top &&
              e.clientY < r.bottom
            if (!inside) setSidebarHovered(false)
          }}
          className={cn(
            'hairline flex shrink-0 flex-col overflow-hidden whitespace-nowrap border-r bg-ink-900/70 transition-[width] duration-200',
            sidebarExpanded ? 'w-[200px]' : 'w-[72px]'
          )}
        >
          {/* logo row: the whole strip toggles the sidebar, revealing the
            collapse icon on hover */}
          <button
            onClick={toggleSidebar}
            title={sidebarCollapsed ? 'Pin sidebar open (⌘B)' : 'Collapse sidebar (⌘B)'}
            className={cn(
              'group mx-2 mt-3 flex cursor-pointer items-center rounded-lg py-1.5 transition-colors duration-150 hover:bg-ink-800',
              sidebarExpanded ? 'justify-between px-3' : 'justify-center'
            )}
          >
            <SullyMark className="h-[20px] w-auto shrink-0 text-ink-50" />
            {sidebarExpanded && (
              <span className="text-ink-400 opacity-0 transition-[opacity,color] duration-150 group-hover:opacity-100 group-hover:text-ink-100 group-focus-visible:opacity-100">
                {sidebarCollapsed ? (
                  <PanelLeftOpen size={15} strokeWidth={1.8} />
                ) : (
                  <PanelLeftClose size={15} strokeWidth={1.8} />
                )}
              </span>
            )}
          </button>

          <nav className="mt-3 flex flex-col gap-0.5 px-2">
            {NAV.map(({ id, label, icon: Icon }) => (
              <button
                key={id}
                onClick={() => setView(id)}
                title={sidebarExpanded ? undefined : label}
                className={cn(
                  'flex items-center rounded-lg py-[7px] text-[13px] transition-colors duration-150',
                  sidebarExpanded ? 'gap-2.5 px-3' : 'justify-center',
                  view === id
                    ? 'bg-ink-700 text-ink-50'
                    : 'text-ink-300 hover:bg-ink-800 hover:text-ink-100'
                )}
              >
                <Icon size={15} strokeWidth={1.8} className="shrink-0" />
                {sidebarExpanded && (
                  <>
                    <span className="flex-1 text-left">{label}</span>
                    {id === 'sessions' && runningCount > 0 && <Vu />}
                    {id === 'reviews' && reviewingCount > 0 && (
                      <span className="rounded-full bg-brass-500/20 px-1.5 text-[10.5px] font-bold text-brass-300">
                        {reviewingCount}
                      </span>
                    )}
                  </>
                )}
              </button>
            ))}
            {/* toggles the dockable browser panel rather than switching views */}
            <button
              onClick={toggleBrowser}
              title="Toggle browser (⌘⇧B)"
              className={cn(
                'flex items-center rounded-lg py-[7px] text-[13px] transition-colors duration-150',
                sidebarExpanded ? 'gap-2.5 px-3' : 'justify-center',
                browserOpen
                  ? 'bg-ink-700 text-ink-50'
                  : 'text-ink-300 hover:bg-ink-800 hover:text-ink-100'
              )}
            >
              <Globe size={15} strokeWidth={1.8} className="shrink-0" />
              {sidebarExpanded && <span className="flex-1 text-left">Browser</span>}
            </button>
            <button
              onClick={() => setShortcutsOpen(true)}
              title="Keyboard shortcuts"
              className={cn(
                'flex items-center rounded-lg py-[7px] text-[13px] text-ink-300 transition-colors duration-150 hover:bg-ink-800 hover:text-ink-100',
                sidebarExpanded ? 'gap-2.5 px-3' : 'justify-center'
              )}
            >
              <Keyboard size={15} strokeWidth={1.8} className="shrink-0" />
              {sidebarExpanded && <span className="flex-1 text-left">Shortcuts</span>}
            </button>
          </nav>

          <div className="flex-1" />

          {/* master switches; compact state-only toggles in the collapsed rail */}
          {!sidebarExpanded && (
            <div className="hairline mx-2 mb-3 flex flex-col items-center gap-2.5 rounded-xl border bg-ink-850 py-3">
              <span title={`Orchestrator: ${settings.orchestrator.enabled ? 'on' : 'off'}`}>
                <Toggle
                  checked={settings.orchestrator.enabled}
                  onChange={(v) => void call(window.sully.orchestratorSetEnabled(v))}
                  label="Orchestrator"
                />
              </span>
              <span title={`Auto reviews: ${settings.prWatcher.enabled ? 'on' : 'off'}`}>
                <Toggle
                  checked={settings.prWatcher.enabled}
                  onChange={(v) => void call(window.sully.reviewsSetEnabled(v))}
                  label="Auto reviews"
                />
              </span>
              <span
                title={`Auto-fix failing CI: ${settings.orchestrator.ciAutoFix ? 'on' : 'off'}`}
              >
                <Toggle
                  checked={settings.orchestrator.ciAutoFix}
                  onChange={(v) => saveOrchestrator({ ciAutoFix: v })}
                  label="Auto-fix failing CI"
                />
              </span>
              <span
                title={`Auto-merge approved PRs: ${settings.orchestrator.autoMergeOnApproval ? 'on' : 'off'}`}
              >
                <Toggle
                  checked={settings.orchestrator.autoMergeOnApproval}
                  onChange={(v) => saveOrchestrator({ autoMergeOnApproval: v })}
                  label="Auto-merge approved PRs"
                />
              </span>
            </div>
          )}
          {sidebarExpanded && (
            <div className="hairline mx-2 mb-3 flex flex-col gap-2.5 rounded-xl border bg-ink-850 p-3">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-[12px] font-bold text-ink-100">Orchestrator</p>
                  <p className="text-[10.5px] text-ink-400">plan &amp; code from Linear</p>
                </div>
                <Toggle
                  checked={settings.orchestrator.enabled}
                  onChange={(v) => void call(window.sully.orchestratorSetEnabled(v))}
                  label="Orchestrator"
                />
              </div>
              <div className="hairline flex items-center justify-between border-t pt-2.5">
                <div>
                  <p className="text-[12px] font-bold text-ink-100">Auto reviews</p>
                  <p className="text-[10.5px] text-ink-400">PRs assigned to you</p>
                </div>
                <Toggle
                  checked={settings.prWatcher.enabled}
                  onChange={(v) => void call(window.sully.reviewsSetEnabled(v))}
                  label="Auto reviews"
                />
              </div>
              <div
                className="hairline flex items-center justify-between border-t pt-2.5"
                title="When a ticket's PR checks fail, resume the coding session with the failure logs, push a fix, and re-check — up to the attempt cap"
              >
                <div>
                  <p className="text-[12px] font-bold text-ink-100">Auto-fix CI</p>
                  <p className="text-[10.5px] text-ink-400">retry failing PR checks</p>
                </div>
                <Toggle
                  checked={settings.orchestrator.ciAutoFix}
                  onChange={(v) => saveOrchestrator({ ciAutoFix: v })}
                  label="Auto-fix failing CI"
                />
              </div>
              <div
                className="hairline flex items-center justify-between border-t pt-2.5"
                title="When a ticket's PR is approved and CI is green, squash-merge it automatically and delete the branch"
              >
                <div>
                  <p className="text-[12px] font-bold text-ink-100">Auto-merge</p>
                  <p className="text-[10.5px] text-ink-400">approved PRs, green CI</p>
                </div>
                <Toggle
                  checked={settings.orchestrator.autoMergeOnApproval}
                  onChange={(v) => saveOrchestrator({ autoMergeOnApproval: v })}
                  label="Auto-merge approved PRs"
                />
              </div>
            </div>
          )}

          {/* settings pinned to the bottom rail, below the master switches */}
          <nav className="mb-3 flex flex-col px-2">
            <button
              onClick={() => setView('settings')}
              title={sidebarExpanded ? undefined : 'Settings'}
              className={cn(
                'flex items-center rounded-lg py-[7px] text-[13px] transition-colors duration-150',
                sidebarExpanded ? 'gap-2.5 px-3' : 'justify-center',
                view === 'settings'
                  ? 'bg-ink-700 text-ink-50'
                  : 'text-ink-300 hover:bg-ink-800 hover:text-ink-100'
              )}
            >
              <Settings2 size={15} strokeWidth={1.8} className="shrink-0" />
              {sidebarExpanded && <span className="flex-1 text-left">Settings</span>}
            </button>
          </nav>
        </aside>

        {/* main pane */}
        <main className="flex min-w-0 flex-1 flex-col">
          <ToolHealthBanner />
          <div
            className={cn(
              'min-h-0 flex-1 overflow-y-auto',
              fullscreen === 'terminal' ? 'p-2' : 'px-7 pb-8 pt-6'
            )}
          >
            {view === 'board' && <BoardView />}
            {view === 'sessions' && <SessionsView />}
            {view === 'reviews' && <ReviewsView />}
            {view === 'errors' && <ErrorsView />}
            {/* stays mounted so xterm buffers and shells survive view switches */}
            <div className={cn('h-full', view !== 'terminal' && 'hidden')}>
              <TerminalView />
            </div>
            {view === 'settings' && <SettingsView />}
          </div>
          {/* DockablePanel portals here in bottom mode. display:contents makes
              panels direct flex items of <main> — a wrapper would size to the
              panel's min-content and ignore its flex-basis */}
          <div id="dock-bottom" className="contents" />
        </main>
        {/* DockablePanel portals here in sidebar mode. display:contents makes
            panels direct flex items of the row — a wrapper would size to the
            panel's min-content and ignore its flex-basis */}
        <div id="dock-right" className="contents" />
        {browserOpen && <BrowserPanel />}
      </div>
      {shortcutsOpen && <ShortcutsModal />}
      {confirmQuitOpen && <QuitConfirm />}
      <Toasts />
    </div>
  )
}
