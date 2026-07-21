import { spawn } from 'child_process'
import { EventEmitter } from 'events'
import * as fs from 'fs'
import * as path from 'path'
import type { DevServer } from '../../shared/types'
import { LOGS_DIR } from '../paths'
import { spawnEnv } from '../env'

/**
 * One dev environment per ticket, run from the ticket's worktree so the user
 * can manually test the branch. Unlike agent sessions these have no timeout
 * and live until stopped (or the app quits). Not persisted: a dev server dies
 * with the app, so there is nothing to reconcile on restart.
 */
export class DevServerManager extends EventEmitter {
  private servers = new Map<string, DevServer>()

  list(): DevServer[] {
    return Array.from(this.servers.values())
  }

  get(issueId: string): DevServer | undefined {
    return this.servers.get(issueId)
  }

  start(opts: { issueId: string; identifier: string; command: string; cwd: string }): DevServer {
    const existing = this.servers.get(opts.issueId)
    if (existing?.status === 'running') return existing

    const logFile = path.join(LOGS_DIR, `dev-${opts.issueId}.log`)
    const info: DevServer = {
      issueId: opts.issueId,
      identifier: opts.identifier,
      command: opts.command,
      cwd: opts.cwd,
      status: 'running',
      startedAt: new Date().toISOString(),
      logFile
    }

    // shell: dev commands are user-authored strings ("npm run dev", "pnpm dev --port 3001")
    const child = spawn(opts.command, {
      cwd: opts.cwd,
      env: spawnEnv(),
      shell: true,
      detached: true, // own process group -> tree kill via kill(-pid)
      stdio: ['ignore', 'pipe', 'pipe']
    })
    info.pid = child.pid
    this.servers.set(opts.issueId, info)
    this.broadcast()

    const logStream = fs.createWriteStream(logFile) // truncate: one log per run
    const capture = (chunk: Buffer): void => {
      const text = chunk.toString('utf8')
      logStream.write(text)
      info.lastOutput = ((info.lastOutput ?? '') + text).slice(-500)
      if (!info.url) {
        // dev tools print their address with ANSI color codes (vite, next, etc.)
        // eslint-disable-next-line no-control-regex
        const plain = text.replace(/\x1b\[[0-9;]*m/g, '')
        const match = plain.match(/https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0)(?::\d+)?\/?/i)
        if (match) {
          info.url = match[0].replace('0.0.0.0', 'localhost')
          this.broadcast()
        }
      }
    }
    child.stdout?.on('data', capture)
    child.stderr?.on('data', capture)

    child.on('error', (err) => {
      logStream.end()
      info.status = 'error'
      info.lastOutput = err.message
      this.broadcast()
    })
    child.on('exit', (code) => {
      logStream.end()
      if (info.status === 'running') info.status = code === 0 ? 'stopped' : 'error'
      this.broadcast()
    })

    return info
  }

  stop(issueId: string): void {
    const info = this.servers.get(issueId)
    if (!info || info.status !== 'running') return
    info.status = 'stopped' // mark first so the exit handler doesn't flag an error
    this.killTree(info.pid)
    setTimeout(() => this.killTree(info.pid, 'SIGKILL'), 5000)
    this.broadcast()
  }

  /** Kill every running dev server (app quit). */
  stopAll(): void {
    for (const info of this.servers.values()) {
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
    this.emit('updated', this.list())
  }
}

export const devServerManager = new DevServerManager()
