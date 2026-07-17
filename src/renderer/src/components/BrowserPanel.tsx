/* eslint react/no-unknown-property: ["error", { "ignore": ["partition"] }] -- real webview attribute */
import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react'
import { ArrowLeft, ArrowRight, Globe, Plus, RotateCw, X } from 'lucide-react'
import { NEW_TAB_URL, useApp, type BrowserTab } from '../store'
import { cn } from '../lib/utils'
import DockablePanel, { DockControls } from './DockablePanel'

const navBtnCls =
  'rounded-lg p-1.5 text-ink-300 transition-colors duration-150 hover:bg-ink-800 hover:text-ink-100 disabled:pointer-events-none disabled:opacity-35'

interface NavState {
  ready: boolean
  loading: boolean
  canBack: boolean
  canFwd: boolean
}

const EMPTY_NAV: NavState = { ready: false, loading: false, canBack: false, canFwd: false }

/** prepend https:// when the user omits a scheme */
const normalizeUrl = (raw: string): string => {
  const trimmed = raw.trim()
  if (!trimmed) return ''
  return /^[a-z][a-z0-9+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`
}

const tabLabel = (tab: BrowserTab): string => {
  if (tab.title) return tab.title
  if (tab.url === NEW_TAB_URL) return 'New Tab'
  try {
    return new URL(tab.url).host || tab.url
  } catch {
    return tab.url
  }
}

/**
 * One tab's <webview>. Stays mounted while its tab exists so page state
 * survives tab switches; inactive tabs are hidden with visibility (not
 * display:none, which breaks webview rendering). The guest is destroyed and
 * recreated when the panel switches dock modes (the portal target changes) —
 * each fresh element is re-seeded with the tab's last known url, so a mode
 * switch reloads the page in place and in-page history is lost.
 */
function TabView({
  tabId,
  active,
  onElement,
  onNavState
}: {
  tabId: string
  active: boolean
  onElement: (id: string, el: Electron.WebviewTag | null) => void
  onNavState: (id: string, patch: Partial<NavState>) => void
}): ReactElement {
  const updateBrowserTab = useApp((s) => s.updateBrowserTab)
  const [wv, setWv] = useState<Electron.WebviewTag | null>(null)
  const wvRef = useRef<Electron.WebviewTag | null>(null)
  // webview methods throw before the first dom-ready of a fresh element
  const ready = useRef(false)

  const attach = useCallback(
    (el: Electron.WebviewTag | null) => {
      if (!el) {
        wvRef.current = null
        onElement(tabId, null)
        return
      }
      if (el === wvRef.current) return
      wvRef.current = el
      ready.current = false
      el.src = useApp.getState().browserTabs.find((t) => t.id === tabId)?.url ?? NEW_TAB_URL
      onElement(tabId, el)
      setWv(el)
    },
    [tabId, onElement]
  )

  useEffect(() => {
    if (!wv) return
    const syncHistory = (): void => {
      if (!ready.current) return
      onNavState(tabId, { canBack: wv.canGoBack(), canFwd: wv.canGoForward() })
    }
    const onReady = (): void => {
      ready.current = true
      onNavState(tabId, { ready: true })
      syncHistory()
    }
    const onNavigate = (e: Electron.DidNavigateEvent): void => {
      updateBrowserTab(tabId, { url: e.url })
      syncHistory()
    }
    const onNavigateInPage = (e: Electron.DidNavigateInPageEvent): void => {
      if (e.isMainFrame) {
        updateBrowserTab(tabId, { url: e.url })
        syncHistory()
      }
    }
    const onTitle = (e: Electron.PageTitleUpdatedEvent): void => {
      updateBrowserTab(tabId, { title: e.title })
    }
    const onStartLoading = (): void => onNavState(tabId, { loading: true })
    const onStopLoading = (): void => {
      onNavState(tabId, { loading: false })
      syncHistory()
    }
    wv.addEventListener('dom-ready', onReady)
    wv.addEventListener('did-navigate', onNavigate)
    wv.addEventListener('did-navigate-in-page', onNavigateInPage)
    wv.addEventListener('page-title-updated', onTitle)
    wv.addEventListener('did-start-loading', onStartLoading)
    wv.addEventListener('did-stop-loading', onStopLoading)
    return () => {
      wv.removeEventListener('dom-ready', onReady)
      wv.removeEventListener('did-navigate', onNavigate)
      wv.removeEventListener('did-navigate-in-page', onNavigateInPage)
      wv.removeEventListener('page-title-updated', onTitle)
      wv.removeEventListener('did-start-loading', onStartLoading)
      wv.removeEventListener('did-stop-loading', onStopLoading)
    }
  }, [wv, tabId, updateBrowserTab, onNavState])

  return (
    <webview
      ref={attach}
      partition="persist:browser"
      className={cn('absolute inset-0', !active && 'invisible')}
    />
  )
}

export default function BrowserPanel(): ReactElement {
  const browserTabs = useApp((s) => s.browserTabs)
  const activeId = useApp((s) => s.activeBrowserTabId)
  const closeBrowser = useApp((s) => s.closeBrowser)
  const newBrowserTab = useApp((s) => s.newBrowserTab)
  const closeBrowserTab = useApp((s) => s.closeBrowserTab)
  const setActiveBrowserTab = useApp((s) => s.setActiveBrowserTab)

  const wvMap = useRef(new Map<string, Electron.WebviewTag>())
  const [navStates, setNavStates] = useState<Record<string, NavState>>({})
  const inputRef = useRef<HTMLInputElement>(null)
  const [urlInput, setUrlInput] = useState('')

  const activeTab = browserTabs.find((t) => t.id === activeId)
  const activeUrl = activeTab?.url ?? ''
  const nav = navStates[activeId] ?? EMPTY_NAV

  // mirror the active tab's url into the url bar unless the user is editing it
  useEffect(() => {
    if (document.activeElement !== inputRef.current) {
      setUrlInput(activeUrl === NEW_TAB_URL ? '' : activeUrl)
    }
  }, [activeUrl, activeId])

  // on tab switch: blank tabs get the url bar; otherwise, when focus fell to
  // <body> (tab closed via ⌘W, or a tab pill was clicked), hand it to the
  // page so browser shortcuts keep landing in the panel
  const prevTabRef = useRef<string | null>(null)
  useEffect(() => {
    if (prevTabRef.current === activeId) return
    prevTabRef.current = activeId
    if (activeUrl === NEW_TAB_URL) inputRef.current?.focus()
    else if (document.activeElement === document.body) wvMap.current.get(activeId)?.focus()
  })

  const onElement = useCallback((id: string, el: Electron.WebviewTag | null): void => {
    if (el) {
      wvMap.current.set(id, el)
    } else {
      wvMap.current.delete(id)
      setNavStates((s) => {
        const next = { ...s }
        delete next[id]
        return next
      })
    }
  }, [])

  const onNavState = useCallback((id: string, patch: Partial<NavState>): void => {
    setNavStates((s) => ({ ...s, [id]: { ...EMPTY_NAV, ...s[id], ...patch } }))
  }, [])

  const navigate = (): void => {
    const url = normalizeUrl(urlInput)
    const el = wvMap.current.get(activeId)
    if (!url || !el) return
    // src assignment (unlike loadURL) is safe before dom-ready
    el.src = url
    inputRef.current?.blur()
  }

  // the tab-switch effect above puts the cursor in the url bar for blank tabs
  const addTab = (): void => newBrowserTab()

  const activeWv = (): Electron.WebviewTag | undefined =>
    nav.ready ? wvMap.current.get(activeId) : undefined

  return (
    <DockablePanel
      id="browser"
      modalClassName="h-[min(920px,88vh)] w-[min(1280px,92vw)] min-h-[360px] min-w-[480px]"
      minWidth={480}
      minHeight={360}
    >
      {/* data-browser-panel: the ⌘W handler checks focus against this wrapper */}
      <div data-browser-panel className="flex min-h-0 flex-1 flex-col">
        <header className="hairline flex items-center gap-1.5 border-b px-4 py-2.5">
          <Globe size={14} strokeWidth={1.8} className="mr-1 shrink-0 text-ink-400" />
          <button
            onClick={() => activeWv()?.goBack()}
            disabled={!nav.canBack}
            title="Back"
            className={navBtnCls}
          >
            <ArrowLeft size={14} strokeWidth={1.8} />
          </button>
          <button
            onClick={() => activeWv()?.goForward()}
            disabled={!nav.canFwd}
            title="Forward"
            className={navBtnCls}
          >
            <ArrowRight size={14} strokeWidth={1.8} />
          </button>
          <button onClick={() => activeWv()?.reload()} title="Reload" className={navBtnCls}>
            <RotateCw size={14} strokeWidth={1.8} className={cn(nav.loading && 'animate-spin')} />
          </button>
          <input
            ref={inputRef}
            value={urlInput}
            onChange={(e) => setUrlInput(e.target.value)}
            onFocus={(e) => e.currentTarget.select()}
            onKeyDown={(e) => {
              if (e.key === 'Enter') navigate()
              if (e.key === 'Escape') e.currentTarget.blur()
            }}
            placeholder="Enter a URL"
            spellCheck={false}
            className="hairline-strong selectable mx-1.5 min-w-0 flex-1 rounded-lg border bg-ink-950 px-2.5 py-1.5 font-mono text-[11.5px] text-ink-50 placeholder:text-ink-400 focus:border-brass-500 focus:outline-none"
          />
          <DockControls />
          <button onClick={closeBrowser} className="ml-1.5 text-ink-300 hover:text-ink-50">
            <X size={17} />
          </button>
        </header>

        <div className="hairline flex shrink-0 items-center gap-1 overflow-x-auto border-b px-2.5 py-1.5">
          {browserTabs.map((tab) => (
            <div
              key={tab.id}
              onClick={() => setActiveBrowserTab(tab.id)}
              title={tab.url === NEW_TAB_URL ? undefined : tab.url}
              className={cn(
                'group flex max-w-[180px] shrink-0 cursor-pointer items-center gap-1.5 rounded-lg px-2.5 py-1 text-[11.5px] transition-colors duration-150',
                tab.id === activeId
                  ? 'bg-ink-700 text-ink-50'
                  : 'text-ink-300 hover:bg-ink-800 hover:text-ink-100'
              )}
            >
              <span className="truncate">{tabLabel(tab)}</span>
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  closeBrowserTab(tab.id)
                }}
                title="Close tab"
                className="shrink-0 rounded text-ink-400 opacity-0 transition-opacity hover:text-ink-50 group-hover:opacity-100"
              >
                <X size={11} strokeWidth={2} />
              </button>
            </div>
          ))}
          <button onClick={addTab} title="New tab" className={cn(navBtnCls, 'shrink-0 p-1')}>
            <Plus size={13} strokeWidth={1.8} />
          </button>
        </div>

        <div className="relative min-h-0 flex-1">
          {browserTabs.map((tab) => (
            <TabView
              key={tab.id}
              tabId={tab.id}
              active={tab.id === activeId}
              onElement={onElement}
              onNavState={onNavState}
            />
          ))}
        </div>
      </div>
    </DockablePanel>
  )
}
