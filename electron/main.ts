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
import { PLATFORM_CONFIGS } from '../shared/platforms'

const CHROME_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

let mainWindow: BrowserWindow | null = null
let db: Database | null = null
let scheduler: TaskScheduler | null = null
let scheduledRunner: ScheduledTaskRunner | null = null
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
    },
  })

  console.log('[Startup] Window created, loading page...')

  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDesc, validatedURL) => {
    console.error(`[Startup] Page failed to load: ${errorCode} ${errorDesc} ${validatedURL}`)
  })

  mainWindow.webContents.on('crashed' as any, (_event: any, killed: any) => {
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

  // 提前提取出平铺域名数组，优化性能并避免高频查询开销
  const fakeUaDomains = new Set<string>()
  try {
    if (Array.isArray(PLATFORM_CONFIGS)) {
      for (const p of PLATFORM_CONFIGS) {
        if (p && Array.isArray(p.domains)) {
          for (const d of p.domains) {
            fakeUaDomains.add(d)
          }
        }
      }
    }
  } catch (e) {
    console.error('[Main] Failed to extract platform domains:', e)
  }

  // 兜底常用域名，确保即使配置读取异常也绝不丢失淘宝和关键平台的UA伪装
  const fallbackDomains = ['taobao.com', 'tmall.com', 'jd.com', 'jd.hk', 'pinduoduo.com', 'yangkeduo.com']
  for (const d of fallbackDomains) {
    fakeUaDomains.add(d)
  }

  const fakeUaDomainsArray = Array.from(fakeUaDomains)

  session.defaultSession.webRequest.onBeforeSendHeaders((details, callback) => {
    try {
      const shouldAddUA = fakeUaDomainsArray.some(domain => details.url.includes(domain))
      if (shouldAddUA) {
        details.requestHeaders['User-Agent'] = CHROME_USER_AGENT
      }
    } catch (e) {
      console.error('[Main] Error in onBeforeSendHeaders UA faking:', e)
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
