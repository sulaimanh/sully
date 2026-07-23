import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type ReactElement
} from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import {
  CircleCheck,
  CircleHelp,
  Copy,
  ExternalLink,
  FileText,
  GitCommitHorizontal,
  GitPullRequest,
  MapPin,
  MessageSquarePlus,
  MessagesSquare,
  MoreHorizontal,
  Pencil,
  Play,
  Plus,
  Rocket,
  RotateCcw,
  RotateCw,
  ScrollText,
  Square,
  SquareTerminal,
  ThumbsUp,
  Trash2,
  TriangleAlert,
  X
} from 'lucide-react'
import type {
  BoardColumn,
  DeployBump,
  DevServer,
  FigmaCommentItem,
  GhReviewItem,
  IssueComment,
  IssuePhase,
  Session,
  TrackedIssue
} from '@shared/types'
import { call, issueList, useApp } from '../store'
import { Button, EmptyState, Vu } from '../lib/ui'
import { cn, timeAgo } from '../lib/utils'
import LogViewer from '../components/LogViewer'
import DockablePanel, { DockControls } from '../components/DockablePanel'
import AgentTerminal from '../components/AgentTerminal'
import NewTicketDialog from '../components/NewTicketDialog'
import PlanSelectionMenu, { type PlanSelectionAction } from '../components/PlanSelectionMenu'
import TerminalDock from '../components/TerminalDock'
import BrowserDock from '../components/BrowserDock'

const COLUMNS: Array<{
  key: BoardColumn
  phase: IssuePhase[]
  title: string
  accent: string
  hint: string
}> = [
  {
    key: 'uncategorized',
    phase: ['uncategorized'],
    title: 'Uncategorized',
    accent: 'bg-ink-500',
    hint: 'parked — Sully leaves these alone'
  },
  {
    key: 'planning',
    phase: ['planning', 'plan_questions'],
    title: 'Planning',
    accent: 'bg-brass-400',
    hint: 'sessions draft a plan'
  },
  {
    key: 'planReady',
    phase: ['plan_ready'],
    title: 'Plan ready',
    accent: 'bg-plan-400',
    hint: 'awaiting your approval'
  },
  {
    key: 'inProgress',
    phase: ['coding', 'reprompting'],
    title: 'In progress',
    accent: 'bg-mist-400',
    hint: 'implementing the plan'
  },
  {
    key: 'inReview',
    phase: ['in_review'],
    title: 'In review',
    accent: 'bg-sage-400',
    hint: 'PR is up'
  }
]

/** Column a phase renders in — error cards live in the attention strip instead. */
const COLUMN_FOR_PHASE: Partial<Record<IssuePhase, BoardColumn>> = {
  uncategorized: 'uncategorized',
  planning: 'planning',
  plan_questions: 'planning',
  plan_ready: 'planReady',
  coding: 'inProgress',
  reprompting: 'inProgress',
  in_review: 'inReview'
}

/**
 * In-app conversation with the agent about a ticket. Routes by phase:
 * plan_ready → plan feedback session, in_review → reprompt session. Replies
 * land back in issue.chat (never in Linear) and stream in via issueUpdated.
 */
function ChatPanel({ issue, fill = false }: { issue: TrackedIssue; fill?: boolean }): ReactElement {
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const endRef = useRef<HTMLDivElement>(null)
  const chat = issue.chat ?? []
  const busy = sending || Boolean(issue.activeSessionId)
  const waiting = busy && chat[chat.length - 1]?.role === 'user'
  const canChat = !busy && (issue.phase === 'plan_ready' || issue.phase === 'in_review')

  // live view of the running session: each assistant turn streams in as
  // Claude emits it; the persisted reply replaces it when the session ends
  const activeSession = useApp((s) =>
    issue.activeSessionId ? s.sessions[issue.activeSessionId] : undefined
  )
  const liveEvents = useApp((s) =>
    issue.activeSessionId ? s.sessionEvents[issue.activeSessionId] : undefined
  )
  const stoppable =
    waiting &&
    activeSession?.status === 'running' &&
    (activeSession.kind === 'plan_feedback' || activeSession.kind === 'reprompt')
  const liveText = waiting
    ? [...(liveEvents ?? [])].reverse().find((e) => e.kind === 'text')?.text
    : undefined
  const liveTool = waiting
    ? [...(liveEvents ?? [])].reverse().find((e) => e.kind === 'tool')?.text
    : undefined

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'nearest' })
  }, [chat.length, waiting, liveText, liveTool])

  const send = async (): Promise<void> => {
    const msg = text.trim()
    if (!msg || !canChat) return
    setText('')
    setSending(true)
    try {
      if (issue.phase === 'plan_ready') await call(window.sully.planFeedback(issue.issueId, msg))
      else await call(window.sully.repromptIssue(issue.issueId, msg))
    } finally {
      setSending(false)
    }
  }

  const placeholder = !canChat
    ? waiting
      ? 'waiting for the agent…'
      : 'the agent is busy…'
    : issue.phase === 'plan_ready'
      ? 'Ask about the plan or request a change…'
      : 'Ask about the implementation or request a change…'

  return (
    <div className={cn('flex min-h-0 flex-col', fill && 'flex-1')}>
      {(fill || chat.length > 0 || waiting) && (
        <div
          className={cn(
            'hairline min-h-0 overflow-y-auto border-t px-5 py-3',
            fill ? 'flex-1' : 'max-h-[320px]'
          )}
        >
          <div className="flex flex-col gap-2.5">
            {chat.map((m, i) =>
              m.role === 'user' ? (
                <div
                  key={i}
                  className="ml-12 self-end whitespace-pre-wrap rounded-lg bg-brass-500/10 px-3 py-2 text-[12.5px] leading-relaxed text-ink-100"
                >
                  {m.text}
                </div>
              ) : (
                <div key={i} className="prose-plan mr-8 self-start text-[12.5px]">
                  <ReactMarkdown>{m.text}</ReactMarkdown>
                </div>
              )
            )}
            {waiting && (
              <>
                {liveText && (
                  <div className="prose-plan mr-8 self-start text-[12.5px] opacity-60">
                    <ReactMarkdown>{liveText}</ReactMarkdown>
                  </div>
                )}
                <span className="flex min-w-0 items-center gap-1.5 py-1 text-[11px] text-brass-300">
                  <Vu />
                  {liveTool ? (
                    <span className="truncate font-mono text-[10.5px] text-ink-300">
                      {liveTool}
                    </span>
                  ) : (
                    'thinking…'
                  )}
                </span>
              </>
            )}
            <div ref={endRef} />
          </div>
        </div>
      )}
      <div className="hairline flex items-end gap-2 border-t px-4 py-3">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              void send()
            }
          }}
          placeholder={placeholder}
          spellCheck={false}
          rows={2}
          disabled={!canChat}
          className="hairline flex-1 resize-none rounded-lg border bg-ink-950/40 px-3 py-2 text-[12.5px] leading-relaxed text-ink-100 outline-none focus:border-brass-500/40 disabled:opacity-50"
        />
        {stoppable ? (
          <Button
            variant="danger"
            onClick={() => {
              if (issue.activeSessionId) void call(window.sully.stopSession(issue.activeSessionId))
            }}
            title="Stop the agent"
          >
            <Square size={11} /> Stop
          </Button>
        ) : (
          <Button variant="primary" onClick={() => void send()} disabled={!canChat || !text.trim()}>
            <MessageSquarePlus size={12} /> Send
          </Button>
        )}
      </div>
    </div>
  )
}

/** Keep in sync with PLAN_FILE_REL in src/main/orchestrator/prompts.ts. */
const PLAN_FILE = '.sully/plan.md'

/**
 * Uncommitted file count in the ticket's worktree — drives the commit & push
 * buttons; re-checked when a session starts or finishes, and polled so changes
 * made outside a session (manual edits) still surface the button.
 */
function useLocalChanges(issue: TrackedIssue): number {
  const [count, setCount] = useState(0)
  useEffect(() => {
    let cancelled = false
    const fetchCount = (): void => {
      window.sully
        .issueLocalChanges(issue.issueId)
        .then((n) => {
          if (!cancelled) setCount(n)
        })
        .catch(() => {})
    }
    fetchCount()
    const id = setInterval(fetchCount, 5000)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [issue.issueId, issue.activeSessionId])
  return count
}

function CommitPushButton({
  issue,
  localChanges,
  full = false
}: {
  issue: TrackedIssue
  localChanges: number
  /** full-width row on the board card; default is the dialog's inline button */
  full?: boolean
}): ReactElement | null {
  if (!issue.repoPath || localChanges === 0) return null
  const files = `${localChanges} changed file${localChanges === 1 ? '' : 's'}`
  return (
    <Button
      className={full ? 'mt-2.5 w-full justify-center' : undefined}
      disabled={Boolean(issue.activeSessionId)}
      onClick={() =>
        void call(
          window.sully.commitPushIssue(issue.issueId),
          `Committing & pushing ${issue.identifier}`
        )
      }
      title={`Commit the worktree's local changes (${files}) and push the branch to origin`}
    >
      <GitCommitHorizontal size={13} />
      {full ? 'Commit & push' : `Commit & push (${files})`}
    </Button>
  )
}

function PlanDialog({
  issue,
  onClose
}: {
  issue: TrackedIssue
  onClose: () => void
}): ReactElement {
  const [draft, setDraft] = useState<string | null>(null) // null = viewing
  const [saving, setSaving] = useState(false)
  const [rewriting, setRewriting] = useState(false)
  const [rewriteText, setRewriteText] = useState('')
  // closing only hides the pane — the pty keeps running and reattaches with
  // its scrollback when reopened
  const [termOpen, setTermOpen] = useState(false)
  const proseRef = useRef<HTMLDivElement>(null)
  const body = (issue.planBody ?? '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/^## Implementation plan \((?:Conductor|Sully)\)\s*/m, '')
    .trim()
  const editable = issue.phase === 'plan_ready' && !issue.activeSessionId
  // highlight-to-reprompt: repo tickets talk to the agent terminal below (fine
  // while a headless session runs); repo-less tickets go through planFeedback,
  // which refuses while a session is active
  const selectable =
    draft === null &&
    issue.phase === 'plan_ready' &&
    (Boolean(issue.repoPath) || !issue.activeSessionId)

  const save = async (): Promise<void> => {
    if (draft === null || !draft.trim()) return
    setSaving(true)
    try {
      const ok = await call(window.sully.updatePlan(issue.issueId, draft), 'Plan saved')
      if (ok) setDraft(null)
    } finally {
      setSaving(false)
    }
  }

  const rewrite = async (): Promise<void> => {
    await call(
      window.sully.rewritePlan(issue.issueId, rewriteText.trim() || undefined),
      `${issue.identifier} — rewriting plan`
    )
    onClose()
  }

  const actOnSelection = async ({ selection, instruction }: PlanSelectionAction): Promise<void> => {
    const quote = selection
      .split('\n')
      .map((l) => `> ${l}`)
      .join('\n')
    if (issue.repoPath) {
      // paste into the ticket's interactive claude terminal (mounted below) and
      // submit — the user watches the agent respond right under the plan
      setTermOpen(true)
      const message = [
        `Regarding this section of the implementation plan (${PLAN_FILE}):`,
        '',
        quote,
        '',
        instruction,
        '',
        `If this needs a plan change, edit ${PLAN_FILE} (keep its structure: context, files to change, step-by-step implementation, verification) — do NOT implement anything yet. If it's a question, just answer here.`
      ].join('\n')
      await call(
        window.sully.termCreateAgentForIssue(issue.issueId).then((info) => {
          useApp.getState().termOpened(info)
          window.sully.termWrite(info.id, `\x1b[200~${message}\x1b[201~`)
          // let claude ingest the bracketed paste before the enter keystroke
          setTimeout(() => window.sully.termWrite(info.id, '\r'), 250)
        }),
        'Sent to the agent terminal below'
      )
    } else {
      // headless plan-feedback session — the reply streams into the chat below
      await call(
        window.sully.planFeedback(
          issue.issueId,
          `Regarding this section of the plan:\n\n${quote}\n\n${instruction}`
        )
      )
    }
  }

  return (
    <DockablePanel
      id="plan"
      modalClassName="h-[min(920px,90vh)] w-[min(1100px,92vw)] min-h-[420px] min-w-[520px]"
      minWidth={520}
      minHeight={420}
      onClose={onClose}
    >
      <header className="hairline flex flex-col gap-3 border-b px-6 py-4">
        <div className="selectable">
          <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-brass-400">
            implementation plan
          </p>
          <h3 className="mt-0.5 font-display text-[19px] text-ink-50">
            {issue.identifier} — {issue.title}
          </h3>
          {selectable && (
            <p className="mt-1 text-[10.5px] italic text-ink-400">
              highlight any part of the plan to explain, revise, or remove it
            </p>
          )}
        </div>
        <div className="flex items-center gap-3 self-end">
          <DockControls />
          <button onClick={onClose} className="text-ink-300 hover:text-ink-50">
            <X size={17} />
          </button>
        </div>
      </header>
      {/* the agent terminal docks around the plan; tickets with no repo mapped
            can't spawn a worktree shell, so they keep the headless chat */}
      <TerminalDock
        issueId={issue.issueId}
        open={termOpen && draft === null && issue.phase !== 'planning' && Boolean(issue.repoPath)}
      >
        {draft !== null ? (
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            spellCheck={false}
            autoFocus
            className="hairline min-h-0 flex-1 resize-none bg-ink-950/40 px-6 py-4 font-mono text-[12px] leading-relaxed text-ink-100 outline-none"
          />
        ) : (
          <div
            ref={proseRef}
            className="prose-plan selectable min-h-0 flex-1 overflow-y-auto px-6 py-4 text-[13px]"
          >
            {body ? (
              <ReactMarkdown>{body}</ReactMarkdown>
            ) : (
              <p className="italic">No plan captured.</p>
            )}
          </div>
        )}
        <PlanSelectionMenu
          containerRef={proseRef}
          disabled={!selectable}
          onAction={(a) => void actOnSelection(a)}
        />
      </TerminalDock>
      {draft === null && issue.phase !== 'planning' && !issue.repoPath && (
        <ChatPanel issue={issue} />
      )}
      {(issue.phase === 'plan_ready' || (issue.repoPath && issue.phase !== 'planning')) && (
        <footer className="hairline flex items-center justify-end gap-2 border-t px-6 py-3.5">
          {draft !== null ? (
            <>
              <Button onClick={() => setDraft(null)} disabled={saving}>
                Cancel
              </Button>
              <Button variant="primary" onClick={() => void save()} disabled={saving}>
                {saving ? 'Saving…' : 'Save plan'}
              </Button>
            </>
          ) : rewriting ? (
            <>
              <input
                value={rewriteText}
                onChange={(e) => setRewriteText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    void rewrite()
                  }
                }}
                placeholder="Optional: what should be different this time?"
                spellCheck={false}
                autoFocus
                className="hairline flex-1 rounded-lg border bg-ink-950/40 px-3 py-2 text-[12.5px] leading-relaxed text-ink-100 outline-none focus:border-brass-500/40"
              />
              <Button onClick={() => setRewriting(false)}>Cancel</Button>
              <Button variant="primary" onClick={() => void rewrite()}>
                <RotateCcw size={11} /> Rewrite plan
              </Button>
            </>
          ) : (
            <>
              <div className="mr-auto flex items-center gap-2">
                {issue.repoPath && (
                  <Button
                    onClick={() => setTermOpen(!termOpen)}
                    title={termOpen ? 'Hide the agent terminal' : 'Show the agent terminal'}
                  >
                    <SquareTerminal size={12} /> {termOpen ? 'Hide terminal' : 'Terminal'}
                  </Button>
                )}
                {editable && (
                  <>
                    <Button onClick={() => setDraft(body)}>
                      <Pencil size={11} /> Edit plan
                    </Button>
                    {issue.repoPath && (
                      <Button
                        onClick={() => setRewriting(true)}
                        title="Throw this plan away and have a fresh session write a new one"
                      >
                        <RotateCcw size={11} /> Rewrite plan
                      </Button>
                    )}
                  </>
                )}
              </div>
              {issue.phase === 'plan_ready' && (
                <>
                  <Button onClick={onClose}>Close</Button>
                  <Button
                    variant="primary"
                    onClick={() => {
                      void call(
                        window.sully.approvePlan(issue.issueId),
                        `${issue.identifier} approved — coding started`
                      )
                      onClose()
                    }}
                  >
                    <ThumbsUp size={12} /> Approve &amp; start coding
                  </Button>
                </>
              )}
            </>
          )}
        </footer>
      )}
    </DockablePanel>
  )
}

/**
 * The planning session paused with blocking questions instead of guessing.
 * Each question renders with the agent's context and suggested options; a
 * click on an option fills the answer, which stays editable. Submitting
 * resumes the planning conversation with all answers in one turn.
 */
function PlanQuestionsDialog({
  issue,
  onClose
}: {
  issue: TrackedIssue
  onClose: () => void
}): ReactElement {
  const questions = issue.planQuestions ?? []
  const [answers, setAnswers] = useState<Record<string, string>>({})
  const allAnswered = questions.length > 0 && questions.every((q) => Boolean(answers[q.id]?.trim()))

  const send = (): void => {
    void call(
      window.sully.answerPlanQuestions(
        issue.issueId,
        questions.map((q) => ({ id: q.id, answer: answers[q.id]?.trim() ?? '' }))
      ),
      `Answers sent — planning ${issue.identifier} resumes`
    )
    onClose()
  }

  return (
    <DockablePanel
      id="plan-questions"
      modalClassName="max-h-[88vh] w-[min(880px,90vw)] min-h-[380px] min-w-[480px]"
      minWidth={480}
      minHeight={380}
      onClose={onClose}
    >
      <header className="hairline flex flex-col gap-3 border-b px-6 py-4">
        <div className="selectable">
          <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-brass-400">
            agent questions
          </p>
          <h3 className="mt-0.5 font-display text-[19px] text-ink-50">
            {issue.identifier} — {issue.title}
          </h3>
          <p className="mt-1 text-[10.5px] italic text-ink-400">
            the agent paused planning to ask instead of guessing — your answers shape the plan
          </p>
        </div>
        <div className="flex items-center gap-3 self-end">
          <DockControls />
          <button onClick={onClose} className="text-ink-300 hover:text-ink-50">
            <X size={17} />
          </button>
        </div>
      </header>

      <div className="selectable min-h-0 flex-1 overflow-y-auto px-6 py-4">
        <div className="flex flex-col gap-4">
          {questions.map((q, idx) => (
            <div key={q.id} className="hairline rounded-xl border bg-ink-850 p-4">
              <p className="text-[13px] leading-snug text-ink-50">
                <span className="mr-1.5 font-mono text-[11px] text-brass-300">{idx + 1}.</span>
                {q.question}
              </p>
              {q.context && (
                <p className="mt-1.5 text-[11.5px] italic leading-snug text-ink-300">{q.context}</p>
              )}
              {(q.options?.length ?? 0) > 0 && (
                <div className="mt-2.5 flex flex-wrap gap-1.5">
                  {q.options!.map((opt) => (
                    <button
                      key={opt}
                      onClick={() => setAnswers((a) => ({ ...a, [q.id]: opt }))}
                      className={cn(
                        'hairline rounded-lg border px-2.5 py-1 text-left text-[11.5px] transition-colors',
                        answers[q.id] === opt
                          ? 'border-brass-500/40 bg-brass-500/10 text-brass-300'
                          : 'text-ink-200 hover:border-ink-600 hover:text-ink-50'
                      )}
                    >
                      {opt}
                    </button>
                  ))}
                </div>
              )}
              <textarea
                value={answers[q.id] ?? ''}
                onChange={(e) => setAnswers((a) => ({ ...a, [q.id]: e.target.value }))}
                placeholder="Your answer…"
                spellCheck={false}
                rows={2}
                className="hairline mt-2.5 w-full resize-none rounded-lg border bg-ink-950/40 px-3 py-2 text-[12.5px] leading-relaxed text-ink-100 outline-none focus:border-brass-500/40"
              />
            </div>
          ))}
        </div>
      </div>

      <footer className="hairline flex items-center justify-between border-t px-6 py-3.5">
        <span className="text-[11px] text-ink-400">
          {questions.filter((q) => answers[q.id]?.trim()).length} of {questions.length} answered
        </span>
        <div className="flex items-center gap-2">
          <Button onClick={onClose}>Close</Button>
          <Button variant="primary" disabled={!allAnswered} onClick={send}>
            <MessageSquarePlus size={12} /> Send answers &amp; resume planning
          </Button>
        </div>
      </footer>
    </DockablePanel>
  )
}

/**
 * "Chat with the agent" is an actual terminal: an interactive claude session
 * in the ticket's worktree, resuming the ticket's conversation when possible.
 * The pty is shared with the Terminal view's "<identifier> · claude" tab, so
 * the session keeps running after the dialog closes.
 */
function RepromptDialog({
  issue,
  onClose
}: {
  issue: TrackedIssue
  onClose: () => void
}): ReactElement {
  return (
    <DockablePanel
      id="agent-chat"
      modalClassName="h-[min(820px,88vh)] w-[min(920px,90vw)] min-h-[380px] min-w-[480px]"
      minWidth={480}
      minHeight={380}
      onClose={onClose}
    >
      <header className="hairline flex flex-col gap-3 border-b px-6 py-4">
        <div>
          <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-brass-400">
            chat with the agent
          </p>
          <h3 className="mt-0.5 font-display text-[19px] text-ink-50">
            {issue.identifier} — {issue.title}
          </h3>
        </div>
        <div className="flex items-center gap-3 self-end">
          <DockControls />
          <button onClick={onClose} className="text-ink-300 hover:text-ink-50">
            <X size={17} />
          </button>
        </div>
      </header>
      <div className="min-h-0 flex-1">
        <AgentTerminal issueId={issue.issueId} />
      </div>
    </DockablePanel>
  )
}

/**
 * Open GitHub PR review comments (auto-refreshed by the orchestrator poll) as
 * individually addressable items. Pick a subset and "Address selected"
 * dispatches an in-app reprompt for just those. The chat below routes to the
 * reprompt flow too, so freeform follow-ups work from here.
 */
function GhReviewDialog({
  issue,
  onClose
}: {
  issue: TrackedIssue
  onClose: () => void
}): ReactElement {
  const busy = Boolean(issue.activeSessionId)
  const items = issue.ghReviewItems ?? []
  // newest first; addressed items sink to the bottom as a display-only record
  const byNewest = (a: GhReviewItem, b: GhReviewItem): number =>
    (b.createdAt ?? '').localeCompare(a.createdAt ?? '')
  const open = items.filter((i) => !i.addressedAt).sort(byNewest)
  const addressed = items.filter((i) => i.addressedAt).sort(byNewest)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [termOpen, setTermOpen] = useState(false)

  // the poll refreshes items in place (ids are stable) — drop picks whose
  // comment disappeared (resolved/deleted) or got addressed, keep the rest
  const [seenItems, setSeenItems] = useState(issue.ghReviewItems)
  if (seenItems !== issue.ghReviewItems) {
    setSeenItems(issue.ghReviewItems)
    setSelected(new Set([...selected].filter((id) => open.some((i) => i.id === id))))
  }

  const toggle = (id: string): void => {
    const next = new Set(selected)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    setSelected(next)
  }

  const address = (): void => {
    const ids = [...selected]
    setSelected(new Set())
    void call(
      window.sully.addressGhComments(issue.issueId, ids),
      `Addressing ${ids.length} review comment${ids.length === 1 ? '' : 's'} on ${issue.identifier}`
    )
  }

  return (
    <DockablePanel
      id="gh-review"
      modalClassName="h-[min(920px,90vh)] w-[min(1100px,92vw)] min-h-[420px] min-w-[520px]"
      minWidth={520}
      minHeight={420}
      onClose={onClose}
    >
      <header className="hairline flex flex-col gap-3 border-b px-6 py-4">
        <div className="selectable">
          <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-brass-400">
            github review
          </p>
          <h3 className="mt-0.5 font-display text-[19px] text-ink-50">
            {issue.identifier} — {issue.title}
          </h3>
        </div>
        <div className="flex items-center gap-3 self-end">
          <DockControls />
          <button onClick={onClose} className="text-ink-300 hover:text-ink-50">
            <X size={17} />
          </button>
        </div>
      </header>

      <TerminalDock issueId={issue.issueId} open={termOpen && Boolean(issue.repoPath)}>
        <div className="selectable min-h-0 flex-1 overflow-y-auto px-6 py-4">
          {items.length === 0 ? (
            <p className="font-display text-[13px] text-ink-400">
              No open review comments on the PR.
            </p>
          ) : (
            <div className="flex flex-col gap-2.5">
              {open.map((item) => (
                <label
                  key={item.id}
                  className={cn(
                    'hairline flex cursor-pointer gap-3 rounded-xl border bg-ink-850 p-3.5 transition-colors',
                    selected.has(item.id) ? 'border-brass-500/40' : 'hover:border-ink-600'
                  )}
                >
                  <input
                    type="checkbox"
                    className="mt-1 shrink-0"
                    checked={selected.has(item.id)}
                    onChange={() => toggle(item.id)}
                  />
                  <div className="min-w-0 flex-1">
                    <p className="font-mono text-[10.5px] text-ink-400">
                      {item.author && <span className="text-brass-300">{item.author}</span>}
                      {item.author && item.file && ' — '}
                      {item.file && `${item.file}${item.line ? `:${item.line}` : ''}`}
                    </p>
                    <div className="prose-plan mt-1 text-[12.5px]">
                      <ReactMarkdown>{item.comment}</ReactMarkdown>
                    </div>
                  </div>
                </label>
              ))}
              {addressed.length > 0 && (
                <p className="mt-2 font-mono text-[10.5px] uppercase tracking-[0.18em] text-ink-500">
                  addressed
                </p>
              )}
              {addressed.map((item) => (
                <div
                  key={item.id}
                  className="hairline flex gap-3 rounded-xl border bg-ink-850 p-3.5 opacity-55"
                >
                  <div className="min-w-0 flex-1">
                    <p className="font-mono text-[10.5px] text-ink-400">
                      {item.author && <span className="text-brass-300">{item.author}</span>}
                      {item.author && item.file && ' — '}
                      {item.file && `${item.file}${item.line ? `:${item.line}` : ''}`}
                      <span className="ml-2 rounded bg-ink-700 px-1.5 py-0.5 text-[9.5px] uppercase tracking-wide text-ink-200">
                        addressed {timeAgo(item.addressedAt!)}
                      </span>
                    </p>
                    <div className="prose-plan mt-1 text-[12.5px]">
                      <ReactMarkdown>{item.comment}</ReactMarkdown>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </TerminalDock>

      {(open.length > 0 || issue.repoPath) && (
        <footer className="hairline flex items-center justify-between border-t px-6 py-3">
          <div className="flex items-center gap-3">
            {issue.repoPath && (
              <Button
                onClick={() => setTermOpen(!termOpen)}
                title={termOpen ? 'Hide the agent terminal' : 'Show the agent terminal'}
              >
                <SquareTerminal size={12} /> {termOpen ? 'Hide terminal' : 'Terminal'}
              </Button>
            )}
            {open.length > 0 && (
              <button
                className="text-[11px] text-ink-400 hover:text-ink-100"
                onClick={() =>
                  setSelected(
                    selected.size === open.length ? new Set() : new Set(open.map((i) => i.id))
                  )
                }
              >
                {selected.size === open.length ? 'clear selection' : 'select all'}
              </button>
            )}
          </div>
          {open.length > 0 && (
            <Button variant="primary" disabled={busy || selected.size === 0} onClick={address}>
              <ThumbsUp size={11} /> Address selected ({selected.size})
            </Button>
          )}
        </footer>
      )}

      {/* same as PlanDialog: tickets with a repo get the dockable agent
            terminal (toggled from the footer, hidden by default), repo-less
            tickets keep the headless chat */}
      {!issue.repoPath && <ChatPanel issue={issue} />}
    </DockablePanel>
  )
}

/**
 * Markdown link renderer that opens http(s) links in the in-dialog browser
 * pane (same as the PR / Linear buttons) instead of navigating the app frame.
 */
function paneLinkComponents(open: (url: string) => void): Components {
  return {
    a: ({ href, children, ...props }) => (
      <a
        href={href}
        onClick={(e) => {
          if (href && /^https?:\/\//i.test(href)) {
            e.preventDefault()
            open(href)
          }
        }}
        {...props}
      >
        {children}
      </a>
    )
  }
}

function CommentBlock({
  comment,
  onOpenLink
}: {
  comment: IssueComment
  onOpenLink: (url: string) => void
}): ReactElement {
  const name = comment.authorName ?? 'Unknown'
  return (
    <div>
      <div className="flex items-center gap-2">
        <span className="flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full bg-ink-700 text-[9px] font-medium uppercase text-ink-200">
          {name.slice(0, 1)}
        </span>
        <span className="text-[12.5px] font-medium text-ink-100">{name}</span>
        <span className="text-[11px] text-ink-400">{timeAgo(comment.createdAt)}</span>
      </div>
      <div className="prose-plan mt-1.5 pl-[26px]">
        <ReactMarkdown components={paneLinkComponents(onOpenLink)}>{comment.body}</ReactMarkdown>
      </div>
    </div>
  )
}

/** Linear comments at the bottom of ticket details, threaded the way Linear shows them. */
function TicketComments({
  issueId,
  onOpenLink
}: {
  issueId: string
  onOpenLink: (url: string) => void
}): ReactElement {
  const [comments, setComments] = useState<IssueComment[] | null>(null)
  const [failed, setFailed] = useState(false)
  /** thread root the composer replies under — null posts a top-level comment */
  const [replyTo, setReplyTo] = useState<IssueComment | null>(null)
  const [draft, setDraft] = useState('')
  const [posting, setPosting] = useState(false)

  const load = useCallback(
    (): Promise<void> =>
      window.sully
        .linearIssueComments(issueId)
        .then((list) => {
          setComments(list)
          setFailed(false)
        })
        .catch(() => {
          // keep whatever is already on screen; only blank lists show the error
          setComments((prev) => prev ?? [])
          setFailed(true)
        }),
    [issueId]
  )

  useEffect(() => {
    void load()
  }, [load])

  const send = async (): Promise<void> => {
    const body = draft.trim()
    if (!body || posting) return
    setPosting(true)
    try {
      const ok = await call(window.sully.linearPostComment(issueId, body, replyTo?.id))
      if (ok) {
        setDraft('')
        setReplyTo(null)
        await load()
      }
    } finally {
      setPosting(false)
    }
  }

  const threads = useMemo(() => {
    const sorted = [...(comments ?? [])].sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    // a reply whose parent didn't come back (pagination) degrades to top-level
    const topLevel = sorted.filter((c) => !sorted.some((p) => p.id === c.parentId))
    return topLevel.map((c) => ({
      comment: c,
      replies: sorted.filter((r) => r.parentId === c.id)
    }))
  }, [comments])

  return (
    <div className="hairline mt-6 border-t pt-4">
      <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-brass-400">comments</p>
      {comments === null ? (
        <p className="mt-3 text-[12.5px] italic text-ink-400">Loading comments…</p>
      ) : failed ? (
        <p className="mt-3 text-[12.5px] italic text-ink-400">Couldn&apos;t load comments.</p>
      ) : threads.length === 0 ? (
        <p className="mt-3 text-[12.5px] italic text-ink-400">No comments.</p>
      ) : (
        <div className="mt-4 flex flex-col gap-5">
          {threads.map(({ comment, replies }) => (
            <div key={comment.id}>
              <CommentBlock comment={comment} onOpenLink={onOpenLink} />
              {replies.length > 0 && (
                <div className="hairline ml-2 mt-3 flex flex-col gap-4 border-l pl-4">
                  {replies.map((r) => (
                    <CommentBlock key={r.id} comment={r} onOpenLink={onOpenLink} />
                  ))}
                </div>
              )}
              <button
                onClick={() => setReplyTo(comment)}
                className="mt-1.5 pl-[26px] text-[11px] text-ink-400 hover:text-ink-100"
              >
                Reply
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="mt-4">
        {replyTo && (
          <div className="mb-1.5 flex items-center gap-1.5 text-[11px] text-ink-400">
            Replying to {replyTo.authorName ?? 'Unknown'}
            <button
              onClick={() => setReplyTo(null)}
              className="hover:text-ink-100"
              title="Cancel reply"
            >
              <X size={11} />
            </button>
          </div>
        )}
        <div className="flex items-end gap-2">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                void send()
              }
            }}
            placeholder={replyTo ? 'Write a reply…' : 'Leave a comment…'}
            spellCheck={false}
            rows={2}
            disabled={posting}
            className="hairline flex-1 resize-none rounded-lg border bg-ink-950/40 px-3 py-2 text-[12.5px] leading-relaxed text-ink-100 outline-none focus:border-brass-500/40 disabled:opacity-50"
          />
          <Button variant="primary" onClick={() => void send()} disabled={posting || !draft.trim()}>
            <MessageSquarePlus size={12} /> {replyTo ? 'Reply' : 'Comment'}
          </Button>
        </div>
      </div>
    </div>
  )
}

/**
 * Deep link to a comment's pin — must match figmaCommentUrl in
 * src/main/figma/comments.ts (pure string math, duplicated to keep the
 * preload surface small).
 */
function figmaCommentUrl(c: FigmaCommentItem): string {
  const node = c.nodeId ? `?node-id=${c.nodeId.replace(':', '-')}` : ''
  return `https://www.figma.com/design/${c.fileKey}${node}#${c.id}`
}

/**
 * Figma comments on the ticket's linked design files — the "Design feedback"
 * section under the Linear comments. Select comments and send them to the
 * agent (same flow as the GitHub review modal), or mark them addressed
 * locally; Figma's REST API has no resolve endpoint, so resolving stays in
 * Figma and resolved threads are hidden behind a toggle.
 */
function FigmaComments({
  issue,
  onOpenLink
}: {
  issue: TrackedIssue
  onOpenLink: (url: string) => void
}): ReactElement | null {
  const tokenSet = useApp((s) => Boolean(s.credentials?.figmaTokenSet))
  // starts true when a fetch will fire on mount, so the first paint says "loading"
  const [loading, setLoading] = useState(tokenSet)
  const [failed, setFailed] = useState(false)
  const [showResolved, setShowResolved] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  /** editing the manual Figma-file override */
  const [editing, setEditing] = useState(false)
  const [urlDraft, setUrlDraft] = useState('')

  useEffect(() => {
    if (!tokenSet) return
    let cancelled = false
    window.sully
      .figmaRefreshComments(issue.issueId)
      .then(() => !cancelled && setFailed(false))
      .catch(() => !cancelled && setFailed(true))
      .finally(() => !cancelled && setLoading(false))
    return () => {
      cancelled = true
    }
  }, [issue.issueId, tokenSet])

  const refresh = (): void => {
    if (!tokenSet || loading) return
    setLoading(true)
    window.sully
      .figmaRefreshComments(issue.issueId)
      .then(() => setFailed(false))
      .catch(() => setFailed(true))
      .finally(() => setLoading(false))
  }

  const items = issue.figmaComments ?? []
  const byNewest = (a: FigmaCommentItem, b: FigmaCommentItem): number =>
    (b.createdAt ?? '').localeCompare(a.createdAt ?? '')
  const open = items.filter((i) => !i.addressedAt && !i.resolvedAt).sort(byNewest)
  const addressed = items.filter((i) => i.addressedAt && !i.resolvedAt).sort(byNewest)
  const resolved = items.filter((i) => i.resolvedAt).sort(byNewest)

  // the poll refreshes items in place (ids are stable) — drop picks whose
  // comment got addressed or resolved, keep the rest
  const [seenItems, setSeenItems] = useState(issue.figmaComments)
  if (seenItems !== issue.figmaComments) {
    setSeenItems(issue.figmaComments)
    setSelected(new Set([...selected].filter((id) => open.some((i) => i.id === id))))
  }

  const links = issue.figmaLinks ?? []
  const manual = links.some((l) => l.source === 'manual')

  const startEdit = (): void => {
    setUrlDraft(manual ? (links[0]?.url ?? '') : '')
    setEditing(true)
  }
  /** empty url clears the manual override and reverts to auto-detected links */
  const setLink = (url: string): void => {
    setEditing(false)
    void call(
      window.sully.figmaSetLink(issue.issueId, url),
      url ? `Fetching design comments from the new Figma link on ${issue.identifier}` : undefined
    )
  }

  const linkEditor = editing && (
    <div className="mt-3 flex items-center gap-2">
      <input
        value={urlDraft}
        onChange={(e) => setUrlDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && urlDraft.trim()) setLink(urlDraft.trim())
          if (e.key === 'Escape') setEditing(false)
        }}
        placeholder="https://www.figma.com/design/…"
        spellCheck={false}
        autoFocus
        className="hairline min-w-0 flex-1 rounded-lg border bg-ink-950/40 px-3 py-1.5 font-mono text-[11.5px] text-ink-100 outline-none focus:border-brass-500/40"
      />
      <Button
        variant="primary"
        disabled={!urlDraft.trim()}
        onClick={() => setLink(urlDraft.trim())}
      >
        Save
      </Button>
      <Button onClick={() => setEditing(false)}>Cancel</Button>
    </div>
  )

  if (links.length === 0) {
    return (
      <div className="hairline mt-6 border-t pt-4">
        {editing ? (
          <>
            <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-brass-400">
              design feedback
            </p>
            {linkEditor}
          </>
        ) : (
          <button
            onClick={startEdit}
            className="text-[11px] text-ink-500 hover:text-ink-200"
            title="Fetch designer comments from a Figma file for this ticket"
          >
            + link a Figma file for design feedback
          </button>
        )}
      </div>
    )
  }

  const busy = Boolean(issue.activeSessionId)
  const canSend = !busy && (issue.phase === 'plan_ready' || issue.phase === 'in_review')

  const toggle = (id: string): void => {
    const next = new Set(selected)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    setSelected(next)
  }

  const send = (): void => {
    const ids = [...selected]
    setSelected(new Set())
    void call(
      window.sully.figmaAddressComments(issue.issueId, ids),
      `Sending ${ids.length} design comment${ids.length === 1 ? '' : 's'} to the agent on ${issue.identifier}`
    )
  }

  const meta = (item: FigmaCommentItem): ReactElement => (
    <>
      {item.orderId && (
        <span className="rounded bg-ink-700 px-1.5 py-px text-ink-200">#{item.orderId}</span>
      )}
      {item.author && <span className="text-brass-300">{item.author}</span>}
      {item.createdAt && <span>{timeAgo(item.createdAt)}</span>}
      <button
        onClick={(e) => {
          e.preventDefault()
          onOpenLink(figmaCommentUrl(item))
        }}
        title="Open this comment's pin in Figma"
        className="text-ink-300 hover:text-ink-50"
      >
        <MapPin size={11} />
      </button>
    </>
  )

  const body = (item: FigmaCommentItem): ReactElement => (
    <div className="prose-plan mt-1 text-[12.5px]">
      <ReactMarkdown components={paneLinkComponents(onOpenLink)}>{item.message}</ReactMarkdown>
    </div>
  )

  /** addressed / resolved cards: display-only record, dimmed */
  const doneCard = (item: FigmaCommentItem): ReactElement => (
    <div
      key={item.id}
      className="hairline flex gap-3 rounded-xl border bg-ink-850 p-3.5 opacity-55"
    >
      <div className="min-w-0 flex-1">
        <p className="flex flex-wrap items-center gap-2 font-mono text-[10.5px] text-ink-400">
          {meta(item)}
          <span className="rounded bg-ink-700 px-1.5 py-0.5 text-[9.5px] uppercase tracking-wide text-ink-200">
            {item.resolvedAt ? 'resolved in figma' : `addressed ${timeAgo(item.addressedAt!)}`}
          </span>
          {!item.resolvedAt && (
            <button
              onClick={() =>
                void call(window.sully.figmaMarkAddressed(issue.issueId, [item.id], false))
              }
              className="ml-auto text-[10.5px] text-ink-400 hover:text-ink-100"
            >
              undo
            </button>
          )}
        </p>
        {body(item)}
      </div>
    </div>
  )

  return (
    <div className="hairline mt-6 border-t pt-4">
      <div className="flex flex-wrap items-center gap-2">
        <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-brass-400">
          design feedback
        </p>
        {links.map((l) => (
          <button
            key={l.fileKey}
            onClick={() => onOpenLink(l.url)}
            title={
              l.nodeId
                ? 'Open the Figma file — comments are filtered to the linked frame'
                : 'Open the Figma file'
            }
            className="max-w-[220px] truncate rounded bg-ink-700 px-1.5 py-px font-mono text-[10.5px] text-ink-200 hover:text-ink-50"
          >
            {l.fileName ?? l.fileKey}
          </button>
        ))}
        {links.some((l) => l.nodeId) && (
          <span
            className="font-mono text-[10px] text-ink-500"
            title="The link points at a specific node, so only comments pinned inside that frame show here. Link the file without a node-id to see all file comments."
          >
            · linked frame only
          </span>
        )}
        <span className="ml-auto flex items-center gap-3">
          {manual && (
            <button
              onClick={() => setLink('')}
              className="text-[11px] text-ink-400 hover:text-ink-100"
              title="Remove the manual link and go back to links detected in the ticket"
            >
              use auto-detect
            </button>
          )}
          {resolved.length > 0 && (
            <button
              onClick={() => setShowResolved(!showResolved)}
              className="text-[11px] text-ink-400 hover:text-ink-100"
            >
              {showResolved ? 'hide resolved' : `show resolved (${resolved.length})`}
            </button>
          )}
          <button
            onClick={startEdit}
            title="Change which Figma file comments are fetched from"
            className="text-ink-300 hover:text-ink-50"
          >
            <Pencil size={11} />
          </button>
          <button
            onClick={refresh}
            disabled={loading || !tokenSet}
            title="Refresh Figma comments"
            className="text-ink-300 hover:text-ink-50 disabled:opacity-50"
          >
            <RotateCw size={12} className={loading ? 'animate-spin' : undefined} />
          </button>
        </span>
      </div>

      {linkEditor}

      {!tokenSet ? (
        <p className="mt-3 text-[12.5px] italic text-ink-400">
          Add a Figma token under Settings → Credentials to see design comments.
        </p>
      ) : loading && items.length === 0 ? (
        <p className="mt-3 text-[12.5px] italic text-ink-400">Loading design feedback…</p>
      ) : failed && items.length === 0 ? (
        <p className="mt-3 text-[12.5px] italic text-ink-400">Couldn&apos;t load Figma comments.</p>
      ) : open.length === 0 && addressed.length === 0 && resolved.length === 0 ? (
        <p className="mt-3 text-[12.5px] italic text-ink-400">
          No comments on the linked Figma {links.some((l) => l.nodeId) ? 'frame' : 'file'}
          {links.length === 1 ? '' : 's'}.
        </p>
      ) : (
        <div className="mt-4 flex flex-col gap-2.5">
          {open.map((item) => (
            <label
              key={item.id}
              className={cn(
                'hairline flex cursor-pointer gap-3 rounded-xl border bg-ink-850 p-3.5 transition-colors',
                selected.has(item.id) ? 'border-brass-500/40' : 'hover:border-ink-600'
              )}
            >
              <input
                type="checkbox"
                className="mt-1 shrink-0"
                checked={selected.has(item.id)}
                onChange={() => toggle(item.id)}
              />
              <div className="min-w-0 flex-1">
                <p className="flex flex-wrap items-center gap-2 font-mono text-[10.5px] text-ink-400">
                  {meta(item)}
                  <button
                    onClick={(e) => {
                      e.preventDefault()
                      void call(window.sully.figmaMarkAddressed(issue.issueId, [item.id], true))
                    }}
                    className="ml-auto text-[10.5px] text-ink-400 hover:text-ink-100"
                  >
                    mark addressed
                  </button>
                </p>
                {body(item)}
              </div>
            </label>
          ))}
          {addressed.length > 0 && (
            <p className="mt-2 font-mono text-[10.5px] uppercase tracking-[0.18em] text-ink-500">
              addressed
            </p>
          )}
          {addressed.map(doneCard)}
          {showResolved && resolved.length > 0 && (
            <p className="mt-2 font-mono text-[10.5px] uppercase tracking-[0.18em] text-ink-500">
              resolved in figma
            </p>
          )}
          {showResolved && resolved.map(doneCard)}
          {open.length === 0 && addressed.length + resolved.length > 0 && (
            <p className="text-[12.5px] italic text-ink-400">No open comments.</p>
          )}
        </div>
      )}

      {open.length > 0 && (
        <div className="mt-3 flex items-center justify-between">
          <button
            className="text-[11px] text-ink-400 hover:text-ink-100"
            onClick={() =>
              setSelected(
                selected.size === open.length ? new Set() : new Set(open.map((i) => i.id))
              )
            }
          >
            {selected.size === open.length ? 'clear selection' : 'select all'}
          </button>
          <Button
            variant="primary"
            disabled={!canSend || selected.size === 0}
            onClick={send}
            title={
              canSend
                ? issue.phase === 'plan_ready'
                  ? 'Updates the plan to satisfy the selected feedback'
                  : 'Runs an agent session to implement the selected feedback'
                : busy
                  ? 'An agent session is already running for this ticket'
                  : 'Available once the ticket has a plan (Plan ready) or is In review'
            }
          >
            <ThumbsUp size={11} /> Send to agent ({selected.size})
          </Button>
        </div>
      )}
    </div>
  )
}

/**
 * Read-only view of the ticket itself — description, state, repo, PR — opened
 * by clicking anywhere on a board card. Actions stay in the card's "…" menu.
 */
function TicketDetailsDialog({
  issue,
  session,
  devServer,
  devCommand,
  onViewPlan,
  onViewLog,
  onReprompt,
  onClose
}: {
  issue: TrackedIssue
  session?: Session
  devServer?: DevServer
  devCommand?: string
  onViewPlan: () => void
  onViewLog: () => void
  onReprompt: () => void
  onClose: () => void
}): ReactElement {
  const repoName = issue.repoPath?.split('/').pop()
  const description = (issue.description ?? '').trim()
  // closing only hides the pane — the pty keeps running and reattaches with
  // its scrollback when reopened (same as PlanDialog / GhReviewDialog).
  // lives in the store so the pane survives switching views
  const { detailsTermOpen: termOpen, setDetailsTermOpen: setTermOpen } = useApp()
  /** PR or Linear page shown in the in-dialog browser pane */
  const [browserUrl, setBrowserUrl] = useState<string | null>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  // deleting a local ticket is destructive (stops any running session) — the
  // button arms on first click and deletes on the second
  const [confirmDelete, setConfirmDelete] = useState(false)
  // "Attach PR": associate an existing GitHub PR with a local ticket
  const [attachOpen, setAttachOpen] = useState(false)
  const [attachUrl, setAttachUrl] = useState('')
  const [attaching, setAttaching] = useState(false)
  // local tickets are edited here — there is no Linear page to edit them on
  const [editOpen, setEditOpen] = useState(false)
  const [editTitle, setEditTitle] = useState('')
  const [editDesc, setEditDesc] = useState('')
  const [saving, setSaving] = useState(false)
  const localChanges = useLocalChanges(issue)

  const openEdit = (): void => {
    setEditTitle(issue.title)
    setEditDesc(issue.description ?? '')
    setEditOpen(true)
  }

  const saveEdit = async (): Promise<void> => {
    if (!editTitle.trim() || saving) return
    setSaving(true)
    const ok = await call(
      window.sully.updateLocalIssue(issue.issueId, {
        title: editTitle.trim(),
        description: editDesc
      }),
      `${issue.identifier} updated`
    )
    setSaving(false)
    if (ok) setEditOpen(false)
  }

  const attach = async (): Promise<void> => {
    const url = attachUrl.trim()
    if (!url || attaching) return
    setAttaching(true)
    const ok = await call(
      window.sully.attachPr(issue.issueId, url),
      `${issue.identifier} PR attached`
    )
    setAttaching(false)
    if (ok) {
      setAttachOpen(false)
      setAttachUrl('')
    }
  }
  const actions = cardActions({
    issue,
    session,
    devServer,
    devCommand,
    onViewPlan,
    onViewLog,
    onReprompt
  })

  return (
    <DockablePanel
      id="ticket-details"
      modalClassName="h-[min(820px,88vh)] w-[min(920px,90vw)] min-h-[380px] min-w-[480px]"
      minWidth={480}
      minHeight={380}
      onClose={onClose}
    >
      <header className="hairline flex flex-col gap-3 border-b px-6 py-4">
        <div className="selectable">
          <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-brass-400">
            ticket details
          </p>
          <h3 className="mt-0.5 font-display text-[19px] text-ink-50">
            {issue.identifier} — {issue.title}
          </h3>
        </div>
        <div className="flex items-center gap-3 self-end">
          {actions.length > 0 && (
            <CardMenu actions={actions} open={menuOpen} setOpen={setMenuOpen} />
          )}
          <DockControls />
          <button onClick={onClose} className="text-ink-300 hover:text-ink-50">
            <X size={17} />
          </button>
        </div>
      </header>

      {/* one row: ticket metadata left, spend/recency right */}
      <div className="hairline flex flex-wrap items-center gap-2 border-b px-6 py-2.5">
        <span className="selectable rounded bg-ink-700 px-1.5 py-px font-mono text-[10.5px] text-ink-200">
          {issue.stateName}
        </span>
        {repoName && (
          <span className="selectable rounded bg-ink-700 px-1.5 py-px font-mono text-[10.5px] text-ink-200">
            {repoName}
          </span>
        )}
        <span className="selectable font-mono text-[10.5px] text-ink-400">{issue.branchName}</span>
        <span className="ml-auto flex items-center gap-2 font-mono text-[10.5px] text-ink-400">
          {typeof issue.costUsd === 'number' && issue.costUsd >= 0.01 && (
            <span title="Total AI spend across this ticket's sessions">
              ${issue.costUsd.toFixed(2)}
            </span>
          )}
          {timeAgo(issue.updatedAt)}
        </span>
      </div>

      <BrowserDock url={browserUrl} onClose={() => setBrowserUrl(null)}>
        <TerminalDock issueId={issue.issueId} open={termOpen && Boolean(issue.repoPath)}>
          <div className="selectable min-h-0 flex-1 overflow-y-auto px-6 py-4 text-[13px]">
            {editOpen ? (
              <div className="flex flex-col gap-2">
                <input
                  autoFocus
                  value={editTitle}
                  onChange={(e) => setEditTitle(e.target.value)}
                  placeholder="Title"
                  className="hairline-strong selectable rounded-lg border bg-ink-950 px-2.5 py-1.5 text-[12px] text-ink-50 placeholder:text-ink-400 focus:border-brass-500 focus:outline-none"
                />
                <textarea
                  value={editDesc}
                  onChange={(e) => setEditDesc(e.target.value)}
                  spellCheck={false}
                  placeholder="Description (markdown)"
                  className="hairline-strong selectable min-h-[180px] resize-y rounded-lg border bg-ink-950 px-2.5 py-1.5 font-mono text-[12px] leading-relaxed text-ink-50 placeholder:text-ink-400 focus:border-brass-500 focus:outline-none"
                />
                <div className="flex justify-end gap-2">
                  <Button onClick={() => setEditOpen(false)}>Cancel</Button>
                  <Button
                    variant="primary"
                    disabled={!editTitle.trim() || saving}
                    onClick={() => void saveEdit()}
                  >
                    {saving ? 'Saving…' : 'Save'}
                  </Button>
                </div>
              </div>
            ) : (
              <div className="prose-plan">
                {description ? (
                  <ReactMarkdown components={paneLinkComponents(setBrowserUrl)}>
                    {description}
                  </ReactMarkdown>
                ) : (
                  <p className="italic">No description.</p>
                )}
              </div>
            )}
            {/* keyed so switching tickets in a docked panel resets the list and composer */}
            {/* local tickets have no Linear issue to hold comments */}
            {!issue.local && (
              <TicketComments
                key={issue.issueId}
                issueId={issue.issueId}
                onOpenLink={setBrowserUrl}
              />
            )}
            <FigmaComments
              key={`figma-${issue.issueId}`}
              issue={issue}
              onOpenLink={setBrowserUrl}
            />
          </div>
        </TerminalDock>
      </BrowserDock>

      <footer className="hairline flex flex-wrap items-center justify-end gap-2 border-t px-6 py-3.5">
        <Button onClick={onClose}>Close</Button>
        {issue.repoPath && (
          <Button
            onClick={() => setTermOpen(!termOpen)}
            title={termOpen ? 'Hide the agent terminal' : 'Show the agent terminal'}
          >
            <SquareTerminal size={12} /> {termOpen ? 'Hide terminal' : 'Terminal'}
          </Button>
        )}
        <CommitPushButton issue={issue} localChanges={localChanges} />
        {issue.prUrl && (
          <Button onClick={() => setBrowserUrl(issue.prUrl!)}>
            <GitPullRequest size={12} /> Open pull request
          </Button>
        )}
        {issue.local && !editOpen && (
          <Button onClick={openEdit} title="Edit this local ticket's title and description">
            <Pencil size={12} /> Edit
          </Button>
        )}
        {issue.local &&
          !issue.prUrl &&
          (attachOpen ? (
            <div className="flex items-center gap-1.5">
              <input
                autoFocus
                value={attachUrl}
                onChange={(e) => setAttachUrl(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void attach()
                  if (e.key === 'Escape') setAttachOpen(false)
                }}
                placeholder="https://github.com/…/pull/123"
                spellCheck={false}
                className="hairline-strong selectable w-[240px] rounded-lg border bg-ink-950 px-2.5 py-1.5 text-[12px] text-ink-50 placeholder:text-ink-400 focus:border-brass-500 focus:outline-none"
              />
              <Button disabled={!attachUrl.trim() || attaching} onClick={() => void attach()}>
                {attaching ? 'Attaching…' : 'Attach'}
              </Button>
            </div>
          ) : (
            <Button
              onClick={() => setAttachOpen(true)}
              title="Associate an existing GitHub PR with this ticket — it moves to In review and CI/review/auto-merge apply"
            >
              <GitPullRequest size={12} /> Attach PR
            </Button>
          ))}
        {issue.local ? (
          <Button
            onClick={() => {
              if (!confirmDelete) {
                setConfirmDelete(true)
                return
              }
              void call(window.sully.deleteLocalIssue(issue.issueId))
              onClose()
            }}
            title={
              confirmDelete
                ? 'Click again to delete — any running session is stopped; the worktree stays on disk'
                : 'Remove this local ticket from the board'
            }
          >
            <Trash2 size={12} className={cn(confirmDelete && 'text-terra-400')} />
            {confirmDelete ? 'Really delete?' : 'Delete ticket'}
          </Button>
        ) : (
          <Button variant="primary" onClick={() => setBrowserUrl(issue.url)}>
            <ExternalLink size={12} /> Open in Linear
          </Button>
        )}
      </footer>
    </DockablePanel>
  )
}

interface CardAction {
  icon: ReactElement
  label: string
  onClick: () => void
}

/** The 3-dot menu's actions — shared by the issue card and the ticket details dialog. */
function cardActions({
  issue,
  session,
  devServer,
  devCommand,
  onViewPlan,
  onViewLog,
  onReprompt
}: {
  issue: TrackedIssue
  session?: Session
  devServer?: DevServer
  devCommand?: string
  onViewPlan: () => void
  onViewLog: () => void
  onReprompt: () => void
}): CardAction[] {
  const devRunning = devServer?.status === 'running'
  const actions: CardAction[] = []
  if (issue.phase === 'error')
    actions.push({
      icon: <CircleCheck size={13} />,
      label: 'Dismiss error',
      onClick: () =>
        void call(
          window.sully.dismissIssueError(issue.issueId),
          `Cleared error on ${issue.identifier}`
        )
    })
  if (session)
    actions.push({ icon: <ScrollText size={13} />, label: 'View session log', onClick: onViewLog })
  if (issue.planBody)
    actions.push({ icon: <FileText size={13} />, label: 'View plan', onClick: onViewPlan })
  if (issue.prUrl)
    actions.push({
      icon: <GitPullRequest size={13} />,
      label: 'Open pull request',
      onClick: () => useApp.getState().openBrowser(issue.prUrl!)
    })
  if (issue.repoPath)
    actions.push({
      icon: <MessageSquarePlus size={13} />,
      label: 'Chat with the agent',
      onClick: onReprompt
    })
  if (devCommand && issue.repoPath)
    actions.push(
      devRunning
        ? {
            icon: <Square size={13} />,
            label: 'Stop dev environment',
            onClick: () => void call(window.sully.stopDevServer(issue.issueId))
          }
        : {
            icon: <Play size={13} />,
            label: 'Run dev environment',
            onClick: () => void call(window.sully.startDevServer(issue.issueId))
          }
    )
  return actions
}

function CardMenu({
  actions,
  open,
  setOpen
}: {
  actions: CardAction[]
  open: boolean
  setOpen: (v: boolean) => void
}): ReactElement {
  return (
    <div className="relative">
      <Button onClick={() => setOpen(!open)} title="Actions">
        <MoreHorizontal size={12} />
      </Button>
      {open && (
        <>
          <div
            className="fixed inset-0 z-[70]"
            onClick={(e) => {
              // don't let the click-away bubble to the card, which would open
              // the ticket details right after closing the menu
              e.stopPropagation()
              setOpen(false)
            }}
          />
          <div className="hairline-strong absolute right-0 top-full z-[71] mt-1 w-[220px] rounded-lg border bg-ink-900 py-1 shadow-2xl">
            {actions.map((a) => (
              <button
                key={a.label}
                onClick={() => {
                  setOpen(false)
                  a.onClick()
                }}
                className="flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-[12px] text-ink-100 hover:bg-ink-700 hover:text-ink-50"
              >
                <span className="text-ink-300">{a.icon}</span>
                <span className="truncate">{a.label}</span>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  )
}

function IssueCard({
  issue,
  session,
  devServer,
  devCommand,
  onViewDetails,
  onViewPlan,
  onViewLog,
  onReprompt,
  onViewGhReview,
  onAnswerQuestions
}: {
  issue: TrackedIssue
  session?: Session
  devServer?: DevServer
  devCommand?: string
  onViewDetails: () => void
  onViewPlan: () => void
  onViewLog: () => void
  onReprompt: () => void
  onViewGhReview: () => void
  onAnswerQuestions: () => void
}): ReactElement {
  const running = session?.status === 'running'
  const devRunning = devServer?.status === 'running'
  const repoName = issue.repoPath?.split('/').pop()
  const localChanges = useLocalChanges(issue)
  const lastAgentMsg = [...(issue.chat ?? [])].reverse().find((m) => m.role === 'agent')
  const figmaOpen = (issue.figmaComments ?? []).filter(
    (c) => !c.addressedAt && !c.resolvedAt
  ).length
  const [menuOpen, setMenuOpen] = useState(false)
  const [errorExpanded, setErrorExpanded] = useState(false)
  const [copied, setCopied] = useState(false)

  const copyError = (): void => {
    if (!issue.lastError) return
    void navigator.clipboard.writeText(issue.lastError)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  const actions = cardActions({
    issue,
    session,
    devServer,
    devCommand,
    onViewPlan,
    onViewLog,
    onReprompt
  })

  return (
    <div
      onClick={(e) => {
        // whole-card click opens the ticket details; the card's own controls
        // (buttons, links, selectable error text) keep their behavior
        if ((e.target as HTMLElement).closest('button, a, .selectable')) return
        onViewDetails()
      }}
      className={cn(
        'hairline group rounded-xl border bg-ink-850 p-3.5 transition-all duration-200 hover:border-ink-600',
        running && 'border-brass-500/30 shadow-[0_0_20px_rgba(217,164,65,0.06)]'
      )}
    >
      <div className="flex items-center gap-2">
        {issue.local ? (
          <span
            className="shrink-0 font-mono text-[11px] font-medium text-brass-300"
            title="Local ticket — exists only in Sully, not in Linear"
          >
            {issue.identifier}
            <span className="ml-1 rounded bg-ink-700 px-1 py-px text-[9px] uppercase tracking-wide text-ink-300">
              local
            </span>
          </span>
        ) : (
          <button
            className="shrink-0 font-mono text-[11px] font-medium text-brass-300 hover:underline"
            onClick={() => useApp.getState().openBrowser(issue.url)}
          >
            {issue.identifier}
          </button>
        )}
        {repoName ? (
          <span className="min-w-0 truncate rounded bg-ink-700 px-1.5 py-px font-mono text-[10px] text-ink-200">
            {repoName}
          </span>
        ) : (
          <span
            className="flex min-w-0 shrink items-center gap-1 whitespace-nowrap rounded bg-terra-500/15 px-1.5 py-px font-mono text-[10px] text-terra-400"
            title="Map this ticket's team or project to a repo in Settings"
          >
            <TriangleAlert size={9} className="shrink-0" /> no repo
          </span>
        )}
        <span className="ml-auto flex shrink-0 items-center gap-2 whitespace-nowrap text-[10px] text-ink-400">
          {typeof issue.costUsd === 'number' && issue.costUsd >= 0.01 && (
            <span className="font-mono" title="Total AI spend across this ticket's sessions">
              ${issue.costUsd.toFixed(2)}
            </span>
          )}
          {timeAgo(issue.updatedAt)}
        </span>
      </div>

      <p className="mt-1.5 line-clamp-2 text-[13px] leading-snug text-ink-50">{issue.title}</p>

      {(figmaOpen > 0 ||
        (issue.prUrl &&
          ((issue.ciStatus && issue.ciStatus.state !== 'none') ||
            (issue.prReview && issue.prReview !== 'none')))) && (
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          {issue.prUrl && issue.ciStatus && issue.ciStatus.state !== 'none' && (
            <span
              className={cn(
                'whitespace-nowrap rounded px-1.5 py-px font-mono text-[10px]',
                issue.ciStatus.state === 'fail' && 'bg-terra-500/15 text-terra-400',
                issue.ciStatus.state === 'pending' && 'bg-ink-700 text-ink-300',
                issue.ciStatus.state === 'pass' && 'bg-sage-500/15 text-sage-400'
              )}
              title={
                issue.ciStatus.state === 'fail'
                  ? `Failing: ${issue.ciStatus.failed.join(', ')}${issue.ciFixAttemptShas?.length ? ` — ${issue.ciFixAttemptShas.length} auto-fix attempt${issue.ciFixAttemptShas.length === 1 ? '' : 's'}` : ''}`
                  : `Checks ${issue.ciStatus.state === 'pass' ? 'passing' : 'running'} (${timeAgo(issue.ciStatus.checkedAt)})`
              }
            >
              {issue.ciStatus.state === 'fail'
                ? '✕'
                : issue.ciStatus.state === 'pending'
                  ? '●'
                  : '✓'}{' '}
              CI
            </span>
          )}
          {issue.prUrl && issue.prReview && issue.prReview !== 'none' && (
            <span
              className={cn(
                'whitespace-nowrap rounded px-1.5 py-px font-mono text-[10px]',
                issue.prReview === 'approved' && 'bg-sage-500/15 text-sage-400',
                issue.prReview === 'changes_requested' && 'bg-terra-500/15 text-terra-400',
                issue.prReview === 'review_required' && 'bg-ink-700 text-ink-300'
              )}
              title={
                issue.prReview === 'approved'
                  ? 'PR approved'
                  : issue.prReview === 'changes_requested'
                    ? 'A reviewer requested changes'
                    : 'PR awaiting review'
              }
            >
              {issue.prReview === 'approved'
                ? '✓ approved'
                : issue.prReview === 'changes_requested'
                  ? '± changes'
                  : '○ review'}
            </span>
          )}
          {figmaOpen > 0 && (
            <span
              className="whitespace-nowrap rounded bg-plan-400/15 px-1.5 py-px font-mono text-[10px] text-plan-400"
              title={`${figmaOpen} open Figma design comment${figmaOpen === 1 ? '' : 's'} — open the ticket to review`}
            >
              ◆ figma {figmaOpen}
            </span>
          )}
        </div>
      )}

      {running && session?.lastText && (
        <p className="mt-2 line-clamp-2 font-mono text-[10.5px] leading-relaxed text-ink-300">
          {session.lastText}
        </p>
      )}
      {issue.phase === 'error' && issue.lastError && (
        <div className="mt-2">
          <p
            className={cn(
              'selectable text-[11px] leading-snug text-terra-400',
              !errorExpanded && 'line-clamp-3'
            )}
          >
            {issue.lastError}
          </p>
          <div className="mt-1 flex items-center gap-2.5">
            <button
              onClick={() => setErrorExpanded(!errorExpanded)}
              className="text-[10.5px] text-ink-400 hover:text-ink-100"
            >
              {errorExpanded ? 'show less' : 'show more'}
            </button>
            <button
              onClick={copyError}
              className="flex items-center gap-1 text-[10.5px] text-ink-400 hover:text-ink-100"
              title="Copy the full error to the clipboard"
            >
              <Copy size={10} /> {copied ? 'copied' : 'copy error'}
            </button>
          </div>
        </div>
      )}
      {issue.phase === 'plan_questions' && (issue.planQuestions?.length ?? 0) > 0 && (
        <button
          onClick={onAnswerQuestions}
          className="mt-2 block w-full text-left"
          title="Answer the agent's questions"
        >
          <p className="line-clamp-2 text-[11px] italic leading-snug text-brass-300">
            ? {issue.planQuestions![0].question}
          </p>
        </button>
      )}
      {issue.phase === 'in_review' && lastAgentMsg && (
        <button onClick={onReprompt} className="mt-2 block w-full text-left" title="Open the chat">
          <p className="line-clamp-2 text-[11px] italic leading-snug text-ink-300">
            ↳ {lastAgentMsg.text}
          </p>
        </button>
      )}
      {devServer?.status === 'error' && (
        <p className="mt-2 line-clamp-3 font-mono text-[10.5px] leading-snug text-terra-400">
          dev server failed: {devServer.lastOutput ?? 'no output'}
        </p>
      )}

      {devRunning && (
        <p className="mt-2 flex items-center gap-1.5 text-[10.5px] text-sage-400">
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-sage-400" />
          {devServer?.url ? (
            <button
              onClick={() => void window.sully.openExternal(devServer.url!)}
              className="underline underline-offset-2 hover:text-sage-300"
              title="Open in browser"
            >
              {devServer.url}
            </button>
          ) : (
            'dev environment running'
          )}
        </p>
      )}

      <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
        {running && (
          <span className="flex items-center gap-1.5 whitespace-nowrap text-[10.5px] text-brass-300">
            <Vu /> working
          </span>
        )}
        {issue.phase === 'plan_questions' && !running && (
          <span className="flex items-center gap-1 whitespace-nowrap rounded bg-brass-500/15 px-1.5 py-px text-[10.5px] text-brass-300">
            <CircleHelp size={10} /> has questions
          </span>
        )}
        <div className="ml-auto flex min-w-0 flex-wrap items-center justify-end gap-1">
          {running && session && (
            <Button
              variant="danger"
              onClick={() => void call(window.sully.stopSession(session.id))}
              title="Stop the running session"
            >
              <Square size={11} /> Stop
            </Button>
          )}
          {issue.phase === 'error' && (
            <>
              <Button
                onClick={() =>
                  void call(window.sully.retryIssue(issue.issueId), `Retrying ${issue.identifier}`)
                }
                title="Retry the failed step"
              >
                <RotateCcw size={11} /> Retry
              </Button>
              <Button
                onClick={() =>
                  void call(
                    window.sully.dismissIssueError(issue.issueId),
                    `Cleared error on ${issue.identifier}`
                  )
                }
                title="Clear the error without retrying — returns the card to its column"
              >
                <CircleCheck size={11} /> Dismiss
              </Button>
            </>
          )}
          {devCommand && issue.repoPath && (
            <Button
              className="px-1.5"
              onClick={() =>
                void call(
                  devRunning
                    ? window.sully.stopDevServer(issue.issueId)
                    : window.sully.startDevServer(issue.issueId)
                )
              }
              title={devRunning ? 'Stop dev environment' : 'Run dev environment'}
            >
              {devRunning ? <Square size={13} /> : <Play size={13} />}
            </Button>
          )}
          {issue.prUrl && (
            <Button
              className="px-1.5"
              onClick={() => useApp.getState().openBrowser(issue.prUrl!)}
              title="Open pull request"
            >
              <GitPullRequest size={13} />
            </Button>
          )}
          {issue.repoPath && (
            <Button className="px-1.5" onClick={onReprompt} title="Chat with the agent">
              <MessageSquarePlus size={13} />
            </Button>
          )}
          {actions.length > 0 && (
            <CardMenu actions={actions} open={menuOpen} setOpen={setMenuOpen} />
          )}
        </div>
        {issue.phase === 'plan_questions' && (issue.planQuestions?.length ?? 0) > 0 && (
          <Button variant="primary" onClick={onAnswerQuestions} className="ml-1">
            <CircleHelp size={11} /> Answer questions ({issue.planQuestions!.length})
          </Button>
        )}
        {issue.phase === 'plan_ready' &&
          (issue.planBody ? (
            <Button variant="primary" onClick={onViewPlan} className="ml-1">
              <ThumbsUp size={11} /> Review plan
            </Button>
          ) : (
            <Button
              variant="primary"
              onClick={() =>
                void call(window.sully.retryIssue(issue.issueId), `Planning ${issue.identifier}`)
              }
              className="ml-1"
              title="This ticket entered Plan ready without a plan — start a planning session"
            >
              <FileText size={11} /> Want to plan this?
            </Button>
          ))}
        {issue.phase === 'in_review' &&
          !issue.activeSessionId &&
          issue.prUrl &&
          issue.repoPath &&
          (issue.ghReviewItems?.length ?? 0) > 0 && (
            <Button
              variant={issue.ghReviewItems!.some((i) => !i.addressedAt) ? 'primary' : undefined}
              onClick={onViewGhReview}
              className="ml-1"
              title="Open the PR's review comments — suggest or address fixes from there"
            >
              <MessagesSquare size={11} />
              {(() => {
                const n = issue.ghReviewItems!.filter((i) => !i.addressedAt).length
                return n > 0 ? `View GitHub review (${n})` : 'Review addressed'
              })()}
            </Button>
          )}
      </div>
      <CommitPushButton issue={issue} localChanges={localChanges} full />
    </div>
  )
}

const BUMPS: DeployBump[] = ['patch', 'minor', 'major']

const DEPLOY_STATUS_LABEL: Record<string, string> = {
  running: 'deploying…',
  done: 'release finished',
  error: 'release failed',
  stopped: 'release stopped'
}

/**
 * Manual release trigger. Picking a repo + bump and clicking Deploy is the
 * confirmation — the release script's own y/n prompt is answered automatically
 * by the main process, and its output streams back into this dialog.
 */
function DeployDialog({ onClose }: { onClose: () => void }): ReactElement {
  const settings = useApp((s) => s.settings)
  const deploys = useApp((s) => s.deploys)
  const repos = (settings?.repoMappings ?? []).filter((r) => r.deployCommand?.trim())
  const [repoId, setRepoId] = useState(repos[0]?.id ?? '')
  const [bump, setBump] = useState<DeployBump>('minor')
  const outRef = useRef<HTMLPreElement>(null)

  const repo = repos.find((r) => r.id === repoId)
  const deploy = deploys[repoId]
  const running = deploy?.status === 'running'

  useEffect(() => {
    outRef.current?.scrollTo({ top: outRef.current.scrollHeight })
  }, [deploy?.lastOutput])

  return (
    <DockablePanel
      id="deploy"
      modalClassName="max-h-[82vh] w-[min(720px,90vw)]"
      minWidth={420}
      minHeight={280}
      onClose={onClose}
    >
      <header className="hairline flex flex-col gap-3 border-b px-6 py-4">
        <div>
          <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-brass-400">
            deploy a release
          </p>
          <h3 className="mt-0.5 font-display text-[19px] text-ink-50">
            {repo ? repo.label : 'no repo selected'}
          </h3>
        </div>
        <div className="flex items-center gap-3 self-end">
          <DockControls />
          <button onClick={onClose} className="text-ink-300 hover:text-ink-50">
            <X size={17} />
          </button>
        </div>
      </header>

      <div className="flex min-h-0 flex-col gap-3 overflow-y-auto px-6 py-4">
        <div className="flex items-center gap-3">
          <select
            className="hairline-strong rounded-lg border bg-ink-950 px-2 py-1.5 text-[12px] text-ink-50 focus:border-brass-500 focus:outline-none"
            value={repoId}
            disabled={running}
            onChange={(e) => setRepoId(e.target.value)}
          >
            {repos.map((r) => (
              <option key={r.id} value={r.id}>
                {r.label}
              </option>
            ))}
          </select>
          <div className="hairline flex overflow-hidden rounded-lg border">
            {BUMPS.map((b) => (
              <button
                key={b}
                disabled={running}
                onClick={() => setBump(b)}
                className={cn(
                  'px-3 py-1.5 font-mono text-[11.5px] transition-colors',
                  b === bump
                    ? 'bg-brass-500/15 text-brass-300'
                    : 'text-ink-300 hover:bg-ink-800 hover:text-ink-100'
                )}
              >
                {b}
              </button>
            ))}
          </div>
        </div>

        {repo && (
          <div className="hairline rounded-lg border bg-ink-950/40 px-3 py-2">
            <p className="font-mono text-[12px] text-ink-100">
              $ {repo.deployCommand!.trim()} {bump}
            </p>
            <p className="mt-0.5 truncate font-mono text-[10.5px] text-ink-400">{repo.repoPath}</p>
          </div>
        )}

        {deploy && (
          <div className="flex min-h-0 flex-col gap-1.5">
            <p
              className={cn(
                'text-[11px] font-bold',
                deploy.status === 'running' && 'text-brass-300',
                deploy.status === 'done' && 'text-sage-400',
                deploy.status === 'error' && 'text-terra-400',
                deploy.status === 'stopped' && 'text-ink-300'
              )}
            >
              {DEPLOY_STATUS_LABEL[deploy.status]}{' '}
              <span className="font-mono font-normal text-ink-400">({deploy.command})</span>
            </p>
            {deploy.lastOutput && (
              <pre
                ref={outRef}
                className="hairline max-h-[280px] min-h-[120px] overflow-y-auto whitespace-pre-wrap break-words rounded-lg border bg-ink-950/60 px-3 py-2 font-mono text-[11px] leading-relaxed text-ink-200"
              >
                {deploy.lastOutput}
              </pre>
            )}
          </div>
        )}
      </div>

      <footer className="hairline flex items-center justify-end gap-2 border-t px-6 py-3.5">
        {running ? (
          <Button variant="danger" onClick={() => void call(window.sully.stopDeploy(repoId))}>
            <Square size={11} /> Stop deploy
          </Button>
        ) : (
          <>
            <Button onClick={onClose}>Close</Button>
            <Button
              variant="primary"
              disabled={!repo}
              onClick={() => void call(window.sully.startDeploy(repoId, bump))}
            >
              <Rocket size={12} /> Confirm &amp; deploy {bump}
            </Button>
          </>
        )}
      </footer>
    </DockablePanel>
  )
}

export default function BoardView(): ReactElement {
  const {
    issues,
    sessions,
    settings,
    devServers,
    deploys,
    detailsIssueId,
    setDetailsIssue,
    logSessionId,
    logView,
    openLog,
    closeLog,
    repromptIssueId,
    setRepromptIssue
  } = useApp()
  // the open ticket-details panel lives in the store so it survives view switches
  const detailsFor = detailsIssueId ? (issues[detailsIssueId] ?? null) : null
  // likewise the "chat with the agent" panel, so it comes back on return
  const repromptFor = repromptIssueId ? (issues[repromptIssueId] ?? null) : null
  const [planFor, setPlanFor] = useState<TrackedIssue | null>(null)
  const [questionsFor, setQuestionsFor] = useState<TrackedIssue | null>(null)
  const [ghReviewFor, setGhReviewFor] = useState<TrackedIssue | null>(null)
  const [deployOpen, setDeployOpen] = useState(false)
  const [newTicketOpen, setNewTicketOpen] = useState(false)
  // optimistic card placement while a drag's Linear move + poll round-trip runs
  const [pending, setPending] = useState<Record<string, BoardColumn>>({})
  const [dragCol, setDragCol] = useState<BoardColumn | null>(null)

  // drop optimistic placements the poll has confirmed (or whose ticket left
  // the board) during render — the real phase governs again
  const stalePending = Object.entries(pending).filter(([id, col]) => {
    const issue = issues[id]
    return !issue || COLUMN_FOR_PHASE[issue.phase] === col
  })
  if (stalePending.length > 0) {
    const next = { ...pending }
    for (const [id] of stalePending) delete next[id]
    setPending(next)
  }

  const clearPending = (issueId: string): void =>
    setPending((p) => {
      if (!(issueId in p)) return p
      const next = { ...p }
      delete next[issueId]
      return next
    })

  const dropTo = (col: BoardColumn, issueId: string): void => {
    if (!issues[issueId]) return
    setPending((p) => ({ ...p, [issueId]: col }))
    void call(window.sully.moveIssue(issueId, col)).then((ok) => {
      if (!ok) clearPending(issueId)
    })
    // safety net: never pin a card to a column the poll won't confirm
    setTimeout(() => clearPending(issueId), 20_000)
  }

  const dragProps = (
    issueId: string
  ): {
    draggable: true
    onDragStart: (e: DragEvent<HTMLDivElement>) => void
    onDragEnd: () => void
  } => ({
    draggable: true,
    onDragStart: (e) => {
      e.dataTransfer.setData('text/plain', issueId)
      e.dataTransfer.effectAllowed = 'move'
    },
    // fires on drop AND on a cancelled drag — the highlight must never linger
    onDragEnd: () => setDragCol(null)
  })

  const deployable = settings?.repoMappings.some((r) => r.deployCommand?.trim()) ?? false
  const deployRunning = Object.values(deploys).some((d) => d.status === 'running')

  const list = useMemo(() => issueList(issues), [issues])
  const mapped = settings?.columnMappings.length ?? 0

  const sessionFor = (issue: TrackedIssue): Session | undefined => {
    if (issue.activeSessionId && sessions[issue.activeSessionId])
      return sessions[issue.activeSessionId]
    return Object.values(sessions).find((s) => s.issueId === issue.issueId)
  }

  const devCommandFor = (issue: TrackedIssue): string | undefined =>
    settings?.repoMappings.find((r) => r.repoPath === issue.repoPath)?.devCommand?.trim() ||
    undefined

  // local tickets don't need a Linear column mapping — show the board for them
  if (mapped === 0 && list.length === 0) {
    return (
      <EmptyState
        title="No columns mapped yet."
        hint="Head to Settings → Columns and pick which Linear workflow states mean Planning, Plan ready, In progress, and In review."
      />
    )
  }

  // a just-dragged error card renders in its target column, not the strip
  const errored = list.filter((i) => i.phase === 'error' && !pending[i.issueId])

  return (
    // @container: column counts track the board's own width, not the window's,
    // so a docked side/bottom panel reflows the grid instead of crushing it
    <div className="fade-up @container">
      <div className="mb-6 flex items-end justify-between">
        <div>
          <h1 className="font-display text-[26px] text-ink-50">Board</h1>
          <p className="text-[12px] text-ink-400">
            {settings?.orchestrator.enabled
              ? 'watching your Linear columns and acting on them'
              : 'automation paused — the board stays in sync, but Sully won\u2019t plan, code, or move tickets'}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <span className="font-mono text-[11px] text-ink-400">
            {list.length} ticket{list.length === 1 ? '' : 's'} tracked
          </span>
          {deployable && (
            <Button onClick={() => setDeployOpen(true)}>
              <Rocket size={12} className={cn(deployRunning && 'animate-pulse text-brass-400')} />
              {deployRunning ? 'Deploying…' : 'Deploy'}
            </Button>
          )}
          <Button variant="primary" onClick={() => setNewTicketOpen(true)}>
            <Plus size={12} /> New ticket
          </Button>
        </div>
      </div>

      {errored.length > 0 && (
        <div className="hairline mb-5 rounded-xl border border-terra-500/25 bg-terra-500/5 p-3">
          <p className="mb-2 flex items-center gap-1.5 text-[12px] font-bold text-terra-400">
            <TriangleAlert size={13} /> Needs attention
          </p>
          <div className="grid grid-cols-2 gap-2.5 @5xl:grid-cols-4">
            {errored.map((issue) => (
              <div key={issue.issueId} {...dragProps(issue.issueId)} className="cursor-grab">
                <IssueCard
                  issue={issue}
                  session={sessionFor(issue)}
                  devServer={devServers[issue.issueId]}
                  devCommand={devCommandFor(issue)}
                  onViewDetails={() => setDetailsIssue(issue.issueId)}
                  onViewPlan={() => setPlanFor(issue)}
                  onViewLog={() => {
                    const s = sessionFor(issue)
                    if (s) openLog(s.id)
                  }}
                  onReprompt={() => setRepromptIssue(issue.issueId)}
                  onViewGhReview={() => setGhReviewFor(issue)}
                  onAnswerQuestions={() => setQuestionsFor(issue)}
                />
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="grid grid-cols-2 gap-4 @3xl:grid-cols-3 @5xl:grid-cols-5">
        {COLUMNS.map((col) => {
          const items = list.filter(
            (i) => (pending[i.issueId] ?? COLUMN_FOR_PHASE[i.phase]) === col.key
          )
          return (
            <section
              key={col.title}
              className="hairline flex min-w-0 flex-col rounded-xl border p-2.5"
              onDragOver={(e) => {
                e.preventDefault()
                e.dataTransfer.dropEffect = 'move'
                setDragCol(col.key)
              }}
              onDragLeave={(e) => {
                if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragCol(null)
              }}
              onDrop={(e) => {
                e.preventDefault()
                setDragCol(null)
                const issueId = e.dataTransfer.getData('text/plain')
                if (issueId) dropTo(col.key, issueId)
              }}
            >
              <header className="mb-2.5 flex items-center gap-2 px-1">
                <span className={cn('h-1.5 w-1.5 rounded-full', col.accent)} />
                <h2 className="text-[12px] font-bold uppercase tracking-wider text-ink-200">
                  {col.title}
                </h2>
                <span className="font-mono text-[10.5px] text-ink-400">{items.length}</span>
              </header>
              <div
                className={cn(
                  // flex-1: the drop target (and drag highlight) covers the
                  // column's full bordered height, not just its cards
                  'flex min-h-[120px] flex-1 flex-col gap-2.5 rounded-lg transition-colors',
                  dragCol === col.key && 'bg-ink-800/60 outline-dashed outline-1 outline-ink-500'
                )}
              >
                {items.length === 0 ? (
                  <p className="px-1 py-3 font-display text-[13px] text-ink-400/70">{col.hint}</p>
                ) : (
                  items.map((issue) => (
                    <div key={issue.issueId} {...dragProps(issue.issueId)} className="cursor-grab">
                      <IssueCard
                        issue={issue}
                        session={sessionFor(issue)}
                        devServer={devServers[issue.issueId]}
                        devCommand={devCommandFor(issue)}
                        onViewDetails={() => setDetailsIssue(issue.issueId)}
                        onViewPlan={() => setPlanFor(issue)}
                        onViewLog={() => {
                          const s = sessionFor(issue)
                          if (s) openLog(s.id)
                        }}
                        onReprompt={() => setRepromptIssue(issue.issueId)}
                        onViewGhReview={() => setGhReviewFor(issue)}
                        onAnswerQuestions={() => setQuestionsFor(issue)}
                      />
                    </div>
                  ))
                )}
              </div>
            </section>
          )
        })}
      </div>

      <p className="mt-8 flex items-center gap-1.5 text-[11px] text-ink-400">
        <ExternalLink size={11} />
        Tickets enter the board when they land in a mapped Linear column and are assigned to you.
      </p>

      {detailsFor && (
        <TicketDetailsDialog
          // keyed so opening a different ticket resets the browser/terminal panes
          key={detailsFor.issueId}
          issue={detailsFor}
          session={sessionFor(detailsFor)}
          devServer={devServers[detailsFor.issueId]}
          devCommand={devCommandFor(detailsFor)}
          onViewPlan={() => setPlanFor(detailsFor)}
          onViewLog={() => {
            const s = sessionFor(detailsFor)
            if (s) openLog(s.id)
          }}
          onReprompt={() => setRepromptIssue(detailsFor.issueId)}
          onClose={() => setDetailsIssue(null)}
        />
      )}
      {planFor && (
        <PlanDialog issue={issues[planFor.issueId] ?? planFor} onClose={() => setPlanFor(null)} />
      )}
      {questionsFor && (
        <PlanQuestionsDialog
          issue={issues[questionsFor.issueId] ?? questionsFor}
          onClose={() => setQuestionsFor(null)}
        />
      )}
      {repromptFor && <RepromptDialog issue={repromptFor} onClose={() => setRepromptIssue(null)} />}
      {ghReviewFor && (
        <GhReviewDialog
          issue={issues[ghReviewFor.issueId] ?? ghReviewFor}
          onClose={() => setGhReviewFor(null)}
        />
      )}
      {logView === 'board' && logSessionId && sessions[logSessionId] && (
        <LogViewer session={sessions[logSessionId]} onClose={closeLog} />
      )}
      {deployOpen && <DeployDialog onClose={() => setDeployOpen(false)} />}
      {newTicketOpen && <NewTicketDialog onClose={() => setNewTicketOpen(false)} />}
    </div>
  )
}
