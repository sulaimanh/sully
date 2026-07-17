import { EventEmitter } from 'events'
import type { DoctorReport } from '../shared/types'
import { runQuickChecks } from './doctor'

// Drives the sticky "key tools missing" banner: runs the quick doctor checks
// on launch and every 5 minutes, and pushes the report to the renderer.

const INTERVAL_MS = 5 * 60_000

class ToolHealthMonitor extends EventEmitter {
  private report: DoctorReport | null = null
  private timer: NodeJS.Timeout | null = null
  private inFlight: Promise<DoctorReport> | null = null

  start(): void {
    if (this.timer) return
    void this.runNow()
    this.timer = setInterval(() => void this.runNow(), INTERVAL_MS)
  }

  current(): DoctorReport | null {
    return this.report
  }

  runNow(): Promise<DoctorReport> {
    if (this.inFlight) return this.inFlight
    this.inFlight = (async () => {
      try {
        const checks = await runQuickChecks()
        this.report = { checks, ranAt: new Date().toISOString() }
        this.emit('updated', this.report)
        return this.report
      } finally {
        this.inFlight = null
      }
    })()
    return this.inFlight
  }
}

export const toolHealthMonitor = new ToolHealthMonitor()
