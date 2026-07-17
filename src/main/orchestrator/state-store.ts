import type { TrackedIssue } from '../../shared/types'
import { STATE_FILE, readJson, writeJsonAtomic } from '../paths'

interface StateFile {
  issues: Record<string, TrackedIssue>
}

export class IssueStateStore {
  private issues: Map<string, TrackedIssue>

  constructor() {
    const stored = readJson<StateFile>(STATE_FILE, { issues: {} })
    this.issues = new Map(Object.entries(stored.issues))
  }

  all(): TrackedIssue[] {
    return Array.from(this.issues.values()).sort((a, b) => a.identifier.localeCompare(b.identifier))
  }

  get(issueId: string): TrackedIssue | undefined {
    return this.issues.get(issueId)
  }

  set(issue: TrackedIssue): void {
    issue.updatedAt = new Date().toISOString()
    this.issues.set(issue.issueId, issue)
    this.persist()
  }

  remove(issueId: string): void {
    this.issues.delete(issueId)
    this.persist()
  }

  private persist(): void {
    writeJsonAtomic(STATE_FILE, { issues: Object.fromEntries(this.issues) })
  }
}
