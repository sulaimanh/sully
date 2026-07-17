import { app, shell, BrowserWindow, ipcMain } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { IPC } from '../shared/ipc'
import { ensureDirs } from './paths'
import { initEnv } from './env'
import { registerIpc } from './ipc'
import { createTray } from './tray'
import { notify, updateDockBadge, type NotifyPayload } from './notifications'
import { orchestrator } from './orchestrator/Orchestrator'
import { prReviewWatcher } from './pr-review/PRReviewWatcher'
import { processManager } from './process/ProcessManager'
import { ptyManager } from './process/PtyManager'
import { devServerManager } from './process/DevServerManager'
import { deployManager } from './process/DeployManager'
import { toolHealthMonitor } from './tool-health'
import { planUsageMonitor } from './plan-usage'
import { settingsStore } from './settings'
import appIcon from '../../resources/icon.png?asset'

let quitting = false
// every quit path (⌘Q, menu, tray, dock) must be confirmed in the renderer first
let quitConfirmed = false

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 960,
    minHeight: 620,
    show: false,
    title: 'Sully',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 18, y: 18 },
    // matches --color-ink-950 for each theme so the window doesn't flash on launch
    backgroundColor: settingsStore.get().theme === 'light' ? '#f6f2e9' : '#0e0d0b',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      // the embedded browser panel renders sites in a <webview>
      webviewTag: true
    }
  })

  win.on('ready-to-show', () => win.show())

  // closing the window asks first — the renderer offers hide-to-tray or quit
  win.on('close', (e) => {
    if (!quitting) {
      e.preventDefault()
      win.webContents.send(IPC.evConfirmQuit)
    }
  })

  // ⌘W: the default menu's Close would hide the window before the renderer
  // sees the key. Intercept it and let the renderer decide — close the focused
  // terminal pane, or hide the window when no terminal has focus.
  win.webContents.on('before-input-event', (e, input) => {
    if (input.type !== 'keyDown' || !input.meta || input.control || input.alt) return
    const key = input.key.toLowerCase()
    if (!input.shift && key === 'w') {
      e.preventDefault()
      win.webContents.send(IPC.evCloseShortcut)
    }
    if (input.shift && key === 'b') {
      e.preventDefault()
      win.webContents.send(IPC.evBrowserShortcut)
    }
    if (!input.shift && key === 'b') {
      e.preventDefault()
      win.webContents.send(IPC.evSidebarShortcut)
    }
    if (!input.shift && key === 't') {
      e.preventDefault()
      win.webContents.send(IPC.evNewTabShortcut)
    }
  })

  win.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // browser-panel guests never get node access or the app preload
  win.webContents.on('will-attach-webview', (_e, webPreferences) => {
    delete webPreferences.preload
    webPreferences.nodeIntegration = false
    webPreferences.contextIsolation = true
  })

  if (is.dev && process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }
  return win
}

app.setName('Sully')

app.whenReady().then(async () => {
  electronApp.setAppUserModelId('com.sully.app')
  // in dev the stock Electron binary supplies the dock icon — override it
  if (is.dev && process.platform === 'darwin') {
    app.dock?.setIcon(appIcon)
  }
  ensureDirs()
  await initEnv()

  registerIpc()
  ipcMain.handle(IPC.quitConfirm, () => {
    quitConfirmed = true
    app.quit()
  })
  createWindow()
  createTray()

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  // target=_blank inside the browser panel navigates the panel itself
  app.on('web-contents-created', (_e, contents) => {
    if (contents.getType() === 'webview') {
      contents.setWindowOpenHandler((details) => {
        void contents.loadURL(details.url)
        return { action: 'deny' }
      })
      // input focused inside the guest page never reaches the main window's
      // before-input-event handler — forward the browser shortcuts from here
      contents.on('before-input-event', (e, input) => {
        if (input.type !== 'keyDown' || !input.meta || input.control || input.alt) return
        const key = input.key.toLowerCase()
        const channel =
          input.shift && key === 'b'
            ? IPC.evBrowserShortcut
            : !input.shift && key === 'b'
              ? IPC.evSidebarShortcut
              : !input.shift && key === 'w'
                ? IPC.evCloseShortcut
                : !input.shift && key === 't'
                  ? IPC.evNewTabShortcut
                  : null
        if (channel) {
          e.preventDefault()
          BrowserWindow.getAllWindows()[0]?.webContents.send(channel)
        }
      })
    }
  })

  orchestrator.on('notify', (p: NotifyPayload) => notify(p))
  prReviewWatcher.on('notify', (p: NotifyPayload) => notify(p))
  processManager.on('session', updateDockBadge)

  await processManager.reconcileOrphans()
  orchestrator.start()
  prReviewWatcher.start()
  toolHealthMonitor.start()
  planUsageMonitor.start()

  app.on('activate', () => {
    const win = BrowserWindow.getAllWindows()[0]
    if (win) {
      win.show()
    } else {
      createWindow()
    }
  })
})

// a terminal kill (Ctrl+C on the dev server, system shutdown of the process)
// is not a user-facing quit — skip the confirmation and shut down cleanly
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
  process.on(sig, () => {
    quitConfirmed = true
    app.quit()
  })
}

app.on('before-quit', (e) => {
  if (!quitConfirmed) {
    e.preventDefault()
    const win = BrowserWindow.getAllWindows()[0]
    if (!win) {
      // nothing to ask through — let the quit proceed
      quitConfirmed = true
      app.quit()
      return
    }
    win.show()
    win.webContents.send(IPC.evConfirmQuit)
    return
  }
  quitting = true
  devServerManager.stopAll()
  deployManager.stopAll()
  ptyManager.killAll()
})

// keep running when all windows are "closed" (hidden) — the tray owns the lifecycle
app.on('window-all-closed', () => {
  // no-op on purpose
})
