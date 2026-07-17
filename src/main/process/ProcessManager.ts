import { spawn } from 'child_process'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { EventEmitter } from 'events'
import { randomUUID } from 'crypto'
import * as fs from 'fs'
import * as path from 'path'
import type { RateLimitInfo, Session, StreamEvent } from '../../shared/types'
import { LOGS_DIR, SESSIONS_DIR, readJson, writeJsonAtomic } from './../paths'
import { spawnEnv } from '../env'
import { LineBuffer, parseLine } from './stream-json'
import { estimateCostUsd } from '../../shared/pricing'

const pexecFile = promisify(execFile)

export interface SpawnSpec {
  kind: Session['kind']
  agent: Session['agent']
  model?: string
  command: string[] // [binary, ...argv]
  cwd: string
  timeoutMs: number
  issueId?: string
  issueIdentifier?: string
  prUrl?: string
  env?: Record<string, string>
}

interface RunningProcess {
  session: Session
  timeout?: NodeJS.Timeout
  flushTimer?: NodeJS.Timeout
  pendingEvents: StreamEvent[]
}

/**
 * Shared runtime for all headless sessions (planning, coding, PR review).
 * Children run in their own process group so stop() kills the whole tree.
 * Session records are persisted per-status-change for restart reconciliation.
 */
export class ProcessManager extends EventEmitter {
  private running = new Map<string, RunningProcess>()
  private finished = new Map<string, Session>()
  private latestRateLimit?: RateLimitInfo

  rateLimit(): RateLimitInfo | undefined {
    return this.latestRateLimit
  }

  sessions(): Session[] {
    return [
      ...Array.from(this.running.values()).map((r) => r.session),
      ...Array.from(this.finished.values())
    ].sort((a, b) => b.startedAt.localeCompare(a.startedAt))
  }

  get(id: string): Session | undefined {
    return this.running.get(id)?.session ?? this.finished.get(id)
  }

  runningCount(kind?: Session['kind']): number {
    let n = 0
    for (const r of this.running.values()) {
      if (r.session.status !== 'running') continue
      if (!kind || r.session.kind === kind) n++
    }
    return n
  }

  start(spec: SpawnSpec): Session {
    const id = randomUUID()
    const logFile = path.join(LOGS_DIR, `${id}.ndjson`)
    const [bin, ...argv] = spec.command

    const session: Session = {
      id,
      kind: spec.kind,
      issueId: spec.issueId,
      issueIdentifier: spec.issueIdentifier,
      prUrl: spec.prUrl,
      agent: spec.agent,
      model: spec.model,
      command: spec.command,
      cwd: spec.cwd,
      status: 'running',
      logFile,
      startedAt: new Date().toISOString()
    }

    const child = spawn(bin, argv, {
      cwd: spec.cwd,
      env: spawnEnv(spec.env),
      detached: true, // own process group -> tree kill via kill(-pid)
      stdio: ['ignore', 'pipe', 'pipe']
    })
    session.pid = child.pid

    const rp: RunningProcess = { session, pendingEvents: [] }
    this.running.set(id, rp)
    this.persist(session)
    this.emit('session', { ...session })

    const logStream = fs.createWriteStream(logFile, { flags: 'a' })
    const stdoutBuf = new LineBuffer()

    child.stdout.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8')
      logStream.write(text)
      for (const line of stdoutBuf.push(text)) this.handleLine(rp, line)
    })
    child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8')
      logStream.write(text)
      this.queueEvents(rp, [{ kind: 'stderr', text: text.slice(0, 1000), ts: Date.now() }])
    })

    child.on('error', (err) => {
      this.finalize(id, 'error', undefined, err.message)
      logStream.end()
    })
    child.on('exit', (code) => {
      for (const line of stdoutBuf.flush()) this.handleLine(rp, line)
      logStream.end()
      if (this.running.has(id) && rp.session.status === 'running') {
        this.finalize(id, code === 0 ? 'done' : 'error', code ?? undefined)
      }
    })

    rp.timeout = setTimeout(() => {
      if (rp.session.status === 'running') {
        this.killTree(rp.session.pid)
        this.finalize(id, 'timeout')
      }
    }, spec.timeoutMs)

    return { ...session }
  }

  private handleLine(rp: RunningProcess, line: string): void {
    const parsed = parseLine(line)
    if (parsed.costUsd !== undefined) {
      rp.session.costUsd = parsed.costUsd
      rp.session.costIsEstimate = undefined // the CLI's report is authoritative
    }
    if (parsed.numTurns !== undefined) rp.session.numTurns = parsed.numTurns
    if (parsed.agentSessionId) rp.session.agentSessionId = parsed.agentSessionId
    if (parsed.model) rp.session.resolvedModel = parsed.model
    if (
      parsed.rateLimit &&
      parsed.rateLimit.observedAt >= (this.latestRateLimit?.observedAt ?? 0)
    ) {
      this.latestRateLimit = parsed.rateLimit
      this.emit('rateLimit', parsed.rateLimit)
    }
    if (parsed.usage) {
      const u = rp.session.usage ?? { in: 0, out: 0, cacheRead: 0, cacheWrite: 0 }
      u.in += parsed.usage.in
      u.out += parsed.usage.out
      u.cacheRead += parsed.usage.cacheRead
      u.cacheWrite += parsed.usage.cacheWrite
      rp.session.usage = u
    }
    const lastText = [...parsed.events]
      .reverse()
      .find((e) => e.kind === 'text' || e.kind === 'result')
    if (lastText) rp.session.lastText = lastText.text.slice(0, 300)
    this.queueEvents(rp, parsed.events)
  }

  /** Batch output events per 150ms to keep IPC cheap under fast streams. */
  private queueEvents(rp: RunningProcess, events: StreamEvent[]): void {
    if (events.length === 0) return
    rp.pendingEvents.push(...events)
    if (!rp.flushTimer) {
      rp.flushTimer = setTimeout(() => {
        rp.flushTimer = undefined
        const batch = rp.pendingEvents.splice(0, rp.pendingEvents.length)
        if (batch.length) {
          this.emit('output', { sessionId: rp.session.id, events: batch })
          this.emit('session', { ...rp.session })
        }
      }, 150)
    }
  }

  async stop(id: string): Promise<void> {
    const rp = this.running.get(id)
    if (!rp) return
    rp.session.status = 'stopped' // mark first so exit handler doesn't override
    this.killTree(rp.session.pid)
    // grace period, then hard kill
    setTimeout(() => this.killTree(rp.session.pid, 'SIGKILL'), 5000)
    this.finalize(id, 'stopped')
  }

  private killTree(pid?: number, signal: NodeJS.Signals = 'SIGTERM'): void {
    if (!pid) return
    try {
      process.kill(-pid, signal) // negative pid = process group
    } catch {
      try {
        process.kill(pid, signal)
      } catch {
        // already gone
      }
    }
  }

  private finalize(id: string, status: Session['status'], exitCode?: number, error?: string): void {
    const rp = this.running.get(id)
    if (!rp) return
    clearTimeout(rp.timeout)
    if (rp.flushTimer) {
      clearTimeout(rp.flushTimer)
      rp.flushTimer = undefined
      const batch = rp.pendingEvents.splice(0, rp.pendingEvents.length)
      if (batch.length) this.emit('output', { sessionId: id, events: batch })
    }
    rp.session.status = status
    rp.session.exitCode = exitCode
    rp.session.finishedAt = new Date().toISOString()
    if (error) rp.session.lastText = error
    // stopped/timeout/crashed sessions never emit the final cost event —
    // estimate from streamed usage so killed work isn't recorded as $0
    if (rp.session.costUsd === undefined) {
      const est = estimateCostUsd(rp.session)
      if (est !== undefined) {
        rp.session.costUsd = est
        rp.session.costIsEstimate = true
      }
    }
    this.running.delete(id)
    this.finished.set(id, rp.session)
    this.persist(rp.session)
    this.emit('session', { ...rp.session })
    this.emit('finished', { ...rp.session })
  }

  private persist(session: Session): void {
    writeJsonAtomic(path.join(SESSIONS_DIR, `${session.id}.json`), session)
  }

  /**
   * On app start: sessions persisted as running either survived (orphaned —
   * process still alive, we can no longer stream but can still kill) or died
   * while the app was closed (owner reconciles the outcome).
   */
  async reconcileOrphans(): Promise<Session[]> {
    const affected: Session[] = []
    let files: string[] = []
    try {
      files = fs.readdirSync(SESSIONS_DIR).filter((f) => f.endsWith('.json'))
    } catch {
      return affected
    }
    for (const f of files) {
      const session = readJson<Session | null>(path.join(SESSIONS_DIR, f), null)
      if (!session) continue
      if (session.status === 'running' || session.status === 'orphaned') {
        const alive = session.pid ? await this.isOurProcess(session.pid, session.agent) : false
        session.status = alive ? 'orphaned' : 'error'
        if (!alive) {
          session.finishedAt = session.finishedAt ?? new Date().toISOString()
          session.lastText = session.lastText ?? 'process died while app was closed'
        }
        this.persist(session)
        this.finished.set(session.id, session)
        affected.push(session)
      } else {
        this.finished.set(session.id, session)
      }
    }
    this.pruneOldRecords()
    return affected
  }

  /** Guard against pid reuse: only treat the pid as ours if it runs our agent binary. */
  private async isOurProcess(pid: number, agent: string): Promise<boolean> {
    try {
      const { stdout } = await pexecFile('/bin/ps', ['-p', String(pid), '-o', 'command='], {
        timeout: 5000
      })
      return stdout.toLowerCase().includes(agent)
    } catch {
      return false
    }
  }

  stopOrphan(id: string): void {
    const session = this.finished.get(id)
    if (session?.status === 'orphaned' && session.pid) {
      this.killTree(session.pid)
      session.status = 'stopped'
      session.finishedAt = new Date().toISOString()
      this.persist(session)
      this.emit('session', { ...session })
    }
  }

  /** Keep the 200 newest session records + logs. */
  private pruneOldRecords(): void {
    const all = Array.from(this.finished.values()).sort((a, b) =>
      b.startedAt.localeCompare(a.startedAt)
    )
    for (const old of all.slice(200)) {
      this.finished.delete(old.id)
      try {
        fs.rmSync(path.join(SESSIONS_DIR, `${old.id}.json`), { force: true })
        fs.rmSync(old.logFile, { force: true })
      } catch {
        // best effort
      }
    }
  }

  /**
   * Rebuild normalized display events from the on-disk log — for sessions
   * that streamed in a previous app run, where the renderer's in-memory
   * event buffer is empty.
   */
  readEvents(id: string, maxEvents = 2000): StreamEvent[] {
    const session = this.get(id)
    if (!session) return []
    let content: string
    try {
      const stat = fs.statSync(session.logFile)
      // tail the file: display caps at maxEvents anyway, and logs can be huge
      const fromByte = Math.max(0, stat.size - 4 * 1024 * 1024)
      content = this.readLog(id, fromByte).content
    } catch {
      return []
    }
    const events: StreamEvent[] = []
    for (const line of content.split('\n')) {
      events.push(...parseLine(line).events)
    }
    return events.slice(-maxEvents)
  }

  readLog(id: string, fromByte = 0): { content: string; size: number } {
    const session = this.get(id)
    if (!session) return { content: '', size: 0 }
    try {
      const stat = fs.statSync(session.logFile)
      if (fromByte >= stat.size) return { content: '', size: stat.size }
      const fd = fs.openSync(session.logFile, 'r')
      const len = Math.min(stat.size - fromByte, 2 * 1024 * 1024)
      const buf = Buffer.alloc(len)
      fs.readSync(fd, buf, 0, len, fromByte)
      fs.closeSync(fd)
      return { content: buf.toString('utf8'), size: stat.size }
    } catch {
      return { content: '', size: 0 }
    }
  }
}

export const processManager = new ProcessManager()
