import { EventEmitter } from 'events'
import type { ActiveReview } from '../../shared/types'
import { settingsStore } from '../settings'
import { processManager } from '../process/ProcessManager'
import { buildReviewCommand } from '../orchestrator/prompts'
import { buildRepoMap, findReviewCandidates, prStatus } from '../github/gh'
import { REVIEWS_FILE, REVIEW_ATTEMPTS_FILE, readJson, writeJsonAtomic } from '../paths'

/**
 * TS port of dashboard-skills/dashboard/scripts/watch-pr-reviews.sh.
 * A PR is a candidate when: open, not draft, review requested from me OR I'm
 * assigned, lives in a configured repo, and I haven't reviewed it yet.
 * Success = my review actually landed on GitHub (not just process exit 0).
 */
export class PRReviewWatcher extends EventEmitter {
  private reviews: ActiveReview[] = readJson<ActiveReview[]>(REVIEWS_FILE, [])
  /** url -> head SHA a review was last launched for (landed or not) */
  private attempts: Record<string, string> = readJson<Record<string, string>>(
    REVIEW_ATTEMPTS_FILE,
    {}
  )
  private timer?: NodeJS.Timeout
  private iterating = false

  start(): void {
    this.scheduleNext(3_000)
  }

  list(): ActiveReview[] {
    return [...this.reviews].sort((a, b) => b.startedEpoch - a.startedEpoch)
  }

  setEnabled(enabled: boolean): void {
    settingsStore.update((s) => {
      s.prWatcher.enabled = enabled
      return s
    })
    if (enabled) this.scheduleNext(0)
  }

  /** Re-run a finished review (explicit user action — works with the watcher off). */
  async retrigger(key: string): Promise<void> {
    const row = this.reviews.find((r) => r.key === key)
    if (!row || row.status === 'reviewing') return

    // baseline = my latest review right now, so only a NEW review counts as done
    const [owner, repo] = row.repository.split('/')
    const status = await prStatus(owner, repo, row.number)
    row.baselineReviewAt = status.myReviewSubmittedAt
    this.recordAttempt(row.url, status.headRefOid)

    const settings = settingsStore.get()
    const command = buildReviewCommand(settings.phases.prReview, row.url, status.changedLines)
    const session = processManager.start({
      kind: 'pr_review',
      agent: settings.phases.prReview.agent,
      model: settings.phases.prReview.model,
      command,
      cwd: row.repoPath,
      timeoutMs: settings.prWatcher.timeoutMs,
      prUrl: row.url
    })

    row.sessionId = session.id
    row.status = 'reviewing'
    row.verdict = undefined
    row.error = undefined
    row.merged = false
    row.startedAt = new Date().toISOString()
    row.startedEpoch = Math.floor(Date.now() / 1000)
    row.finishedEpoch = undefined
    this.persist()
  }

  async stopReview(key: string): Promise<void> {
    const row = this.reviews.find((r) => r.key === key)
    if (!row || row.status !== 'reviewing') return
    if (row.sessionId) await processManager.stop(row.sessionId)
    row.status = 'stopped'
    row.error = 'stopped by user'
    row.finishedEpoch = Math.floor(Date.now() / 1000)
    this.persist()
  }

  private scheduleNext(delayMs?: number): void {
    clearTimeout(this.timer)
    const interval = settingsStore.get().prWatcher.intervalMs
    this.timer = setTimeout(() => void this.iterate(), delayMs ?? interval)
  }

  private persist(): void {
    writeJsonAtomic(REVIEWS_FILE, this.reviews)
    this.emit('updated', this.list())
  }

  private recordAttempt(url: string, headSha?: string): void {
    if (!headSha) return
    // delete-then-set keeps insertion order = recency, so trimming drops the
    // oldest (long-closed) PRs first
    delete this.attempts[url]
    this.attempts[url] = headSha
    const keys = Object.keys(this.attempts)
    for (const k of keys.slice(0, Math.max(0, keys.length - 200))) delete this.attempts[k]
    writeJsonAtomic(REVIEW_ATTEMPTS_FILE, this.attempts)
  }

  private async iterate(): Promise<void> {
    if (this.iterating) return
    this.iterating = true
    try {
      const settings = settingsStore.get()
      const nowEpoch = Math.floor(Date.now() / 1000)

      // 1. Reconcile in-flight reviews (runs even when the watcher is toggled
      // off, so already-launched reviews still finalize)
      for (const row of this.reviews) {
        if (row.status !== 'reviewing') continue
        const [owner, repo] = row.repository.split('/')
        const status = await prStatus(owner, repo, row.number)
        const session = row.sessionId ? processManager.get(row.sessionId) : undefined
        const sessionOver = !session || !['running', 'orphaned', 'queued'].includes(session.status)

        // a pre-existing review (before a re-review was triggered) doesn't count
        const reviewLanded =
          status.myReviewState !== 'NONE' &&
          status.myReviewState !== 'PENDING' &&
          (!row.baselineReviewAt || (status.myReviewSubmittedAt ?? '') > row.baselineReviewAt)

        if (reviewLanded) {
          row.status = 'done'
          row.verdict = status.myReviewState
          row.merged = status.merged
          row.finishedEpoch = nowEpoch
          this.emit('notify', {
            title: `Review posted: ${row.repository}#${row.number}`,
            body: `${status.myReviewState} — ${row.title}`.slice(0, 200),
            view: 'reviews'
          })
        } else if (session?.status === 'stopped') {
          row.status = 'stopped'
          row.error = 'stopped by user'
          row.finishedEpoch = nowEpoch
        } else if (session?.status === 'timeout') {
          row.status = 'error'
          row.error = 'timed out'
          row.finishedEpoch = nowEpoch
        } else if (sessionOver) {
          row.status = 'error'
          row.error = 'review did not post'
          row.finishedEpoch = nowEpoch
        }
      }

      // 2. Prune old finished rows
      const retentionSec = settings.prWatcher.retentionMs / 1000
      this.reviews = this.reviews.filter(
        (r) => r.status === 'reviewing' || (r.finishedEpoch ?? 0) > nowEpoch - retentionSec
      )

      // 3. Launch new reviews (only when enabled)
      if (settings.prWatcher.enabled) {
        await this.launchCandidates(nowEpoch)
      }

      this.persist()
    } catch (err) {
      this.emit('error', (err as Error).message)
    } finally {
      this.iterating = false
      this.scheduleNext()
    }
  }

  private async launchCandidates(nowEpoch: number): Promise<void> {
    const settings = settingsStore.get()
    let reviewing = this.reviews.filter((r) => r.status === 'reviewing').length
    if (reviewing >= settings.prWatcher.maxConcurrent) return

    const repoMap = await buildRepoMap(settings.repoMappings.map((r) => r.repoPath))
    if (repoMap.size === 0) return
    const candidates = await findReviewCandidates()

    for (const pr of candidates) {
      if (reviewing >= settings.prWatcher.maxConcurrent) break
      const repoPath = repoMap.get(pr.nameWithOwner)
      if (!repoPath) continue
      if (this.reviews.some((r) => r.url === pr.url)) continue // reviewing or recently finished

      const [owner, repo] = pr.nameWithOwner.split('/')
      const status = await prStatus(owner, repo, pr.number)
      if (status.myReviewState !== 'NONE' && status.myReviewState !== 'PENDING') continue
      // already launched a review for this exact head (it may have failed to
      // post) — don't burn another full run until the PR actually changes
      if (status.headRefOid && this.attempts[pr.url] === status.headRefOid) continue
      this.recordAttempt(pr.url, status.headRefOid)

      const command = buildReviewCommand(settings.phases.prReview, pr.url, status.changedLines)
      const session = processManager.start({
        kind: 'pr_review',
        agent: settings.phases.prReview.agent,
        model: settings.phases.prReview.model,
        command,
        cwd: repoPath,
        timeoutMs: settings.prWatcher.timeoutMs,
        prUrl: pr.url
      })

      this.reviews.push({
        key: `${pr.nameWithOwner}_${pr.number}`.replace(/[^A-Za-z0-9_.-]/g, '_'),
        url: pr.url,
        repository: pr.nameWithOwner,
        number: pr.number,
        title: pr.title,
        author: pr.author,
        repoPath,
        sessionId: session.id,
        status: 'reviewing',
        merged: false,
        startedAt: new Date().toISOString(),
        startedEpoch: nowEpoch
      })
      reviewing++
    }
  }
}

export const prReviewWatcher = new PRReviewWatcher()
