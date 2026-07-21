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
  PLAN_FILE_REL,
  PLAN_QUESTIONS_FILE_REL,
  buildCodingCommand,
  buildCodingResumeCommand,
  buildCommitPushCommand,
  buildCreatePrCommand,
  buildPlanAnswersCommand,
  buildPlanChatResumeCommand,
  buildPlanFeedbackCommand,
  buildPlanningCommand,
  buildPlanningResumeCommand,
  buildRepromptCommand,
  buildRepromptResumeCommand
} from './prompts'
import {
  fetchIssueComments,
  fetchIssueState,
  fetchIssuesInStates,
  moveIssue,
  type LinearIssueNode
} from '../linear/operations'
import {
  createPr,
  failedRunLogs,
  mergePr,
  prChecks,
  prForBranch,
  prReviewComments,
  updatePrBranch
} from '../github/gh'

const PLAN_MARKER = (issueId: string): string => `<!-- sully:plan issueId=${issueId} v=1 -->`
// plan comments posted before the conductor→sully rename must stay recognized
// (never double-plan), so scanning matches the old token too
const LEGACY_PLAN_MARKER = (issueId: string): string =>
  `<!-- conductor:plan issueId=${issueId} v=1 -->`
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

/** Parse the planning session's questions JSON, tolerating the usual model slips. */
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
 * Linear-driven state machine. Linear columns are the *trigger*; local state is
 * the *dedupe*. Every post-session step (move, PR create) checks before acting,
 * so restart recovery is just re-running the steps.
 */
export class Orchestrator extends EventEmitter {
  private store = new IssueStateStore()
  private timer?: NodeJS.Timeout
  private polling = false
  /** issues with an async transition in flight (post/move/spawn) — skip in poll */
  private busy = new Set<string>()
  /** HEAD sha captured before each reprompt session, to detect whether it changed code */
  private repromptBaseSha = new Map<string, string>()

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
          local.planBody = undefined
          local.planQuestions = undefined
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
            local.planBody = undefined
            local.planQuestions = undefined
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
        this.save(local)
        // CI/review status is read-only board sync — it refreshes even with
        // automation off; only the fix sessions require act.
        if (local.phase === 'in_review') {
          await this.checkCiAutoFix(local, act)
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

    // inReview — track read-only; review comments auto-populate on the next poll
    const issue = this.toTracked(node, 'in_review')
    if (issue.repoPath && issue.branchName) {
      const pr = await prForBranch(issue.repoPath, issue.branchName)
      if (pr) issue.prUrl = pr.url
    }
    this.save(issue)
  }

  /** Legacy: plans used to be posted as Linear comments — read-only fallback now. */
  private async findPlanComment(issueId: string): Promise<string | null> {
    try {
      const comments = await fetchIssueComments(issueId)
      const markers = [PLAN_MARKER(issueId), LEGACY_PLAN_MARKER(issueId)]
      const found = [...comments].reverse().find((c) => markers.some((m) => c.body.includes(m)))
      return found?.body ?? null
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
      issue.planBody = planTextFromBody(issue.issueId, comment)
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

  /** User asked about / requested a change to the plan from the app — the chat stays in-app. */
  async planFeedback(issueId: string, message: string): Promise<void> {
    const issue = this.store.get(issueId)
    if (!issue || issue.phase !== 'plan_ready' || issue.activeSessionId || !message.trim()) return
    this.appendChat(issue, 'user', message.trim())
    this.save(issue)
    await this.startPlanFeedback(issue, [message.trim()])
  }

  private async startPlanFeedback(issue: TrackedIssue, comments: string[]): Promise<void> {
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
      const history = (issue.chat ?? []).slice(0, -1)
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
      issue.activeSessionId = session.id
      issue.lastError = undefined
      this.save(issue)
    } finally {
      this.busy.delete(issue.issueId)
    }
  }

  private async handleFeedbackFinished(issue: TrackedIssue, session: Session): Promise<void> {
    issue.activeSessionId = undefined
    if (session.status !== 'done') {
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
      // the chat lives in the app, never in Linear
      this.appendChat(issue, 'agent', reply)
      issue.chatSessionId = session.agentSessionId ?? issue.chatSessionId

      issue.lastError = undefined
      this.save(issue)
      this.emit('notify', {
        title: `${issue.identifier} ${planChanged ? 'plan updated' : 'plan question answered'}`,
        body: planChanged ? 'The plan was revised from your message.' : reply.slice(0, 200),
        view: 'board'
      })
    } finally {
      this.busy.delete(issue.issueId)
    }
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
    if (!body) body = (await this.findPlanComment(issue.issueId)) ?? undefined
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
    await this.startReprompt(issue, [prompt.trim()])
  }

  /**
   * Watch the PR's checks and review decision while the ticket sits in
   * review; when CI settles red (and auto-fix is on), resume the coding
   * conversation with the failure logs so it can fix and push. Attempts are
   * SHA-deduped and capped, so a red streak can never loop forever — after a
   * give-up the Retry button re-arms it.
   */
  private async checkCiAutoFix(issue: TrackedIssue, act: boolean): Promise<void> {
    const settings = settingsStore.get()
    if (!issue.prUrl || !issue.repoPath || !issue.branchName || issue.activeSessionId) return

    const checks = await prChecks(issue.repoPath, issue.branchName)
    if (!checks) return
    if (checks.state !== 'OPEN') {
      // merged/closed mid-loop — nothing left to watch
      if (issue.ciStatus || issue.ciFixAttemptShas || issue.prReview || issue.ghReviewItems) {
        issue.ciStatus = undefined
        issue.ciFixAttemptShas = undefined
        issue.prReview = undefined
        issue.ghReviewItems = undefined
        this.save(issue)
      }
      return
    }

    // review comments auto-populate the "View GitHub review" modal; a failed
    // fetch (null) keeps the last known list
    const prRef = issue.prUrl.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/)
    const comments = prRef ? await prReviewComments(prRef[1], prRef[2], Number(prRef[3])) : null
    let itemsChanged = false
    if (comments) {
      // carry addressed marks across refetches; a changed body (new thread
      // reply) drops the mark so the comment becomes actionable again
      const prev = new Map((issue.ghReviewItems ?? []).map((i) => [i.id, i]))
      const merged: GhReviewItem[] = comments.map((c) => {
        const old = prev.get(c.id)
        return old?.addressedAt && old.comment === c.comment
          ? { ...c, addressedAt: old.addressedAt }
          : c
      })
      itemsChanged = JSON.stringify(merged) !== JSON.stringify(issue.ghReviewItems ?? [])
      if (itemsChanged) issue.ghReviewItems = merged
    }

    const review = (
      {
        APPROVED: 'approved',
        CHANGES_REQUESTED: 'changes_requested',
        REVIEW_REQUIRED: 'review_required'
      } as const
    )[checks.reviewDecision as string]
    const failedNames = checks.failed.map((f) => f.name)
    // save only on meaningful change — every save rewrites state.json and
    // pings the renderer, so don't churn on the checkedAt timestamp alone
    if (
      issue.ciStatus?.state !== checks.overall ||
      issue.ciStatus?.headSha !== checks.headSha ||
      issue.prReview !== (review ?? 'none') ||
      itemsChanged
    ) {
      issue.ciStatus = {
        state: checks.overall,
        headSha: checks.headSha,
        failed: failedNames,
        checkedAt: new Date().toISOString()
      }
      issue.prReview = review ?? 'none'
      this.save(issue)
    }

    // auto-merge on approval — independent of the CI-fix path below. Merge
    // only when approved AND CI is green (or has no checks); once merged the
    // next poll sees state !== OPEN and clears status above.
    if (
      act &&
      settings.orchestrator.autoMergeOnApproval &&
      review === 'approved' &&
      (checks.overall === 'pass' || checks.overall === 'none')
    ) {
      try {
        if (checks.mergeStateStatus === 'BEHIND') {
          // repo requires the branch to be up to date — sync with base first.
          // The resulting commit re-runs CI, so a later green poll does the merge.
          await updatePrBranch(issue.repoPath, issue.branchName)
          this.emit('notify', {
            title: `${issue.identifier} branch updated`,
            body: 'Synced with base before auto-merge; will merge once CI passes again.',
            view: 'board'
          })
        } else {
          await mergePr(issue.repoPath, issue.branchName)
          this.emit('notify', {
            title: `${issue.identifier} auto-merged`,
            body: 'PR merged after approval.',
            view: 'board'
          })
        }
      } catch (err) {
        this.emit('notify', {
          title: `${issue.identifier} auto-merge failed`,
          body: (err as Error).message.slice(0, 200),
          view: 'board'
        })
      }
    }

    // everything below acts on a red streak — that requires automation on
    // (act) and the auto-fix toggle; the status refresh above is always-on
    if (!act || !settings.orchestrator.ciAutoFix) return
    if (checks.overall === 'pending') return
    if (checks.overall !== 'fail') {
      if (issue.ciFixAttemptShas?.length) {
        issue.ciFixAttemptShas = undefined
        this.save(issue)
        this.emit('notify', {
          title: `${issue.identifier} CI green`,
          body: 'Checks passing after auto-fix.',
          view: 'board'
        })
      }
      return
    }

    const sha7 = checks.headSha.slice(0, 7)
    const attempts = issue.ciFixAttemptShas ?? []
    if (attempts.includes(checks.headSha)) {
      // the fix attempt produced no new commit (judged flaky, or the push
      // failed) — rerunning on identical input would loop, so give up once
      this.fail(
        issue.issueId,
        `CI still failing on ${sha7} after an auto-fix attempt that produced no new commit — see the ticket chat, fix manually, or Retry to re-arm auto-fix.`
      )
      return
    }
    const max = settings.orchestrator.ciMaxFixAttempts
    if (attempts.length >= max) {
      this.fail(
        issue.issueId,
        `CI still failing after ${attempts.length} auto-fix attempt${attempts.length === 1 ? '' : 's'} (${failedNames.join(', ')}) — fix manually or Retry to re-arm auto-fix.`
      )
      return
    }
    if (processManager.runningCount('reprompt') >= settings.orchestrator.maxConcurrentCoding) {
      return // retries next poll
    }

    const logs = await failedRunLogs(
      issue.repoPath,
      checks.failed.map((f) => f.link)
    )
    const attempt = attempts.length + 1
    const prompt = [
      `Automated CI report — the checks on this ticket's pull request (${issue.prUrl}) failed at commit ${sha7} (auto-fix attempt ${attempt} of ${max}).`,
      [
        'Failing checks:',
        ...checks.failed.map((f) => `- ${f.name}${f.link ? ` — ${f.link}` : ''}`)
      ].join('\n'),
      logs
        ? `Failed-step logs (truncated — fetch more yourself with \`gh run view <run-id> --log-failed\` if needed):\n"""\n${logs}\n"""`
        : '',
      "Diagnose the failures and fix the code (or tests/config) in this worktree. Where a check has no logs above, reproduce it locally (run the project's lint/typecheck/tests). Verify locally, then commit and push so CI re-runs. If a failure is flaky or infrastructural and no code change is warranted, say so in your reply and change nothing."
    ]
      .filter(Boolean)
      .join('\n\n')

    // record before spawning so a crash mid-fix can never double-attempt a SHA
    issue.ciFixAttemptShas = [...attempts, checks.headSha].slice(-10)
    this.appendChat(
      issue,
      'user',
      `CI auto-fix (attempt ${attempt}/${max}): checks failed on ${sha7} — ${failedNames.join(', ')}`
    )
    this.save(issue)
    this.emit('notify', {
      title: `${issue.identifier} CI failed`,
      body: `Auto-fixing (attempt ${attempt}/${max}): ${failedNames.join(', ')}`.slice(0, 200),
      view: 'board'
    })
    await this.startReprompt(issue, [prompt])
  }

  /**
   * User picked review items in the modal and clicked "Address selected".
   * Runs as an in-app reprompt built from the stored items, so the usual
   * implement–push–reply-in-chat flow applies to just that subset.
   */
  async addressGhComments(issueId: string, itemIds: string[]): Promise<void> {
    const issue = this.store.get(issueId)
    if (!issue || issue.phase !== 'in_review' || issue.activeSessionId) return
    // already-addressed items are display-only — never re-dispatch them
    const items = (issue.ghReviewItems ?? []).filter(
      (i) => itemIds.includes(i.id) && !i.addressedAt
    )
    if (items.length === 0) return

    const blocks = items.map((i) => {
      const where = [
        i.author && `by ${i.author}`,
        i.file && `${i.file}${i.line ? `:${i.line}` : ''}`
      ]
        .filter(Boolean)
        .join(' — ')
      return [where, i.comment].filter(Boolean).join('\n')
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
    // dedicated phase config — its model wins, no feedbackModel swap
    await this.startReprompt(issue, [prompt], settingsStore.get().phases.addressComments)
    // mark after a successful dispatch so a failed spawn leaves them actionable
    const at = new Date().toISOString()
    for (const i of items) i.addressedAt = at
    this.save(issue)
  }

  private async startReprompt(
    issue: TrackedIssue,
    prompts: string[],
    configOverride?: PhaseConfig
  ): Promise<void> {
    const settings = settingsStore.get()
    if (!issue.repoPath) return

    this.busy.add(issue.issueId)
    try {
      issue.worktreePath = await ensureWorktree(issue.repoPath, issue.branchName)
      await this.restorePlanFile(issue)
      // stale reply from a previous run must not be mistaken for this session's
      fs.rmSync(path.join(issue.worktreePath, FEEDBACK_REPLY_FILE_REL), { force: true })
      const base = await headSha(issue.worktreePath)
      if (base) this.repromptBaseSha.set(issue.issueId, base)
      else this.repromptBaseSha.delete(issue.issueId)

      const config =
        configOverride ?? feedbackConfig(settings.phases.coding, settings.feedbackModel)
      // resume the coding/chat conversation when its transcript exists locally
      // (cheap: no re-exploration); otherwise start fresh
      const resumeId =
        config.agent === 'claude'
          ? resumableSessionId(issue.worktreePath, issue.chatSessionId)
          : undefined
      const history = (issue.chat ?? []).slice(0, -1)
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
      // in-app chat stays in the app, so the ticket does not move in Linear
      issue.phase = 'reprompting'
      issue.activeSessionId = session.id
      issue.lastError = undefined
      this.save(issue)
    } finally {
      this.busy.delete(issue.issueId)
    }
  }

  private async handleRepromptFinished(issue: TrackedIssue, session: Session): Promise<void> {
    issue.activeSessionId = undefined
    const baseSha = this.repromptBaseSha.get(issue.issueId)
    this.repromptBaseSha.delete(issue.issueId)

    if (session.status !== 'done') {
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
      issue.phase = 'in_review'

      const reply = changed
        ? `${pushed ? 'Code updated.' : 'Code was changed, but pushing it to the PR may have failed — the branch on GitHub is behind. Check the session log in Sully.'}${replyText ? `\n\n${replyText}` : ''}`
        : replyText ||
          session.lastText?.trim() ||
          'Looked into it, but produced no answer — please retry.'
      // the chat lives in the app, never in Linear
      this.appendChat(issue, 'agent', reply)
      issue.chatSessionId = session.agentSessionId ?? issue.chatSessionId

      issue.lastError = undefined
      this.save(issue)
      this.emit('notify', {
        title: `${issue.identifier} ${changed ? 'code updated' : 'question answered'}`,
        body: changed
          ? pushed
            ? 'Changes pushed to the PR.'
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

  // ---------- manual commit & push ----------

  /**
   * User clicked "Commit & push" on a ticket whose worktree has uncommitted
   * changes (manual edits, a stopped session's leftovers). Runs a dedicated
   * commit-push session; the ticket keeps its phase and Linear state.
   */
  async commitPush(issueId: string): Promise<void> {
    const issue = this.store.get(issueId)
    if (!issue || !issue.repoPath || issue.activeSessionId) return
    if (!issue.worktreePath || !fs.existsSync(issue.worktreePath)) return

    this.busy.add(issue.issueId)
    try {
      const config = settingsStore.get().phases.commitPush
      const session = processManager.start({
        kind: 'commit_push',
        agent: config.agent,
        model: config.model,
        command: buildCommitPushCommand(config, issue, issue.worktreePath),
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

  private async handleCommitPushFinished(issue: TrackedIssue, session: Session): Promise<void> {
    // a manual commit never moves the ticket — release it and report the outcome
    issue.activeSessionId = undefined
    this.save(issue)
    if (session.status !== 'done') {
      this.emit('notify', {
        title: `${issue.identifier} commit & push ${session.status}`,
        body: sessionFailure('commit & push', session).slice(0, 200),
        view: 'board'
      })
      return
    }
    // "pushed" must mean origin has the commits — a local commit with a failed
    // push would otherwise report success. Offline skips the check.
    const sha = issue.worktreePath ? await headSha(issue.worktreePath) : null
    let pushed = true
    if (sha && issue.worktreePath) {
      const remote = await remoteBranchSha(issue.worktreePath, issue.branchName)
      if (remote !== null) pushed = remote === sha
    }
    this.emit('notify', {
      title: `${issue.identifier} ${pushed ? 'changes pushed' : 'push may have failed'}`,
      body: pushed
        ? `Local changes committed and pushed to ${issue.branchName}.`
        : 'Changes were committed, but the branch on GitHub is behind — check the session log.',
      view: 'board'
    })
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
    else if (session.kind === 'commit_push') await this.handleCommitPushFinished(issue, session)
    else if (session.kind === 'reprompt') await this.handleRepromptFinished(issue, session)
    else if (session.kind === 'fetch_comments') {
      // legacy fetch session from before the poll auto-fetched comments —
      // nothing to parse anymore, just release the ticket
      issue.activeSessionId = undefined
      this.save(issue)
    }
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
      // an explicit retry re-arms CI auto-fix after a give-up
      issue.ciFixAttemptShas = undefined
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
