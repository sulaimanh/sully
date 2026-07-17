import { useState, type ReactElement } from 'react'
import { ChevronDown, ChevronUp, RefreshCw, TriangleAlert } from 'lucide-react'
import { useApp } from '../store'
import { Button } from '../lib/ui'

/** Sticky warning shown on every view while key tools are missing or unauthenticated. */
export default function ToolHealthBanner(): ReactElement | null {
  const toolHealth = useApp((s) => s.toolHealth)
  const setView = useApp((s) => s.setView)
  const [checking, setChecking] = useState(false)
  const [expanded, setExpanded] = useState(false)

  const failing = toolHealth?.checks.filter((c) => !c.ok) ?? []
  if (failing.length === 0) return null

  async function recheck(): Promise<void> {
    setChecking(true)
    try {
      await window.sully.runToolHealth()
    } finally {
      setChecking(false)
    }
  }

  return (
    <div className="mx-7 mb-3 rounded-xl border border-brass-500/40 bg-brass-500/10 px-4 py-2.5">
      <div className="flex items-center gap-3">
        <TriangleAlert size={15} className="shrink-0 text-brass-400" />
        <p className="min-w-0 flex-1 truncate text-[12px] text-ink-200">
          <span className="font-bold text-brass-300">
            {failing.length === 1 ? 'A key tool is unavailable' : 'Key tools are unavailable'} —
            sessions may get blocked:
          </span>{' '}
          {failing.map((c, i) => (
            <span key={c.id}>
              {i > 0 && <span className="text-ink-400"> · </span>}
              <span className="font-bold text-ink-100">{c.label}</span>
            </span>
          ))}
        </p>
        <div className="flex shrink-0 items-center gap-2">
          <Button
            onClick={() => setExpanded(!expanded)}
            title={expanded ? 'Hide the error details' : 'Show the error details'}
          >
            {expanded ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
            {expanded ? 'Hide details' : 'Details'}
          </Button>
          <Button onClick={() => void recheck()} disabled={checking} title="Re-run the checks now">
            <RefreshCw size={12} className={checking ? 'animate-spin' : undefined} />
            Recheck
          </Button>
          <Button onClick={() => setView('settings')}>Fix in Settings</Button>
        </div>
      </div>
      {expanded && (
        <div className="mt-2 flex flex-col gap-1.5 pl-[27px]">
          {failing.map((c) => (
            <div key={c.id} className="min-w-0 text-[11.5px] leading-relaxed">
              <span className="font-bold text-ink-100">{c.label}</span>
              <div className="mt-0.5 max-h-40 overflow-y-auto whitespace-pre-wrap break-all rounded-lg bg-ink-950/40 px-2.5 py-1.5 font-mono text-[10.5px] text-ink-300">
                {c.detail}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
