import { app, BrowserWindow, Notification } from 'electron'
import { IPC } from '../shared/ipc'
import { settingsStore } from './settings'
import { processManager } from './process/ProcessManager'

export interface NotifyPayload {
  title: string
  body: string
  view?: string
}

export function notify(payload: NotifyPayload): void {
  if (!settingsStore.get().notifications) return
  if (!Notification.isSupported()) return
  const n = new Notification({ title: payload.title, body: payload.body })
  n.on('click', () => {
    const win = BrowserWindow.getAllWindows()[0]
    if (win) {
      win.show()
      win.focus()
      if (payload.view) win.webContents.send(IPC.evNavigate, payload.view)
    }
  })
  n.show()
}

export function updateDockBadge(): void {
  const count = processManager.runningCount()
  app.dock?.setBadge(count > 0 ? String(count) : '')
}
