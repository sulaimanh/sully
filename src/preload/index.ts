import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { IPC } from '../shared/ipc'
import type {
  ActiveReview,
  AppSettings,
  BoardColumn,
  CreateIssueInput,
  CreatedIssue,
  CredentialStatus,
  Deploy,
  DeployBump,
  DevServer,
  DoctorReport,
  ErrorSource,
  ErrorTrackingIssue,
  IssueCreateMeta,
  LinearTeam,
  LinearWorkflowState,
  PlanUsage,
  RateLimitInfo,
  Session,
  StateSnapshot,
  StreamEvent,
  TerminalInfo,
  TrackedIssue
} from '../shared/types'

function on<T>(channel: string, cb: (payload: T) => void): () => void {
  const listener = (_e: Electron.IpcRendererEvent, payload: T): void => cb(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const api = {
  getSnapshot: (): Promise<StateSnapshot> => ipcRenderer.invoke(IPC.getSnapshot),
  getSettings: (): Promise<AppSettings> => ipcRenderer.invoke(IPC.getSettings),
  setSettings: (s: AppSettings): Promise<void> => ipcRenderer.invoke(IPC.setSettings, s),
  setCredentials: (c: {
    linearApiKey?: string
    ghToken?: string
    figmaToken?: string
    posthogApiKey?: string
  }): Promise<CredentialStatus> => ipcRenderer.invoke(IPC.setCredentials, c),
  runDoctor: (): Promise<DoctorReport> => ipcRenderer.invoke(IPC.runDoctor),
  runToolHealth: (): Promise<DoctorReport> => ipcRenderer.invoke(IPC.toolHealthRun),
  linearTeams: (): Promise<LinearTeam[]> => ipcRenderer.invoke(IPC.linearTeams),
  linearWorkflowStates: (teamId: string): Promise<LinearWorkflowState[]> =>
    ipcRenderer.invoke(IPC.linearWorkflowStates, teamId),
  linearIssueCreateMeta: (teamId: string): Promise<IssueCreateMeta> =>
    ipcRenderer.invoke(IPC.linearIssueCreateMeta, teamId),
  createLinearIssue: (input: CreateIssueInput): Promise<CreatedIssue> =>
    ipcRenderer.invoke(IPC.linearCreateIssue, input),
  listSkills: (): Promise<string[]> => ipcRenderer.invoke(IPC.skillsList),
  listMcpServers: (): Promise<string[]> => ipcRenderer.invoke(IPC.mcpServersList),
  orchestratorSetEnabled: (enabled: boolean): Promise<void> =>
    ipcRenderer.invoke(IPC.orchestratorSetEnabled, enabled),
  approvePlan: (issueId: string): Promise<void> =>
    ipcRenderer.invoke(IPC.issueApprovePlan, issueId),
  updatePlan: (issueId: string, planText: string): Promise<void> =>
    ipcRenderer.invoke(IPC.issueUpdatePlan, issueId, planText),
  planFeedback: (issueId: string, message: string): Promise<void> =>
    ipcRenderer.invoke(IPC.issuePlanFeedback, issueId, message),
  answerPlanQuestions: (
    issueId: string,
    answers: Array<{ id: string; answer: string }>
  ): Promise<void> => ipcRenderer.invoke(IPC.issueAnswerPlanQuestions, issueId, answers),
  repromptIssue: (issueId: string, prompt: string): Promise<void> =>
    ipcRenderer.invoke(IPC.issueReprompt, issueId, prompt),
  fetchGhComments: (issueId: string): Promise<void> =>
    ipcRenderer.invoke(IPC.issueFetchGhComments, issueId),
  addressGhComments: (issueId: string, itemIds: string[]): Promise<void> =>
    ipcRenderer.invoke(IPC.issueAddressGhComments, issueId, itemIds),
  retryIssue: (issueId: string): Promise<void> => ipcRenderer.invoke(IPC.issueRetry, issueId),
  moveIssue: (issueId: string, column: BoardColumn): Promise<void> =>
    ipcRenderer.invoke(IPC.issueMove, issueId, column),
  stopSession: (id: string): Promise<void> => ipcRenderer.invoke(IPC.sessionStop, id),
  readSessionLog: (id: string, fromByte: number): Promise<{ content: string; size: number }> =>
    ipcRenderer.invoke(IPC.sessionReadLog, id, fromByte),
  termCreate: (cwd?: string): Promise<TerminalInfo> => ipcRenderer.invoke(IPC.termCreate, cwd),
  termCreateForIssue: (issueId: string): Promise<TerminalInfo> =>
    ipcRenderer.invoke(IPC.termCreateForIssue, issueId),
  termCreateAgentForIssue: (issueId: string): Promise<TerminalInfo> =>
    ipcRenderer.invoke(IPC.termCreateAgentForIssue, issueId),
  termCreateTicketDraft: (repoPath?: string): Promise<TerminalInfo> =>
    ipcRenderer.invoke(IPC.termCreateTicketDraft, repoPath),
  termList: (): Promise<TerminalInfo[]> => ipcRenderer.invoke(IPC.termList),
  termBuffer: (id: string): Promise<string> => ipcRenderer.invoke(IPC.termBuffer, id),
  termKill: (id: string): Promise<void> => ipcRenderer.invoke(IPC.termKill, id),
  // send (not invoke): keystrokes and resizes are hot paths needing no reply
  termWrite: (id: string, data: string): void => ipcRenderer.send(IPC.termWrite, id, data),
  termResize: (id: string, cols: number, rows: number): void =>
    ipcRenderer.send(IPC.termResize, id, cols, rows),
  hideWindow: (): void => ipcRenderer.send(IPC.winHide),
  startDevServer: (issueId: string): Promise<void> => ipcRenderer.invoke(IPC.devStart, issueId),
  stopDevServer: (issueId: string): Promise<void> => ipcRenderer.invoke(IPC.devStop, issueId),
  startDeploy: (repoId: string, bump: DeployBump): Promise<void> =>
    ipcRenderer.invoke(IPC.deployStart, repoId, bump),
  stopDeploy: (repoId: string): Promise<void> => ipcRenderer.invoke(IPC.deployStop, repoId),
  reviewsSetEnabled: (enabled: boolean): Promise<void> =>
    ipcRenderer.invoke(IPC.reviewsSetEnabled, enabled),
  stopReview: (key: string): Promise<void> => ipcRenderer.invoke(IPC.reviewStop, key),
  retriggerReview: (key: string): Promise<void> => ipcRenderer.invoke(IPC.reviewRetrigger, key),
  listErrors: (source: ErrorSource, days: number): Promise<ErrorTrackingIssue[]> =>
    ipcRenderer.invoke(IPC.errorsList, source, days),
  investigateError: (source: ErrorSource, error: ErrorTrackingIssue): Promise<Session> =>
    ipcRenderer.invoke(IPC.errorsInvestigate, source, error),
  // File.path was removed in Electron 32 — the renderer needs this to resolve dropped files
  pathForFile: (file: File): string => webUtils.getPathForFile(file),
  pickFolder: (): Promise<string | null> => ipcRenderer.invoke(IPC.pickFolder),
  confirmQuit: (): Promise<void> => ipcRenderer.invoke(IPC.quitConfirm),
  openExternal: (url: string): Promise<void> => ipcRenderer.invoke(IPC.openExternal, url),
  revealFile: (path: string): Promise<void> => ipcRenderer.invoke(IPC.revealFile, path),

  onSnapshot: (cb: (s: StateSnapshot) => void) => on(IPC.evSnapshot, cb),
  onIssueUpdated: (cb: (i: TrackedIssue) => void) => on(IPC.evIssueUpdated, cb),
  onIssueRemoved: (cb: (issueId: string) => void) => on(IPC.evIssueRemoved, cb),
  onSessionUpdated: (cb: (s: Session) => void) => on(IPC.evSessionUpdated, cb),
  onSessionOutput: (cb: (p: { sessionId: string; events: StreamEvent[] }) => void) =>
    on(IPC.evSessionOutput, cb),
  onReviewsUpdated: (cb: (r: ActiveReview[]) => void) => on(IPC.evReviewsUpdated, cb),
  onDevServersUpdated: (cb: (d: DevServer[]) => void) => on(IPC.evDevServersUpdated, cb),
  onDeploysUpdated: (cb: (d: Deploy[]) => void) => on(IPC.evDeploysUpdated, cb),
  onSettingsChanged: (cb: (s: AppSettings) => void) => on(IPC.evSettingsChanged, cb),
  onToolHealth: (cb: (r: DoctorReport) => void) => on(IPC.evToolHealth, cb),
  onRateLimit: (cb: (info: RateLimitInfo) => void) => on(IPC.evRateLimit, cb),
  onPlanUsage: (cb: (usage: PlanUsage) => void) => on(IPC.evPlanUsage, cb),
  onNavigate: (cb: (view: string) => void) => on(IPC.evNavigate, cb),
  onTermData: (cb: (p: { id: string; data: string }) => void) => on(IPC.evTermData, cb),
  onTermExit: (cb: (p: { id: string; exitCode: number }) => void) => on(IPC.evTermExit, cb),
  onCloseShortcut: (cb: () => void) => on(IPC.evCloseShortcut, cb),
  onBrowserShortcut: (cb: () => void) => on(IPC.evBrowserShortcut, cb),
  onSidebarShortcut: (cb: () => void) => on(IPC.evSidebarShortcut, cb),
  onNewTabShortcut: (cb: () => void) => on(IPC.evNewTabShortcut, cb),
  onConfirmQuit: (cb: () => void) => on(IPC.evConfirmQuit, cb)
}

export type SullyApi = typeof api

contextBridge.exposeInMainWorld('sully', api)
