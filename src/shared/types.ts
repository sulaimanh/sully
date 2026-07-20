// Shared contracts between main, preload, and renderer.

export type PhaseKey =
  'planning' | 'coding' | 'createPr' | 'addressComments' | 'prReview' | 'errorInvestigation'

export type AgentKind = 'claude' | 'codex'

export type IssuePhase =
  | 'uncategorized' // parked in the dead column — tracked, but nothing ever happens
  | 'planning' // session running or queued to plan
  | 'plan_questions' // planning paused: the agent needs answers before it can write the plan
  | 'plan_ready' // plan posted, waiting for approval
  | 'coding' // coding session running or queued
  | 'reprompting' // post-review follow-up session running (comment or in-app reprompt)
  | 'in_review' // PR created, ticket moved to review column
  | 'error' // last session failed; waiting for retry

/** A board column a card can be dragged to — resolves to a Linear state via ColumnMapping. */
export type BoardColumn = 'uncategorized' | 'planning' | 'planReady' | 'inProgress' | 'inReview'

export type SessionStatus =
  'queued' | 'running' | 'done' | 'error' | 'stopped' | 'timeout' | 'orphaned'

export interface PhaseConfig {
  agent: AgentKind
  model?: string
  /** Optional slash-command skill, e.g. "/plan:create --auto --skip-branch". Empty = built-in prompt. */
  skill?: string
  /** Freeform text prepended to every prompt this phase sends, e.g. extra context like sibling repo paths. */
  injectedPrompt?: string
  /** claude permission handling. 'bypass' maps to --dangerously-skip-permissions */
  permissionMode: 'acceptEdits' | 'bypass'
  timeoutMs: number
  /** Hard per-session spend cap passed as --max-budget-usd (claude only). Unset/0 = no cap. */
  maxBudgetUsd?: number
  /**
   * Which of the user's global MCP servers to load (claude only). Their tool
   * schemas tax every turn, so phases should load only what they use.
   * true/unset = all, false = none, array = only those servers (names from
   * ~/.claude.json; claude.ai connectors can't be subsetted — see main/mcp.ts).
   */
  mcp?: boolean | string[]
}

export interface ColumnMapping {
  teamId: string
  teamKey: string
  teamName: string
  planningStateId: string
  planReadyStateId: string
  inProgressStateId: string
  inReviewStateId: string
  /** Dead column: tickets here are tracked but Sully never plans, codes, or moves them. Optional. */
  uncategorizedStateId?: string
}

export interface RepoMapping {
  id: string
  /** Ticket match precedence: linearLabel > linearProjectId > linearTeamId */
  linearLabel?: string // Linear label name, e.g. "repo:frontend"
  linearTeamId?: string
  linearProjectId?: string
  label: string
  repoPath: string
  /** Command to run the dev environment from a ticket's worktree, e.g. "npm run dev". Blank = no dev button. */
  devCommand?: string
  /** Branch new ticket branches are cut from, e.g. "develop". Blank = auto-detect origin's default. */
  baseBranch?: string
  /** Release command run from the repo root, e.g. "./scripts/release.sh" — the chosen bump (patch/minor/major) is appended. Blank = no deploy button. */
  deployCommand?: string
}

/** An embedded terminal (pty) hosted by the main process. */
export interface TerminalInfo {
  id: string
  /** tab label — ticket identifier for issue terminals, else basename of the starting directory */
  title: string
  cwd: string
  shell: string
  /** set when the terminal was opened for a ticket's worktree — one terminal per issue and kind */
  issueId?: string
  /** 'agent' terminals auto-run an interactive claude session; plain shells are 'shell' */
  kind?: 'shell' | 'agent'
}

export interface StreamEvent {
  /** normalized kind for display */
  kind: 'init' | 'text' | 'tool' | 'result' | 'raw' | 'stderr'
  text: string
  ts: number
}

/** Cumulative token usage parsed from the stream — survives kills, unlike the CLI's final cost report. */
export interface SessionUsage {
  in: number
  out: number
  cacheRead: number
  cacheWrite: number
}

export interface Session {
  id: string
  kind:
    | 'planning'
    | 'plan_feedback'
    | 'coding'
    | 'create_pr'
    | 'reprompt'
    | 'pr_review'
    | 'fetch_comments' // legacy — kept so old persisted session records still render
    | 'error_investigation'
    | 'probe'
  issueId?: string
  issueIdentifier?: string
  prUrl?: string
  agent: AgentKind
  model?: string
  /** Full argv (binary first) for display in the UI */
  command: string[]
  cwd: string
  pid?: number
  status: SessionStatus
  exitCode?: number
  logFile: string
  startedAt: string
  finishedAt?: string
  /** rolling latest assistant text for compact display */
  lastText?: string
  /** the CLI's own conversation id — lets follow-up sessions --resume it */
  agentSessionId?: string
  costUsd?: number
  /** costUsd was estimated from streamed usage (the session died before the CLI reported a final cost) */
  costIsEstimate?: boolean
  usage?: SessionUsage
  /** model id resolved by the CLI (stream init event) — pricing source for estimates */
  resolvedModel?: string
  numTurns?: number
}

/** One open review comment on a ticket's PR, individually addressable from the modal. */
export interface GhReviewItem {
  /** GraphQL node id — stable across the poll's refetches */
  id: string
  author?: string
  /** file path + line the comment targets (inline comments only) */
  file?: string
  line?: number
  /** the reviewer's comment (markdown) */
  comment: string
  /** when the comment was posted on GitHub — newest-first ordering in the modal */
  createdAt?: string
  /** set when an "Address selected" session was dispatched for this item; a new
   *  reply in the thread clears it (the comment body changes on refetch) */
  addressedAt?: string
}

export interface ChatMessage {
  role: 'user' | 'agent'
  text: string
  at: string
}

/** One blocking question the planning agent asked instead of guessing. */
export interface PlanQuestion {
  /** index-based, assigned on parse — only meaningful within the stored array */
  id: string
  question: string
  /** what the agent found and why the answer changes the plan */
  context?: string
  /** suggested answers the user can pick from */
  options?: string[]
}

export interface TrackedIssue {
  issueId: string
  identifier: string
  title: string
  description?: string
  url: string
  teamId: string
  projectId?: string
  branchName: string
  stateId: string
  stateName: string
  phase: IssuePhase
  repoPath?: string
  worktreePath?: string
  /** The plan text — a cached copy of the worktree plan file, which is the source of truth. */
  planBody?: string
  /** Blocking questions from the planning session — cached copy of the worktree questions file. */
  planQuestions?: PlanQuestion[]
  activeSessionId?: string
  prUrl?: string
  lastError?: string
  /** total AI spend across this ticket's sessions (planning, coding, feedback, …) */
  costUsd?: number
  /** the ticket-budget warning already fired — never nag twice */
  costWarned?: boolean
  /** claude conversation of the last coding session — resumed on retry so partial work isn't redone */
  codingSessionId?: string
  /** Fetched GitHub PR review comments — rendered by the "View GitHub review" modal */
  ghReviewItems?: GhReviewItem[]
  /** In-app conversation with the agent (plan feedback + reprompts) — never posted to Linear */
  chat?: ChatMessage[]
  /** claude conversation to --resume for chat follow-ups, so context isn't re-explored each turn */
  chatSessionId?: string
  /** CI state of the PR head, refreshed while the ticket is in review */
  ciStatus?: {
    state: 'pass' | 'fail' | 'pending' | 'none'
    headSha: string
    /** names of failing checks (fail state only) */
    failed: string[]
    checkedAt: string
  }
  /** head SHAs an auto-fix was already launched for — never re-attempt one (capped, newest last) */
  ciFixAttemptShas?: string[]
  /** PR review decision, refreshed alongside ciStatus. 'none' = repo requires no reviews */
  prReview?: 'approved' | 'changes_requested' | 'review_required' | 'none'
  updatedAt: string
}

export interface DevServer {
  issueId: string
  identifier: string
  command: string
  cwd: string
  pid?: number
  status: 'running' | 'stopped' | 'error'
  startedAt: string
  /** tail of recent output, for quick diagnostics when the command fails */
  lastOutput?: string
  logFile: string
}

export type DeployBump = 'patch' | 'minor' | 'major'

/** One manual release run, keyed by repo. Not persisted — dies with the app. */
export interface Deploy {
  repoId: string
  label: string
  command: string
  cwd: string
  pid?: number
  status: 'running' | 'done' | 'error' | 'stopped'
  startedAt: string
  finishedAt?: string
  /** tail of recent output, streamed for the deploy dialog */
  lastOutput?: string
  logFile: string
}

export interface ActiveReview {
  key: string
  url: string
  repository: string
  number: number
  title: string
  author: string
  repoPath: string
  sessionId?: string
  status: 'reviewing' | 'done' | 'error' | 'stopped'
  verdict?: string
  merged: boolean
  error?: string
  /** Set on re-review: only my reviews submitted after this instant count as done */
  baselineReviewAt?: string
  startedAt: string
  startedEpoch: number
  finishedEpoch?: number
}

export type ErrorSource = 'frontend' | 'backend'

export interface ErrorTrackingSettings {
  /** PostHog instance base URL, e.g. https://us.posthog.com */
  host: string
  /** PostHog project id for frontend errors */
  frontendProjectId: string
  /** PostHog project id for backend errors — blank until the backend migration to PostHog lands */
  backendProjectId: string
  /** RepoMapping id investigations of frontend errors run in — blank falls back to the only repo */
  frontendRepoId?: string
  /** RepoMapping id investigations of backend errors run in */
  backendRepoId?: string
}

/** One PostHog error-tracking issue (grouped $exception events) */
export interface ErrorTrackingIssue {
  /** PostHog error tracking issue id — empty when the event predates issue grouping */
  id: string
  type: string
  message: string
  occurrences: number
  users: number
  firstSeen: string
  lastSeen: string
  /** deep link into PostHog error tracking */
  url: string
}

export interface PhaseSettings {
  planning: PhaseConfig
  coding: PhaseConfig
  createPr: PhaseConfig
  addressComments: PhaseConfig
  prReview: PhaseConfig
  errorInvestigation: PhaseConfig
}

export interface AppSettings {
  onboarded: boolean
  columnMappings: ColumnMapping[]
  repoMappings: RepoMapping[]
  phases: PhaseSettings
  orchestrator: {
    enabled: boolean
    pollIntervalMs: number
    maxConcurrentPlanning: number
    maxConcurrentCoding: number
    /** Only orchestrate tickets carrying this Linear label. Blank = all tickets. */
    requiredLabel: string
    /** Notify once when a ticket's cumulative session cost crosses this (USD). 0 = off. */
    ticketBudgetUsd: number
    /** Watch PR checks on in-review tickets and auto-spawn a fix session when CI fails */
    ciAutoFix: boolean
    /** Give up after this many auto-fix attempts per red streak */
    ciMaxFixAttempts: number
    /** Merge a ticket's PR automatically once it's approved and CI is green */
    autoMergeOnApproval: boolean
  }
  prWatcher: {
    enabled: boolean
    intervalMs: number
    maxConcurrent: number
    timeoutMs: number
    retentionMs: number
  }
  toolHealth: {
    /** MCP server names (from `claude mcp list`) sessions depend on — checked by the health banner */
    mcpServers: string[]
  }
  errorTracking: ErrorTrackingSettings
  /** Model for follow-up turns (plan feedback, reprompts) instead of the borrowed phase model (claude only). Blank = phase model. */
  feedbackModel: string
  /** Create pull requests as drafts */
  draftPrs: boolean
  notifications: boolean
  theme: 'dark' | 'light'
}

export interface DoctorCheck {
  id: string
  label: string
  ok: boolean
  detail: string
}

export interface DoctorReport {
  checks: DoctorCheck[]
  ranAt: string
}

export interface LinearTeam {
  id: string
  key: string
  name: string
}

export interface LinearWorkflowState {
  id: string
  name: string
  type: string
  position: number
  color: string
}

export interface LinearViewer {
  id: string
  name: string
  email: string
}

export interface LinearLabel {
  id: string
  name: string
  color: string
}

export interface LinearProject {
  id: string
  name: string
}

export interface LinearMember {
  id: string
  name: string
  displayName?: string
}

/** Everything the "new ticket" form can offer for one team. */
export interface IssueCreateMeta {
  states: LinearWorkflowState[]
  /** team labels plus workspace labels, name-sorted */
  labels: LinearLabel[]
  /** excludes completed/canceled projects */
  projects: LinearProject[]
  members: LinearMember[]
}

export interface CreateIssueInput {
  teamId: string
  title: string
  description?: string
  stateId?: string
  assigneeId?: string
  /** 0 none, 1 urgent, 2 high, 3 medium, 4 low */
  priority?: number
  labelIds: string[]
  /** labels created on the team (then applied) when Linear doesn't have them yet, e.g. the repo routing label */
  ensureLabelNames?: string[]
  projectId?: string
}

export interface CreatedIssue {
  id: string
  identifier: string
  url: string
}

/** A Linear comment on a ticket — read-only, shown at the bottom of ticket details. */
export interface IssueComment {
  id: string
  /** markdown, as authored in Linear */
  body: string
  createdAt: string
  /** set when this comment is a threaded reply */
  parentId?: string
  authorName?: string
}

/**
 * Latest plan rate-limit status streamed by the claude CLI (rate_limit_event).
 * Only updates while a session runs — between sessions it's the last known value.
 */
export interface RateLimitInfo {
  status: 'allowed' | 'allowed_warning' | 'rejected'
  /** fraction of the window used, 0..1 — the CLI only sends it past the warning threshold */
  utilization?: number
  /** unix seconds when the window resets */
  resetsAt?: number
  /** e.g. "five_hour" */
  rateLimitType?: string
  isUsingOverage?: boolean
  /** ms epoch when the event was observed */
  observedAt: number
}

/** One plan rate-limit window from the claude.ai OAuth usage endpoint. */
export interface PlanUsageWindow {
  /** percent of the window used, 0-100 */
  utilization: number
  /** ISO instant the window resets */
  resetsAt?: string
}

/**
 * Plan usage polled from the OAuth usage endpoint (the numbers `claude /usage`
 * shows). Unlike RateLimitInfo it's always available, not just near the limit.
 */
export interface PlanUsage {
  fiveHour?: PlanUsageWindow
  sevenDay?: PlanUsageWindow
  /** ms epoch of the successful fetch */
  fetchedAt: number
}

/** Full snapshot pushed to the renderer on connect and on demand */
export interface StateSnapshot {
  settings: AppSettings
  issues: TrackedIssue[]
  sessions: Session[]
  reviews: ActiveReview[]
  devServers: DevServer[]
  deploys: Deploy[]
  credentials: CredentialStatus
  viewer?: LinearViewer
  /** Latest background tool-health report — undefined until the first run finishes */
  toolHealth?: DoctorReport
  /** Last rate-limit status seen on any session's stream — undefined until one arrives */
  rateLimit?: RateLimitInfo
  /** Latest polled plan usage — undefined until the first successful fetch */
  planUsage?: PlanUsage
}

export interface CredentialStatus {
  linearKeySet: boolean
  ghTokenSet: boolean
  ghCliAuthed: boolean
  figmaTokenSet: boolean
  posthogKeySet: boolean
}

// Models are tiered by phase difficulty: Opus where quality pays for itself
// (planning, coding), Haiku for the mechanical create-pr phase, Sonnet for
// read-and-report work. Effort is left at the CLI default on purpose.
// Coding/create-pr/pr-review don't need MCP servers, so they skip loading
// their tool schemas; planning and error investigation keep them (Linear,
// Figma) for ticket and design context.
export function defaultPhaseSettings(): PhaseSettings {
  return {
    planning: {
      agent: 'claude',
      model: 'opus',
      permissionMode: 'acceptEdits',
      timeoutMs: 20 * 60_000
    },
    coding: {
      agent: 'claude',
      model: 'opus',
      permissionMode: 'bypass',
      timeoutMs: 90 * 60_000,
      mcp: false
    },
    createPr: {
      agent: 'claude',
      model: 'haiku',
      permissionMode: 'bypass',
      timeoutMs: 15 * 60_000,
      mcp: false
    },
    addressComments: {
      agent: 'claude',
      model: 'opus',
      permissionMode: 'bypass',
      timeoutMs: 90 * 60_000,
      mcp: false
    },
    prReview: {
      agent: 'claude',
      model: 'sonnet',
      permissionMode: 'bypass',
      timeoutMs: 40 * 60_000,
      maxBudgetUsd: 5,
      mcp: false
    },
    errorInvestigation: {
      agent: 'claude',
      model: 'sonnet',
      permissionMode: 'acceptEdits',
      timeoutMs: 20 * 60_000
    }
  }
}

export function defaultSettings(): AppSettings {
  return {
    onboarded: false,
    columnMappings: [],
    repoMappings: [],
    phases: defaultPhaseSettings(),
    orchestrator: {
      enabled: false,
      pollIntervalMs: 60_000,
      maxConcurrentPlanning: 2,
      maxConcurrentCoding: 2,
      requiredLabel: 'sully',
      ticketBudgetUsd: 25,
      ciAutoFix: true,
      ciMaxFixAttempts: 3,
      autoMergeOnApproval: false
    },
    prWatcher: {
      enabled: false,
      intervalMs: 60_000,
      maxConcurrent: 3,
      timeoutMs: 40 * 60_000,
      retentionMs: 60 * 60_000
    },
    toolHealth: {
      mcpServers: ['linear-runwise', 'claude.ai Figma']
    },
    errorTracking: {
      host: 'https://us.posthog.com',
      frontendProjectId: '94442',
      backendProjectId: ''
    },
    feedbackModel: 'opus',
    draftPrs: true,
    notifications: true,
    theme: 'dark'
  }
}
