import { create } from 'zustand'
import type {
  ActiveReview,
  AppSettings,
  CredentialStatus,
  Deploy,
  DevServer,
  DoctorReport,
  LinearViewer,
  PlanUsage,
  RateLimitInfo,
  Session,
  StateSnapshot,
  StreamEvent,
  TerminalInfo,
  TrackedIssue
} from '@shared/types'
import {
  findLeaf,
  leafInfos,
  leafNode,
  removeLeaf,
  setRatio,
  splitLeaf,
  type SplitDirection,
  type SplitNode
} from './lib/splitTree'

export type View = 'board' | 'sessions' | 'reviews' | 'errors' | 'terminal' | 'settings'

const MAX_EVENTS_PER_SESSION = 600

export interface Toast {
  id: number
  kind: 'success' | 'error'
  text: string
}

let toastSeq = 0

export interface BrowserTab {
  id: string
  url: string
  title?: string
}

export const NEW_TAB_URL = 'about:blank'

// persisted like DockablePanel layouts — deliberately not in AppSettings,
// which would kick an orchestrator poll on every navigation
const BROWSER_TABS_KEY = 'sully:browser-tabs'

function loadBrowserTabs(): { tabs: BrowserTab[]; activeId: string } {
  try {
    const raw = localStorage.getItem(BROWSER_TABS_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as { tabs?: BrowserTab[]; activeId?: string }
      if (Array.isArray(parsed.tabs) && parsed.tabs.length > 0) {
        const tabs = parsed.tabs.filter((t) => t.id && t.url)
        if (tabs.length > 0) {
          const activeId = tabs.some((t) => t.id === parsed.activeId)
            ? parsed.activeId!
            : tabs[0].id
          return { tabs, activeId }
        }
      }
    }
  } catch {
    // corrupt entry — fall through to a fresh tab
  }
  // migrate the pre-tabs single persisted url, if any
  const legacy = localStorage.getItem('sully:browser-url')
  const tab: BrowserTab = { id: crypto.randomUUID(), url: legacy ?? 'https://github.com' }
  return { tabs: [tab], activeId: tab.id }
}

function saveBrowserTabs(tabs: BrowserTab[], activeId: string): void {
  try {
    localStorage.setItem(BROWSER_TABS_KEY, JSON.stringify({ tabs, activeId }))
  } catch {
    // quota/private-mode failures just lose persistence
  }
}

const initialBrowser = loadBrowserTabs()

const SIDEBAR_COLLAPSED_KEY = 'sully.sidebarCollapsed'

interface AppState {
  loaded: boolean
  view: View
  settings?: AppSettings
  credentials?: CredentialStatus
  viewer?: LinearViewer
  issues: Record<string, TrackedIssue>
  sessions: Record<string, Session>
  reviews: ActiveReview[]
  devServers: Record<string, DevServer>
  deploys: Record<string, Deploy>
  sessionEvents: Record<string, StreamEvent[]>
  toolHealth?: DoctorReport
  rateLimit?: RateLimitInfo
  planUsage?: PlanUsage
  toasts: Toast[]
  termTabs: TerminalInfo[]
  activeTermId: string | null
  /** split layouts keyed by the tab's root terminal id — only tabs with ≥2 panes have an entry */
  splitLayouts: Record<string, SplitNode>
  browserOpen: boolean
  /** embedded browser tabs — persisted so close/reopen and restarts restore them */
  browserTabs: BrowserTab[]
  activeBrowserTabId: string
  /** a quit was requested — the confirm modal is showing */
  confirmQuitOpen: boolean
  /** sidebar is collapsed to the icon rail (hover still expands it) */
  sidebarCollapsed: boolean
  /** the keyboard-shortcuts modal is showing */
  shortcutsOpen: boolean

  setView: (v: View) => void
  toggleSidebar: () => void
  setShortcutsOpen: (open: boolean) => void
  setActiveTerm: (id: string) => void
  /** register a freshly created (or refocused) terminal and switch to it */
  termOpened: (info: TerminalInfo) => void
  openIssueTerminal: (issueId: string) => Promise<void>
  /** split a pane inside rootId's layout with a fresh pty; resolves to the new pane id */
  splitTerm: (rootId: string, paneId: string, direction: SplitDirection) => Promise<string | null>
  setSplitRatio: (rootId: string, splitId: string, ratio: number) => void
  /** close a terminal tab including every split pane inside it */
  closeTermTab: (id: string) => void
  /** open the embedded browser panel; a url opens (or refocuses) a tab for it */
  openBrowser: (url?: string) => void
  toggleBrowser: () => void
  closeBrowser: () => void
  newBrowserTab: () => void
  closeBrowserTab: (id: string) => void
  setActiveBrowserTab: (id: string) => void
  /** merge navigation state (url/title) into a tab as its webview navigates */
  updateBrowserTab: (id: string, patch: Partial<Pick<BrowserTab, 'url' | 'title'>>) => void
  dismissConfirmQuit: () => void
  init: () => Promise<void>
  refresh: () => Promise<void>
  applySettings: (s: AppSettings) => void
  pushToast: (kind: Toast['kind'], text: string) => void
  dismissToast: (id: number) => void
}

let initialized = false

export const useApp = create<AppState>((set, get) => ({
  loaded: false,
  view: 'board',
  issues: {},
  sessions: {},
  reviews: [],
  devServers: {},
  deploys: {},
  sessionEvents: {},
  toasts: [],
  termTabs: [],
  activeTermId: null,
  splitLayouts: {},
  browserOpen: false,
  browserTabs: initialBrowser.tabs,
  activeBrowserTabId: initialBrowser.activeId,
  confirmQuitOpen: false,
  sidebarCollapsed: localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === '1',
  shortcutsOpen: false,

  setView: (view) => set({ view }),

  toggleSidebar: () =>
    set((st) => {
      const sidebarCollapsed = !st.sidebarCollapsed
      localStorage.setItem(SIDEBAR_COLLAPSED_KEY, sidebarCollapsed ? '1' : '0')
      return { sidebarCollapsed }
    }),

  setShortcutsOpen: (shortcutsOpen) => set({ shortcutsOpen }),

  dismissConfirmQuit: () => set({ confirmQuitOpen: false }),

  openBrowser: (url) =>
    set((st) => {
      if (!url) return { browserOpen: true }
      // refocus an existing tab on the same url instead of duplicating it
      const existing = st.browserTabs.find((t) => t.url === url)
      const tab = existing ?? { id: crypto.randomUUID(), url }
      const browserTabs = existing ? st.browserTabs : [...st.browserTabs, tab]
      saveBrowserTabs(browserTabs, tab.id)
      return { browserOpen: true, browserTabs, activeBrowserTabId: tab.id }
    }),

  toggleBrowser: () => set((st) => ({ browserOpen: !st.browserOpen })),

  closeBrowser: () => set({ browserOpen: false }),

  newBrowserTab: () =>
    set((st) => {
      const tab: BrowserTab = { id: crypto.randomUUID(), url: NEW_TAB_URL }
      const browserTabs = [...st.browserTabs, tab]
      saveBrowserTabs(browserTabs, tab.id)
      return { browserTabs, activeBrowserTabId: tab.id }
    }),

  closeBrowserTab: (id) =>
    set((st) => {
      const idx = st.browserTabs.findIndex((t) => t.id === id)
      const browserTabs = st.browserTabs.filter((t) => t.id !== id)
      // closing the last tab closes the panel and leaves a fresh tab behind
      if (browserTabs.length === 0) {
        const tab: BrowserTab = { id: crypto.randomUUID(), url: NEW_TAB_URL }
        saveBrowserTabs([tab], tab.id)
        return { browserOpen: false, browserTabs: [tab], activeBrowserTabId: tab.id }
      }
      const activeBrowserTabId =
        st.activeBrowserTabId === id
          ? browserTabs[Math.min(idx, browserTabs.length - 1)].id
          : st.activeBrowserTabId
      saveBrowserTabs(browserTabs, activeBrowserTabId)
      return { browserTabs, activeBrowserTabId }
    }),

  setActiveBrowserTab: (id) =>
    set((st) => {
      saveBrowserTabs(st.browserTabs, id)
      return { activeBrowserTabId: id }
    }),

  updateBrowserTab: (id, patch) =>
    set((st) => {
      const browserTabs = st.browserTabs.map((t) => (t.id === id ? { ...t, ...patch } : t))
      saveBrowserTabs(browserTabs, st.activeBrowserTabId)
      return { browserTabs }
    }),

  setActiveTerm: (activeTermId) => set({ activeTermId }),

  termOpened: (info) =>
    set((st) => ({
      termTabs: st.termTabs.some((t) => t.id === info.id) ? st.termTabs : [...st.termTabs, info],
      activeTermId: info.id
    })),

  openIssueTerminal: async (issueId) => {
    // returns the existing terminal if the ticket already has one
    const info = await window.sully.termCreateForIssue(issueId)
    get().termOpened(info)
    set({ view: 'terminal' })
  },

  splitTerm: async (rootId, paneId, direction) => {
    const st = get()
    const base =
      st.splitLayouts[rootId] ??
      (() => {
        const root = st.termTabs.find((t) => t.id === rootId)
        return root ? leafNode(root) : null
      })()
    if (!base) return null
    // new shells open in the split pane's starting directory, like iTerm
    const pane = findLeaf(base, paneId) ?? findLeaf(base, rootId)
    try {
      const info = await window.sully.termCreate(pane?.cwd)
      set((s) => ({
        splitLayouts: {
          ...s.splitLayouts,
          [rootId]: splitLeaf(s.splitLayouts[rootId] ?? base, paneId, direction, info)
        }
      }))
      return info.id
    } catch (err) {
      get().pushToast('error', err instanceof Error ? err.message : String(err))
      return null
    }
  },

  setSplitRatio: (rootId, splitId, ratio) =>
    set((st) => {
      const node = st.splitLayouts[rootId]
      if (!node) return {}
      return { splitLayouts: { ...st.splitLayouts, [rootId]: setRatio(node, splitId, ratio) } }
    }),

  closeTermTab: (id) => {
    const node = get().splitLayouts[id]
    // drop the layout first so onTermExit prunes plainly instead of promoting panes
    set((st) => {
      const splitLayouts = { ...st.splitLayouts }
      delete splitLayouts[id]
      return { splitLayouts }
    })
    const ids = node ? leafInfos(node).map((i) => i.id) : [id]
    // onTermExit prunes the tab once the pty actually dies
    for (const pid of ids) void call(window.sully.termKill(pid))
  },

  applySettings: (settings) => set({ settings }),

  pushToast: (kind, text) => {
    const id = ++toastSeq
    set((st) => ({ toasts: [...st.toasts, { id, kind, text }].slice(-5) }))
    setTimeout(() => get().dismissToast(id), kind === 'error' ? 8000 : 4000)
  },

  dismissToast: (id) => set((st) => ({ toasts: st.toasts.filter((t) => t.id !== id) })),

  refresh: async () => {
    const snap: StateSnapshot = await window.sully.getSnapshot()
    set({
      loaded: true,
      settings: snap.settings,
      credentials: snap.credentials,
      viewer: snap.viewer,
      issues: Object.fromEntries(snap.issues.map((i) => [i.issueId, i])),
      sessions: Object.fromEntries(snap.sessions.map((s) => [s.id, s])),
      reviews: snap.reviews,
      devServers: Object.fromEntries(snap.devServers.map((d) => [d.issueId, d])),
      deploys: Object.fromEntries(snap.deploys.map((d) => [d.repoId, d])),
      toolHealth: snap.toolHealth,
      rateLimit: snap.rateLimit ?? get().rateLimit,
      planUsage: snap.planUsage ?? get().planUsage
    })
  },

  init: async () => {
    // StrictMode double-mounts the effect that calls this — a second run would
    // register every IPC listener twice (e.g. ⌘⇧B toggling the browser open
    // and instantly closed again)
    if (initialized) return
    initialized = true
    await get().refresh()
    // adopt ptys that outlived a renderer reload
    const existingTerms = await window.sully.termList()
    set((st) => ({
      termTabs: existingTerms,
      activeTermId: st.activeTermId ?? existingTerms[0]?.id ?? null
    }))
    window.sully.onTermExit(({ id }) =>
      set((st) => {
        let activeTermId = st.activeTermId
        const splitLayouts = { ...st.splitLayouts }

        // pane inside a split layout: collapse it out; a dying root pane hands
        // its tab (and layout key) to the first surviving pane
        const rootId = Object.keys(splitLayouts).find((r) => findLeaf(splitLayouts[r], id))
        if (rootId) {
          const remaining = removeLeaf(splitLayouts[rootId], id)
          delete splitLayouts[rootId]
          if (remaining) {
            let termTabs = st.termTabs
            if (id === rootId) {
              const promoted = leafInfos(remaining)[0]
              if (remaining.type === 'split') splitLayouts[promoted.id] = remaining
              termTabs = termTabs.map((t) => (t.id === id ? promoted : t))
              if (activeTermId === id) activeTermId = promoted.id
            } else if (remaining.type === 'split') {
              splitLayouts[rootId] = remaining
            }
            return { termTabs, activeTermId, splitLayouts }
          }
        }

        const termTabs = st.termTabs.filter((t) => t.id !== id)
        if (activeTermId === id) {
          const idx = st.termTabs.findIndex((t) => t.id === id)
          activeTermId = termTabs[Math.min(idx, termTabs.length - 1)]?.id ?? null
        }
        return { termTabs, activeTermId, splitLayouts }
      })
    )
    // ⌘W (intercepted in main before the menu can hide the window): close the
    // terminal pane owning keyboard focus, else the focused browser tab, else
    // ask whether to hide to the tray or quit
    window.sully.onCloseShortcut(() => {
      const pane = document.activeElement?.closest('[data-term-id]')
      const id = pane?.getAttribute('data-term-id')
      if (id) {
        void call(window.sully.termKill(id))
        return
      }
      const st = get()
      if (st.browserOpen && document.activeElement?.closest('[data-browser-panel]')) {
        st.closeBrowserTab(st.activeBrowserTabId)
        return
      }
      set({ confirmQuitOpen: true })
    })
    // ⌘⇧B: toggle the embedded browser panel
    window.sully.onBrowserShortcut(() => get().toggleBrowser())
    // ⌘B: collapse/expand the sidebar
    window.sully.onSidebarShortcut(() => get().toggleSidebar())
    // ⌘T: new browser tab (only meaningful while the panel is open)
    window.sully.onNewTabShortcut(() => {
      if (get().browserOpen) get().newBrowserTab()
    })
    // main intercepted a quit (⌘Q/menu/tray/dock) — ask before letting it through
    window.sully.onConfirmQuit(() => set({ confirmQuitOpen: true }))
    window.sully.onIssueUpdated((issue) =>
      set((st) => ({ issues: { ...st.issues, [issue.issueId]: issue } }))
    )
    window.sully.onIssueRemoved((issueId) =>
      set((st) => {
        const issues = { ...st.issues }
        delete issues[issueId]
        return { issues }
      })
    )
    window.sully.onSessionUpdated((session) =>
      set((st) => ({ sessions: { ...st.sessions, [session.id]: session } }))
    )
    window.sully.onSessionOutput(({ sessionId, events }) =>
      set((st) => {
        const existing = st.sessionEvents[sessionId] ?? []
        const merged = [...existing, ...events].slice(-MAX_EVENTS_PER_SESSION)
        return { sessionEvents: { ...st.sessionEvents, [sessionId]: merged } }
      })
    )
    window.sully.onReviewsUpdated((reviews) => set({ reviews }))
    window.sully.onDevServersUpdated((servers) =>
      set({ devServers: Object.fromEntries(servers.map((d) => [d.issueId, d])) })
    )
    window.sully.onDeploysUpdated((deploys) =>
      set({ deploys: Object.fromEntries(deploys.map((d) => [d.repoId, d])) })
    )
    window.sully.onSettingsChanged((settings) => set({ settings }))
    window.sully.onToolHealth((toolHealth) => set({ toolHealth }))
    window.sully.onRateLimit((rateLimit) => set({ rateLimit }))
    window.sully.onPlanUsage((planUsage) => set({ planUsage }))
    window.sully.onNavigate((view) => {
      if (['board', 'sessions', 'reviews', 'errors', 'terminal', 'settings'].includes(view)) {
        set({ view: view as View })
        window.focus()
      }
    })
  }
}))

/**
 * Run an IPC call with user feedback: failures surface as a toast instead of
 * vanishing (the old `void window.sully.*` pattern), successes optionally
 * confirm. Returns whether the call succeeded.
 */
export async function call(action: Promise<unknown>, successText?: string): Promise<boolean> {
  try {
    await action
    if (successText) useApp.getState().pushToast('success', successText)
    return true
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err)
    // strip electron's invoke wrapper so the user sees the actual reason
    const msg = raw.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
    useApp.getState().pushToast('error', msg || 'Something went wrong')
    return false
  }
}

export function sessionList(sessions: Record<string, Session>): Session[] {
  return Object.values(sessions).sort((a, b) => b.startedAt.localeCompare(a.startedAt))
}

export function issueList(issues: Record<string, TrackedIssue>): TrackedIssue[] {
  return Object.values(issues).sort((a, b) => a.identifier.localeCompare(b.identifier))
}
