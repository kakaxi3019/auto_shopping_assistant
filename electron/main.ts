process.removeAllListeners('warning')
process.on('warning', (warning) => {
  if (warning.name === 'DeprecationWarning') return
  console.warn(warning)
})

import { app, BrowserWindow, ipcMain, Menu, session } from 'electron'

app.commandLine.appendSwitch('disable-blink-features', 'AutomationControlled')
app.commandLine.appendSwitch('log-level', '3')
import { join } from 'path'
import { Database } from './db/database'
import { registerIpcHandlers } from './ipc/handlers'
import { TaskScheduler } from './scheduler/task-scheduler'
import { ScheduledTaskRunner } from './scheduler/scheduled-task-runner'

const CHROME_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

let mainWindow: BrowserWindow | null = null
let db: Database | null = null
let scheduler: TaskScheduler | null = null
let scheduledRunner: ScheduledTaskRunner | null = null
let backendReady = false

function createWindow() {
  console.log('[Startup] Creating main window...')

  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    title: 'Auto Shopping Assistant',
    icon: app.isPackaged
      ? join(process.resourcesPath, 'app-icon', 'auto_shopping_app_icon.png')
      : join(__dirname, '../build/auto_shopping_app_icon.png'),
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webviewTag: true,
    },
  })

  console.log('[Startup] Window created, loading page...')

  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDesc, validatedURL) => {
    console.error(`[Startup] Page failed to load: ${errorCode} ${errorDesc} ${validatedURL}`)
  })

  mainWindow.webContents.on('crashed', (_event, killed) => {
    console.error(`[Error] mainWindow webContents CRASHED! killed=${killed}`)
  })

  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    console.error(`[Error] mainWindow render-process-gone! reason=${details.reason} exitCode=${details.exitCode}`)
  })

  mainWindow.webContents.on('will-navigate', (event, url) => {
    let isAllowed = url.startsWith('file://')
    if (!isAllowed && url.startsWith('http://localhost:')) {
      try {
        const port = parseInt(new URL(url).port, 10)
        isAllowed = port >= 5173 && port <= 5200
      } catch { isAllowed = false }
    }
    if (!isAllowed) {
      event.preventDefault()
    }
  })

  mainWindow.webContents.on('did-navigate', (_event, _url) => {
  })

  mainWindow.webContents.on('did-navigate-in-page', (_event, _url) => {
  })

  if (process.env.VITE_DEV_SERVER_URL) {
    console.log(`[Startup] Loading dev URL: ${process.env.VITE_DEV_SERVER_URL}`)
    mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL)
  } else {
    mainWindow.loadFile(join(__dirname, '../dist/index.html'))
  }

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

Menu.setApplicationMenu(null)

app.whenReady().then(async () => {
  console.log('[Startup] App ready')

  session.defaultSession.webRequest.onBeforeSendHeaders((details, callback) => {
    if (details.url.includes('taobao.com') || details.url.includes('tmall.com')) {
      details.requestHeaders['User-Agent'] = CHROME_USER_AGENT
    }
    callback({ requestHeaders: details.requestHeaders })
  })

  db = new Database()
  await db.waitReady()

  const staleCount = db.resetStaleRunningTasks()
  if (staleCount > 0) {
    console.log(`[Startup] Reset ${staleCount} stale running/pending tasks to cancelled`)
  }

  scheduler = new TaskScheduler(db)
  const handlers = registerIpcHandlers(db, scheduler)

  ipcMain.handle('app:is-ready', () => true)

  createWindow()

  if (mainWindow) {
    scheduler.setMainWindow(mainWindow)
    handlers.setMainWindow(mainWindow)
  }

  scheduledRunner = new ScheduledTaskRunner(db, scheduler)
  scheduledRunner.start()

  backendReady = true
  mainWindow?.webContents.send('app:ready')

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  scheduledRunner?.stop()
  scheduler?.stop()
  try { db?.close() } catch { /* ignore */ }
  if (process.platform !== 'darwin') app.quit()
})
