import { ipcMain, BrowserWindow } from 'electron'
import type { ParsedShoppingItem } from '../../shared/types/platform.types'
import type { Database } from '../db/database'
import type { TaskScheduler } from '../scheduler/task-scheduler'

export function registerIpcHandlers(db: Database, scheduler: TaskScheduler) {
  let mainWindow: BrowserWindow | null = null

  const setMainWindow = (win: BrowserWindow) => {
    mainWindow = win
  }

  const emitSyncStatus = (status: string, error?: string) => {
    mainWindow?.webContents.send('sync:status-update', { status, error })
  }

  // Tasks
  ipcMain.handle('task:preview', async (_event, instruction: string) => {
    try {
      return await scheduler.previewTask(instruction)
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) }
    }
  })

  ipcMain.handle('task:confirm', async (_event, instruction: string, items: ParsedShoppingItem[], platform?: string, dryRun?: boolean) => {
    try {
      return await scheduler.confirmTask(instruction, items, platform || 'taobao', dryRun)
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) }
    }
  })

  ipcMain.handle('task:create', async (_event, instruction: string) => {
    try {
      return await scheduler.createTask(instruction)
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) }
    }
  })

  ipcMain.handle('task:list', async (_event, status?: string) => {
    return db.getTasks(status)
  })

  ipcMain.handle('task:cancel', async (_event, id: number) => {
    scheduler.cancelTask(id)
    return true
  })

  ipcMain.handle('task:retry-item', async (_event, taskId: number, itemName: string) => {
    try {
      return await scheduler.retryTaskItem(taskId, itemName)
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  // Account
  ipcMain.handle('account:login', async (_event, platform: string) => {
    try {
      const adapter = scheduler.getRegistry().get(platform)
      if (!adapter) return { success: false, error: '平台不存在' }
      const success = await adapter.login()
      return { success }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      console.error('Login error:', msg)
      return { success: false, error: msg }
    }
  })

  ipcMain.handle('account:status', async (_event, platform: string) => {
    try {
      const adapter = scheduler.getRegistry().get(platform)
      if (!adapter) return { loggedIn: false, cookieAge: null }
      const loggedIn = await adapter.isLoggedIn()
      const cookieAge = adapter.getCookieAge?.() ?? null
      return { loggedIn, cookieAge }
    } catch {
      return { loggedIn: false, cookieAge: null }
    }
  })

  ipcMain.handle('account:logout', async (_event, platform: string) => {
    try {
      const adapter = scheduler.getRegistry().get(platform)
      if (!adapter) return { success: false }
      await adapter.logout()
      return { success: true }
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  // Orders
  ipcMain.handle('orders:sync', async (_event, platform: string, timeRange?: { beginTime?: string; endTime?: string }) => {
    try {
      const adapter = scheduler.getRegistry().get(platform)
      if (!adapter) return { success: false, error: '平台不存在' }

      adapter.onStatusChange((status) => {
        emitSyncStatus(status)
      })

      const orders = await adapter.fetchOrderHistory(1, timeRange)
      const actualCount = db.getOrderCount(platform)
      db.setSetting('last_sync_time', new Date().toISOString())
      db.setSetting('last_sync_count', String(actualCount))
      emitSyncStatus(`同步完成，共 ${actualCount} 条订单已保存到本地数据库`)
      return { success: true, count: actualCount }
    } catch (e) {
      const errorMsg = e instanceof Error ? e.message : String(e)
      emitSyncStatus('同步失败', errorMsg)
      return { success: false, error: errorMsg }
    }
  })

  ipcMain.handle('orders:search', async (_event, keyword: string) => {
    return db.searchOrders(keyword)
  })

  ipcMain.handle('orders:list', async (_event, platform: string, limit?: number, offset?: number) => {
    return db.getOrders(platform, limit, offset)
  })

  ipcMain.handle('orders:count', async (_event, platform: string) => {
    return db.getOrderCount(platform)
  })

  ipcMain.handle('orders:clear', async (_event, platform: string) => {
    const count = db.clearOrders(platform)
    return { success: true, count }
  })

  // Settings
  ipcMain.handle('settings:get', async (_event, key: string) => {
    return db.getSetting(key)
  })

  ipcMain.handle('settings:set', async (_event, key: string, value: string) => {
    db.setSetting(key, value)
    if (key === 'openai_api_key' || key === 'openai_base_url' || key === 'openai_model' || key === 'anthropic_api_key' || key === 'anthropic_base_url' || key === 'anthropic_model' || key === 'llm_provider') {
      scheduler.getParser().resetClient()
    }
    return true
  })

  ipcMain.handle('settings:verify-llm', async () => {
    return scheduler.getParser().verify()
  })

  ipcMain.handle('settings:fetch-models', async () => {
    return scheduler.getParser().fetchModels()
  })

  // Scheduled Tasks
  ipcMain.handle('scheduled:create', async (_event, task: { name: string; instruction: string; repeatType: string; scheduledTime: string; dayOfWeek?: number; dayOfMonth?: number }) => {
    return db.createScheduledTask(task)
  })

  ipcMain.handle('scheduled:list', async () => {
    return db.getScheduledTasks()
  })

  ipcMain.handle('scheduled:update', async (_event, id: number, updates: Record<string, unknown>) => {
    db.updateScheduledTask(id, updates)
    return true
  })

  ipcMain.handle('scheduled:delete', async (_event, id: number) => {
    db.deleteScheduledTask(id)
    return true
  })

  return { setMainWindow }
}
