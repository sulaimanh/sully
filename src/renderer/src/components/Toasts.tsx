import type { ReactElement } from 'react'
import { CheckCircle2, TriangleAlert, X } from 'lucide-react'
import { useApp } from '../store'
import { cn } from '../lib/utils'

/** Transient feedback for user actions — success confirmations and IPC failures. */
export default function Toasts(): ReactElement | null {
  const toasts = useApp((s) => s.toasts)
  const dismiss = useApp((s) => s.dismissToast)
  if (toasts.length === 0) return null

  return (
    <div className="fixed bottom-5 right-5 z-[100] flex w-[360px] flex-col gap-2">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={cn(
            'fade-up flex items-start gap-2.5 rounded-xl border bg-ink-900 px-3.5 py-2.5 shadow-2xl',
            t.kind === 'error' ? 'border-terra-500/30' : 'border-sage-500/30'
          )}
        >
          {t.kind === 'error' ? (
            <TriangleAlert size={14} className="mt-0.5 shrink-0 text-terra-400" />
          ) : (
            <CheckCircle2 size={14} className="mt-0.5 shrink-0 text-sage-400" />
          )}
          <p className="selectable min-w-0 flex-1 break-words text-[12px] leading-snug text-ink-100">
            {t.text}
          </p>
          <button
            onClick={() => dismiss(t.id)}
            className="shrink-0 text-ink-400 hover:text-ink-100"
            aria-label="Dismiss"
          >
            <X size={13} />
          </button>
        </div>
      ))}
    </div>
  )
}
