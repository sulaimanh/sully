import { spawn } from 'child_process'
import { EventEmitter } from 'events'
import * as fs from 'fs'
import * as path from 'path'
import type { Deploy } from '../../shared/types'
import { LOGS_DIR } from '../paths'
import { spawnEnv } from '../env'

/**
 * Manual release runs, one per repo, run from the repo root (not a worktree).
 * The user confirms in-app before start, so the release script's own y/n
 * prompt is answered by piping "y" on stdin; stdin then closes so any further
 * unexpected prompt reads EOF and aborts instead of hanging forever.
 * Like dev servers these are not persisted — a deploy dies with the app.
 */
export class DeployManager extends EventEmitter {
  private deploys = new Map<string, Deploy>()
  private flushTimer?: NodeJS.Timeout

  list(): Deploy[] {
    return Array.from(this.deploys.values())
  }

  start(opts: { repoId: string; label: string; command: string; cwd: string }): Deploy {
    const existing = this.deploys.get(opts.repoId)
    if (existing?.status === 'running') return existing

    const logFile = path.join(LOGS_DIR, `deploy-${opts.repoId}.log`)
    const info: Deploy = {
      repoId: opts.repoId,
      label: opts.label,
      command: opts.command,
      cwd: opts.cwd,
      status: 'running',
      startedAt: new Date().toISOString(),
      logFile
    }

    // shell: deploy commands are user-authored strings ("./scripts/release.sh minor")
    const child = spawn(opts.command, {
      cwd: opts.cwd,
      env: spawnEnv(),
      shell: true,
      detached: true, // own process group -> tree kill via kill(-pid)
      stdio: ['pipe', 'pipe', 'pipe']
    })
    info.pid = child.pid
    this.deploys.set(opts.repoId, info)
    this.broadcast()

    child.stdin?.write('y\n')
    child.stdin?.end()

    const logStream = fs.createWriteStream(logFile) // truncate: one log per run
    const capture = (chunk: Buffer): void => {
      const text = chunk.toString('utf8')
      logStream.write(text)
      info.lastOutput = ((info.lastOutput ?? '') + text).slice(-4000)
      this.broadcastThrottled()
    }
    child.stdout?.on('data', capture)
    child.stderr?.on('data', capture)

    child.on('error', (err) => {
      logStream.end()
      info.status = 'error'
      info.lastOutput = err.message
      info.finishedAt = new Date().toISOString()
      this.broadcast()
    })
    child.on('exit', (code) => {
      logStream.end()
      if (info.status === 'running') info.status = code === 0 ? 'done' : 'error'
      info.finishedAt = new Date().toISOString()
      this.broadcast()
    })

    return info
  }

  stop(repoId: string): void {
    const info = this.deploys.get(repoId)
    if (!info || info.status !== 'running') return
    info.status = 'stopped' // mark first so the exit handler doesn't flag an error
    this.killTree(info.pid)
    setTimeout(() => this.killTree(info.pid, 'SIGKILL'), 5000)
    this.broadcast()
  }

  /** Kill every running deploy (app quit). */
  stopAll(): void {
    for (const info of this.deploys.values()) {
      if (info.status !== 'running') continue
      info.status = 'stopped'
      this.killTree(info.pid)
    }
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

  private broadcast(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer)
      this.flushTimer = undefined
    }
    this.emit('updated', this.list())
  }

  /** Batch streamed output per 300ms so a chatty script doesn't flood IPC. */
  private broadcastThrottled(): void {
    if (this.flushTimer) return
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined
      this.emit('updated', this.list())
    }, 300)
  }
}

export const deployManager = new DeployManager()
