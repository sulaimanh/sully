import { EventEmitter } from 'events'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import * as pty from 'node-pty'
import { spawnEnv } from '../env'
import type { TerminalInfo } from '../../shared/types'

/** Replayed to the renderer on re-attach (view remount / window reload). */
const SCROLLBACK_BYTES = 200_000

interface Term {
  info: TerminalInfo
  proc: pty.IPty
  buffer: string
}

/**
 * Owns the ptys behind the embedded Terminal view. Ptys live in the main
 * process so they survive renderer reloads and window hides; the renderer
 * attaches by id and replays the scrollback buffer.
 */
class PtyManager extends EventEmitter {
  private terms = new Map<string, Term>()
  private seq = 0

  create(
    cwd?: string,
    opts: {
      issueId?: string
      title?: string
      kind?: 'shell' | 'agent'
      /** typed into the shell right after spawn (the pty buffers it until the shell reads) */
      initialCommand?: string
    } = {}
  ): TerminalInfo {
    const dir = cwd && fs.existsSync(cwd) ? cwd : os.homedir()
    const shell = process.env.SHELL || '/bin/zsh'
    // spawnEnv() may hold undefined values; node-pty requires plain strings
    const env: Record<string, string> = {}
    for (const [k, v] of Object.entries(spawnEnv())) if (v !== undefined) env[k] = v

    const proc = pty.spawn(shell, ['-l'], {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd: dir,
      env
    })
    const id = `term-${++this.seq}-${proc.pid}`
    const info: TerminalInfo = {
      id,
      title: opts.title ?? path.basename(dir),
      cwd: dir,
      shell,
      issueId: opts.issueId,
      kind: opts.kind ?? 'shell'
    }
    if (opts.initialCommand) proc.write(`${opts.initialCommand}\r`)
    const term: Term = { info, proc, buffer: '' }
    this.terms.set(id, term)

    proc.onData((data) => {
      term.buffer = (term.buffer + data).slice(-SCROLLBACK_BYTES)
      this.emit('data', { id, data })
    })
    proc.onExit(({ exitCode }) => {
      this.terms.delete(id)
      this.emit('exit', { id, exitCode })
    })
    return info
  }

  list(): TerminalInfo[] {
    return Array.from(this.terms.values()).map((t) => t.info)
  }

  findByIssue(issueId: string, kind: 'shell' | 'agent'): TerminalInfo | undefined {
    for (const t of this.terms.values())
      if (t.info.issueId === issueId && (t.info.kind ?? 'shell') === kind) return t.info
    return undefined
  }

  buffer(id: string): string {
    return this.terms.get(id)?.buffer ?? ''
  }

  write(id: string, data: string): void {
    this.terms.get(id)?.proc.write(data)
  }

  resize(id: string, cols: number, rows: number): void {
    if (cols < 1 || rows < 1) return
    try {
      this.terms.get(id)?.proc.resize(Math.floor(cols), Math.floor(rows))
    } catch {
      // pty may have exited between the renderer's resize and this call
    }
  }

  kill(id: string): void {
    this.terms.get(id)?.proc.kill()
  }

  killAll(): void {
    for (const t of this.terms.values()) t.proc.kill()
    this.terms.clear()
  }
}

export const ptyManager = new PtyManager()
