import { BrowserWindow, Menu, Tray, app, nativeImage } from 'electron'
import * as path from 'path'
import { settingsStore } from './settings'
import { orchestrator } from './orchestrator/Orchestrator'
import { prReviewWatcher } from './pr-review/PRReviewWatcher'
import { processManager } from './process/ProcessManager'

let tray: Tray | null = null

function showWindow(): void {
  const win = BrowserWindow.getAllWindows()[0]
  if (win) {
    win.show()
    win.focus()
  }
}

function buildMenu(): Menu {
  const settings = settingsStore.get()
  const running = processManager.runningCount()
  return Menu.buildFromTemplate([
    {
      label: running > 0 ? `${running} session${running === 1 ? '' : 's'} running` : 'Idle',
      enabled: false
    },
    { type: 'separator' },
    {
      label: 'Orchestrator',
      type: 'checkbox',
      checked: settings.orchestrator.enabled,
      click: (item) => {
        settingsStore.update((s) => {
          s.orchestrator.enabled = item.checked
          return s
        })
        if (item.checked) orchestrator.pollNow()
      }
    },
    {
      label: 'Auto PR reviews',
      type: 'checkbox',
      checked: settings.prWatcher.enabled,
      click: (item) => prReviewWatcher.setEnabled(item.checked)
    },
    { type: 'separator' },
    { label: 'Open Sully', click: showWindow },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => {
        app.quit()
      }
    }
  ])
}

export function createTray(): void {
  const icon = nativeImage
    .createFromPath(path.join(__dirname, '../../resources/trayTemplate.png'))
    .resize({ width: 18, height: 18 })
  icon.setTemplateImage(true)
  tray = new Tray(icon)
  tray.setToolTip('Sully')
  refreshTray()
  tray.on('click', () => tray?.popUpContextMenu(buildMenu()))

  settingsStore.on('changed', refreshTray)
  processManager.on('session', refreshTray)
}

export function refreshTray(): void {
  tray?.setContextMenu(buildMenu())
}
