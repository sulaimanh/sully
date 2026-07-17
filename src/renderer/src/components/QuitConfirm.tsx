import { useEffect, useRef, type ReactElement } from 'react'
import { useApp } from '../store'
import { Button } from '../lib/ui'

/**
 * Close/quit confirmation — main intercepts every close and quit path (⌘W
 * fallback, red button, ⌘Q, menu, tray, dock) and shows this instead. Hide
 * keeps Sully running in the tray; quitting proceeds only via confirmQuit.
 */
export default function QuitConfirm(): ReactElement {
  const dismiss = useApp((s) => s.dismissConfirmQuit)
  const dialogRef = useRef<HTMLDivElement>(null)

  const hide = (): void => {
    dismiss()
    window.sully.hideWindow()
  }

  useEffect(() => {
    // focus the dialog so Enter/Escape work even if a webview held focus
    dialogRef.current?.focus()
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') dismiss()
      if (e.key === 'Enter') hide()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- hide is stable
  }, [dismiss])

  return (
    <div
      onClick={dismiss}
      className="fixed inset-0 z-[80] flex items-center justify-center bg-ink-950/80 p-10 backdrop-blur-sm"
    >
      <div
        ref={dialogRef}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        className="fade-up hairline-strong w-[420px] rounded-2xl border bg-ink-900 p-5 shadow-2xl outline-none"
      >
        <p className="font-display text-[17px] text-ink-50">Close Sully?</p>
        <p className="mt-1.5 text-[12.5px] leading-relaxed text-ink-300">
          Hide keeps everything running in the menu bar. Quit stops running agent sessions,
          terminals, and dev servers.
        </p>
        <div className="mt-4 flex items-center justify-end gap-2">
          <Button onClick={dismiss}>Cancel</Button>
          <Button variant="danger" onClick={() => void window.sully.confirmQuit()}>
            Quit
          </Button>
          <Button variant="primary" onClick={hide}>
            Hide to tray
          </Button>
        </div>
      </div>
    </div>
  )
}
