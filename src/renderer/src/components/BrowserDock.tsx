/* eslint react/no-unknown-property: ["error", { "ignore": ["partition"] }] -- real webview attribute */
import { useCallback, useEffect, useRef, useState, type ReactElement, type ReactNode } from 'react'
import { ArrowLeft, ExternalLink, RotateCw, X } from 'lucide-react'
import { useApp } from '../store'
import { cn } from '../lib/utils'
import Dock from './Dock'

const btnCls =
  'rounded px-1.5 py-1 text-ink-400 transition-colors duration-150 hover:bg-ink-800 hover:text-ink-100 disabled:pointer-events-none disabled:opacity-35'

/**
 * Dockable in-dialog browser: shows a url (the ticket's PR or Linear page)
 * inside the dialog with the same docking mechanics as the terminal pane.
 * Shares the persist:browser session with the main browser panel, so logins
 * carry over. Closing unmounts the webview — reopening starts fresh.
 */
export default function BrowserDock({
  url,
  onClose,
  children
}: {
  /** null renders only the dialog content, no pane */
  url: string | null
  onClose: () => void
  children: ReactNode
}): ReactElement {
  const [wv, setWv] = useState<Electron.WebviewTag | null>(null)
  const wvRef = useRef<Electron.WebviewTag | null>(null)
  // webview methods throw before the first dom-ready of a fresh element
  const ready = useRef(false)
  /** last url pushed into the webview — dedupes the mount + effect double-fire */
  const requested = useRef<string | null>(null)
  const [canBack, setCanBack] = useState(false)
  const [loading, setLoading] = useState(false)

  // stable identity — a recreated callback ref makes React detach/reattach the
  // element every render, which would re-seed src and reload the page forever
  const attach = useCallback((el: Electron.WebviewTag | null): void => {
    wvRef.current = el
    if (el) {
      ready.current = false
      requested.current = null
    }
    setWv(el)
  }, [])

  // seed a fresh element, and follow later requests on a mounted one (PR → Linear)
  useEffect(() => {
    const el = wvRef.current
    if (el && url && requested.current !== url) {
      requested.current = url
      el.src = url
    }
  }, [wv, url])

  useEffect(() => {
    if (!wv) return
    ready.current = false
    const sync = (): void => {
      if (ready.current) setCanBack(wv.canGoBack())
    }
    const onReady = (): void => {
      ready.current = true
      sync()
    }
    const onStart = (): void => setLoading(true)
    const onStop = (): void => {
      setLoading(false)
      sync()
    }
    wv.addEventListener('dom-ready', onReady)
    wv.addEventListener('did-navigate', sync)
    wv.addEventListener('did-navigate-in-page', sync)
    wv.addEventListener('did-start-loading', onStart)
    wv.addEventListener('did-stop-loading', onStop)
    return () => {
      wv.removeEventListener('dom-ready', onReady)
      wv.removeEventListener('did-navigate', sync)
      wv.removeEventListener('did-navigate-in-page', sync)
      wv.removeEventListener('did-start-loading', onStart)
      wv.removeEventListener('did-stop-loading', onStop)
    }
  }, [wv])

  const openInPanel = (): void => {
    const current = ready.current && wv ? wv.getURL() : url
    if (!current) return
    useApp.getState().openBrowser(current)
    onClose()
  }

  return (
    <Dock
      open={Boolean(url)}
      label="browser"
      storageKey="sully:browser-dock"
      fallback={{ side: 'right', width: 560, height: 320 }}
      headerActions={
        <>
          <button onClick={() => wv?.goBack()} disabled={!canBack} title="Back" className={btnCls}>
            <ArrowLeft size={12} strokeWidth={1.8} />
          </button>
          <button onClick={() => ready.current && wv?.reload()} title="Reload" className={btnCls}>
            <RotateCw size={12} strokeWidth={1.8} className={cn(loading && 'animate-spin')} />
          </button>
          <button onClick={openInPanel} title="Open in the browser panel" className={btnCls}>
            <ExternalLink size={12} strokeWidth={1.8} />
          </button>
          <button onClick={onClose} title="Close the browser pane" className={btnCls}>
            <X size={12} strokeWidth={1.8} />
          </button>
        </>
      }
      pane={
        url ? (
          <webview ref={attach} partition="persist:browser" className="absolute inset-0" />
        ) : null
      }
    >
      {children}
    </Dock>
  )
}
