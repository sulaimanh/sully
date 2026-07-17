import { EventEmitter } from 'events'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import type {
  BoardColumn,
  ColumnMapping,
  GhReviewItem,
  PhaseConfig,
  PlanQuestion,
  Session,
  TrackedIssue
} from '../../shared/types'
import { settingsStore } from '../settings'
import { IssueStateStore } from './state-store'
import { processManager } from '../process/ProcessManager'
import { ensureWorktree, headSha, remoteBranchSha } from './worktrees'
import {
  FEEDBACK_REPLY_FILE_REL,
  GH_REVIEW_FILE_REL,
  PLAN_FILE_REL,
  PLAN_QUESTIONS_FILE_REL,
  buildCodingCommand,
  buildCodingResumeCommand,
  buildCreatePrCommand,
  buildPlanAnswersCommand,
  buildPlanChatResumeCommand,
  buildPlanFeedbackCommand,
  buildPlanningCommand,
  buildFetchCommentsCommand,
  buildPlanningResumeCommand,
  buildRepromptCommand,
  buildRepromptResumeCommand
} from './prompts'
import {
  fetchIssueComments,
  fetchIssueState,
  fetchIssuesInStates,
  fetchViewer,
  moveIssue,
  postComment,
  type LinearIssueNode
} from '../linear/operations'
import { createPr, prForBranch } from '../github/gh'

const PLAN_MARKER = (issueId: string): string => `<!-- sully:plan issueId=${issueId} v=1 -->`
// plan comments posted before the conductor→sully rename must stay recognized
// (never double-plan), so scanning matches the old token too
const LEGACY_PLAN_MARKER = (issueId: string): string =>
  `<!-- conductor:plan issueId=${issueId} v=1 -->`
// replies posted by Sully in the plan thread carry one marker per feedback
// comment they answered, so "handled" survives restarts and cleared state
const REPLY_MARKER = (commentId: string): string => `<!-- sully:reply to=${commentId} -->`
const REPLY_MARKER_RE = /<!-- sully:reply to=([\w-]+) -->/g
// sully replies carry the claude conversation id, so follow-ups can --resume
// it (skipping re-exploration) even after a restart or cleared local state
const SESSION_MARKER = (id: string): string => `<!-- sully:session id=${id} -->`
const SESSION_MARKER_RE = /<!-- sully:session id=([\w-]+) -->/g

// Resuming replays the whole prior conversation as fresh input (the prompt
// cache is long cold by the time a follow-up arrives), so past this transcript
// size a resume costs more than starting over — observed $6-7 per reprompt on
// ~30-turn coding threads. Oversized conversations start fresh instead.
const MAX_RESUME_TRANSCRIPT_BYTES = 1024 * 1024

/**
 * A claude conversation is only resumable if its transcript exists on this
 * machine (session ids recovered from Linear may be from a teammate's app)
 * and isn't so large that replaying it costs more than fresh exploration.
 */
export function resumableSessionId(
  cwd: string | undefined,
  id: string | undefined
): string | undefined {
  if (!cwd || !id) return undefined
  const munged = cwd.replace(/[/.]/g, '-')
  const file = path.join(os.homedir(), '.claude', 'projects', munged, `${id}.jsonl`)
  try {
    return fs.statSync(file).size <= MAX_RESUME_TRANSCRIPT_BYTES ? id : undefined
  } catch {
    return undefined
  }
}
/**
 * Follow-up turns (plan feedback, reprompts) borrow the planning/coding phase
 * config but are lighter work — swap in the dedicated follow-up model when one
 * is configured. Blank feedbackModel or a codex agent keeps the phase model.
 */
function feedbackConfig(config: PhaseConfig, feedbackModel: string): PhaseConfig {
  if (config.agent !== 'claude' || !feedbackModel) return config
  return { ...config, model: feedbackModel }
}

/**
 * Failure message for the board: the bare status ("error (exit 1)") tells the
 * user nothing, so append the agent's final output — usually the actual reason.
 */
function sessionFailure(label: string, session: Session, suffix = ''): string {
  const head = `${label} session ${session.status}${session.exitCode !== undefined ? ` (exit ${session.exitCode})` : ''}${suffix}`
  const detail = session.lastText?.trim()
  return detail ? `${head} — last agent output: ${detail}` : head
}

/** Strip the marker + header wrapping of legacy Linear plan comments; plain plan text passes through. */
function planTextFromBody(issueId: string, body: string): string {
  return body
    .replace(PLAN_MARKER(issueId), '')
    .replace(LEGACY_PLAN_MARKER(issueId), '')
    .replace(/^## Implementation plan \((?:Conductor|Sully)\)\s*/m, '')
    .trim()
}

/**
 * Parse the fetch session's JSON into review items, tolerating the usual model
 * slips (code fences, an {items: []} wrapper, junk entries). Ids are assigned
 * from the index — selection only ever references the stored array.
 */
function parseGhReviewItems(raw: string): GhReviewItem[] | null {
  const stripped = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/, '')
  let parsed: unknown
  try {
    parsed = JSON.parse(stripped)
  } catch {
    return null
  }
  const arr = Array.isArray(parsed)
    ? parsed
    : Array.isArray((parsed as { items?: unknown })?.items)
      ? (parsed as { items: unknown[] }).items
      : null
  if (!arr) return null
  return arr
    .filter(
      (x): x is Record<string, unknown> =>
        typeof x === 'object' &&
        x !== null &&
        typeof (x as Record<string, unknown>).comment === 'string' &&
        Boolean(((x as Record<string, unknown>).comment as string).trim())
    )
    .map((x, idx) => ({
      id: String(idx),
      author: typeof x.author === 'string' ? x.author : undefined,
      file: typeof x.file === 'string' ? x.file : undefined,
      line: typeof x.line === 'number' ? x.line : undefined,
      comment: x.comment as string,
      suggestion: typeof x.suggestion === 'string' ? x.suggestion : undefined
    }))
}

/** Parse the planning session's questions JSON, tolerating the same model slips. */
function parsePlanQuestions(raw: string): PlanQuestion[] | null {
  const stripped = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/, '')
  let parsed: unknown
  try {
    parsed = JSON.parse(stripped)
  } catch {
    return null
  }
  const arr = Array.isArray(parsed)
    ? parsed
    : Array.isArray((parsed as { questions?: unknown })?.questions)
      ? (parsed as { questions: unknown[] }).questions
      : null
  if (!arr) return null
  const items = arr
    .filter(
      (x): x is Record<string, unknown> =>
        typeof x === 'object' &&
        x !== null &&
        typeof (x as Record<string, unknown>).question === 'string' &&
        Boolean(((x as Record<string, unknown>).question as string).trim())
    )
    .map((x, idx) => ({
      id: String(idx),
      question: (x.question as string).trim(),
      context: typeof x.context === 'string' && x.context.trim() ? x.context.trim() : undefined,
      options: Array.isArray(x.options)
        ? x.options.filter((o): o is string => typeof o === 'string' && Boolean(o.trim()))
        : undefined
    }))
  return items.length > 0 ? items : null
}

type ColumnKind = BoardColumn

/**
 * Linear-driven state machine. Linear columns are the *trigger*; local state +
 * a hidden marker in the plan comment are the *dedupe*. Every post-session step
 * (comment, move, PR create) checks before acting, so restart recovery is just
 * re-running the steps.
 */
export class Orchestrator extends EventEmitter {
  private store = new IssueStateStore()
  private timer?: NodeJS.Timeout
  private polling = false
  /** issues with an async transition in flight (post/move/spawn) — skip in poll */
  private busy = new Set<string>()
  /** HEAD sha captured before each reprompt session, to detect whether it changed code */
  private repromptBaseSha = new Map<string, string>()
  /** Linear user id of the person running this app — only their comments trigger actions */
  private viewerId?: string

  /**
   * Teammates chat on tickets too; only comments from the app's own Linear
   * user are directives. Unknown viewer (fetch failed) means trigger nothing —
   * unhandled comments re-detect on a later poll once the viewer resolves.
   */
  private async ensureViewerId(): Promise<string | undefined> {
    if (!this.viewerId) {
      try {
        this.viewerId = (await fetchViewer()).id
      } catch {
        // leave undefined — retried next poll
      }
    }
    return this.viewerId
  }

  start(): void {
    processManager.on('finished', (session: Session) => {
      this.onSessionFinished(session).catch((err) =>
        this.fail(session.issueId, `post-session step failed: ${(err as Error).message}`)
      )
    })
    // sessions that died or were orphaned while the app was closed never emit
    // 'finished' — resolve the issues that still point at them
    void this.reconcileLostSessions().catch(() => {})
    this.scheduleNext(2_000) // first poll shortly after launch
  }

  /** Runs once at startup, after ProcessManager.reconcileOrphans(). */
  private async reconcileLostSessions(): Promise<void> {
    for (const issue of this.store.all()) {
      if (!issue.activeSessionId) continue
      const session = processManager.get(issue.activeSessionId)
      if (session?.status === 'running') continue
      if (!session) {
        issue.activeSessionId = undefined
        this.fail(issue.issueId, 'session lost while the app was closed')
        continue
      }
      // still alive from a previous app run: we can't stream it, so stop it
      if (session.status === 'orphaned') processManager.stopOrphan(session.id)
      const finished = processManager.get(session.id) ?? session
      try {
        await this.onSessionFinished({ ...finished })
      } catch (err) {
        this.fail(issue.issueId, `post-session step failed: ${(err as Error).message}`)
      }
    }
  }

  private scheduleNext(delayMs?: number): void {
    clearTimeout(this.timer)
    const interval = settingsStore.get().orchestrator.pollIntervalMs
    this.timer = setTimeout(() => void this.poll(), delayMs ?? interval)
  }

  issues(): TrackedIssue[] {
    return this.store.all()
  }

  pollNow(): void {
    this.scheduleNext(0)
  }

  async poll(): Promise<void> {
    if (this.polling) return
    this.polling = true
    try {
      const settings = settingsStore.get()
      // Polling is always on so the board reflects Linear truth; the enabled
      // toggle only gates ACTIONS (spawning, moving tickets, posting comments).
      if (settings.columnMappings.length === 0) return

      const stateIds = settings.columnMappings.flatMap((m) => [
        m.planningStateId,
        m.planReadyStateId,
        m.inProgressStateId,
        m.inReviewStateId,
        m.uncategorizedStateId ?? ''
      ])
      const nodes = await fetchIssuesInStates(
        stateIds.filter(Boolean),
        settings.orchestrator.requiredLabel
      )
      const seen = new Set<string>()

      for (const node of nodes) {
        seen.add(node.id)
        if (this.busy.has(node.id)) continue
        try {
          await this.processIssue(node)
        } catch (err) {
          this.fail(node.id, (err as Error).message)
        }
      }

      // tracked issues that left all mapped columns: done/canceled/unassigned
      for (const tracked of this.store.all()) {
        if (seen.has(tracked.issueId) || this.busy.has(tracked.issueId)) continue
        if (tracked.activeSessionId) {
          // killing a running session is destructive and easy to trigger from
          // Linear (move to Done, unassign, drop the label) — never do it silently
          const active = processManager.get(tracked.activeSessionId)
          await processManager.stop(tracked.activeSessionId)
          if (active?.status === 'running') {
            this.emit('notify', {
              title: `${tracked.identifier} left the board`,
              body: 'Its running session was stopped (the ticket left all mapped columns). Any uncommitted work is still in the worktree.',
              view: 'sessions'
            })
          }
        }
        this.store.remove(tracked.issueId)
        this.emit('issueRemoved', tracked.issueId)
      }
    } catch (err) {
      this.emit('pollError', (err as Error).message)
    } finally {
      this.polling = false
      this.scheduleNext()
    }
  }

  private mappingFor(teamId: string): ColumnMapping | undefined {
    return settingsStore.get().columnMappings.find((m) => m.teamId === teamId)
  }

  private columnKind(stateId: string, m: ColumnMapping): ColumnKind | null {
    if (stateId === m.planningStateId) return 'planning'
    if (stateId === m.planReadyStateId) return 'planReady'
    if (stateId === m.inProgressStateId) return 'inProgress'
    if (stateId === m.inReviewStateId) return 'inReview'
    if (m.uncategorizedStateId && stateId === m.uncategorizedStateId) return 'uncategorized'
    return null
  }

  private stateIdForColumn(m: ColumnMapping, column: ColumnKind): string | undefined {
    return {
      uncategorized: m.uncategorizedStateId,
      planning: m.planningStateId,
      planReady: m.planReadyStateId,
      inProgress: m.inProgressStateId,
      inReview: m.inReviewStateId
    }[column]
  }

  private repoPathFor(node: LinearIssueNode): string | undefined {
    const { repoMappings } = settingsStore.get()
    // most specific wins: per-ticket repo label, then project, then team
    const labelNames = (node.labels?.nodes ?? []).map((l) => l.name.toLowerCase())
    const byLabel = repoMappings.find(
      (r) => r.linearLabel && labelNames.includes(r.linearLabel.toLowerCase())
    )
    const byProject = node.project
      ? repoMappings.find((r) => r.linearProjectId === node.project?.id)
      : undefined
    const byTeam = repoMappings.find((r) => r.linearTeamId === node.team.id && !r.linearProjectId)
    return (byLabel ?? byProject ?? byTeam)?.repoPath
  }

  /** Configured base branch for the ticket's repo — undefined means the repo default. */
  private baseBranchFor(issue: TrackedIssue): string | undefined {
    return (
      settingsStore
        .get()
        .repoMappings.find((r) => r.repoPath === issue.repoPath)
        ?.baseBranch?.trim() || undefined
    )
  }

  private toTracked(node: LinearIssueNode, phase: TrackedIssue['phase']): TrackedIssue {
    return {
      issueId: node.id,
      identifier: node.identifier,
      title: node.title,
      description: node.description,
      url: node.url,
      teamId: node.team.id,
      projectId: node.project?.id,
      branchName: node.branchName,
      stateId: node.state.id,
      stateName: node.state.name,
      phase,
      repoPath: this.repoPathFor(node),
      updatedAt: new Date().toISOString()
    }
  }

  private save(issue: TrackedIssue): void {
    this.store.set(issue)
    this.emit('issueUpdated', { ...issue })
  }

  /** In-app conversation thread — capped so state stays small. */
  private appendChat(issue: TrackedIssue, role: 'user' | 'agent', text: string): void {
    issue.chat = [...(issue.chat ?? []), { role, text, at: new Date().toISOString() }].slice(-50)
  }

  private fail(issueId: string | undefined, message: string): void {
    if (!issueId) return
    const issue = this.store.get(issueId)
    if (!issue) return
    issue.phase = 'error'
    issue.lastError = message
    issue.activeSessionId = undefined
    this.save(issue)
    this.emit('notify', {
      title: `${issue.identifier} failed`,
      body: message.slice(0, 200),
      view: 'board'
    })
  }

  private async processIssue(node: LinearIssueNode): Promise<void> {
    const mapping = this.mappingFor(node.team.id)
    if (!mapping) return
    const column = this.columnKind(node.state.id, mapping)
    if (!column) return

    const local = this.store.get(node.id)
    if (!local) {
      await this.discoverIssue(node, mapping, column)
      return
    }

    // stateId still holds last poll's position — capture before refreshing so
    // we can tell a real backward drag from a ticket that simply sits there
    const prevStateId = local.stateId
    const act = settingsStore.get().orchestrator.enabled

    // refresh mutable fields from Linear
    local.title = node.title
    local.description = node.description
    local.stateId = node.state.id
    local.stateName = node.state.name
    local.branchName = node.branchName
    // a repo label added after discovery must win until work starts — once a
    // worktree exists the repo is locked in
    const resolved = this.repoPathFor(node)
    local.repoPath = !local.worktreePath && resolved ? resolved : (local.repoPath ?? resolved)

    if (local.activeSessionId) {
      this.save(local)
      return // a session is running for this issue — nothing to dispatch
    }

    switch (column) {
      case 'uncategorized':
        // dead column: track it, act on nothing (clears an error card too)
        local.phase = 'uncategorized'
        this.save(local)
        break
      case 'planning':
        if (local.phase === 'uncategorized') {
          // unparked into Planning — an explicit plan request; anything left
          // over from before the ticket was parked is stale (same reset as
          // dragging a plan-ready ticket back to Planning)
          local.planCommentId = undefined
          local.planBody = undefined
          local.planQuestions = undefined
          local.codeFeedbackCutoff = undefined
          local.codingSessionId = undefined
          local.phase = 'planning'
          this.save(local)
          await this.startPlanning(local)
        } else if (local.phase === 'plan_ready') {
          const draggedBack =
            prevStateId !== node.state.id &&
            [mapping.planReadyStateId, mapping.inProgressStateId, mapping.inReviewStateId].includes(
              prevStateId
            )
          if (draggedBack) {
            // user dragged it back: explicit re-plan request. A new plan means
            // any old coding attempt is stale — retries must not resume it.
            local.planCommentId = undefined
            local.planBody = undefined
            local.planQuestions = undefined
            local.codeFeedbackCutoff = undefined
            local.codingSessionId = undefined
            local.phase = 'planning'
            this.save(local)
            await this.startPlanning(local)
          } else {
            // plan exists but the move to Plan ready is still pending (it was
            // deferred while automation was off)
            this.save(local)
            if (act) {
              await this.moveIfStillIn(local, [mapping.planningStateId], mapping.planReadyStateId)
              this.save(local)
            }
          }
        } else if (local.phase === 'planning') {
          this.save(local)
          await this.startPlanning(local) // queued/deferred earlier — try again
        } else {
          this.save(local)
        }
        break
      case 'planReady': {
        // moved manually mid-flight, or unparked from the dead column; dragging
        // a questions card here means "skip the questions, proceed as-is"
        if (
          local.phase === 'planning' ||
          local.phase === 'plan_questions' ||
          local.phase === 'uncategorized'
        ) {
          local.phase = 'plan_ready'
          local.planQuestions = undefined
        }
        // the plan file is the source of truth — adopt edits made outside the
        // app (agent terminal, editor) so the board never shows a stale plan
        if (local.phase === 'plan_ready') {
          const fileText = this.readPlanFile(local)
          if (fileText && fileText !== planTextFromBody(local.issueId, local.planBody ?? ''))
            local.planBody = fileText
        }
        this.save(local)
        if (act && local.phase === 'plan_ready' && local.planCommentId) {
          await this.checkPlanFeedback(local)
        }
        break
      }
      case 'inProgress':
        if (
          local.phase === 'plan_ready' ||
          local.phase === 'coding' ||
          local.phase === 'uncategorized' // unparked straight into In progress
        ) {
          local.phase = 'coding'
          this.save(local)
          await this.startCoding(local)
        } else if (local.phase === 'reprompting') {
          // reprompt session lost (crash/restart) — park back in review;
          // unhandled comments re-detect via reply markers
          local.phase = 'in_review'
          this.save(local)
          if (act) {
            await this.moveIfStillIn(local, [mapping.inProgressStateId], mapping.inReviewStateId)
            this.save(local)
          }
        } else {
          this.save(local)
        }
        break
      case 'inReview':
        if (local.phase !== 'in_review' && local.phase !== 'error') local.phase = 'in_review'
        this.restoreGhReview(local)
        this.save(local)
        if (act && local.phase === 'in_review') {
          await this.checkReprompt(local)
        }
        break
    }
  }

  /** First sight of an issue in a mapped column — adopt existing work before creating any. */
  private async discoverIssue(
    node: LinearIssueNode,
    mapping: ColumnMapping,
    column: ColumnKind
  ): Promise<void> {
    if (column === 'uncategorized') {
      this.save(this.toTracked(node, 'uncategorized')) // dead column — track read-only
      return
    }

    const act = settingsStore.get().orchestrator.enabled

    if (column === 'planning') {
      const issue = this.toTracked(node, 'plan_ready')
      if (await this.adoptPlan(issue)) {
        // plan already exists (app reinstall / cleared state) — just move it forward
        this.save(issue)
        if (act) {
          await this.moveIfStillIn(issue, [mapping.planningStateId], mapping.planReadyStateId)
          this.save(issue)
        }
      } else {
        issue.phase = 'planning'
        this.save(issue)
        await this.startPlanning(issue)
      }
      return
    }

    if (column === 'planReady') {
      const issue = this.toTracked(node, 'plan_ready')
      await this.adoptPlan(issue)
      this.save(issue)
      return
    }

    if (column === 'inProgress') {
      const issue = this.toTracked(node, 'coding')
      const hasPlan = await this.adoptPlan(issue)
      // already has an open PR? skip straight to review (a closed or merged
      // one is a dead artifact from an earlier attempt — never adopt it)
      if (issue.repoPath && issue.branchName) {
        const pr = await prForBranch(issue.repoPath, issue.branchName)
        if (pr && pr.state === 'OPEN') {
          issue.prUrl = pr.url
          issue.phase = 'in_review'
          this.save(issue)
          if (act) {
            await this.moveIfStillIn(issue, [mapping.inProgressStateId], mapping.inReviewStateId)
            this.save(issue)
          }
          return
        }
      }
      if (!hasPlan) {
        issue.phase = 'error'
        issue.lastError =
          'No plan found for this ticket — move it to the planning column first, or retry to code without a plan.'
        this.save(issue)
        return
      }
      this.save(issue)
      await this.startCoding(issue)
      return
    }

    // inReview — track read-only
    const issue = this.toTracked(node, 'in_review')
    if (issue.repoPath && issue.branchName) {
      const pr = await prForBranch(issue.repoPath, issue.branchName)
      if (pr) issue.prUrl = pr.url
    }
    this.restoreGhReview(issue)
    this.save(issue)
  }

  /** Legacy: plans used to be posted as Linear comments — read-only fallback now. */
  private async findPlanComment(issueId: string): Promise<{ id: string; body: string } | null> {
    try {
      const comments = await fetchIssueComments(issueId)
      const markers = [PLAN_MARKER(issueId), LEGACY_PLAN_MARKER(issueId)]
      const found = [...comments].reverse().find((c) => markers.some((m) => c.body.includes(m)))
      return found ? { id: found.id, body: found.body } : null
    } catch {
      return null
    }
  }

  /** Worktree location without creating it — freshly discovered tickets have no worktreePath yet. */
  private worktreePathFor(issue: TrackedIssue): string | undefined {
    if (issue.worktreePath) return issue.worktreePath
    if (!issue.repoPath) return undefined
    return path.join(
      path.dirname(issue.repoPath),
      `${path.basename(issue.repoPath)}-worktrees`,
      issue.branchName.replace(/\//g, '-')
    )
  }

  /** The worktree plan file — the source of truth for a ticket's plan. */
  private readPlanFile(issue: TrackedIssue): string | null {
    const wt = this.worktreePathFor(issue)
    if (!wt) return null
    try {
      return fs.readFileSync(path.join(wt, PLAN_FILE_REL), 'utf8').trim() || null
    } catch {
      return null
    }
  }

  /**
   * Adopt an existing plan into local state: the worktree file wins (source of
   * truth); a plan comment left by an older app version is the fallback.
   */
  private async adoptPlan(issue: TrackedIssue): Promise<boolean> {
    const fileText = this.readPlanFile(issue)
    if (fileText) {
      issue.planBody = fileText
      return true
    }
    const comment = await this.findPlanComment(issue.issueId)
    if (comment) {
      issue.planCommentId = comment.id
      issue.planBody = planTextFromBody(issue.issueId, comment.body)
      return true
    }
    return false
  }

  // ---------- planning ----------

  private async startPlanning(issue: TrackedIssue, force = false): Promise<void> {
    const settings = settingsStore.get()
    if (!settings.orchestrator.enabled && !force) return // automation off — poll stays passive
    if (!issue.repoPath) return // surfaced on the board as "no repo mapped"
    if (processManager.runningCount('planning') >= settings.orchestrator.maxConcurrentPlanning) {
      return // stays phase=planning with no session; next poll retries
    }

    this.busy.add(issue.issueId)
    try {
      issue.worktreePath = await ensureWorktree(issue.repoPath, issue.branchName)
      // questions from a previous run must not be mistaken for this session's
      fs.rmSync(path.join(issue.worktreePath, PLAN_QUESTIONS_FILE_REL), { force: true })
      // retries and re-plans resume the prior planning conversation when its
      // transcript is available — the codebase exploration is already paid for
      const resumeId =
        settings.phases.planning.agent === 'claude'
          ? resumableSessionId(issue.worktreePath, issue.chatSessionId)
          : undefined
      const command = resumeId
        ? buildPlanningResumeCommand(settings.phases.planning, issue, resumeId)
        : buildPlanningCommand(
            settings.phases.planning,
            issue,
            issue.description,
            issue.worktreePath
          )
      const session = processManager.start({
        kind: 'planning',
        agent: settings.phases.planning.agent,
        model: settings.phases.planning.model,
        command,
        cwd: issue.worktreePath,
        timeoutMs: settings.phases.planning.timeoutMs,
        issueId: issue.issueId,
        issueIdentifier: issue.identifier
      })
      issue.phase = 'planning'
      issue.planQuestions = undefined
      issue.activeSessionId = session.id
      issue.lastError = undefined
      this.save(issue)
    } finally {
      this.busy.delete(issue.issueId)
    }
  }

  /** Blocking questions the planning session wrote instead of a plan. */
  private readPlanQuestions(issue: TrackedIssue): PlanQuestion[] | null {
    if (!issue.worktreePath) return null
    const file = path.join(issue.worktreePath, PLAN_QUESTIONS_FILE_REL)
    if (!fs.existsSync(file)) return null
    return parsePlanQuestions(fs.readFileSync(file, 'utf8'))
  }

  private async handlePlanningFinished(issue: TrackedIssue, session: Session): Promise<void> {
    issue.activeSessionId = undefined
    if (session.status !== 'done') {
      // keep the conversation id so a retry can resume instead of re-exploring
      issue.chatSessionId = session.agentSessionId ?? issue.chatSessionId
      this.fail(issue.issueId, sessionFailure('planning', session))
      return
    }

    const planFile = issue.worktreePath ? path.join(issue.worktreePath, PLAN_FILE_REL) : null
    let planText: string | null = null
    if (planFile && fs.existsSync(planFile)) planText = fs.readFileSync(planFile, 'utf8').trim()

    // no plan + a questions file = the session paused to ask instead of
    // guessing. Park the ticket (it stays in the Planning column) until the
    // user answers from the board.
    if (!planText) {
      const questions = this.readPlanQuestions(issue)
      if (questions) {
        issue.planQuestions = questions
        issue.phase = 'plan_questions'
        // answers resume this conversation — the exploration is already paid for
        issue.chatSessionId = session.agentSessionId ?? issue.chatSessionId
        issue.lastError = undefined
        this.save(issue)
        this.emit('notify', {
          title: `${issue.identifier} has questions`,
          body: `The agent needs ${questions.length} answer${questions.length === 1 ? '' : 's'} before it can write the plan.`,
          view: 'board'
        })
        return
      }
    }

    if (!planText) planText = session.lastText ?? null
    if (!planText) {
      this.fail(issue.issueId, 'planning session finished but produced no plan file')
      return
    }

    this.busy.add(issue.issueId)
    try {
      // the plan file is the source of truth; planBody is the board's cached
      // copy. A plan that only arrived as session output is written back to
      // the file. Plans are never posted to Linear.
      if (!planFile || !fs.existsSync(planFile)) this.writePlanFile(issue, planText)
      issue.planBody = planText
      issue.planQuestions = undefined // answered (or superseded) once a plan exists
      issue.planCommentId = undefined // a re-plan supersedes any legacy plan comment

      const mapping = this.mappingFor(issue.teamId)
      if (mapping) {
        await this.moveIfStillIn(issue, [mapping.planningStateId], mapping.planReadyStateId)
      }
      issue.phase = 'plan_ready'
      // plan feedback resumes the planning conversation — it already holds the
      // explored codebase context
      issue.chatSessionId = session.agentSessionId ?? issue.chatSessionId
      issue.lastError = undefined
      this.save(issue)
      this.emit('notify', {
        title: `${issue.identifier} plan ready`,
        body: 'Review the plan and approve to start coding.',
        view: 'board'
      })
    } finally {
      this.busy.delete(issue.issueId)
    }
  }

  /**
   * User answered the planning session's blocking questions from the board —
   * explicit action, works with automation off. Resumes the paused planning
   * conversation with the answers; the session either writes the plan (normal
   * plan-ready flow) or asks a new round of questions.
   */
  async answerPlanQuestions(
    issueId: string,
    answers: Array<{ id: string; answer: string }>
  ): Promise<void> {
    const issue = this.store.get(issueId)
    if (!issue || issue.phase !== 'plan_questions' || issue.activeSessionId || !issue.repoPath)
      return
    const qa = (issue.planQuestions ?? [])
      .map((q) => {
        const answer = answers.find((a) => a.id === q.id)?.answer.trim()
        return answer ? { question: q.question, answer } : null
      })
      .filter((x): x is { question: string; answer: string } => x !== null)
    if (qa.length === 0) return

    const settings = settingsStore.get()
    this.busy.add(issue.issueId)
    try {
      issue.worktreePath = await ensureWorktree(issue.repoPath, issue.branchName)
      // consumed — a leftover file must not re-park the ticket after this round
      fs.rmSync(path.join(issue.worktreePath, PLAN_QUESTIONS_FILE_REL), { force: true })
      const resumeId =
        settings.phases.planning.agent === 'claude'
          ? resumableSessionId(issue.worktreePath, issue.chatSessionId)
          : undefined
      const session = processManager.start({
        kind: 'planning',
        agent: settings.phases.planning.agent,
        model: settings.phases.planning.model,
        command: buildPlanAnswersCommand(
          settings.phases.planning,
          issue,
          qa,
          issue.worktreePath,
          resumeId
        ),
        cwd: issue.worktreePath,
        timeoutMs: settings.phases.planning.timeoutMs,
        issueId: issue.issueId,
        issueIdentifier: issue.identifier
      })
      issue.phase = 'planning'
      issue.planQuestions = undefined
      issue.activeSessionId = session.id
      issue.lastError = undefined
      this.save(issue)
    } finally {
      this.busy.delete(issue.issueId)
    }
  }

  // ---------- plan editing + feedback ----------

  /** User edited the plan (in-app). The worktree plan file is the only copy that matters. */
  async updatePlan(issueId: string, planText: string): Promise<void> {
    const issue = this.store.get(issueId)
    if (!issue || issue.phase !== 'plan_ready' || issue.activeSessionId) return
    this.busy.add(issueId)
    try {
      // the file is the source of truth — make sure there is a worktree to hold it
      if (issue.repoPath && !issue.worktreePath)
        issue.worktreePath = await ensureWorktree(issue.repoPath, issue.branchName)
      issue.planBody = planText.trim()
      this.writePlanFile(issue, planText.trim())
      this.save(issue)
    } finally {
      this.busy.delete(issueId)
    }
  }

  /**
   * Legacy (tickets whose plan was posted to Linear by an older app version):
   * new replies on the plan comment while in Plan ready are feedback: a session
   * decides question vs. edit, edits the plan file if asked, and writes a reply.
   * A reply is only "handled" once a Sully reply carrying its marker exists in
   * Linear, so restarts and cleared state never drop or double-handle feedback.
   */
  private async checkPlanFeedback(issue: TrackedIssue): Promise<void> {
    const settings = settingsStore.get()
    if (!issue.repoPath || !issue.planCommentId) return
    if (processManager.runningCount('plan_feedback') >= settings.orchestrator.maxConcurrentPlanning)
      return

    const viewerId = await this.ensureViewerId()
    if (!viewerId) return

    const comments = await fetchIssueComments(issue.issueId)
    const handled = new Set<string>()
    for (const c of comments) {
      for (const m of c.body.matchAll(REPLY_MARKER_RE)) handled.add(m[1])
    }
    this.recoverChatSessionId(issue, comments)
    const pending = comments
      .filter(
        (c) =>
          c.parent?.id === issue.planCommentId &&
          c.user?.id === viewerId &&
          !c.body.includes('<!-- sully:') &&
          !handled.has(c.id)
      )
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    if (pending.length === 0) return

    await this.startPlanFeedback(
      issue,
      pending.map((c) => c.body),
      pending.map((c) => c.id)
    )
  }

  /** User asked about / requested a change to the plan from the app — the chat stays in-app. */
  async planFeedback(issueId: string, message: string): Promise<void> {
    const issue = this.store.get(issueId)
    if (!issue || issue.phase !== 'plan_ready' || issue.activeSessionId || !message.trim()) return
    this.appendChat(issue, 'user', message.trim())
    this.save(issue)
    await this.startPlanFeedback(issue, [message.trim()], [])
  }

  /** Cleared local state? Pick the resume id back up from sully's Linear reply markers. */
  private recoverChatSessionId(
    issue: TrackedIssue,
    comments: Array<{ body: string; createdAt: string }>
  ): void {
    if (issue.chatSessionId) return
    const sorted = [...comments].sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    for (const c of sorted) {
      for (const m of c.body.matchAll(SESSION_MARKER_RE)) issue.chatSessionId = m[1]
    }
  }

  /** Empty commentIds = in-app chat message; non-empty = Linear plan-thread comments. */
  private async startPlanFeedback(
    issue: TrackedIssue,
    comments: string[],
    commentIds: string[]
  ): Promise<void> {
    const settings = settingsStore.get()
    if (!issue.repoPath) return

    this.busy.add(issue.issueId)
    try {
      issue.worktreePath = await ensureWorktree(issue.repoPath, issue.branchName)
      await this.restorePlanFile(issue)
      // stale reply from a previous run must not be mistaken for this session's
      fs.rmSync(path.join(issue.worktreePath, FEEDBACK_REPLY_FILE_REL), { force: true })

      const config = feedbackConfig(settings.phases.planning, settings.feedbackModel)
      // resume the planning/feedback conversation when its transcript exists
      // locally (cheap: no re-exploration); otherwise start fresh
      const resumeId =
        config.agent === 'claude'
          ? resumableSessionId(issue.worktreePath, issue.chatSessionId)
          : undefined
      const history = commentIds.length ? [] : (issue.chat ?? []).slice(0, -1)
      const command = resumeId
        ? buildPlanChatResumeCommand(config, comments.join('\n\n'), resumeId)
        : buildPlanFeedbackCommand(config, issue, comments, issue.worktreePath, history)
      const session = processManager.start({
        kind: 'plan_feedback',
        agent: config.agent,
        model: config.model,
        command,
        cwd: issue.worktreePath,
        timeoutMs: config.timeoutMs,
        issueId: issue.issueId,
        issueIdentifier: issue.identifier
      })
      issue.feedbackCommentIds = commentIds
      issue.activeSessionId = session.id
      issue.lastError = undefined
      this.save(issue)
    } finally {
      this.busy.delete(issue.issueId)
    }
  }

  private async handleFeedbackFinished(issue: TrackedIssue, session: Session): Promise<void> {
    issue.activeSessionId = undefined
    const commentIds = issue.feedbackCommentIds ?? []
    issue.feedbackCommentIds = undefined
    if (session.status !== 'done' && commentIds.length === 0) {
      // in-app chat cancelled or lost — resolve in the chat, never error the
      // ticket; drop the resume id in case the conversation itself is broken
      issue.chatSessionId = undefined
      this.appendChat(
        issue,
        'agent',
        session.status === 'stopped'
          ? '_Stopped._'
          : `_Session ${session.status} — please try again._`
      )
      this.save(issue)
      return
    }
    if (session.status !== 'done') {
      issue.chatSessionId = undefined
      this.fail(issue.issueId, sessionFailure('plan feedback', session))
      return
    }
    if (!issue.worktreePath || !issue.planBody) {
      this.fail(issue.issueId, 'plan feedback session finished but plan context is missing')
      return
    }

    const planFile = path.join(issue.worktreePath, PLAN_FILE_REL)
    const newPlan = fs.existsSync(planFile) ? fs.readFileSync(planFile, 'utf8').trim() : null
    const planChanged =
      Boolean(newPlan) && newPlan !== planTextFromBody(issue.issueId, issue.planBody)

    const replyFile = path.join(issue.worktreePath, FEEDBACK_REPLY_FILE_REL)
    const replyText = fs.existsSync(replyFile) ? fs.readFileSync(replyFile, 'utf8').trim() : ''

    this.busy.add(issue.issueId)
    try {
      // the session already wrote the plan file — just refresh the board's copy
      if (planChanged && newPlan) issue.planBody = newPlan
      const reply = planChanged
        ? `Plan updated.${replyText ? `\n\n${replyText}` : ''}`
        : replyText ||
          session.lastText?.trim() ||
          'Looked into it, but produced no answer — please retry.'
      if (commentIds.length) {
        const markers = commentIds.map(REPLY_MARKER).join('')
        const sm = session.agentSessionId ? SESSION_MARKER(session.agentSessionId) : ''
        // threads are one level deep: reply under the plan comment
        await postComment(issue.issueId, `${markers}${sm}\n${reply}`, issue.planCommentId)
      } else {
        // in-app chat: answer in the app, never in Linear
        this.appendChat(issue, 'agent', reply)
      }
      issue.chatSessionId = session.agentSessionId ?? issue.chatSessionId

      issue.lastError = undefined
      this.save(issue)
      this.emit('notify', {
        title: `${issue.identifier} ${planChanged ? 'plan updated' : 'plan question answered'}`,
        body: planChanged ? 'The plan was revised from your comment.' : reply.slice(0, 200),
        view: 'board'
      })
    } finally {
      this.busy.delete(issue.issueId)
    }
  }

  /**
   * Restore fetched review items from the worktree file when local state lacks
   * them (cleared state, re-discovery, schema change) — the worktree file is
   * the durable copy; state is just a cache of it.
   */
  private restoreGhReview(issue: TrackedIssue): void {
    if (issue.ghReviewItems || !issue.repoPath) return
    const wt = this.worktreePathFor(issue)
    if (!wt) return
    const file = path.join(wt, GH_REVIEW_FILE_REL)
    if (!fs.existsSync(file)) return
    const items = parseGhReviewItems(fs.readFileSync(file, 'utf8'))
    if (items) issue.ghReviewItems = items
  }

  /**
   * Ensure the worktree plan file exists (it is the source of truth, but the
   * worktree may have been recreated) — restore from the board's cached copy,
   * or a legacy Linear plan comment as a last resort.
   */
  private async restorePlanFile(issue: TrackedIssue): Promise<void> {
    if (!issue.worktreePath) return
    const planFile = path.join(issue.worktreePath, PLAN_FILE_REL)
    if (fs.existsSync(planFile)) return
    let body = issue.planBody
    if (!body) body = (await this.findPlanComment(issue.issueId))?.body
    if (body) this.writePlanFile(issue, planTextFromBody(issue.issueId, body))
  }

  private writePlanFile(issue: TrackedIssue, planText: string): void {
    if (!issue.worktreePath || !fs.existsSync(issue.worktreePath)) return
    const planFile = path.join(issue.worktreePath, PLAN_FILE_REL)
    fs.mkdirSync(path.dirname(planFile), { recursive: true })
    fs.writeFileSync(planFile, planText)
  }

  // ---------- reprompting after review ----------

  /** User reprompted the agent from the app (explicit action — works with automation off). */
  async reprompt(issueId: string, prompt: string): Promise<void> {
    const issue = this.store.get(issueId)
    if (!issue || issue.phase !== 'in_review' || issue.activeSessionId || !prompt.trim()) return
    this.appendChat(issue, 'user', prompt.trim())
    this.save(issue)
    await this.startReprompt(issue, [prompt.trim()], [])
  }

  /**
   * Top-level ticket comments left after coding is done are reprompts: a
   * session decides question vs. change request, implements + pushes to the PR
   * branch if asked, and replies on the ticket. Same marker-based handled
   * tracking as plan feedback, so restarts never drop or double-handle one.
   */
  private async checkReprompt(issue: TrackedIssue): Promise<void> {
    const settings = settingsStore.get()
    if (!issue.repoPath) return
    if (processManager.runningCount('reprompt') >= settings.orchestrator.maxConcurrentCoding) return

    // comments predating review (ticket discussion, planning notes) are not
    // reprompts — anchor the cutoff on first sight and only look after it
    if (!issue.codeFeedbackCutoff) {
      issue.codeFeedbackCutoff = new Date().toISOString()
      this.save(issue)
      return
    }

    const viewerId = await this.ensureViewerId()
    if (!viewerId) return

    const comments = await fetchIssueComments(issue.issueId)
    const handled = new Set<string>()
    for (const c of comments) {
      for (const m of c.body.matchAll(REPLY_MARKER_RE)) handled.add(m[1])
    }
    this.recoverChatSessionId(issue, comments)
    const cutoff = issue.codeFeedbackCutoff
    const pending = comments
      .filter(
        (c) =>
          !c.parent && // top-level only — plan-thread replies are plan feedback
          c.user?.id === viewerId &&
          !c.body.includes('<!-- sully:') &&
          c.createdAt > cutoff &&
          !handled.has(c.id)
      )
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    if (pending.length === 0) return

    await this.startReprompt(
      issue,
      pending.map((c) => c.body),
      pending.map((c) => c.id)
    )
  }

  /**
   * User clicked "Fetch GitHub comments" (or the modal's re-run) on an
   * in-review card — explicit action, works with automation off. Fetch only:
   * the session writes the PR's review comments to a markdown document, which
   * is stored on the ticket and rendered by the "View GitHub review" modal.
   * The ticket stays in review the whole time — no code is touched.
   */
  async fetchGhComments(issueId: string): Promise<void> {
    const issue = this.store.get(issueId)
    if (!issue || issue.phase !== 'in_review' || issue.activeSessionId || !issue.repoPath) return
    const config = settingsStore.get().phases.fetchComments

    this.busy.add(issue.issueId)
    try {
      issue.worktreePath = await ensureWorktree(issue.repoPath, issue.branchName)
      // a document from a previous run must not be mistaken for this session's
      fs.rmSync(path.join(issue.worktreePath, GH_REVIEW_FILE_REL), { force: true })

      const session = processManager.start({
        kind: 'fetch_comments',
        agent: config.agent,
        model: config.model,
        command: buildFetchCommentsCommand(config, issue, issue.worktreePath),
        cwd: issue.worktreePath,
        timeoutMs: config.timeoutMs,
        issueId: issue.issueId,
        issueIdentifier: issue.identifier
      })
      issue.activeSessionId = session.id
      issue.lastError = undefined
      this.save(issue)
    } finally {
      this.busy.delete(issue.issueId)
    }
  }

  private async handleFetchCommentsFinished(issue: TrackedIssue, session: Session): Promise<void> {
    issue.activeSessionId = undefined
    if (session.status !== 'done') {
      // a user-stopped fetch is not an error — quietly keep whatever document
      // the ticket already had
      if (session.status === 'stopped') {
        this.save(issue)
        return
      }
      this.fail(issue.issueId, sessionFailure('fetch comments', session))
      return
    }
    const file = issue.worktreePath ? path.join(issue.worktreePath, GH_REVIEW_FILE_REL) : null
    const raw = file && fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''
    const items = raw ? parseGhReviewItems(raw) : null
    if (!items) {
      this.fail(
        issue.issueId,
        raw
          ? 'fetch comments session wrote an unparseable review file — re-run the fetch'
          : 'fetch comments session finished but produced no review file'
      )
      return
    }
    issue.ghReviewItems = items
    issue.lastError = undefined
    this.save(issue)
    this.emit('notify', {
      title: `${issue.identifier} GitHub review fetched`,
      body: items.length
        ? `${items.length} review comment${items.length === 1 ? '' : 's'} — open "View GitHub review" on the card.`
        : 'No open review comments on the PR.',
      view: 'board'
    })
  }

  /**
   * User picked review items in the modal and clicked "Address selected".
   * Runs as an in-app reprompt built from the stored items, so the usual
   * implement–push–reply-in-chat flow applies to just that subset.
   */
  async addressGhComments(issueId: string, itemIds: string[]): Promise<void> {
    const issue = this.store.get(issueId)
    if (!issue || issue.phase !== 'in_review' || issue.activeSessionId) return
    const items = (issue.ghReviewItems ?? []).filter((i) => itemIds.includes(i.id))
    if (items.length === 0) return

    const blocks = items.map((i) => {
      const where = [
        i.author && `by ${i.author}`,
        i.file && `${i.file}${i.line ? `:${i.line}` : ''}`
      ]
        .filter(Boolean)
        .join(' — ')
      return [where, i.comment, i.suggestion ? `Suggested fix: ${i.suggestion}` : '']
        .filter(Boolean)
        .join('\n')
    })
    const prompt = [
      `Address ${items.length === 1 ? 'this review comment' : `these ${items.length} review comments`} from the GitHub review of this ticket's PR:`,
      ...blocks
    ].join('\n\n')

    const labels = items.map((i) =>
      i.file ? `${i.file}${i.line ? `:${i.line}` : ''}` : (i.author ?? 'comment')
    )
    this.appendChat(
      issue,
      'user',
      `Address ${items.length} selected review comment${items.length === 1 ? '' : 's'}: ${labels.join(', ')}`
    )
    this.save(issue)
    await this.startReprompt(issue, [prompt], [])
  }

  private async startReprompt(
    issue: TrackedIssue,
    prompts: string[],
    commentIds: string[]
  ): Promise<void> {
    const settings = settingsStore.get()
    if (!issue.repoPath) return
    const mapping = this.mappingFor(issue.teamId)

    this.busy.add(issue.issueId)
    try {
      issue.worktreePath = await ensureWorktree(issue.repoPath, issue.branchName)
      await this.restorePlanFile(issue)
      // stale reply from a previous run must not be mistaken for this session's
      fs.rmSync(path.join(issue.worktreePath, FEEDBACK_REPLY_FILE_REL), { force: true })
      const base = await headSha(issue.worktreePath)
      if (base) this.repromptBaseSha.set(issue.issueId, base)
      else this.repromptBaseSha.delete(issue.issueId)

      const config = feedbackConfig(settings.phases.coding, settings.feedbackModel)
      // resume the coding/chat conversation when its transcript exists locally
      // (cheap: no re-exploration); otherwise start fresh
      const resumeId =
        config.agent === 'claude'
          ? resumableSessionId(issue.worktreePath, issue.chatSessionId)
          : undefined
      const history = commentIds.length ? [] : (issue.chat ?? []).slice(0, -1)
      const command = resumeId
        ? buildRepromptResumeCommand(config, issue, prompts.join('\n\n'), resumeId)
        : buildRepromptCommand(config, issue, prompts, issue.worktreePath, history)
      const session = processManager.start({
        kind: 'reprompt',
        agent: config.agent,
        model: config.model,
        command,
        cwd: issue.worktreePath,
        timeoutMs: config.timeoutMs,
        issueId: issue.issueId,
        issueIdentifier: issue.identifier
      })
      // a Linear-originated reprompt is visible work — reflect it in Linear;
      // in-app chat stays in the app, so the ticket does not move
      if (mapping && commentIds.length) {
        await this.moveIfStillIn(issue, [mapping.inReviewStateId], mapping.inProgressStateId)
      }
      issue.phase = 'reprompting'
      issue.feedbackCommentIds = commentIds
      issue.activeSessionId = session.id
      issue.lastError = undefined
      this.save(issue)
    } finally {
      this.busy.delete(issue.issueId)
    }
  }

  private async handleRepromptFinished(issue: TrackedIssue, session: Session): Promise<void> {
    issue.activeSessionId = undefined
    const commentIds = issue.feedbackCommentIds ?? []
    issue.feedbackCommentIds = undefined
    const baseSha = this.repromptBaseSha.get(issue.issueId)
    this.repromptBaseSha.delete(issue.issueId)
    const mapping = this.mappingFor(issue.teamId)

    if (session.status !== 'done' && commentIds.length === 0) {
      // in-app chat cancelled or lost — resolve in the chat, never error the
      // ticket (it never moved in Linear either); drop the resume id in case
      // the conversation itself is broken
      issue.phase = 'in_review'
      issue.chatSessionId = undefined
      this.appendChat(
        issue,
        'agent',
        session.status === 'stopped'
          ? '_Stopped._'
          : `_Session ${session.status} — please try again._`
      )
      this.save(issue)
      return
    }
    if (session.status !== 'done') {
      // park the ticket back in review; unhandled comments re-detect via markers
      // (in-app chats never moved the ticket, so there is nothing to move back)
      issue.chatSessionId = undefined
      if (commentIds.length) {
        this.busy.add(issue.issueId)
        try {
          if (mapping) {
            await this.moveIfStillIn(issue, [mapping.inProgressStateId], mapping.inReviewStateId)
          }
        } finally {
          this.busy.delete(issue.issueId)
        }
      }
      this.fail(issue.issueId, sessionFailure('reprompt', session))
      return
    }

    const replyFile = issue.worktreePath
      ? path.join(issue.worktreePath, FEEDBACK_REPLY_FILE_REL)
      : null
    const replyText =
      replyFile && fs.existsSync(replyFile) ? fs.readFileSync(replyFile, 'utf8').trim() : ''
    const newSha = issue.worktreePath ? await headSha(issue.worktreePath) : null
    const changed = Boolean(baseSha && newSha && baseSha !== newSha)
    // "Code updated." must mean the PR actually has the commits — a local
    // HEAD change with a failed push would otherwise report success. If the
    // remote is unreachable the check is skipped rather than false-alarming.
    let pushed = true
    if (changed && issue.worktreePath) {
      const remote = await remoteBranchSha(issue.worktreePath, issue.branchName)
      if (remote !== null) pushed = remote === newSha
    }

    this.busy.add(issue.issueId)
    try {
      // in-app chats never moved the ticket, so there is nothing to move back
      if (mapping && commentIds.length) {
        await this.moveIfStillIn(issue, [mapping.inProgressStateId], mapping.inReviewStateId)
      }
      issue.phase = 'in_review'

      const reply = changed
        ? `${pushed ? 'Code updated.' : 'Code was changed, but pushing it to the PR may have failed — the branch on GitHub is behind. Check the session log in Sully.'}${replyText ? `\n\n${replyText}` : ''}`
        : replyText ||
          session.lastText?.trim() ||
          'Looked into it, but produced no answer — please retry.'
      if (commentIds.length) {
        // Linear-originated reprompt: answer where the user asked
        const markers = commentIds.map(REPLY_MARKER).join('')
        const sm = session.agentSessionId ? SESSION_MARKER(session.agentSessionId) : ''
        await postComment(issue.issueId, `${markers}${sm}\n${reply}`, commentIds[0])
      } else {
        // in-app chat: answer in the app, never in Linear
        this.appendChat(issue, 'agent', reply)
      }
      issue.chatSessionId = session.agentSessionId ?? issue.chatSessionId

      issue.lastError = undefined
      this.save(issue)
      this.emit('notify', {
        title: `${issue.identifier} ${changed ? 'code updated' : 'comment answered'}`,
        body: changed
          ? pushed
            ? 'Changes pushed to the PR from your comment.'
            : 'Changes committed, but the push may have failed — check the session log.'
          : reply.slice(0, 200),
        view: 'board'
      })
    } finally {
      this.busy.delete(issue.issueId)
    }
  }

  // ---------- approval + coding ----------

  async approvePlan(issueId: string): Promise<void> {
    const issue = this.store.get(issueId)
    if (!issue || issue.phase !== 'plan_ready') return
    const mapping = this.mappingFor(issue.teamId)
    if (!mapping) return
    // approval supersedes an in-flight feedback session — detach it first so
    // its finish handler can't touch the plan mid-coding
    if (issue.activeSessionId) {
      const active = processManager.get(issue.activeSessionId)
      if (active?.kind !== 'plan_feedback') return
      const sessionId = issue.activeSessionId
      issue.activeSessionId = undefined
      issue.feedbackCommentIds = undefined
      await processManager.stop(sessionId)
    }
    this.busy.add(issueId)
    try {
      await moveIssue(issueId, mapping.inProgressStateId)
      issue.stateId = mapping.inProgressStateId
      issue.phase = 'coding'
      this.save(issue)
    } finally {
      this.busy.delete(issueId)
    }
    // approving is an explicit user action — start coding even if automation is off
    await this.startCoding(issue, true)
  }

  private async startCoding(issue: TrackedIssue, force = false): Promise<void> {
    const settings = settingsStore.get()
    if (!settings.orchestrator.enabled && !force) return // automation off — poll stays passive
    if (!issue.repoPath) return
    if (processManager.runningCount('coding') >= settings.orchestrator.maxConcurrentCoding) return

    this.busy.add(issue.issueId)
    try {
      issue.worktreePath = await ensureWorktree(issue.repoPath, issue.branchName)

      // make sure the plan file exists in the worktree (restore from Linear if needed)
      await this.restorePlanFile(issue)

      // the plan conversation is over once coding starts — reprompts about the
      // implementation must not resume it
      issue.chatSessionId = undefined
      // retries resume the failed coding conversation (partial work + explored
      // context); the first attempt has no codingSessionId and starts fresh
      const resumeId =
        settings.phases.coding.agent === 'claude'
          ? resumableSessionId(issue.worktreePath, issue.codingSessionId)
          : undefined
      const command = resumeId
        ? buildCodingResumeCommand(settings.phases.coding, issue, resumeId)
        : buildCodingCommand(settings.phases.coding, issue, issue.worktreePath)
      const session = processManager.start({
        kind: 'coding',
        agent: settings.phases.coding.agent,
        model: settings.phases.coding.model,
        command,
        cwd: issue.worktreePath,
        timeoutMs: settings.phases.coding.timeoutMs,
        issueId: issue.issueId,
        issueIdentifier: issue.identifier
      })
      issue.phase = 'coding'
      issue.activeSessionId = session.id
      issue.lastError = undefined
      this.save(issue)
    } finally {
      this.busy.delete(issue.issueId)
    }
  }

  private async handleCodingFinished(issue: TrackedIssue, session: Session): Promise<void> {
    issue.activeSessionId = undefined
    // remembered for retries: a failed/stopped/timed-out coding session is
    // resumed rather than re-run cold on the dirty tree
    issue.codingSessionId = session.agentSessionId ?? issue.codingSessionId
    if (session.status !== 'done') {
      this.fail(issue.issueId, sessionFailure('coding', session))
      return
    }
    // reprompts resume the coding conversation — it already holds the
    // implementation context
    issue.chatSessionId = session.agentSessionId ?? issue.chatSessionId

    // already shipped? (a skill or previous run may have opened the PR) —
    // only an OPEN PR counts; a closed/merged one is from an earlier attempt
    const existing = issue.repoPath ? await prForBranch(issue.repoPath, issue.branchName) : null
    if (existing && existing.state === 'OPEN') {
      await this.finishWithPr(issue, existing.url)
      return
    }
    await this.startCreatePr(issue)
  }

  /** Dedicated create-pr phase: commits, pushes, and opens the PR. */
  private async startCreatePr(issue: TrackedIssue): Promise<void> {
    const settings = settingsStore.get()
    if (!issue.repoPath || !issue.worktreePath) {
      this.fail(issue.issueId, 'coding finished but the worktree is missing')
      return
    }
    this.busy.add(issue.issueId)
    try {
      const command = buildCreatePrCommand(
        settings.phases.createPr,
        issue,
        issue.worktreePath,
        settings.draftPrs,
        this.baseBranchFor(issue)
      )
      const session = processManager.start({
        kind: 'create_pr',
        agent: settings.phases.createPr.agent,
        model: settings.phases.createPr.model,
        command,
        cwd: issue.worktreePath,
        timeoutMs: settings.phases.createPr.timeoutMs,
        issueId: issue.issueId,
        issueIdentifier: issue.identifier
      })
      issue.activeSessionId = session.id
      this.save(issue)
    } finally {
      this.busy.delete(issue.issueId)
    }
  }

  private async handleCreatePrFinished(issue: TrackedIssue, session: Session): Promise<void> {
    issue.activeSessionId = undefined
    let pr = issue.repoPath ? await prForBranch(issue.repoPath, issue.branchName) : null
    // a closed/merged PR from an earlier attempt must not count as shipped
    if (pr && pr.state !== 'OPEN') pr = null
    // session failed or forgot the PR — last-resort direct gh pr create
    if (!pr && session.status === 'done' && issue.repoPath && issue.worktreePath) {
      try {
        const url = await createPr(
          issue.worktreePath,
          issue.branchName,
          `${issue.identifier}: ${issue.title}`,
          `Implements ${issue.url}\n\nPlan: see Linear comment.`,
          settingsStore.get().draftPrs,
          this.baseBranchFor(issue)
        )
        pr = { url, number: 0, state: 'OPEN' }
      } catch (err) {
        this.fail(
          issue.issueId,
          `create-pr finished but no PR exists and gh pr create failed: ${(err as Error).message.slice(0, 300)}`
        )
        return
      }
    }
    if (!pr) {
      this.fail(issue.issueId, sessionFailure('create-pr', session, ' and no PR exists'))
      return
    }
    await this.finishWithPr(issue, pr.url)
  }

  private async finishWithPr(issue: TrackedIssue, prUrl: string): Promise<void> {
    this.busy.add(issue.issueId)
    try {
      issue.prUrl = prUrl
      const mapping = this.mappingFor(issue.teamId)
      if (mapping) {
        await this.moveIfStillIn(issue, [mapping.inProgressStateId], mapping.inReviewStateId)
      }
      issue.phase = 'in_review'
      // comments from here on count as reprompts
      if (!issue.codeFeedbackCutoff) issue.codeFeedbackCutoff = new Date().toISOString()
      issue.lastError = undefined
      this.save(issue)
      this.emit('notify', {
        title: `${issue.identifier} PR created`,
        body: prUrl,
        view: 'board'
      })
    } finally {
      this.busy.delete(issue.issueId)
    }
  }

  // ---------- shared ----------

  /** Per-ticket spend rollup + a one-time budget warning. */
  private recordCost(issue: TrackedIssue, session: Session): void {
    if (!session.costUsd) return
    issue.costUsd = (issue.costUsd ?? 0) + session.costUsd
    const budget = settingsStore.get().orchestrator.ticketBudgetUsd
    if (budget > 0 && !issue.costWarned && issue.costUsd >= budget) {
      issue.costWarned = true
      this.emit('notify', {
        title: `${issue.identifier} passed $${budget} in AI spend`,
        body: `Sessions for this ticket have cost $${issue.costUsd.toFixed(2)} so far.`,
        view: 'board'
      })
    }
  }

  private async onSessionFinished(session: Session): Promise<void> {
    if (!session.issueId) return
    const issue = this.store.get(session.issueId)
    if (!issue || issue.activeSessionId !== session.id) return
    this.recordCost(issue, session) // persisted by each handler's save below
    if (session.kind === 'planning') await this.handlePlanningFinished(issue, session)
    else if (session.kind === 'plan_feedback') await this.handleFeedbackFinished(issue, session)
    else if (session.kind === 'coding') await this.handleCodingFinished(issue, session)
    else if (session.kind === 'create_pr') await this.handleCreatePrFinished(issue, session)
    else if (session.kind === 'reprompt') await this.handleRepromptFinished(issue, session)
    else if (session.kind === 'fetch_comments')
      await this.handleFetchCommentsFinished(issue, session)
  }

  /** Two-writer guard: only move if the user hasn't already moved it elsewhere. */
  private async moveIfStillIn(
    issue: TrackedIssue,
    expectedStateIds: string[],
    targetStateId: string
  ): Promise<void> {
    try {
      const current = await fetchIssueState(issue.issueId)
      if (!expectedStateIds.includes(current.id)) {
        issue.stateId = current.id
        issue.stateName = current.name
        return
      }
    } catch {
      // if the check fails, attempt the move anyway
    }
    await moveIssue(issue.issueId, targetStateId)
    issue.stateId = targetStateId
  }

  async retry(issueId: string): Promise<void> {
    const issue = this.store.get(issueId)
    if (!issue || issue.activeSessionId) return
    const mapping = this.mappingFor(issue.teamId)
    if (!mapping) return
    const column = this.columnKind(issue.stateId, mapping)
    issue.lastError = undefined
    // the plan file on disk is the source of truth — a cleared or clobbered
    // cache must not force a re-plan while the plan still exists
    if (!issue.planBody) issue.planBody = this.readPlanFile(issue) ?? undefined
    if (column === 'planning' || (column === 'planReady' && !issue.planBody)) {
      issue.phase = 'planning'
      this.save(issue)
      await this.startPlanning(issue, true) // explicit user action
    } else if (column === 'inProgress') {
      issue.phase = 'coding'
      this.save(issue)
      await this.startCoding(issue, true) // explicit user action
    } else {
      issue.phase =
        column === 'planReady'
          ? 'plan_ready'
          : column === 'uncategorized'
            ? 'uncategorized'
            : 'in_review'
      this.save(issue)
    }
  }

  /**
   * User dropped a card on a board column. Only Linear is written — the next
   * poll reacts exactly as if the ticket had been dragged inside Linear (the
   * backward-drag re-plan detection relies on local stateId still holding the
   * pre-drag position, so local state must not be touched here).
   */
  async moveToColumn(issueId: string, column: ColumnKind): Promise<void> {
    const issue = this.store.get(issueId)
    if (!issue) return
    const mapping = this.mappingFor(issue.teamId)
    if (!mapping) throw new Error('no column mapping for this ticket’s team')
    const stateId = this.stateIdForColumn(mapping, column)
    if (!stateId)
      throw new Error(
        `no Linear state is mapped to that column for ${mapping.teamName} — map it in Settings → Columns`
      )
    if (stateId === issue.stateId) return
    await moveIssue(issueId, stateId)
    this.pollNow()
  }
}

export const orchestrator = new Orchestrator()
