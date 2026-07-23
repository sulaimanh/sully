import type { TrackedIssue } from '../../shared/types'
import { STATE_FILE, readJson, writeJsonAtomic } from '../paths'

interface StateFile {
  issues: Record<string, TrackedIssue>
  /** monotonic counter behind LOC-<n> identifiers for local-only tickets */
  localSeq?: number
}

export class IssueStateStore {
  private issues: Map<string, TrackedIssue>
  private localSeq: number

  constructor() {
    const stored = readJson<StateFile>(STATE_FILE, { issues: {} })
    this.issues = new Map(Object.entries(stored.issues))
    // older state files predate localSeq — recover it from existing identifiers
    // so a restart never reissues a LOC-<n> that's already on the board
    this.localSeq =
      stored.localSeq ??
      Math.max(
        0,
        ...Array.from(this.issues.values()).map((i) => {
          const m = /^LOC-(\d+)$/.exec(i.identifier)
          return m ? Number(m[1]) : 0
        })
      )
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

  nextLocalSeq(): number {
    this.localSeq += 1
    this.persist()
    return this.localSeq
  }

  private persist(): void {
    writeJsonAtomic(STATE_FILE, {
      issues: Object.fromEntries(this.issues),
      localSeq: this.localSeq
    })
  }
}
