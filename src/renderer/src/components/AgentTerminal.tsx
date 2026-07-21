import { useEffect, useState, type ReactElement, type ReactNode } from 'react'
import { RotateCcw, SquareTerminal } from 'lucide-react'
import type { TerminalInfo } from '@shared/types'
import { useApp } from '../store'
import { Button } from '../lib/ui'
import SplitTerminal from './SplitTerminal'

/**
 * The ticket's interactive claude terminal: a pty in the issue's worktree that
 * auto-runs `claude --resume` on the ticket's conversation (fresh session when
 * no transcript is local). One per issue — the pty is shared with the Terminal
 * view's "<identifier> · claude" tab and keeps running when this unmounts.
 *
 * Renders on the near-black term screen (bg-term) so a pty region reads as a
 * distinct surface wherever it's embedded.
 */
export default function AgentTerminal({ issueId }: { issueId: string }): ReactElement {
  const [term, setTerm] = useState<TerminalInfo | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0) // bumped by "Try again" / "New session"
  // pruned from termTabs when the shell exits — offer a fresh session then
  const alive = useApp((s) => (term ? s.termTabs.some((t) => t.id === term.id) : false))
  // no worktree recorded yet means opening includes cutting the branch,
  // creating the worktree, and installing deps — tell the user why it's slow
  const creatingWorktree = useApp((s) =>
    Boolean(s.issues[issueId] && !s.issues[issueId].worktreePath)
  )

  useEffect(() => {
    let cancelled = false
    window.sully
      .termCreateAgentForIssue(issueId)
      .then((info) => {
        if (cancelled) return
        useApp.getState().termOpened(info) // register as a Terminal-view tab too
        setTerm(info)
        setError(null)
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err))
      })
    return () => {
      cancelled = true
    }
  }, [issueId, attempt])

  const retry = (): void => {
    setError(null)
    setAttempt((a) => a + 1)
  }

  let body: ReactNode
  if (error) {
    body = (
      <div className="flex h-full flex-col items-center justify-center gap-3">
        <p className="font-display text-[18px] text-ink-300">couldn&apos;t open the terminal</p>
        <p className="max-w-[420px] text-center text-[12.5px] text-ink-400">{error}</p>
        <Button onClick={retry}>
          <RotateCcw size={11} /> Try again
        </Button>
      </div>
    )
  } else if (term && alive) {
    body = <SplitTerminal rootId={term.id} active />
  } else if (term) {
    body = (
      <div className="flex h-full flex-col items-center justify-center gap-3">
        <p className="font-display text-[18px] text-ink-300">session ended</p>
        <Button onClick={retry}>
          <SquareTerminal size={11} /> New session
        </Button>
      </div>
    )
  } else {
    body = (
      <div className="flex h-full flex-col items-center justify-center gap-1.5">
        <p className="breathe font-display text-[15px] text-ink-300">
          {creatingWorktree ? 'setting up the worktree…' : 'opening terminal…'}
        </p>
        {creatingWorktree && (
          <p className="text-[11.5px] text-ink-400">
            fetching origin, cutting the branch, installing dependencies
          </p>
        )}
      </div>
    )
  }

  return <div className="h-full min-h-0 bg-term p-2">{body}</div>
}
