import { useEffect, useRef, useState, type ReactElement } from 'react'
import { Terminal, type ITheme } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebglAddon } from '@xterm/addon-webgl'
import { useApp } from '../store'
import { cn } from '../lib/utils'
import '@xterm/xterm/css/xterm.css'

// single-quote a path unless it's already shell-safe, so dropped files paste cleanly
function shellQuote(path: string): string {
  if (/^[A-Za-z0-9_./~-]+$/.test(path)) return path
  return `'${path.replaceAll("'", "'\\''")}'`
}

// mirrors the GitHub Dark/Light palettes in main.css so the terminal sits in
// the same room; background must match --color-term there — the frame around
// the pty uses bg-term, and the two have to read as one seamless screen
function themeFor(light: boolean): ITheme {
  return light
    ? {
        background: '#ffffff',
        foreground: '#1f2328',
        cursor: '#0969da',
        cursorAccent: '#ffffff',
        selectionBackground: 'rgba(84, 174, 255, 0.4)',
        black: '#24292f',
        red: '#cf222e',
        green: '#116329',
        yellow: '#4d2d00',
        blue: '#0969da',
        magenta: '#8250df',
        cyan: '#1b7c83',
        white: '#6e7781',
        brightBlack: '#57606a',
        brightRed: '#a40e26',
        brightGreen: '#1a7f37',
        brightYellow: '#633c01',
        brightBlue: '#218bff',
        brightMagenta: '#a475f9',
        brightCyan: '#3192aa',
        brightWhite: '#8c959f'
      }
    : {
        background: '#010409',
        foreground: '#e6edf3',
        cursor: '#58a6ff',
        cursorAccent: '#010409',
        selectionBackground: 'rgba(56, 139, 253, 0.4)',
        black: '#484f58',
        red: '#ff7b72',
        green: '#3fb950',
        yellow: '#d29922',
        blue: '#58a6ff',
        magenta: '#bc8cff',
        cyan: '#39c5cf',
        white: '#b1bac4',
        brightBlack: '#6e7681',
        brightRed: '#ffa198',
        brightGreen: '#56d364',
        brightYellow: '#e3b341',
        brightBlue: '#79c0ff',
        brightMagenta: '#d2a8ff',
        brightCyan: '#56d4dd',
        brightWhite: '#ffffff'
      }
}

/**
 * One xterm.js surface attached to a main-process pty. Stays mounted (hidden
 * via CSS) while its tab is inactive so scrollback and cursor state persist.
 * `visible` gates fitting (a hidden pane measures 0×0); `focused` marks the
 * pane that owns the keyboard within a split layout.
 */
export default function TerminalPane({
  id,
  visible,
  focused
}: {
  id: string
  visible: boolean
  focused: boolean
}): ReactElement {
  const hostRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const webglRef = useRef<WebglAddon | null>(null)
  const theme = useApp((s) => s.settings?.theme ?? 'dark')
  // real keyboard focus (xterm's hidden textarea), not the split-layout's
  // focused pane — drives the dimming shade over inactive terminals
  const [hasFocus, setHasFocus] = useState(false)

  useEffect(() => {
    const host = hostRef.current
    if (!host) return undefined

    const term = new Terminal({
      fontFamily: "'Red Hat Mono', 'SF Mono', monospace",
      fontSize: 12.5,
      lineHeight: 1.25,
      cursorBlink: true,
      scrollback: 5000,
      macOptionIsMeta: true,
      theme: themeFor(document.documentElement.classList.contains('light'))
    })
    term.attachCustomKeyEventHandler((e) => {
      // shift+enter inserts a newline instead of submitting: send LF (ctrl+j),
      // Claude Code's universally supported line-break sequence. Must swallow
      // the keypress event too, or xterm still emits \r after our \n
      if (e.key === 'Enter' && e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
        if (e.type === 'keydown') window.sully.termWrite(id, '\n')
        return false
      }
      if (e.type !== 'keydown') return true
      // let ⌘D / ⌘⇧D bubble to SplitTerminal instead of xterm handling them
      if (e.metaKey && !e.ctrlKey && !e.altKey && e.key.toLowerCase() === 'd') return false
      return true
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(host)
    termRef.current = term
    fitRef.current = fit

    // replay scrollback (re-attach after a view remount or window reload)
    void window.sully.termBuffer(id).then((buf) => {
      if (buf) term.write(buf)
    })

    term.onData((data) => window.sully.termWrite(id, data))
    term.onResize(({ cols, rows }) => window.sully.termResize(id, cols, rows))
    const offData = window.sully.onTermData((p) => {
      if (p.id === id) term.write(p.data)
    })

    const refit = (): void => {
      // fit() while display:none proposes 0×0 — only fit when measurable
      if (host.clientWidth > 0 && host.clientHeight > 0) fit.fit()
    }
    const ro = new ResizeObserver(refit)
    ro.observe(host)
    refit()

    // dropping files (e.g. screenshots for Claude Code) pastes their paths;
    // paste() respects bracketed paste mode so the CLI sees one paste, not keystrokes
    const onDragOver = (e: DragEvent): void => e.preventDefault()
    const onDrop = (e: DragEvent): void => {
      e.preventDefault()
      const paths = Array.from(e.dataTransfer?.files ?? [])
        .map((f) => window.sully.pathForFile(f))
        .filter(Boolean)
      if (paths.length === 0) return
      term.paste(paths.map(shellQuote).join(' ') + ' ')
      term.focus()
    }
    host.addEventListener('dragover', onDragOver)
    host.addEventListener('drop', onDrop)

    // macOS can wipe the WebGL glyph atlas while the app is backgrounded
    // without firing a context-loss event, leaving mostly-blank text on
    // return — rebuild the atlas whenever the window regains focus
    const onWindowFocus = (): void => {
      term.clearTextureAtlas()
      term.refresh(0, term.rows - 1)
    }
    window.addEventListener('focus', onWindowFocus)

    return () => {
      offData()
      window.removeEventListener('focus', onWindowFocus)
      host.removeEventListener('dragover', onDragOver)
      host.removeEventListener('drop', onDrop)
      ro.disconnect()
      term.dispose() // also disposes any loaded addons, incl. webgl
      webglRef.current = null
      termRef.current = null
      fitRef.current = null
    }
  }, [id])

  // WebGL only while on screen: Chromium caps a page at 16 live WebGL
  // contexts and kills the oldest past that, so panes accumulating in the
  // always-mounted Terminal view corrupt whichever terminal the user is
  // looking at. Hidden panes ride the (idle) DOM renderer instead.
  useEffect(() => {
    const term = termRef.current
    if (!term) return
    if (visible && !webglRef.current) {
      try {
        const webgl = new WebglAddon()
        // GPU/display switches can kill the context; fall back to the DOM renderer
        webgl.onContextLoss(() => {
          webgl.dispose()
          if (webglRef.current === webgl) webglRef.current = null
        })
        term.loadAddon(webgl)
        webglRef.current = webgl
      } catch {
        // WebGL unavailable — xterm falls back to the DOM renderer
      }
      // repair any atlas corruption that happened while hidden
      term.clearTextureAtlas()
      term.refresh(0, term.rows - 1)
    } else if (!visible && webglRef.current) {
      webglRef.current.dispose()
      webglRef.current = null
    }
  }, [visible, id])

  useEffect(() => {
    const term = termRef.current
    if (term) term.options.theme = themeFor(theme === 'light')
  }, [theme])

  useEffect(() => {
    if (!visible) return
    const host = hostRef.current
    if (host && host.clientWidth > 0 && host.clientHeight > 0) fitRef.current?.fit()
    if (focused) termRef.current?.focus()
  }, [visible, focused])

  return (
    <div
      className={visible ? 'relative h-full w-full' : 'hidden'}
      onFocusCapture={() => setHasFocus(true)}
      onBlurCapture={() => setHasFocus(false)}
    >
      <div
        ref={hostRef}
        // lets the global ⌘W handler find the pane owning keyboard focus
        data-term-id={id}
        className="h-full w-full"
        // xterm draws its own selection; re-enable text cursor affordances inside
        style={{ cursor: 'text' }}
      />
      {/* unfocused terminals sit behind a faint shade so the pane owning the
          keyboard is obvious; clicks pass through to focus the terminal */}
      <div
        className={cn(
          'term-shade pointer-events-none absolute inset-0 transition-opacity duration-200',
          hasFocus ? 'opacity-0' : 'opacity-100'
        )}
      />
    </div>
  )
}
