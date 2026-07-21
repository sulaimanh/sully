import { BrowserWindow, dialog, ipcMain, shell } from 'electron'
import * as fs from 'fs'
import type {
  AppSettings,
  BoardColumn,
  CreateIssueInput,
  CredentialStatus,
  ErrorSource,
  ErrorTrackingIssue,
  IssueComment,
  StateSnapshot
} from '../shared/types'
import { IPC } from '../shared/ipc'
import { settingsStore } from './settings'
import {
  getFigmaToken,
  getGhToken,
  getLinearApiKey,
  getPosthogApiKey,
  setCredentials
} from './credentials'
import { fetchErrorIssues } from './posthog/errors'
import { buildErrorInvestigationCommand } from './orchestrator/prompts'
import { orchestrator, resumableSessionId } from './orchestrator/Orchestrator'
import { binaryPath } from './env'
import { ensureWorktree, installDeps, localChangesCount } from './orchestrator/worktrees'
import { prReviewWatcher } from './pr-review/PRReviewWatcher'
import { processManager } from './process/ProcessManager'
import { ptyManager } from './process/PtyManager'
import { devServerManager } from './process/DevServerManager'
import { deployManager } from './process/DeployManager'
import {
  createIssue,
  fetchIssueComments,
  fetchIssueCreateMeta,
  fetchTeams,
  fetchViewer,
  fetchWorkflowStates,
  postComment
} from './linear/operations'
import { ghAuthStatus } from './github/gh'
import { loginMcpServer, runDoctor } from './doctor'
import { toolHealthMonitor } from './tool-health'
import { planUsageMonitor } from './plan-usage'
import { listGlobalSkills } from './skills'
import { listGlobalMcpServerNames } from './mcp'

async function resolveIssueWorktree(
  issueId: string
): Promise<{ issue: ReturnType<typeof orchestrator.issues>[number]; cwd: string }> {
  const issue = orchestrator.issues().find((i) => i.issueId === issueId)
  if (!issue?.repoPath) throw new Error('no repo mapped for this ticket')
  const cwd =
    issue.worktreePath && fs.existsSync(issue.worktreePath)
      ? issue.worktreePath
      : await ensureWorktree(issue.repoPath, issue.branchName)
  return { issue, cwd }
}

function broadcast(channel: string, ...args: unknown[]): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(channel, ...args)
  }
}

async function credentialStatus(): Promise<CredentialStatus> {
  const gh = await ghAuthStatus()
  return {
    linearKeySet: Boolean(getLinearApiKey()),
    ghTokenSet: Boolean(getGhToken()),
    ghCliAuthed: gh.ok,
    figmaTokenSet: Boolean(getFigmaToken()),
    posthogKeySet: Boolean(getPosthogApiKey())
  }
}

async function buildSnapshot(): Promise<StateSnapshot> {
  let viewer: StateSnapshot['viewer']
  if (getLinearApiKey()) {
    try {
      viewer = await fetchViewer()
    } catch {
      viewer = undefined
    }
  }
  return {
    settings: settingsStore.get(),
    issues: orchestrator.issues(),
    sessions: processManager.sessions(),
    reviews: prReviewWatcher.list(),
    devServers: devServerManager.list(),
    deploys: deployManager.list(),
    credentials: await credentialStatus(),
    viewer,
    toolHealth: toolHealthMonitor.current() ?? undefined,
    rateLimit: processManager.rateLimit(),
    planUsage: planUsageMonitor.current() ?? undefined
  }
}

export function registerIpc(): void {
  ipcMain.handle(IPC.getSnapshot, () => buildSnapshot())
  ipcMain.handle(IPC.getSettings, () => settingsStore.get())
  ipcMain.handle(IPC.setSettings, (_e, next: AppSettings) => {
    settingsStore.set(next)
    orchestrator.pollNow()
  })
  ipcMain.handle(
    IPC.setCredentials,
    async (
      _e,
      creds: {
        linearApiKey?: string
        ghToken?: string
        figmaToken?: string
        posthogApiKey?: string
      }
    ) => {
      setCredentials(creds)
      void toolHealthMonitor.runNow() // clear the banner as soon as a fixed key lands
      return credentialStatus()
    }
  )
  ipcMain.handle(IPC.runDoctor, () => runDoctor())
  ipcMain.handle(IPC.toolHealthRun, () => toolHealthMonitor.runNow())
  ipcMain.handle(IPC.linearTeams, () => fetchTeams())
  ipcMain.handle(IPC.linearWorkflowStates, (_e, teamId: string) => fetchWorkflowStates(teamId))
  ipcMain.handle(IPC.linearIssueCreateMeta, (_e, teamId: string) => fetchIssueCreateMeta(teamId))
  ipcMain.handle(IPC.linearCreateIssue, async (_e, input: CreateIssueInput) => {
    const created = await createIssue(input)
    // a ticket created in a mapped column shows on the board without waiting a poll
    orchestrator.pollNow()
    return created
  })
  ipcMain.handle(IPC.linearIssueComments, async (_e, issueId: string): Promise<IssueComment[]> => {
    const comments = await fetchIssueComments(issueId)
    return comments.map((c) => ({
      id: c.id,
      body: c.body,
      createdAt: c.createdAt,
      parentId: c.parent?.id,
      authorName: c.user ? c.user.displayName || c.user.name : undefined
    }))
  })
  ipcMain.handle(IPC.linearPostComment, (_e, issueId: string, body: string, parentId?: string) =>
    postComment(issueId, body, parentId)
  )
  ipcMain.handle(IPC.skillsList, () => listGlobalSkills())
  ipcMain.handle(IPC.mcpServersList, () => listGlobalMcpServerNames())
  ipcMain.handle(IPC.mcpLogin, (_e, name: string) => loginMcpServer(name))

  ipcMain.handle(IPC.orchestratorSetEnabled, (_e, enabled: boolean) => {
    settingsStore.update((s) => {
      s.orchestrator.enabled = enabled
      return s
    })
    if (enabled) orchestrator.pollNow()
  })
  ipcMain.handle(IPC.issueApprovePlan, (_e, issueId: string) => orchestrator.approvePlan(issueId))
  ipcMain.handle(IPC.issueUpdatePlan, (_e, issueId: string, planText: string) =>
    orchestrator.updatePlan(issueId, planText)
  )
  ipcMain.handle(IPC.issuePlanFeedback, (_e, issueId: string, message: string) =>
    orchestrator.planFeedback(issueId, message)
  )
  ipcMain.handle(
    IPC.issueAnswerPlanQuestions,
    (_e, issueId: string, answers: Array<{ id: string; answer: string }>) =>
      orchestrator.answerPlanQuestions(issueId, answers)
  )
  ipcMain.handle(IPC.issueReprompt, (_e, issueId: string, prompt: string) =>
    orchestrator.reprompt(issueId, prompt)
  )
  ipcMain.handle(IPC.issueAddressGhComments, (_e, issueId: string, itemIds: string[]) =>
    orchestrator.addressGhComments(issueId, itemIds)
  )
  ipcMain.handle(IPC.issueRetry, (_e, issueId: string) => orchestrator.retry(issueId))
  ipcMain.handle(IPC.issueLocalChanges, (_e, issueId: string) => {
    const issue = orchestrator.issues().find((i) => i.issueId === issueId)
    if (!issue?.worktreePath || !fs.existsSync(issue.worktreePath)) return 0
    return localChangesCount(issue.worktreePath)
  })
  ipcMain.handle(IPC.issueCommitPush, (_e, issueId: string) => orchestrator.commitPush(issueId))
  ipcMain.handle(IPC.issueMove, (_e, issueId: string, column: BoardColumn) =>
    orchestrator.moveToColumn(issueId, column)
  )

  ipcMain.handle(IPC.sessionStop, async (_e, id: string) => {
    const session = processManager.get(id)
    if (session?.status === 'orphaned') processManager.stopOrphan(id)
    else await processManager.stop(id)
  })
  ipcMain.handle(IPC.sessionReadLog, (_e, id: string, fromByte: number) =>
    processManager.readLog(id, fromByte)
  )
  ipcMain.handle(IPC.sessionReadEvents, (_e, id: string) => processManager.readEvents(id))

  // embedded terminal: ptys live here so they survive renderer reloads
  ipcMain.handle(IPC.termCreate, (_e, cwd?: string) => ptyManager.create(cwd))
  ipcMain.handle(IPC.termCreateForIssue, async (_e, issueId: string) => {
    const existing = ptyManager.findByIssue(issueId, 'shell')
    if (existing) return existing
    const { issue, cwd } = await resolveIssueWorktree(issueId)
    return ptyManager.create(cwd, { issueId, title: issue.identifier })
  })
  // "chat with the agent": a real terminal running interactive claude in the
  // ticket's worktree, resuming the ticket's conversation when its transcript
  // is on this machine (same rule as headless resumes)
  ipcMain.handle(IPC.termCreateAgentForIssue, async (_e, issueId: string) => {
    const existing = ptyManager.findByIssue(issueId, 'agent')
    if (existing) return existing
    const { issue, cwd } = await resolveIssueWorktree(issueId)
    const claude = binaryPath('claude') ?? 'claude'
    const resumeId = resumableSessionId(cwd, issue.chatSessionId)
    const bin = claude.includes(' ') ? JSON.stringify(claude) : claude
    return ptyManager.create(cwd, {
      issueId,
      kind: 'agent',
      title: `${issue.identifier} · claude`,
      initialCommand: resumeId ? `${bin} --resume ${resumeId}` : bin
    })
  })
  // the "new ticket" dialog's terminal: plain interactive claude in the
  // target repo — one per repo, shared with the Terminal view like the issue
  // agent terminals
  ipcMain.handle(IPC.termCreateTicketDraft, (_e, repoPath?: string) => {
    const key = `ticket-draft:${repoPath ?? 'none'}`
    const existing = ptyManager.findByIssue(key, 'agent')
    if (existing) return existing
    const claude = binaryPath('claude') ?? 'claude'
    return ptyManager.create(repoPath, {
      issueId: key,
      kind: 'agent',
      title: 'new ticket · claude',
      initialCommand: claude.includes(' ') ? JSON.stringify(claude) : claude
    })
  })
  ipcMain.handle(IPC.termList, () => ptyManager.list())
  ipcMain.handle(IPC.termBuffer, (_e, id: string) => ptyManager.buffer(id))
  ipcMain.handle(IPC.termKill, (_e, id: string) => ptyManager.kill(id))
  ipcMain.on(IPC.termWrite, (_e, id: string, data: string) => ptyManager.write(id, data))
  ipcMain.on(IPC.termResize, (_e, id: string, cols: number, rows: number) =>
    ptyManager.resize(id, cols, rows)
  )
  // renderer's ⌘W fallback when no terminal pane has focus
  ipcMain.on(IPC.winHide, (e) => BrowserWindow.fromWebContents(e.sender)?.hide())

  ipcMain.handle(IPC.devStart, async (_e, issueId: string) => {
    const issue = orchestrator.issues().find((i) => i.issueId === issueId)
    if (!issue?.repoPath) throw new Error('no repo mapped for this ticket')
    const devCommand = settingsStore
      .get()
      .repoMappings.find((r) => r.repoPath === issue.repoPath)
      ?.devCommand?.trim()
    if (!devCommand) throw new Error('no dev command configured for this repo')
    const cwd =
      issue.worktreePath && fs.existsSync(issue.worktreePath)
        ? issue.worktreePath
        : await ensureWorktree(issue.repoPath, issue.branchName)
    // worktrees created before install-on-create existed may still lack deps
    await installDeps(cwd)
    devServerManager.start({
      issueId,
      identifier: issue.identifier,
      command: devCommand,
      cwd
    })
  })
  ipcMain.handle(IPC.devStop, (_e, issueId: string) => devServerManager.stop(issueId))

  ipcMain.handle(IPC.deployStart, (_e, repoId: string, bump: string) => {
    if (!['patch', 'minor', 'major'].includes(bump)) throw new Error(`invalid bump: ${bump}`)
    const repo = settingsStore.get().repoMappings.find((r) => r.id === repoId)
    const command = repo?.deployCommand?.trim()
    if (!repo || !command) throw new Error('no deploy command configured for this repo')
    deployManager.start({
      repoId,
      label: repo.label,
      command: `git checkout master && git pull --ff-only && ${command} ${bump}`,
      cwd: repo.repoPath
    })
  })
  ipcMain.handle(IPC.deployStop, (_e, repoId: string) => deployManager.stop(repoId))

  ipcMain.handle(IPC.reviewsSetEnabled, (_e, enabled: boolean) =>
    prReviewWatcher.setEnabled(enabled)
  )
  ipcMain.handle(IPC.reviewStop, (_e, key: string) => prReviewWatcher.stopReview(key))
  ipcMain.handle(IPC.reviewRetrigger, (_e, key: string) => prReviewWatcher.retrigger(key))
  ipcMain.handle(IPC.reviewRemove, (_e, key: string) => prReviewWatcher.remove(key))

  ipcMain.handle(IPC.errorsList, (_e, source: ErrorSource, days: number) => {
    if (source !== 'frontend' && source !== 'backend') throw new Error(`invalid source: ${source}`)
    return fetchErrorIssues(source, days)
  })

  ipcMain.handle(IPC.errorsInvestigate, (_e, source: ErrorSource, error: ErrorTrackingIssue) => {
    if (source !== 'frontend' && source !== 'backend') throw new Error(`invalid source: ${source}`)
    const settings = settingsStore.get()
    const repoId =
      source === 'frontend'
        ? settings.errorTracking.frontendRepoId
        : settings.errorTracking.backendRepoId
    // an explicit mapping wins; a single-repo setup needs no configuration
    const repo =
      settings.repoMappings.find((r) => r.id === repoId) ??
      (settings.repoMappings.length === 1 ? settings.repoMappings[0] : undefined)
    if (!repo) {
      throw new Error(
        `no repo mapped for ${source} error investigations — pick one in Settings → Error tracking`
      )
    }
    const config = settings.phases.errorInvestigation
    return processManager.start({
      kind: 'error_investigation',
      agent: config.agent,
      model: config.model,
      command: buildErrorInvestigationCommand(config, error, source, repo.repoPath),
      cwd: repo.repoPath,
      timeoutMs: config.timeoutMs,
      issueIdentifier: error.type
    })
  })

  ipcMain.handle(IPC.pickFolder, async () => {
    const res = await dialog.showOpenDialog({ properties: ['openDirectory'] })
    return res.canceled ? null : res.filePaths[0]
  })
  ipcMain.handle(IPC.openExternal, (_e, url: string) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url)
  })
  ipcMain.handle(IPC.revealFile, (_e, filePath: string) => shell.showItemInFolder(filePath))

  // event fan-out: main-process emitters -> renderer
  settingsStore.on('changed', (s) => broadcast(IPC.evSettingsChanged, s))
  orchestrator.on('issueUpdated', (issue) => broadcast(IPC.evIssueUpdated, issue))
  orchestrator.on('issueRemoved', (issueId) => broadcast(IPC.evIssueRemoved, issueId))
  processManager.on('session', (session) => broadcast(IPC.evSessionUpdated, session))
  processManager.on('output', (payload) => broadcast(IPC.evSessionOutput, payload))
  processManager.on('rateLimit', (info) => broadcast(IPC.evRateLimit, info))
  planUsageMonitor.on('updated', (usage) => broadcast(IPC.evPlanUsage, usage))
  prReviewWatcher.on('updated', (reviews) => broadcast(IPC.evReviewsUpdated, reviews))
  devServerManager.on('updated', (servers) => broadcast(IPC.evDevServersUpdated, servers))
  deployManager.on('updated', (deploys) => broadcast(IPC.evDeploysUpdated, deploys))
  toolHealthMonitor.on('updated', (report) => broadcast(IPC.evToolHealth, report))
  ptyManager.on('data', (payload) => broadcast(IPC.evTermData, payload))
  ptyManager.on('exit', (payload) => broadcast(IPC.evTermExit, payload))
}

export { broadcast, buildSnapshot }
