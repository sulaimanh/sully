import { linearRequest } from './client'
import type {
  CreateIssueInput,
  CreatedIssue,
  IssueCreateMeta,
  LinearLabel,
  LinearMember,
  LinearProject,
  LinearTeam,
  LinearViewer,
  LinearWorkflowState
} from '../../shared/types'

export interface LinearIssueNode {
  id: string
  identifier: string
  title: string
  description?: string
  url: string
  branchName: string
  updatedAt: string
  team: { id: string; key: string }
  project?: { id: string; name: string }
  state: { id: string; name: string }
  labels: { nodes: Array<{ name: string }> }
}

export async function fetchViewer(): Promise<LinearViewer> {
  const data = await linearRequest<{ viewer: LinearViewer }>(
    `query Viewer { viewer { id name email } }`
  )
  return data.viewer
}

export async function fetchTeams(): Promise<LinearTeam[]> {
  const data = await linearRequest<{ teams: { nodes: LinearTeam[] } }>(
    `query Teams { teams(first: 50) { nodes { id key name } } }`
  )
  return data.teams.nodes
}

export async function fetchWorkflowStates(teamId: string): Promise<LinearWorkflowState[]> {
  const data = await linearRequest<{
    team: { states: { nodes: LinearWorkflowState[] } }
  }>(
    `query WorkflowStates($teamId: String!) {
      team(id: $teamId) { states { nodes { id name type position color } } }
    }`,
    { teamId }
  )
  return [...data.team.states.nodes].sort((a, b) => a.position - b.position)
}

/**
 * Single poll query: all mapped states at once, only issues assigned to the
 * viewer, optionally gated on a label (per-ticket opt-in to orchestration).
 */
export async function fetchIssuesInStates(
  stateIds: string[],
  requiredLabel?: string
): Promise<LinearIssueNode[]> {
  if (stateIds.length === 0) return []
  const label = requiredLabel?.trim()
  const labelFilter = label ? ', labels: { some: { name: { eqIgnoreCase: $label } } }' : ''
  const data = await linearRequest<{ issues: { nodes: LinearIssueNode[] } }>(
    `query IssuesInStates($stateIds: [ID!]${label ? ', $label: String!' : ''}) {
      issues(
        filter: { state: { id: { in: $stateIds } }, assignee: { isMe: { eq: true } }${labelFilter} }
        first: 100
      ) {
        nodes {
          id identifier title description url branchName updatedAt
          team { id key }
          project { id name }
          state { id name }
          labels { nodes { name } }
        }
      }
    }`,
    label ? { stateIds, label } : { stateIds }
  )
  return data.issues.nodes
}

/** One round trip for everything the "new ticket" form offers on a team. */
export async function fetchIssueCreateMeta(teamId: string): Promise<IssueCreateMeta> {
  const data = await linearRequest<{
    team: {
      states: { nodes: LinearWorkflowState[] }
      labels: { nodes: LinearLabel[] }
      projects: { nodes: Array<LinearProject & { state: string }> }
      members: { nodes: Array<LinearMember & { active: boolean }> }
    }
    issueLabels: { nodes: LinearLabel[] }
  }>(
    `query IssueCreateMeta($teamId: String!) {
      team(id: $teamId) {
        states { nodes { id name type position color } }
        labels(first: 250) { nodes { id name color } }
        projects(first: 100) { nodes { id name state } }
        members(first: 100) { nodes { id name displayName active } }
      }
      issueLabels(first: 250, filter: { team: { null: true } }) { nodes { id name color } }
    }`,
    { teamId }
  )
  const team = data.team
  const teamLabelIds = new Set(team.labels.nodes.map((l) => l.id))
  return {
    states: [...team.states.nodes].sort((a, b) => a.position - b.position),
    labels: [
      ...team.labels.nodes,
      ...data.issueLabels.nodes.filter((l) => !teamLabelIds.has(l.id))
    ].sort((a, b) => a.name.localeCompare(b.name)),
    projects: team.projects.nodes
      .filter((p) => p.state !== 'completed' && p.state !== 'canceled')
      .map(({ id, name }) => ({ id, name })),
    members: team.members.nodes
      .filter((m) => m.active)
      .map(({ id, name, displayName }) => ({ id, name, displayName }))
  }
}

export async function createIssueLabel(teamId: string, name: string): Promise<LinearLabel> {
  const data = await linearRequest<{ issueLabelCreate: { issueLabel: LinearLabel } }>(
    `mutation CreateIssueLabel($input: IssueLabelCreateInput!) {
      issueLabelCreate(input: $input) { issueLabel { id name color } }
    }`,
    { input: { teamId, name } }
  )
  return data.issueLabelCreate.issueLabel
}

export async function createIssue(input: CreateIssueInput): Promise<CreatedIssue> {
  const labelIds = [...input.labelIds]
  for (const name of input.ensureLabelNames ?? []) {
    labelIds.push((await createIssueLabel(input.teamId, name)).id)
  }
  const gqlInput: Record<string, unknown> = {
    teamId: input.teamId,
    title: input.title,
    ...(input.description?.trim() && { description: input.description }),
    ...(input.stateId && { stateId: input.stateId }),
    ...(input.assigneeId && { assigneeId: input.assigneeId }),
    ...(typeof input.priority === 'number' && { priority: input.priority }),
    ...(labelIds.length > 0 && { labelIds }),
    ...(input.projectId && { projectId: input.projectId })
  }
  const data = await linearRequest<{ issueCreate: { issue: CreatedIssue } }>(
    `mutation CreateIssue($input: IssueCreateInput!) {
      issueCreate(input: $input) { issue { id identifier url } }
    }`,
    { input: gqlInput }
  )
  return data.issueCreate.issue
}

export interface LinearComment {
  id: string
  body: string
  createdAt: string
  parent?: { id: string } | null
  user?: { id: string; name?: string; displayName?: string } | null
}

export async function fetchIssueComments(issueId: string): Promise<LinearComment[]> {
  const data = await linearRequest<{
    issue: { comments: { nodes: LinearComment[] } }
  }>(
    `query IssueComments($issueId: String!) {
      issue(id: $issueId) {
        comments(first: 50) {
          nodes { id body createdAt parent { id } user { id name displayName } }
        }
      }
    }`,
    { issueId }
  )
  return data.issue.comments.nodes
}

/** Post a comment as the API key's user; parentId threads it under a top-level comment. */
export async function postComment(issueId: string, body: string, parentId?: string): Promise<void> {
  await linearRequest(
    `mutation PostComment($issueId: String!, $body: String!${parentId ? ', $parentId: String!' : ''}) {
      commentCreate(input: { issueId: $issueId, body: $body${parentId ? ', parentId: $parentId' : ''} }) { success }
    }`,
    parentId ? { issueId, body, parentId } : { issueId, body }
  )
}

export async function fetchIssueState(issueId: string): Promise<{ id: string; name: string }> {
  const data = await linearRequest<{ issue: { state: { id: string; name: string } } }>(
    `query IssueState($issueId: String!) { issue(id: $issueId) { state { id name } } }`,
    { issueId }
  )
  return data.issue.state
}

export async function moveIssue(issueId: string, stateId: string): Promise<void> {
  await linearRequest(
    `mutation MoveIssue($issueId: String!, $stateId: String!) {
      issueUpdate(id: $issueId, input: { stateId: $stateId }) { success }
    }`,
    { issueId, stateId }
  )
}
