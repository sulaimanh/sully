import type {
  ChatMessage,
  ErrorSource,
  ErrorTrackingIssue,
  PhaseConfig,
  TrackedIssue
} from '../../shared/types'
import { binaryPath } from '../env'
import { subsetMcpConfigFile } from '../mcp'

export const PLAN_FILE_REL = '.sully/plan.md'
export const FEEDBACK_REPLY_FILE_REL = '.sully/feedback-reply.md'
export const PLAN_QUESTIONS_FILE_REL = '.sully/questions.json'
/** Ticket metadata written into every worktree so any agent can see what it's working on. */
export const TICKET_FILE_REL = '.sully/ticket.md'

// Planning sessions run headless, so the agent can't ask interactively. This
// contract gives it an escape hatch: stop and write questions instead of
// guessing — a wrong assumption here produces a confidently wrong plan.
const PLAN_QUESTIONS_CONTRACT = `If the ticket is ambiguous in a way that would materially change the plan (unclear requirements, several plausible approaches, missing context you cannot resolve from the codebase or the ticket), do NOT guess and do NOT write ${PLAN_FILE_REL}. Instead write your blocking questions as JSON to ${PLAN_QUESTIONS_FILE_REL} (create directories as needed) and stop: an array where each element has "question" (one specific question), "context" (brief — what you found and why the answer changes the plan), and optionally "options" (2-4 plausible answers). The file must contain only valid JSON — no code fences or surrounding prose. The user's answers arrive in a follow-up turn. Only ask questions whose answers change the plan; resolve everything else from the codebase yourself.`

// Replies are shown in the app's ticket chat, possibly to non-engineers, so
// they must read like a teammate's quick update, not an engineering report.
const REPLY_STYLE =
  'The reply is shown to the person who left the feedback: keep it brief and to the point — a few plain sentences covering only what they need to know (what changed and anything that affects them). No headings, no code blocks, no file paths, no root-cause essays, no verification or test logs.'

// Built-in prompts are skill-free so the app works for teammates without
// custom Claude skills installed. A configured `skill` replaces the lead-in.

// Reprompts run while a human is reviewing the PR — they may have pushed
// commits or rebased the branch, so a naive push would reject or build on
// stale code. Every reprompt syncs with origin first.
const SYNC_BRANCH = (branch: string): string =>
  `Before changing anything, run git fetch origin and, if origin/${branch} has commits you don't have locally, integrate them (rebase onto origin/${branch}, or merge if rebase conflicts). If your push is rejected, fetch and rebase onto origin/${branch}, then push again. Never force-push.`

// The user's per-phase injected prompt leads every session prompt (initial,
// resume, and chat turns) so context like sibling repo paths is always present.
function withInjected(config: PhaseConfig, prompt: string): string {
  const injected = config.injectedPrompt?.trim()
  return injected ? `${injected}\n\n${prompt}` : prompt
}

function claudeArgs(config: PhaseConfig, prompt: string, extra: string[] = []): string[] {
  const bin = binaryPath('claude')
  if (!bin) throw new Error('claude CLI not found')
  const args = [
    bin,
    '-p',
    withInjected(config, prompt),
    '--output-format',
    'stream-json',
    '--verbose'
  ]
  if (config.permissionMode === 'bypass') args.push('--dangerously-skip-permissions')
  else args.push('--permission-mode', 'acceptEdits')
  if (config.model) args.push('--model', config.model)
  if (config.maxBudgetUsd && config.maxBudgetUsd > 0)
    args.push('--max-budget-usd', String(config.maxBudgetUsd))
  // MCP servers' tool schemas are a fixed input-token tax on every turn, so
  // phases load none (false) or a picked subset (array) instead of all
  if (config.mcp === false) args.push('--strict-mcp-config')
  else if (Array.isArray(config.mcp)) {
    args.push('--strict-mcp-config')
    const file = subsetMcpConfigFile(config.mcp)
    if (file) args.push('--mcp-config', file)
  }
  args.push(...extra)
  return args
}

function codexArgs(config: PhaseConfig, prompt: string, cwd: string): string[] {
  const bin = binaryPath('codex')
  if (!bin) throw new Error('codex CLI not found')
  const args = [
    bin,
    'exec',
    '--cd',
    cwd,
    '--sandbox',
    'workspace-write',
    '--skip-git-repo-check',
    '--json'
  ]
  if (config.model) args.push('-m', config.model)
  args.push(withInjected(config, prompt))
  return args
}

/** Prior in-app chat turns, so follow-up questions keep their context. */
function historyBlock(history: ChatMessage[] | undefined): string {
  if (!history?.length) return ''
  const lines = history
    .slice(-10)
    .map((m) => `${m.role === 'user' ? 'User' : 'You'}: ${m.text.slice(0, 1500)}`)
  return `Earlier conversation for context (oldest first):\n"""\n${lines.join('\n\n')}\n"""\n\n`
}

function ticketContext(issue: TrackedIssue, description: string | undefined): string {
  return [
    `Ticket: ${issue.identifier} — ${issue.title}`,
    issue.url
      ? `Ticket URL: ${issue.url}`
      : 'Local ticket — exists only in Sully, there is no Linear issue for it.',
    `Branch: ${issue.branchName} (already checked out in this worktree)`,
    description ? `\nTicket description:\n${description}` : ''
  ]
    .filter(Boolean)
    .join('\n')
}

/** "ENG-123 (https://…)" for Linear tickets, plain "LOC-4" for local ones. */
function ticketRef(issue: TrackedIssue): string {
  return issue.url ? `${issue.identifier} (${issue.url})` : issue.identifier
}

export function buildPlanningCommand(
  config: PhaseConfig,
  issue: TrackedIssue,
  description: string | undefined,
  worktreePath: string,
  rewriteInstructions?: string
): string[] {
  const context = ticketContext(issue, description)
  const nonInteractive = `Run fully non-interactively: never wait for confirmation or ask by printing text — ${PLAN_QUESTIONS_FILE_REL} is the only channel for questions.`
  // set (possibly empty) only when the user explicitly asked for a rewrite of
  // an existing plan — the old plan file is still in the worktree and must not
  // seed the new one
  const rewrite =
    rewriteInstructions !== undefined
      ? `A previous plan for this ticket was rejected by the user. Write a completely new plan from scratch — do not reuse or anchor on the existing content of ${PLAN_FILE_REL}; overwrite it.${rewriteInstructions ? `\nThe user's direction for the new plan:\n${rewriteInstructions}` : ''}\n\n`
      : ''

  if (config.agent === 'codex') {
    const prompt = `${rewrite}Explore this codebase and produce a detailed implementation plan for the ticket below. Write the final plan as markdown to ${PLAN_FILE_REL} (create directories as needed). The plan must include: context, files to change, step-by-step implementation, and a verification section. Do NOT implement anything yet.\n\n${context}\n\n${PLAN_QUESTIONS_CONTRACT}\n${nonInteractive}`
    return codexArgs(config, prompt, worktreePath)
  }

  const lead = config.skill
    ? `${config.skill}\n\n`
    : `Explore this codebase and produce a detailed implementation plan for the ticket below. Do NOT implement anything yet.\n\n`
  // the rewrite note goes after the lead — a configured skill's slash command
  // must stay at the very start of the prompt to trigger
  const prompt = `${lead}${rewrite}${context}\n\nWhen the plan is final, also write it as markdown to ${PLAN_FILE_REL} in this worktree (create directories as needed). It must include: context, files to change, step-by-step implementation, and a verification section.\n${PLAN_QUESTIONS_CONTRACT}\n${nonInteractive}`
  return claudeArgs(config, prompt, ['--add-dir', worktreePath])
}

/**
 * Retry or re-plan on a resumed planning conversation: the session already
 * holds the explored codebase context, so this skips re-exploration entirely.
 */
export function buildPlanningResumeCommand(
  config: PhaseConfig,
  issue: TrackedIssue,
  resumeId: string
): string[] {
  const prompt = [
    'Plan this ticket again: the previous planning session ended early, or the user asked for a fresh plan. Re-read the ticket below — it may have been edited since.',
    ticketContext(issue, issue.description),
    `Write the final plan as markdown to ${PLAN_FILE_REL} (create directories as needed), replacing any existing content. It must include: context, files to change, step-by-step implementation, and a verification section. Do NOT implement anything.`,
    PLAN_QUESTIONS_CONTRACT,
    `Run fully non-interactively: never wait for confirmation or ask by printing text — ${PLAN_QUESTIONS_FILE_REL} is the only channel for questions.`
  ].join('\n\n')
  return claudeArgs(config, prompt, ['--resume', resumeId])
}

/**
 * The planning session stopped with blocking questions; the user answered them
 * in the app. Resume the planning conversation (the explored context is
 * already there) — or start fresh with the Q&A inlined when no transcript is
 * resumable — and finish the plan, or ask again if new blockers surface.
 */
export function buildPlanAnswersCommand(
  config: PhaseConfig,
  issue: TrackedIssue,
  qa: Array<{ question: string; answer: string }>,
  worktreePath: string,
  resumeId?: string
): string[] {
  const answers = qa.map((x) => `Q: ${x.question}\nA: ${x.answer}`).join('\n\n')
  const finish = [
    `Now write the final plan as markdown to ${PLAN_FILE_REL} (create directories as needed), replacing any existing content. It must include: context, files to change, step-by-step implementation, and a verification section. Do NOT implement anything.`,
    `Only if a NEW blocking ambiguity remains that these answers do not resolve: write it as JSON to ${PLAN_QUESTIONS_FILE_REL} (same shape as before: array of {"question", "context", "options"}, valid JSON only) instead of writing the plan, and stop. Never re-ask a question that was just answered.`,
    `Run fully non-interactively: never wait for confirmation or ask by printing text — ${PLAN_QUESTIONS_FILE_REL} is the only channel for questions.`
  ]

  if (resumeId) {
    const prompt = [
      `You paused planning with blocking questions in ${PLAN_QUESTIONS_FILE_REL}. The user answered:`,
      answers,
      ...finish
    ].join('\n\n')
    return claudeArgs(config, prompt, ['--resume', resumeId])
  }

  const prompt = [
    'A previous planning session for the ticket below paused with blocking questions instead of writing a plan. The user answered:',
    answers,
    ticketContext(issue, issue.description),
    'Explore this codebase as needed.',
    ...finish
  ].join('\n\n')
  if (config.agent === 'codex') return codexArgs(config, prompt, worktreePath)
  return claudeArgs(config, prompt, ['--add-dir', worktreePath])
}

export function buildPlanFeedbackCommand(
  config: PhaseConfig,
  issue: TrackedIssue,
  comments: string[],
  worktreePath: string,
  history?: ChatMessage[]
): string[] {
  const quoted = comments.map((c) => `"""\n${c}\n"""`).join('\n\n')
  const task = [
    historyBlock(history) +
      `You previously wrote the implementation plan at ${PLAN_FILE_REL} for the ticket below. The user left ${comments.length === 1 ? 'this comment' : 'these comments'} on the plan:`,
    '',
    quoted,
    '',
    'Read the plan, explore the codebase as needed, and decide whether the user is asking a question about the plan or requesting a change to it.',
    `- If they request a change: edit ${PLAN_FILE_REL} accordingly (keep its structure: context, files to change, step-by-step implementation, verification), and write a one-line note of what changed to ${FEEDBACK_REPLY_FILE_REL}.`,
    `- If they are asking a question: do NOT modify ${PLAN_FILE_REL}; write your answer to ${FEEDBACK_REPLY_FILE_REL}.`,
    REPLY_STYLE,
    'Do NOT implement anything.',
    '',
    ticketContext(issue, issue.description),
    '',
    'Run fully non-interactively: never ask questions or wait for confirmation.'
  ].join('\n')

  if (config.agent === 'codex') return codexArgs(config, task, worktreePath)
  return claudeArgs(config, task, ['--add-dir', worktreePath])
}

/**
 * Follow-up chat turn on a resumed claude conversation: the session already
 * carries the explored context, so the prompt only restates the file contract.
 */
export function buildPlanChatResumeCommand(
  config: PhaseConfig,
  message: string,
  resumeId: string
): string[] {
  const prompt = [
    'The user replied in the plan conversation:',
    `"""\n${message}\n"""`,
    `Re-read ${PLAN_FILE_REL} first — the user may have edited it. Same rules as before: if they request a change, edit ${PLAN_FILE_REL} (keep its structure) and write a one-line note of what changed to ${FEEDBACK_REPLY_FILE_REL}; if they ask a question, do NOT modify the plan and write your answer to ${FEEDBACK_REPLY_FILE_REL}. Do NOT implement anything.`,
    REPLY_STYLE,
    'Run fully non-interactively: never ask questions or wait for confirmation.'
  ].join('\n\n')
  return claudeArgs(config, prompt, ['--resume', resumeId])
}

/** Follow-up chat turn on a resumed reprompt conversation. */
export function buildRepromptResumeCommand(
  config: PhaseConfig,
  issue: TrackedIssue,
  message: string,
  resumeId: string
): string[] {
  const prompt = [
    'The user replied in the conversation about this ticket:',
    `"""\n${message}\n"""`,
    `Re-read any relevant code first — it may have changed since. Same rules as before: if they request a change, implement it in this worktree, verify your work, commit and push the branch "${issue.branchName}" to origin, then write your reply to ${FEEDBACK_REPLY_FILE_REL}. ${SYNC_BRANCH(issue.branchName)} Never commit the .sully directory. If it is a question, do NOT change any code and write your answer to ${FEEDBACK_REPLY_FILE_REL}.`,
    REPLY_STYLE,
    'Run fully non-interactively: never ask questions or wait for confirmation.'
  ].join('\n\n')
  return claudeArgs(config, prompt, ['--resume', resumeId])
}

export function buildRepromptCommand(
  config: PhaseConfig,
  issue: TrackedIssue,
  comments: string[],
  worktreePath: string,
  history?: ChatMessage[]
): string[] {
  const quoted = comments.map((c) => `"""\n${c}\n"""`).join('\n\n')
  const task = [
    historyBlock(history) +
      `The implementation for the ticket below is complete and under review${issue.prUrl ? ` (PR: ${issue.prUrl})` : ''}. The user left ${comments.length === 1 ? 'this follow-up comment' : 'these follow-up comments'} on the ticket:`,
    '',
    quoted,
    '',
    `Read the current code on this branch (the approved plan, if present, is at ${PLAN_FILE_REL}) and decide whether the comment requests a change to the code or asks a question.`,
    `- If it requests a change: implement it in this worktree, verify your work (typecheck/lint/tests where available), commit in logical commits with clear messages, and push the branch "${issue.branchName}" to origin so the existing pull request picks it up. ${SYNC_BRANCH(issue.branchName)} Never commit the .sully directory. Then write your reply to ${FEEDBACK_REPLY_FILE_REL}.`,
    `- If it is a question: do NOT change any code; write your answer to ${FEEDBACK_REPLY_FILE_REL}.`,
    REPLY_STYLE,
    '',
    ticketContext(issue, issue.description),
    '',
    'Run fully non-interactively: never ask questions or wait for confirmation.'
  ].join('\n')

  if (config.agent === 'codex') return codexArgs(config, task, worktreePath)
  return claudeArgs(config, task)
}

export function buildCodingCommand(
  config: PhaseConfig,
  issue: TrackedIssue,
  worktreePath: string
): string[] {
  // committing/pushing/PR creation belongs to the dedicated create-pr phase
  const finish =
    'Do NOT commit, push, or open a pull request — leave the changes in the working tree; a follow-up step handles that.'
  const nonInteractive =
    'Run fully non-interactively: never ask questions or wait for confirmation.'

  if (config.agent === 'codex') {
    const prompt = `Implement the approved plan at ${PLAN_FILE_REL} for ticket ${ticketRef(issue)}. Follow the plan closely and verify your work (typecheck/lint/tests where available). ${finish}\n${nonInteractive}`
    return codexArgs(config, prompt, worktreePath)
  }

  const lead = config.skill ? `${config.skill}\n\n` : ''
  const prompt = `${lead}Implement the approved plan at ${PLAN_FILE_REL} for ticket ${ticketRef(issue)}. Follow the plan closely and verify your work (typecheck/lint/tests where available).\n${finish}\n${nonInteractive}`
  return claudeArgs(config, prompt)
}

/**
 * Retry on a resumed coding conversation: the worktree may hold partial work
 * from the failed/stopped/timed-out attempt, and the session already knows the
 * codebase — assess what exists and continue rather than redoing everything.
 */
export function buildCodingResumeCommand(
  config: PhaseConfig,
  issue: TrackedIssue,
  resumeId: string
): string[] {
  const prompt = [
    `The previous coding session for ticket ${issue.identifier} ended early (stopped, failed, or timed out), so the worktree may hold partial work. Run git status and git diff to assess what already exists, then continue implementing the approved plan at ${PLAN_FILE_REL} from where it left off. Verify your work (typecheck/lint/tests where available).`,
    'Do NOT commit, push, or open a pull request — leave the changes in the working tree; a follow-up step handles that.',
    'Run fully non-interactively: never ask questions or wait for confirmation.'
  ].join('\n')
  return claudeArgs(config, prompt, ['--resume', resumeId])
}

export function buildCreatePrCommand(
  config: PhaseConfig,
  issue: TrackedIssue,
  worktreePath: string,
  draft: boolean,
  baseBranch?: string
): string[] {
  const prTitle = `${issue.identifier}: ${issue.title}`
  const draftNote = draft ? ' Create the pull request as a draft (gh pr create --draft).' : ''
  // repos with a configured base (e.g. develop) must not get PRs against the
  // repo default — the diff would be wrong and inflated
  const baseFlag = baseBranch ? ` --base ${baseBranch}` : ''
  const baseNote = baseBranch ? ` against the "${baseBranch}" base branch` : ''
  const builtin = `Ship the implemented work in this worktree as a pull request: review the changes, commit them in logical commits with clear messages, push the branch "${issue.branchName}" to origin, and create a GitHub pull request${baseNote} titled "${prTitle}" with a clear description${issue.url ? ` that links ${issue.url}` : ''}. Use the gh CLI (gh pr create${baseFlag}).${draftNote}`
  const nonInteractive =
    'Run fully non-interactively: never ask questions or wait for confirmation.'

  if (config.agent === 'codex') {
    return codexArgs(config, `${builtin}\n${nonInteractive}`, worktreePath)
  }

  const prompt = config.skill
    ? `${config.skill} ${PLAN_FILE_REL}\n\nTicket: ${prTitle}\n${issue.url ? `Ticket URL: ${issue.url}` : 'Local ticket — no Linear issue to link.'}\nBranch: ${issue.branchName} (already checked out in this worktree)\nPlan file: ${PLAN_FILE_REL}\n${baseBranch ? `Base branch: open the PR against "${baseBranch}".\n` : ''}${draftNote ? `${draftNote.trim()}\n` : ''}${nonInteractive}`
    : `${builtin}\n${nonInteractive}`
  return claudeArgs(config, prompt)
}

/**
 * Manual "Commit & push" from the ticket details: ship whatever sits
 * uncommitted in the worktree (manual edits, a stopped session's leftovers)
 * to the ticket's branch on origin — no PR creation, no ticket movement.
 */
export function buildCommitPushCommand(
  config: PhaseConfig,
  issue: TrackedIssue,
  worktreePath: string
): string[] {
  const builtin = `This worktree for ticket ${ticketRef(issue)} has uncommitted local changes. Review them (git status, git diff), commit them in logical commits with clear messages, and push the branch "${issue.branchName}" to origin. ${SYNC_BRANCH(issue.branchName)} Never commit the .sully directory. Do NOT open a pull request.`
  const nonInteractive =
    'Run fully non-interactively: never ask questions or wait for confirmation.'

  if (config.agent === 'codex') {
    return codexArgs(config, `${builtin}\n${nonInteractive}`, worktreePath)
  }

  const prompt = config.skill
    ? `${config.skill}\n\n${builtin}\n${nonInteractive}`
    : `${builtin}\n${nonInteractive}`
  return claudeArgs(config, prompt)
}

export function buildErrorInvestigationCommand(
  config: PhaseConfig,
  error: ErrorTrackingIssue,
  source: ErrorSource,
  repoPath: string
): string[] {
  const context = [
    `Error (from PostHog error tracking, ${source}): ${error.type}`,
    `Message: ${error.message || '(no message)'}`,
    `Impact: ${error.occurrences} occurrences across ${error.users} users in the queried window`,
    error.firstSeen ? `First seen (within that window): ${error.firstSeen}` : '',
    error.lastSeen ? `Last seen: ${error.lastSeen}` : '',
    `PostHog issue: ${error.url}`
  ]
    .filter(Boolean)
    .join('\n')

  const task = [
    'Investigate this production error and find its root cause in this codebase.',
    '',
    context,
    '',
    'Timing is a key clue: the regression likely shipped just before the first occurrence. Use git log / git blame around that date (e.g. `git log --until=<first seen> -20`) to see what changed, and correlate suspicious commits with the error.',
    'Locate the code that throws, then report: the root cause, the exact files and lines involved, the commit or PR that likely introduced it (if identifiable), and a proposed minimal fix.',
    'This is an investigation only — do NOT change any code, commit, or push.',
    'Run fully non-interactively: never ask questions or wait for confirmation.'
  ].join('\n')

  if (config.agent === 'codex') return codexArgs(config, task, repoPath)
  const prompt = config.skill ? `${config.skill}\n\n${task}` : task
  return claudeArgs(config, prompt)
}

// Below this many changed lines the review skill's multi-agent pipeline
// (~25 sessions per run) costs dollars without finding more than a single
// session would — use the plain one-session prompt instead.
export const SKILL_REVIEW_MIN_CHANGED_LINES = 300

export function buildReviewCommand(
  config: PhaseConfig,
  prUrl: string,
  changedLines?: number
): string[] {
  if (config.agent === 'codex') {
    const prompt = `Review the GitHub pull request ${prUrl}. Check out the PR locally (gh pr checkout), read the diff carefully, and look for real bugs, security issues, and correctness problems. Then post your review on GitHub via the gh CLI.`
    return codexArgs(config, prompt, process.cwd())
  }
  // Unknown diff size (API hiccup) keeps the configured skill: degrading
  // review depth silently is worse than occasionally overpaying.
  const useSkill =
    Boolean(config.skill) &&
    !(changedLines !== undefined && changedLines < SKILL_REVIEW_MIN_CHANGED_LINES)
  const prompt = useSkill
    ? `${config.skill} ${prUrl}`
    : `Review the GitHub pull request ${prUrl}. Read the full diff (gh pr diff) and the changed files for context. Look for real bugs, security issues, and correctness problems — not style nits. Then post your review on GitHub via the gh CLI (gh pr review).`
  return claudeArgs(config, prompt)
}
