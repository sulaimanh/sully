import { useEffect, useState, type ReactElement } from 'react'
import {
  CheckCircle2,
  FolderOpen,
  Plus,
  RefreshCw,
  Stethoscope,
  Trash2,
  XCircle
} from 'lucide-react'
import type {
  AppSettings,
  ColumnMapping,
  DoctorReport,
  LinearTeam,
  LinearWorkflowState,
  PhaseConfig,
  PhaseKey,
  RepoMapping
} from '@shared/types'
import { call, useApp } from '../store'
import { Button, SectionTitle, Toggle } from '../lib/ui'
import { cn } from '../lib/utils'

function Field({ label, children }: { label: string; children: ReactElement }): ReactElement {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[11px] font-bold text-ink-300">{label}</span>
      {children}
    </label>
  )
}

const inputCls =
  'hairline-strong selectable rounded-lg border bg-ink-950 px-2.5 py-1.5 text-[12px] text-ink-50 placeholder:text-ink-400 focus:border-brass-500 focus:outline-none'
const selectCls =
  'hairline-strong rounded-lg border bg-ink-950 px-2 py-1.5 text-[12px] text-ink-50 focus:border-brass-500 focus:outline-none'

function useSaveSettings(): (next: AppSettings) => void {
  const applySettings = useApp((s) => s.applySettings)
  return (next) => {
    applySettings(next)
    void call(window.sully.setSettings(next))
  }
}

/** Linear fetch failures must not leave silently empty dropdowns — say why. */
function toastFetchError(what: string): void {
  useApp
    .getState()
    .pushToast('error', `Could not load ${what} — check your Linear API key under Credentials`)
}

// ---------- credentials + doctor ----------

function CredentialsSection(): ReactElement {
  const { credentials, refresh } = useApp()
  const [linearKey, setLinearKey] = useState('')
  const [ghToken, setGhToken] = useState('')
  const [figmaToken, setFigmaToken] = useState('')
  const [posthogKey, setPosthogKey] = useState('')
  const [doctor, setDoctor] = useState<DoctorReport | null>(null)
  const [checking, setChecking] = useState(false)
  const [reconnecting, setReconnecting] = useState<string | null>(null)

  async function save(): Promise<void> {
    const ok = await call(
      window.sully.setCredentials({
        ...(linearKey.trim() ? { linearApiKey: linearKey.trim() } : {}),
        ...(ghToken.trim() ? { ghToken: ghToken.trim() } : {}),
        ...(figmaToken.trim() ? { figmaToken: figmaToken.trim() } : {}),
        ...(posthogKey.trim() ? { posthogApiKey: posthogKey.trim() } : {})
      }),
      'Keys saved'
    )
    if (!ok) return
    setLinearKey('')
    setGhToken('')
    setFigmaToken('')
    setPosthogKey('')
    await refresh()
  }

  async function runDoctor(): Promise<void> {
    setChecking(true)
    try {
      setDoctor(await window.sully.runDoctor())
    } finally {
      setChecking(false)
    }
  }

  // `claude mcp login` opens the browser OAuth flow; the returned check
  // replaces just that server's row
  async function reconnectMcp(name: string): Promise<void> {
    setReconnecting(name)
    try {
      const check = await window.sully.mcpLogin(name)
      setDoctor((d) => d && { ...d, checks: d.checks.map((c) => (c.id === check.id ? check : c)) })
      useApp
        .getState()
        .pushToast(check.ok ? 'success' : 'error', `MCP ${name}: ${check.detail.slice(0, 120)}`)
    } catch (err) {
      useApp.getState().pushToast('error', `MCP ${name}: ${(err as Error).message}`)
    } finally {
      setReconnecting(null)
    }
  }

  return (
    <section>
      <SectionTitle>Credentials &amp; health</SectionTitle>
      <div className="hairline rounded-xl border bg-ink-850 p-4">
        <div className="grid grid-cols-2 gap-3">
          <Field label={`Linear API key ${credentials?.linearKeySet ? '(saved)' : ''}`}>
            <input
              type="password"
              className={inputCls}
              value={linearKey}
              onChange={(e) => setLinearKey(e.target.value)}
              placeholder={credentials?.linearKeySet ? '••••••••' : 'lin_api_…'}
            />
          </Field>
          <Field
            label={`GitHub token ${credentials?.ghCliAuthed ? '(gh CLI already authed)' : credentials?.ghTokenSet ? '(saved)' : '(optional if gh CLI is authed)'}`}
          >
            <input
              type="password"
              className={inputCls}
              value={ghToken}
              onChange={(e) => setGhToken(e.target.value)}
              placeholder="ghp_…"
            />
          </Field>
          <Field
            label={`Figma API token ${credentials?.figmaTokenSet ? '(saved)' : '(for reading Figma comments)'}`}
          >
            <input
              type="password"
              className={inputCls}
              value={figmaToken}
              onChange={(e) => setFigmaToken(e.target.value)}
              placeholder="figd_…"
            />
          </Field>
          <Field
            label={`PostHog personal API key ${credentials?.posthogKeySet ? '(saved)' : '(for the Errors tab)'}`}
          >
            <input
              type="password"
              className={inputCls}
              value={posthogKey}
              onChange={(e) => setPosthogKey(e.target.value)}
              placeholder="phx_…"
            />
          </Field>
        </div>
        <div className="mt-3 flex items-center gap-2">
          <Button
            onClick={() => void save()}
            disabled={
              !linearKey.trim() && !ghToken.trim() && !figmaToken.trim() && !posthogKey.trim()
            }
          >
            Save keys
          </Button>
          <Button onClick={() => void runDoctor()} disabled={checking}>
            {checking ? (
              <RefreshCw size={12} className="animate-spin" />
            ) : (
              <Stethoscope size={12} />
            )}
            Run doctor
          </Button>
          {doctor && (
            <span className="text-[11px] text-ink-400">
              checked {new Date(doctor.ranAt).toLocaleTimeString()}
            </span>
          )}
        </div>
        {doctor && (
          <div className="mt-3 grid grid-cols-2 gap-x-6 gap-y-1.5">
            {doctor.checks.map((c) => (
              <div key={c.id} className="flex items-start gap-2">
                {c.ok ? (
                  <CheckCircle2 size={13} className="mt-0.5 shrink-0 text-sage-400" />
                ) : (
                  <XCircle size={13} className="mt-0.5 shrink-0 text-terra-400" />
                )}
                <div className="min-w-0">
                  <p className="text-[12px] font-bold text-ink-100">{c.label}</p>
                  <p className="selectable break-words font-mono text-[10.5px] text-ink-400">
                    {c.detail}
                  </p>
                  {!c.ok && c.id.startsWith('mcp-') && (
                    <Button
                      className="mt-1"
                      onClick={() => void reconnectMcp(c.id.slice('mcp-'.length))}
                      disabled={reconnecting !== null}
                    >
                      {reconnecting === c.id.slice('mcp-'.length) ? (
                        <>
                          <RefreshCw size={12} className="animate-spin" />
                          Waiting for browser…
                        </>
                      ) : (
                        'Reconnect'
                      )}
                    </Button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  )
}

// ---------- column mappings ----------

function ColumnMappingCard({
  mapping,
  onChange,
  onRemove
}: {
  mapping: ColumnMapping
  onChange: (m: ColumnMapping) => void
  onRemove: () => void
}): ReactElement {
  const [states, setStates] = useState<LinearWorkflowState[]>([])

  useEffect(() => {
    void window.sully
      .linearWorkflowStates(mapping.teamId)
      .then(setStates)
      .catch(() => toastFetchError(`workflow states for ${mapping.teamName}`))
  }, [mapping.teamId, mapping.teamName])

  const stateSelect = (
    label: string,
    key: keyof Pick<
      ColumnMapping,
      | 'planningStateId'
      | 'planReadyStateId'
      | 'inProgressStateId'
      | 'inReviewStateId'
      | 'uncategorizedStateId'
    >
  ): ReactElement => (
    <Field label={label}>
      <select
        className={selectCls}
        value={mapping[key] ?? ''}
        onChange={(e) => onChange({ ...mapping, [key]: e.target.value })}
      >
        <option value="">— pick a column —</option>
        {states.map((s) => (
          <option key={s.id} value={s.id}>
            {s.name}
          </option>
        ))}
      </select>
    </Field>
  )

  return (
    <div className="hairline rounded-xl border bg-ink-850 p-4">
      <div className="mb-3 flex items-center justify-between">
        <p className="text-[13px] font-bold text-ink-50">
          {mapping.teamName}{' '}
          <span className="font-mono text-[11px] text-ink-400">({mapping.teamKey})</span>
        </p>
        <Button variant="danger" onClick={onRemove} title="Remove mapping">
          <Trash2 size={12} />
        </Button>
      </div>
      <div className="grid grid-cols-4 gap-3">
        {stateSelect('Uncategorized (parked)', 'uncategorizedStateId')}
        {stateSelect('Planning', 'planningStateId')}
        {stateSelect('Plan ready', 'planReadyStateId')}
        {stateSelect('In progress', 'inProgressStateId')}
        {stateSelect('In review', 'inReviewStateId')}
      </div>
    </div>
  )
}

function ColumnsSection(): ReactElement {
  const settings = useApp((s) => s.settings)!
  const save = useSaveSettings()
  const [teams, setTeams] = useState<LinearTeam[]>([])
  const [pickerOpen, setPickerOpen] = useState(false)

  useEffect(() => {
    void window.sully
      .linearTeams()
      .then(setTeams)
      .catch(() => toastFetchError('Linear teams'))
  }, [])

  const unmappedTeams = teams.filter((t) => !settings.columnMappings.some((m) => m.teamId === t.id))

  return (
    <section>
      <SectionTitle>Linear columns → phases</SectionTitle>
      <p className="mb-3 -mt-1 text-[11.5px] text-ink-400">
        A ticket assigned to you entering <em>Planning</em> gets planned; you approve; coding runs
        in <em>In progress</em>; the PR moves it to <em>In review</em>. <em>Uncategorized</em> is
        optional: tickets there show on the board, but Sully never touches them.
      </p>
      <div className="flex flex-col gap-3">
        {settings.columnMappings.map((m, idx) => (
          <ColumnMappingCard
            key={m.teamId}
            mapping={m}
            onChange={(next) => {
              const columnMappings = [...settings.columnMappings]
              columnMappings[idx] = next
              save({ ...settings, columnMappings })
            }}
            onRemove={() =>
              save({
                ...settings,
                columnMappings: settings.columnMappings.filter((x) => x.teamId !== m.teamId)
              })
            }
          />
        ))}

        {pickerOpen ? (
          <div className="hairline flex items-center gap-2 rounded-xl border border-dashed bg-ink-900 p-3">
            <select
              className={cn(selectCls, 'flex-1')}
              defaultValue=""
              onChange={(e) => {
                const team = teams.find((t) => t.id === e.target.value)
                if (!team) return
                save({
                  ...settings,
                  columnMappings: [
                    ...settings.columnMappings,
                    {
                      teamId: team.id,
                      teamKey: team.key,
                      teamName: team.name,
                      planningStateId: '',
                      planReadyStateId: '',
                      inProgressStateId: '',
                      inReviewStateId: '',
                      uncategorizedStateId: ''
                    }
                  ]
                })
                setPickerOpen(false)
              }}
            >
              <option value="" disabled>
                pick a Linear team…
              </option>
              {unmappedTeams.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name} ({t.key})
                </option>
              ))}
            </select>
            <Button onClick={() => setPickerOpen(false)}>Cancel</Button>
          </div>
        ) : (
          <Button onClick={() => setPickerOpen(true)} className="self-start">
            <Plus size={12} /> Add team
          </Button>
        )}
      </div>
    </section>
  )
}

// ---------- repo mappings ----------

function ReposSection(): ReactElement {
  const settings = useApp((s) => s.settings)!
  const save = useSaveSettings()
  const [teams, setTeams] = useState<LinearTeam[]>([])

  useEffect(() => {
    // team fetch failure already toasts from ColumnsSection; stay quiet here
    void window.sully
      .linearTeams()
      .then(setTeams)
      .catch(() => {})
  }, [])

  async function addRepo(): Promise<void> {
    const path = await window.sully.pickFolder()
    if (!path) return
    const name = path.split('/').pop() ?? path
    const repo: RepoMapping = {
      id: crypto.randomUUID(),
      label: name,
      // prefill the repo:<name> convention — editable per row
      linearLabel: `repo:${name}`,
      repoPath: path
    }
    save({ ...settings, repoMappings: [...settings.repoMappings, repo] })
  }

  function updateRepo(idx: number, patch: Partial<RepoMapping>): void {
    const repoMappings = [...settings.repoMappings]
    repoMappings[idx] = { ...repoMappings[idx], ...patch }
    save({ ...settings, repoMappings })
  }

  return (
    <section>
      <SectionTitle>Repositories</SectionTitle>
      <p className="mb-3 -mt-1 text-[11.5px] text-ink-400">
        Tickets resolve their repo by Linear label first (e.g.{' '}
        <code className="font-mono text-ink-300">repo:frontend</code>), then by team. Repos are also
        where PR auto-reviews run. The dev command powers the run button on ticket cards; the deploy
        command powers the Deploy button on the board (blank hides them).
      </p>
      <div className="flex flex-col gap-2">
        {settings.repoMappings.map((r, idx) => (
          <div
            key={r.id}
            className="hairline flex items-center gap-3 rounded-xl border bg-ink-850 px-4 py-2.5"
          >
            <FolderOpen size={14} className="shrink-0 text-brass-400" />
            <div className="min-w-0 flex-1">
              <p className="text-[12.5px] font-bold text-ink-50">{r.label}</p>
              <p className="truncate font-mono text-[10.5px] text-ink-400">{r.repoPath}</p>
            </div>
            <input
              className={cn(inputCls, 'w-[170px] font-mono')}
              value={r.linearLabel ?? ''}
              placeholder="repo:name label"
              title="Linear label that routes tickets to this repo"
              onChange={(e) => updateRepo(idx, { linearLabel: e.target.value || undefined })}
            />
            <input
              className={cn(inputCls, 'w-[150px] font-mono')}
              value={r.devCommand ?? ''}
              placeholder="npm run dev"
              title="Dev environment command, run from the ticket's worktree"
              onChange={(e) => updateRepo(idx, { devCommand: e.target.value || undefined })}
            />
            <input
              className={cn(inputCls, 'w-[150px] font-mono')}
              value={r.deployCommand ?? ''}
              placeholder="./scripts/release.sh"
              title="Release command, run from the repo root — the chosen version bump (patch/minor/major) is appended. Blank hides the deploy button."
              onChange={(e) => updateRepo(idx, { deployCommand: e.target.value || undefined })}
            />
            <input
              className={cn(inputCls, 'w-[110px] font-mono')}
              value={r.baseBranch ?? ''}
              placeholder="auto (main)"
              title="Base branch new ticket branches are cut from — blank auto-detects origin's default"
              onChange={(e) => updateRepo(idx, { baseBranch: e.target.value || undefined })}
            />
            <select
              className={selectCls}
              value={r.linearTeamId ?? ''}
              onChange={(e) => updateRepo(idx, { linearTeamId: e.target.value || undefined })}
            >
              <option value="">no team fallback</option>
              {teams.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
            <Button
              variant="danger"
              onClick={() =>
                save({
                  ...settings,
                  repoMappings: settings.repoMappings.filter((x) => x.id !== r.id)
                })
              }
            >
              <Trash2 size={12} />
            </Button>
          </div>
        ))}
        <Button onClick={() => void addRepo()} className="self-start">
          <Plus size={12} /> Add repository
        </Button>
      </div>
    </section>
  )
}

// ---------- error tracking ----------

function ErrorTrackingSection(): ReactElement {
  const settings = useApp((s) => s.settings)!
  const save = useSaveSettings()
  const et = settings.errorTracking
  const update = (patch: Partial<typeof et>): void =>
    save({ ...settings, errorTracking: { ...et, ...patch } })

  return (
    <section>
      <SectionTitle>Error tracking</SectionTitle>
      <p className="mb-3 -mt-1 text-[11.5px] text-ink-400">
        Powers the Errors tab from PostHog error tracking. Needs a PostHog personal API key under
        Credentials. The backend is still migrating to PostHog — leave its project ID blank until
        that lands. Investigation repos say where the Investigate agent runs (defaults to your only
        repo when just one is mapped).
      </p>
      <div className="hairline grid grid-cols-3 gap-3 rounded-xl border bg-ink-850 p-4">
        <Field label="PostHog host">
          <input
            className={cn(inputCls, 'font-mono')}
            value={et.host}
            placeholder="https://us.posthog.com"
            onChange={(e) => update({ host: e.target.value })}
          />
        </Field>
        <Field label="Frontend project ID">
          <input
            className={cn(inputCls, 'font-mono')}
            value={et.frontendProjectId}
            placeholder="94442"
            onChange={(e) => update({ frontendProjectId: e.target.value })}
          />
        </Field>
        <Field label="Backend project ID (blank until the migration lands)">
          <input
            className={cn(inputCls, 'font-mono')}
            value={et.backendProjectId}
            placeholder="not on PostHog yet"
            onChange={(e) => update({ backendProjectId: e.target.value })}
          />
        </Field>
        <Field label="Frontend investigation repo">
          <select
            className={selectCls}
            value={et.frontendRepoId ?? ''}
            onChange={(e) => update({ frontendRepoId: e.target.value || undefined })}
          >
            <option value="">
              {settings.repoMappings.length === 1 ? 'auto (only repo)' : '— pick a repo —'}
            </option>
            {settings.repoMappings.map((r) => (
              <option key={r.id} value={r.id}>
                {r.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Backend investigation repo">
          <select
            className={selectCls}
            value={et.backendRepoId ?? ''}
            onChange={(e) => update({ backendRepoId: e.target.value || undefined })}
          >
            <option value="">
              {settings.repoMappings.length === 1 ? 'auto (only repo)' : '— pick a repo —'}
            </option>
            {settings.repoMappings.map((r) => (
              <option key={r.id} value={r.id}>
                {r.label}
              </option>
            ))}
          </select>
        </Field>
      </div>
    </section>
  )
}

// ---------- phase configs ----------

const PHASES: Array<{ key: PhaseKey; title: string; blurb: string }> = [
  { key: 'planning', title: 'Planning', blurb: 'drafts the implementation plan' },
  { key: 'coding', title: 'Coding', blurb: 'implements the approved plan' },
  { key: 'createPr', title: 'Create PR', blurb: 'commits, pushes, and opens the PR' },
  { key: 'prReview', title: 'PR Review', blurb: 'reviews teammates’ PRs' },
  {
    key: 'errorInvestigation',
    title: 'Error Investigation',
    blurb: 'root-causes errors from the Errors tab'
  }
]

// claude values are CLI aliases that always resolve to the latest model of
// each tier; codex has no list-models command, so that side is curated.
const MODEL_OPTIONS: Record<PhaseConfig['agent'], Array<{ value: string; label: string }>> = {
  claude: [
    { value: '', label: 'CLI default' },
    { value: 'fable', label: 'Fable (latest)' },
    { value: 'opus', label: 'Opus (latest)' },
    { value: 'sonnet', label: 'Sonnet (latest)' },
    { value: 'haiku', label: 'Haiku (latest)' }
  ],
  codex: [
    { value: '', label: 'CLI default (config.toml)' },
    { value: 'gpt-5.5', label: 'gpt-5.5' },
    { value: 'gpt-5.1-codex-max', label: 'gpt-5.1-codex-max' },
    { value: 'gpt-5.1-codex', label: 'gpt-5.1-codex' },
    { value: 'gpt-5.1-codex-mini', label: 'gpt-5.1-codex-mini' }
  ]
}

function PhaseCard({
  title,
  blurb,
  config,
  skills,
  mcpServers,
  onChange
}: {
  title: string
  blurb: string
  config: PhaseConfig
  skills: string[]
  mcpServers: string[]
  onChange: (c: PhaseConfig) => void
}): ReactElement {
  const models = MODEL_OPTIONS[config.agent]
  // preserve a stored value that isn't in the curated list
  const modelValue = config.model ?? ''
  const modelKnown = models.some((m) => m.value === modelValue)
  const skillValue = config.skill ?? ''
  const skillKnown = !skillValue || skills.some((s) => `/${s}` === skillValue)

  return (
    <div className="hairline rounded-xl border bg-ink-850 p-4">
      <p className="text-[13px] font-bold text-ink-50">{title}</p>
      <p className="mb-3 text-[11px] text-ink-400">{blurb}</p>
      <div className="flex flex-col gap-2.5">
        <Field label="Agent">
          <select
            className={selectCls}
            value={config.agent}
            onChange={(e) =>
              // model lists and skills don't carry across agents — reset both
              onChange({
                ...config,
                agent: e.target.value as PhaseConfig['agent'],
                model: undefined,
                skill: undefined
              })
            }
          >
            <option value="claude">claude (default)</option>
            <option value="codex">codex</option>
          </select>
        </Field>
        <Field label="Model">
          <select
            className={selectCls}
            value={modelValue}
            onChange={(e) => onChange({ ...config, model: e.target.value || undefined })}
          >
            {models.map((m) => (
              <option key={m.value} value={m.value}>
                {m.label}
              </option>
            ))}
            {!modelKnown && <option value={modelValue}>{modelValue} (custom)</option>}
          </select>
        </Field>
        <Field label={config.agent === 'claude' ? 'Skill (blank = built-in prompt)' : 'Skill'}>
          <select
            className={selectCls}
            value={skillValue}
            disabled={config.agent !== 'claude'}
            onChange={(e) => onChange({ ...config, skill: e.target.value || undefined })}
          >
            <option value="">
              {config.agent === 'claude' ? 'built-in prompt' : 'not supported by codex'}
            </option>
            {config.agent === 'claude' &&
              skills.map((s) => (
                <option key={s} value={`/${s}`}>
                  /{s}
                </option>
              ))}
            {!skillKnown && <option value={skillValue}>{skillValue} (custom)</option>}
          </select>
        </Field>
        <Field label="Injected prompt (prepended to every session)">
          <textarea
            className={cn(inputCls, 'min-h-[54px] resize-y')}
            placeholder="extra context for this phase, e.g. sibling repo paths"
            value={config.injectedPrompt ?? ''}
            onChange={(e) => onChange({ ...config, injectedPrompt: e.target.value || undefined })}
          />
        </Field>
        <div className="grid grid-cols-2 gap-2.5">
          <Field label="Permissions">
            <select
              className={selectCls}
              value={config.permissionMode}
              onChange={(e) =>
                onChange({
                  ...config,
                  permissionMode: e.target.value as PhaseConfig['permissionMode']
                })
              }
            >
              <option value="acceptEdits">accept edits</option>
              <option value="bypass">bypass all (yolo)</option>
            </select>
          </Field>
          <Field label="Timeout (min)">
            <input
              type="number"
              className={inputCls}
              value={Math.round(config.timeoutMs / 60000)}
              min={1}
              onChange={(e) =>
                onChange({ ...config, timeoutMs: Math.max(1, Number(e.target.value)) * 60000 })
              }
            />
          </Field>
        </div>
        <Field label="MCP servers">
          <select
            className={selectCls}
            value={Array.isArray(config.mcp) ? 'custom' : config.mcp === false ? 'none' : 'all'}
            disabled={config.agent !== 'claude'}
            title="Loading MCP servers puts every server's tool schemas in context on each turn — load only what the phase uses"
            onChange={(e) => {
              const v = e.target.value
              // entering custom starts from all detected servers so nothing
              // the phase relies on silently disappears
              onChange({
                ...config,
                mcp: v === 'none' ? false : v === 'custom' ? mcpServers : true
              })
            }}
          >
            <option value="all">
              {config.agent === 'claude' ? 'load all (from claude config)' : 'managed by codex'}
            </option>
            {config.agent === 'claude' && <option value="none">none (save tokens)</option>}
            {config.agent === 'claude' && <option value="custom">choose servers</option>}
          </select>
        </Field>
        {config.agent === 'claude' && Array.isArray(config.mcp) && (
          <div className="flex flex-col gap-1 pl-1">
            {/* union keeps stored names visible even if they left ~/.claude.json */}
            {[...new Set([...mcpServers, ...config.mcp])].sort().map((name) => (
              <label key={name} className="flex items-center gap-2 text-[11px] text-ink-300">
                <input
                  type="checkbox"
                  checked={(config.mcp as string[]).includes(name)}
                  onChange={(e) => {
                    const cur = config.mcp as string[]
                    onChange({
                      ...config,
                      mcp: e.target.checked ? [...cur, name] : cur.filter((n) => n !== name)
                    })
                  }}
                />
                {name}
                {!mcpServers.includes(name) && (
                  <span className="text-ink-500">(not in ~/.claude.json)</span>
                )}
              </label>
            ))}
            {mcpServers.length === 0 && (
              <p className="text-[11px] text-ink-500">no servers found in ~/.claude.json</p>
            )}
            <p className="text-[11px] text-ink-500">
              claude.ai connectors can’t be subsetted — use “load all” for phases that need them
            </p>
          </div>
        )}
      </div>
    </div>
  )
}

function PhasesSection(): ReactElement {
  const settings = useApp((s) => s.settings)!
  const save = useSaveSettings()
  const [skills, setSkills] = useState<string[]>([])
  const [mcpServers, setMcpServers] = useState<string[]>([])

  useEffect(() => {
    void window.sully
      .listSkills()
      .then(setSkills)
      .catch(() => {})
    void window.sully
      .listMcpServers()
      .then(setMcpServers)
      .catch(() => {})
  }, [])

  return (
    <section>
      <SectionTitle>Phase configuration</SectionTitle>
      <div className="grid grid-cols-2 gap-3 2xl:grid-cols-4">
        {PHASES.map(({ key, title, blurb }) => (
          <PhaseCard
            key={key}
            title={title}
            blurb={blurb}
            config={settings.phases[key]}
            skills={skills}
            mcpServers={mcpServers}
            onChange={(c) => save({ ...settings, phases: { ...settings.phases, [key]: c } })}
          />
        ))}
      </div>
    </section>
  )
}

// ---------- tunables ----------

function TunablesSection(): ReactElement {
  const settings = useApp((s) => s.settings)!
  const save = useSaveSettings()
  return (
    <section>
      <SectionTitle>Tuning</SectionTitle>
      <div className="hairline grid grid-cols-4 gap-3 rounded-xl border bg-ink-850 p-4">
        <Field label="Required Linear label (blank = all tickets)">
          <input
            className={inputCls}
            value={settings.orchestrator.requiredLabel}
            placeholder="e.g. sully"
            onChange={(e) =>
              save({
                ...settings,
                orchestrator: { ...settings.orchestrator, requiredLabel: e.target.value }
              })
            }
          />
        </Field>
        <Field label="Linear poll (sec)">
          <input
            type="number"
            className={inputCls}
            min={15}
            value={Math.round(settings.orchestrator.pollIntervalMs / 1000)}
            onChange={(e) =>
              save({
                ...settings,
                orchestrator: {
                  ...settings.orchestrator,
                  pollIntervalMs: Math.max(15, Number(e.target.value)) * 1000
                }
              })
            }
          />
        </Field>
        <Field label="Max planning sessions">
          <input
            type="number"
            className={inputCls}
            min={1}
            value={settings.orchestrator.maxConcurrentPlanning}
            onChange={(e) =>
              save({
                ...settings,
                orchestrator: {
                  ...settings.orchestrator,
                  maxConcurrentPlanning: Math.max(1, Number(e.target.value))
                }
              })
            }
          />
        </Field>
        <Field label="Max coding sessions">
          <input
            type="number"
            className={inputCls}
            min={1}
            value={settings.orchestrator.maxConcurrentCoding}
            onChange={(e) =>
              save({
                ...settings,
                orchestrator: {
                  ...settings.orchestrator,
                  maxConcurrentCoding: Math.max(1, Number(e.target.value))
                }
              })
            }
          />
        </Field>
        <Field label="Ticket budget warning ($, 0 = off)">
          <input
            type="number"
            className={inputCls}
            min={0}
            value={settings.orchestrator.ticketBudgetUsd}
            title="Notifies once when a ticket's total AI spend across all its sessions crosses this amount"
            onChange={(e) =>
              save({
                ...settings,
                orchestrator: {
                  ...settings.orchestrator,
                  ticketBudgetUsd: Math.max(0, Number(e.target.value) || 0)
                }
              })
            }
          />
        </Field>
        <Field label="Follow-up model (plan feedback & reprompts)">
          <select
            className={selectCls}
            value={settings.feedbackModel}
            title="Model for follow-up turns on existing conversations — they borrow the planning/coding phase config otherwise"
            onChange={(e) => save({ ...settings, feedbackModel: e.target.value })}
          >
            <option value="">Phase model</option>
            {MODEL_OPTIONS.claude
              .filter((m) => m.value)
              .map((m) => (
                <option key={m.value} value={m.value}>
                  {m.label}
                </option>
              ))}
          </select>
        </Field>
        <Field label="Max concurrent reviews">
          <input
            type="number"
            className={inputCls}
            min={1}
            value={settings.prWatcher.maxConcurrent}
            onChange={(e) =>
              save({
                ...settings,
                prWatcher: {
                  ...settings.prWatcher,
                  maxConcurrent: Math.max(1, Number(e.target.value))
                }
              })
            }
          />
        </Field>
        <Field label="Key MCP servers (comma-separated, from `claude mcp list`)">
          <input
            className={inputCls}
            value={settings.toolHealth.mcpServers.join(', ')}
            placeholder="linear-runwise, claude.ai Figma"
            title="MCP servers sessions depend on — the health banner warns when one needs authentication"
            onChange={(e) =>
              save({
                ...settings,
                toolHealth: {
                  ...settings.toolHealth,
                  mcpServers: e.target.value.split(',').map((s) => s.trimStart())
                }
              })
            }
          />
        </Field>
        <Field label="Appearance">
          <select
            className={selectCls}
            value={settings.theme}
            onChange={(e) => save({ ...settings, theme: e.target.value as AppSettings['theme'] })}
          >
            <option value="dark">Dark</option>
            <option value="light">Light</option>
          </select>
        </Field>
        <div className="flex flex-col gap-1">
          <span className="text-[11px] font-bold text-ink-300">Create PRs as drafts</span>
          <div className="flex h-[30px] items-center">
            <Toggle
              checked={settings.draftPrs}
              onChange={(v) => save({ ...settings, draftPrs: v })}
              label="Create PRs as drafts"
            />
          </div>
        </div>
        <div
          className="flex flex-col gap-1"
          title="When a ticket's PR checks fail, resume the coding session with the failure logs, push a fix, and re-check — up to the attempt cap"
        >
          <span className="text-[11px] font-bold text-ink-300">Auto-fix failing CI</span>
          <div className="flex h-[30px] items-center">
            <Toggle
              checked={settings.orchestrator.ciAutoFix}
              onChange={(v) =>
                save({ ...settings, orchestrator: { ...settings.orchestrator, ciAutoFix: v } })
              }
              label="Auto-fix failing CI"
            />
          </div>
        </div>
        <Field label="Max CI fix attempts">
          <input
            type="number"
            className={inputCls}
            min={1}
            value={settings.orchestrator.ciMaxFixAttempts}
            title="Give up (with a notification) after this many auto-fix attempts on one red streak"
            onChange={(e) =>
              save({
                ...settings,
                orchestrator: {
                  ...settings.orchestrator,
                  ciMaxFixAttempts: Math.max(1, Number(e.target.value))
                }
              })
            }
          />
        </Field>
      </div>
    </section>
  )
}

export default function SettingsView(): ReactElement {
  const viewer = useApp((s) => s.viewer)
  return (
    <div className="fade-up flex flex-col gap-8 pb-10">
      <div>
        <h1 className="font-display text-[26px] text-ink-50">Settings</h1>
        <p className="text-[12px] text-ink-400">
          {viewer ? `signed in to Linear as ${viewer.name}` : 'connect your accounts below'}
        </p>
      </div>
      <CredentialsSection />
      <ColumnsSection />
      <ReposSection />
      <ErrorTrackingSection />
      <PhasesSection />
      <TunablesSection />
    </div>
  )
}
