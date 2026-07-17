import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactElement,
  type ReactNode
} from 'react'
import { Check, ChevronDown, Plus, RotateCcw, SquareTerminal, X } from 'lucide-react'
import type { CreateIssueInput, IssueCreateMeta, LinearTeam, TerminalInfo } from '@shared/types'
import { useApp } from '../store'
import { Button, Vu } from '../lib/ui'
import { cn } from '../lib/utils'
import SplitTerminal from './SplitTerminal'
import DockablePanel, { DockControls } from './DockablePanel'

const inputCls =
  'hairline-strong selectable rounded-lg border bg-ink-950 px-2.5 py-1.5 text-[12px] text-ink-50 placeholder:text-ink-400 focus:border-brass-500 focus:outline-none'
const selectCls =
  'hairline-strong rounded-lg border bg-ink-950 px-2 py-1.5 text-[12px] text-ink-50 focus:border-brass-500 focus:outline-none'

const PRIORITIES: Array<{ value: number; label: string }> = [
  { value: 0, label: 'No priority' },
  { value: 1, label: 'Urgent' },
  { value: 2, label: 'High' },
  { value: 3, label: 'Medium' },
  { value: 4, label: 'Low' }
]

function Field({ label, children }: { label: string; children: ReactNode }): ReactElement {
  return (
    <label className="flex min-w-0 flex-col gap-1">
      <span className="text-[11px] font-bold text-ink-300">{label}</span>
      {children}
    </label>
  )
}

interface DropdownOption {
  key: string
  label: string
  color?: string
}

const PANEL_MAX_H = 240

/** Lists at least this long get a filter input; shorter ones are just a styled menu. */
const FILTER_THRESHOLD = 8

/**
 * A styled select — every dropdown in the form uses it so none fall back to
 * the OS-native popup. Long lists get a filter input. Single-select closes on
 * pick; multi keeps the list open and marks selections with a check.
 */
function FilterDropdown({
  options,
  selected,
  onPick,
  triggerLabel,
  multi = false,
  disabled = false
}: {
  options: DropdownOption[]
  selected: Set<string>
  onPick: (key: string) => void
  triggerLabel: string
  multi?: boolean
  disabled?: boolean
}): ReactElement {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  // fixed positioning so the panel escapes the form's scroll container instead
  // of being clipped by it (it sits right above the terminal)
  const [panelStyle, setPanelStyle] = useState<CSSProperties>({})
  const anchorRef = useRef<HTMLDivElement>(null)
  const q = query.trim().toLowerCase()
  const filtered = q ? options.filter((o) => o.label.toLowerCase().includes(q)) : options

  const toggle = (): void => {
    if (open) {
      setOpen(false)
      return
    }
    const rect = anchorRef.current?.getBoundingClientRect()
    if (!rect) return
    const spaceBelow = window.innerHeight - rect.bottom
    const openUp = spaceBelow < PANEL_MAX_H + 20 && rect.top > spaceBelow
    setPanelStyle({
      position: 'fixed',
      left: rect.left,
      width: rect.width,
      ...(openUp ? { bottom: window.innerHeight - rect.top + 4 } : { top: rect.bottom + 4 })
    })
    setQuery('')
    setOpen(true)
  }

  return (
    <div ref={anchorRef}>
      <button
        type="button"
        onClick={toggle}
        disabled={disabled}
        className={cn(
          selectCls,
          'flex w-full items-center justify-between gap-2 text-left disabled:opacity-50'
        )}
      >
        <span className="truncate">{triggerLabel}</span>
        <ChevronDown size={12} className="shrink-0 text-ink-400" />
      </button>
      {open && (
        <>
          <div
            className="fixed inset-0 z-[70]"
            onClick={(e) => {
              // preventDefault stops the surrounding <label> from forwarding
              // this click to the trigger button, which would reopen the panel
              e.preventDefault()
              setOpen(false)
            }}
          />
          <div
            style={panelStyle}
            className="hairline-strong z-[71] flex max-h-[240px] flex-col overflow-hidden rounded-lg border bg-ink-900 shadow-2xl"
          >
            {options.length >= FILTER_THRESHOLD && (
              <input
                autoFocus
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="filter…"
                spellCheck={false}
                className="hairline selectable border-b bg-transparent px-3 py-2 text-[12px] text-ink-50 outline-none placeholder:text-ink-400"
              />
            )}
            <div className="min-h-0 overflow-y-auto py-1">
              {filtered.length === 0 && (
                <p className="px-3 py-2 font-display text-[12px] text-ink-400">no matches</p>
              )}
              {filtered.map((o) => (
                <button
                  key={o.key}
                  onClick={() => {
                    onPick(o.key)
                    if (!multi) setOpen(false)
                  }}
                  className={cn(
                    'flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] hover:bg-ink-700',
                    selected.has(o.key) ? 'text-brass-300' : 'text-ink-100'
                  )}
                >
                  {o.color && (
                    <span
                      className="h-2 w-2 shrink-0 rounded-full"
                      style={{ backgroundColor: o.color }}
                    />
                  )}
                  <span className="truncate">{o.label}</span>
                  {selected.has(o.key) && <Check size={12} className="ml-auto shrink-0" />}
                </button>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  )
}

/**
 * The terminal under the form: plain interactive claude in the target repo,
 * for drafting the ticket. Keyed by repo in the main process, so switching
 * the target repo switches terminals (the old one stays alive as a
 * Terminal-view tab).
 */
function DraftTerminal({ repoPath }: { repoPath?: string }): ReactElement {
  // keyed by repoPath so switching repos derives back to "opening…" without a
  // synchronous state reset in the effect
  const [created, setCreated] = useState<{ key?: string; info: TerminalInfo } | null>(null)
  const [failure, setFailure] = useState<{ key?: string; message: string } | null>(null)
  const [attempt, setAttempt] = useState(0)
  const term = created && created.key === repoPath ? created.info : null
  const error = failure && failure.key === repoPath ? failure.message : null
  const alive = useApp((s) => (term ? s.termTabs.some((t) => t.id === term.id) : false))

  useEffect(() => {
    let cancelled = false
    window.sully
      .termCreateTicketDraft(repoPath)
      .then((info) => {
        if (cancelled) return
        useApp.getState().termOpened(info) // register as a Terminal-view tab too
        setCreated({ key: repoPath, info })
        setFailure(null)
      })
      .catch((err: unknown) => {
        if (!cancelled)
          setFailure({ key: repoPath, message: err instanceof Error ? err.message : String(err) })
      })
    return () => {
      cancelled = true
    }
  }, [repoPath, attempt])

  const retry = (): void => {
    setFailure(null)
    setAttempt((a) => a + 1)
  }

  if (error) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3">
        <p className="font-display text-[18px] text-ink-300">couldn&apos;t open the terminal</p>
        <p className="max-w-[420px] text-center text-[12.5px] text-ink-400">{error}</p>
        <Button onClick={retry}>
          <RotateCcw size={11} /> Try again
        </Button>
      </div>
    )
  }
  if (term && alive) return <SplitTerminal rootId={term.id} active />
  if (term) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3">
        <p className="font-display text-[18px] text-ink-300">session ended</p>
        <Button onClick={retry}>
          <SquareTerminal size={11} /> New session
        </Button>
      </div>
    )
  }
  return (
    <div className="flex h-full items-center justify-center">
      <p className="breathe font-display text-[15px] text-ink-300">opening terminal…</p>
    </div>
  )
}

/** A label choice: an existing Linear label id, or `new:<name>` for one created on submit. */
const labelKeyFor = (meta: IssueCreateMeta, name: string): string =>
  meta.labels.find((l) => l.name.toLowerCase() === name.toLowerCase())?.id ?? `new:${name}`

export default function NewTicketDialog({ onClose }: { onClose: () => void }): ReactElement {
  const settings = useApp((s) => s.settings)
  const viewer = useApp((s) => s.viewer)
  const repos = settings?.repoMappings ?? []

  const [teams, setTeams] = useState<LinearTeam[]>([])
  const [teamId, setTeamId] = useState(settings?.columnMappings[0]?.teamId ?? '')
  // keyed by team so switching teams derives back to "loading…" without a
  // synchronous state reset in the effect
  const [metaState, setMetaState] = useState<{ teamId: string; meta: IssueCreateMeta } | null>(null)
  const [metaFailure, setMetaFailure] = useState<{ teamId: string; message: string } | null>(null)
  const [metaAttempt, setMetaAttempt] = useState(0)
  const meta = metaState?.teamId === teamId ? metaState.meta : null
  const metaError = metaFailure?.teamId === teamId ? metaFailure.message : null

  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [stateId, setStateId] = useState('')
  const [assigneeId, setAssigneeId] = useState('')
  const [priority, setPriority] = useState(0)
  const [projectId, setProjectId] = useState('')
  const [repoId, setRepoId] = useState(repos[0]?.id ?? '')
  const [labelKeys, setLabelKeys] = useState<Set<string>>(new Set())
  const [creating, setCreating] = useState(false)

  useEffect(() => {
    window.sully
      .linearTeams()
      .then((ts) => {
        setTeams(ts)
        setTeamId((cur) => cur || ts[0]?.id || '')
      })
      .catch((err: unknown) =>
        setMetaFailure({ teamId: '', message: err instanceof Error ? err.message : String(err) })
      )
  }, [])

  useEffect(() => {
    if (!teamId) return
    let cancelled = false
    window.sully
      .linearIssueCreateMeta(teamId)
      .then((m) => {
        if (cancelled) return
        setMetaState({ teamId, meta: m })
        // defaults: the team's Planning column (so Sully picks the ticket up),
        // me as assignee, and the opt-in + repo routing labels preselected
        const st = useApp.getState()
        const mapping = st.settings?.columnMappings.find((c) => c.teamId === teamId)
        setStateId(
          mapping && m.states.some((s) => s.id === mapping.planningStateId)
            ? mapping.planningStateId
            : (m.states[0]?.id ?? '')
        )
        const me = st.viewer
        setAssigneeId(me && m.members.some((u) => u.id === me.id) ? me.id : '')
        setProjectId('')
        const keys = new Set<string>()
        const required = st.settings?.orchestrator.requiredLabel?.trim()
        if (required) keys.add(labelKeyFor(m, required))
        setLabelKeys(keys)
      })
      .catch((err: unknown) => {
        if (!cancelled)
          setMetaFailure({ teamId, message: err instanceof Error ? err.message : String(err) })
      })
    return () => {
      cancelled = true
    }
  }, [teamId, metaAttempt])

  const repo = repos.find((r) => r.id === repoId)

  const toggleLabel = (key: string): void =>
    setLabelKeys((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })

  const canCreate = Boolean(meta && teamId && title.trim() && !creating)

  const create = async (): Promise<void> => {
    if (!canCreate) return
    const labelIds: string[] = []
    const ensureLabelNames: string[] = []
    for (const key of labelKeys) {
      if (key.startsWith('new:')) ensureLabelNames.push(key.slice(4))
      else labelIds.push(key)
    }
    const input: CreateIssueInput = {
      teamId,
      title: title.trim(),
      description: description.trim() || undefined,
      stateId: stateId || undefined,
      assigneeId: assigneeId || undefined,
      priority,
      labelIds,
      ensureLabelNames: ensureLabelNames.length > 0 ? ensureLabelNames : undefined,
      projectId: projectId || undefined
    }
    setCreating(true)
    try {
      const created = await window.sully.createLinearIssue(input)
      useApp.getState().pushToast('success', `${created.identifier} created`)
      onClose()
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err)
      useApp
        .getState()
        .pushToast(
          'error',
          raw.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') ||
            'Something went wrong'
        )
    } finally {
      setCreating(false)
    }
  }

  // `new:` keys are labels Linear doesn't have yet — created on submit
  const newLabelNames = [...labelKeys].filter((k) => k.startsWith('new:')).map((k) => k.slice(4))
  const memberLabel = (id: string): string => {
    const m = meta?.members.find((u) => u.id === id)
    return m ? `${m.displayName || m.name}${viewer?.id === m.id ? ' (me)' : ''}` : 'Unassigned'
  }
  const selectedLabelNames = [
    ...(meta?.labels ?? []).filter((l) => labelKeys.has(l.id)).map((l) => l.name),
    ...newLabelNames.map((n) => `${n} (new)`)
  ]

  return (
    <DockablePanel
      id="new-ticket"
      modalClassName="h-[min(980px,92vh)] w-[min(1100px,92vw)] min-h-[520px] min-w-[560px]"
      minWidth={560}
      minHeight={520}
    >
      <header className="hairline flex items-center justify-between border-b px-6 py-4">
        <div>
          <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-brass-400">
            new ticket
          </p>
          <h3 className="mt-0.5 font-display text-[19px] text-ink-50">
            {title.trim() || 'untitled'}
          </h3>
        </div>
        <div className="flex items-center gap-3">
          <DockControls />
          <button onClick={onClose} className="text-ink-300 hover:text-ink-50">
            <X size={17} />
          </button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-6 py-4">
        <div className="grid grid-cols-3 gap-3">
          <Field label="Team">
            <FilterDropdown
              options={teams.map((t) => ({ key: t.id, label: t.name }))}
              selected={new Set([teamId])}
              onPick={setTeamId}
              triggerLabel={teams.find((t) => t.id === teamId)?.name ?? '…'}
            />
          </Field>
          {repos.length > 0 && (
            <Field label="Target repo">
              <FilterDropdown
                options={repos.map((r) => ({ key: r.id, label: r.label }))}
                selected={new Set([repoId])}
                onPick={setRepoId}
                triggerLabel={repo?.label ?? '…'}
              />
            </Field>
          )}
          <Field label="Status">
            <FilterDropdown
              options={(meta?.states ?? []).map((s) => ({
                key: s.id,
                label: s.name,
                color: s.color
              }))}
              selected={new Set([stateId])}
              onPick={setStateId}
              triggerLabel={meta?.states.find((s) => s.id === stateId)?.name ?? '…'}
              disabled={!meta}
            />
          </Field>
        </div>

        <Field label="Title">
          <input
            className={inputCls}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="What needs doing?"
            autoFocus
          />
        </Field>

        <Field label="Description (markdown)">
          <textarea
            className={cn(inputCls, 'min-h-[110px] resize-y font-mono leading-relaxed')}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            spellCheck={false}
            placeholder="Context, proposed approach, acceptance criteria — draft it with the agent below."
          />
        </Field>

        {!meta && !metaError && (
          <span className="flex items-center gap-1.5 py-1 text-[11px] text-brass-300">
            <Vu /> loading team metadata…
          </span>
        )}
        {metaError && (
          <div className="flex items-center gap-2.5">
            <p className="text-[11.5px] text-terra-400">{metaError}</p>
            <Button onClick={() => setMetaAttempt((a) => a + 1)}>
              <RotateCcw size={11} /> Retry
            </Button>
          </div>
        )}

        {meta && (
          <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
            <Field label="Priority">
              <FilterDropdown
                options={PRIORITIES.map((p) => ({ key: String(p.value), label: p.label }))}
                selected={new Set([String(priority)])}
                onPick={(k) => setPriority(Number(k))}
                triggerLabel={PRIORITIES.find((p) => p.value === priority)?.label ?? 'No priority'}
              />
            </Field>
            <Field label="Assignee">
              <FilterDropdown
                options={[
                  { key: '', label: 'Unassigned' },
                  ...meta.members.map((m) => ({ key: m.id, label: memberLabel(m.id) }))
                ]}
                selected={new Set([assigneeId])}
                onPick={setAssigneeId}
                triggerLabel={memberLabel(assigneeId)}
              />
            </Field>
            <Field label="Project">
              <FilterDropdown
                options={[
                  { key: '', label: 'No project' },
                  ...meta.projects.map((p) => ({ key: p.id, label: p.name }))
                ]}
                selected={new Set([projectId])}
                onPick={setProjectId}
                triggerLabel={meta.projects.find((p) => p.id === projectId)?.name ?? 'No project'}
              />
            </Field>
            <Field label="Labels">
              <FilterDropdown
                multi
                options={[
                  ...meta.labels.map((l) => ({ key: l.id, label: l.name, color: l.color })),
                  ...newLabelNames.map((name) => ({ key: `new:${name}`, label: `${name} (new)` }))
                ]}
                selected={labelKeys}
                onPick={toggleLabel}
                triggerLabel={
                  selectedLabelNames.length > 0 ? selectedLabelNames.join(', ') : 'No labels'
                }
              />
            </Field>
          </div>
        )}
      </div>

      <div className="hairline h-[32%] min-h-[190px] shrink-0 border-t bg-ink-950/40 p-2">
        <DraftTerminal repoPath={repo?.repoPath} />
      </div>

      <footer className="hairline flex items-center justify-between gap-3 border-t px-6 py-3.5">
        <p className="text-[11px] text-ink-400">
          Draft the ticket with claude above, then paste the title and description into the form.
        </p>
        <div className="flex shrink-0 gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!canCreate} onClick={() => void create()}>
            <Plus size={12} /> {creating ? 'Creating…' : 'Create ticket'}
          </Button>
        </div>
      </footer>
    </DockablePanel>
  )
}
