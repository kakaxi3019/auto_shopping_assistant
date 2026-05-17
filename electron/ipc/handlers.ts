import { ipcMain, BrowserWindow } from 'electron'
import type { ParsedShoppingItem, PaymentMode } from '../../shared/types/platform.types'
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

  const checkAndUpdateTaskAfterConfirmation = (confirmationId: number) => {
    const confirmation = db.getPendingConfirmationById(confirmationId)
    if (!confirmation) return
    const taskId = (confirmation as any).taskId as number
    if (!taskId) return

    const confirmationStatus = (confirmation as any).status as string

    const task = db.getTaskById(taskId)
    if (!task) return

    let itemResults: { status: string; pendingConfirmationId?: number; name?: string }[] = []
    try { itemResults = JSON.parse(task.itemResults || '[]') } catch { /* ignore */ }

    let updated = false
    for (const item of itemResults) {
      if (item.pendingConfirmationId === confirmationId && item.status === 'pending') {
        item.status = confirmationStatus === 'resolved' ? 'success' : 'failed'
        updated = true
      }
    }
    if (updated) {
      db.updateTaskItemResults(taskId, JSON.stringify(itemResults))
    }

    if (!db.hasPendingConfirmationsForTask(taskId)) {
      if (task.status !== 'partial') return
      const successCount = itemResults.filter(r => r.status === 'success').length
      const failedCount = itemResults.filter(r => r.status === 'failed').length
      const pendingCount = itemResults.filter(r => r.status === 'pending').length
      let newStatus: string
      if (pendingCount > 0) {
        newStatus = 'partial'
      } else if (failedCount === 0) {
        newStatus = 'success'
      } else if (successCount > 0) {
        newStatus = 'partial'
      } else {
        newStatus = 'failed'
      }
      db.updateTaskStatus(taskId, newStatus)
      mainWindow?.webContents.send('task:status-update', {
        taskId,
        status: newStatus,
      })
    }
  }

  // Tasks
  ipcMain.handle('task:preview', async (_event, instruction: string) => {
    try {
      return await scheduler.previewTask(instruction)
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) }
    }
  })

  ipcMain.handle('task:confirm', async (_event, instruction: string, items: ParsedShoppingItem[], platform?: string, dryRun?: boolean, paymentMode?: PaymentMode) => {
    try {
      const taskId = await scheduler.confirmTask(instruction, items, platform || 'taobao', dryRun, paymentMode)
      return { taskId }
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

  ipcMain.handle('task:confirm-action', async (_event, platformName: string) => {
    const platform = scheduler.getRegistry().get(platformName || 'taobao')
    if (platform?.resolveConfirmation) {
      await platform.resolveConfirmation(true)
      return true
    }
    return false
  })

  ipcMain.handle('task:reject-action', async (_event, platformName: string) => {
    const platform = scheduler.getRegistry().get(platformName || 'taobao')
    if (platform?.resolveConfirmation) {
      await platform.resolveConfirmation(false)
      return true
    }
    return false
  })

  ipcMain.handle('task:reopen-confirmation-window', async (_event, platformName: string) => {
    const platform = scheduler.getRegistry().get(platformName || 'taobao')
    if (platform?.reopenConfirmationWindow) {
      await platform.reopenConfirmationWindow()
      return true
    }
    return false
  })

  ipcMain.handle('task:retry-item', async (_event, taskId: number, itemName: string) => {
    try {
      return await scheduler.retryTaskItem(taskId, itemName)
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  ipcMain.handle('task:confirm-payment', async (_event, taskId: number, itemName: string) => {
    try {
      return scheduler.confirmPayment(taskId, itemName)
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  ipcMain.handle('task:mark-unpaid', async (_event, taskId: number, itemName: string) => {
    try {
      return scheduler.markUnpaid(taskId, itemName)
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  ipcMain.handle('task:delete', async (_event, id: number) => {
    return db.deleteTask(id)
  })

  ipcMain.handle('task:delete-batch', async (_event, ids: number[]) => {
    return db.deleteTasks(ids)
  })

  ipcMain.handle('task:clear-history', async () => {
    return db.clearCompletedTasks()
  })

  ipcMain.handle('window:open-interaction', async (_event, url: string) => {
    try {
      const platform = scheduler.getPlatform('taobao') as any
      if (platform && typeof platform.openInteractionWindow === 'function') {
        return await platform.openInteractionWindow(url)
      }
      return { success: false, error: '平台未初始化' }
    } catch (e) {
      return { success: false, error: String(e) }
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

  ipcMain.handle('orders:delete', async (_event, id: number) => {
    return db.deleteOrder(id)
  })

  ipcMain.handle('orders:delete-batch', async (_event, ids: number[]) => {
    return db.deleteOrders(ids)
  })

  ipcMain.handle('orders:toggle-unavailable', async (_event, id: number) => {
    return db.toggleOrderUnavailable(id)
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

  // Pending Confirmations
  ipcMain.handle('pending:list', async (_event, status?: string) => {
    return db.getPendingConfirmations(status)
  })

  ipcMain.handle('pending:get-by-id', async (_event, id: number) => {
    return db.getPendingConfirmationById(id)
  })

  ipcMain.handle('pending:resolve', async (_event, id: number) => {
    db.updatePendingConfirmationStatus(id, 'resolved')
    checkAndUpdateTaskAfterConfirmation(id)
    return true
  })

  ipcMain.handle('pending:dismiss', async (_event, id: number) => {
    db.updatePendingConfirmationStatus(id, 'dismissed')
    checkAndUpdateTaskAfterConfirmation(id)
    return true
  })

  ipcMain.handle('pending:count', async () => {
    return db.getPendingConfirmationCount()
  })

  ipcMain.handle('pending:mark-order-unavailable', async (_event, orderId: number) => {
    db.markOrderUnavailable(orderId)
    return true
  })

  ipcMain.handle('pending:confirm-purchase', async (_event, confirmationId: number, candidate: { platform: string; productName: string; price: number; imageUrl: string; productUrl: string; shopName?: string }) => {
    db.createOrderFromSearch(candidate)
    db.updatePendingConfirmationStatus(confirmationId, 'resolved')
    checkAndUpdateTaskAfterConfirmation(confirmationId)
    return true
  })

  ipcMain.handle('pending:purchase-candidate', async (_event, confirmationId: number, productUrl: string, candidate: { platform: string; productName: string; price: number; imageUrl: string; productUrl: string; shopName?: string }, paymentMode: PaymentMode) => {
    try {
      const platform = scheduler.getPlatform()
      if (!platform) return { success: false, error: '平台未初始化' }

      const purchaseResult = await platform.purchaseFromUrl(productUrl)
      if (!purchaseResult.success) {
        await platform.openProductPage(productUrl)
        return { success: true, stage: 'opened', autoPurchaseFailed: purchaseResult.error }
      }

      if (paymentMode === 'cart_only') {
        db.createOrderFromSearch(candidate)
        db.updatePendingConfirmationStatus(confirmationId, 'resolved')
        checkAndUpdateTaskAfterConfirmation(confirmationId)
        return { success: true, stage: 'cart_only' }
      }

      const checkoutResult = await platform.checkout(purchaseResult.directToPay)
      if (!checkoutResult.success) {
        await platform.openProductPage(productUrl)
        return { success: true, stage: 'opened', autoPurchaseFailed: checkoutResult.error }
      }

      if (paymentMode === 'checkout_only') {
        const payWindowResult = await platform.showPaymentWindow()
        if (payWindowResult.paid) {
          db.createOrderFromSearch(candidate)
          db.updatePendingConfirmationStatus(confirmationId, 'resolved')
          checkAndUpdateTaskAfterConfirmation(confirmationId)
          return { success: true, stage: 'checkout_only' }
        }
        return { success: true, stage: 'checkout_only_pending' }
      }

      const payResult = await platform.pay(candidate.price, false, paymentMode)
      if (!payResult.success) {
        await platform.openProductPage(productUrl)
        return { success: true, stage: 'opened', autoPurchaseFailed: payResult.error }
      }

      db.createOrderFromSearch(candidate)
      db.updatePendingConfirmationStatus(confirmationId, 'resolved')
      checkAndUpdateTaskAfterConfirmation(confirmationId)
      return { success: true, stage: 'auto_pay' }
    } catch (e) {
      try {
        const fallbackPlatform = scheduler.getPlatform()
        if (fallbackPlatform) {
          await fallbackPlatform.openProductPage(productUrl)
          return { success: true, stage: 'opened', autoPurchaseFailed: String(e) }
        }
        return { success: false, error: String(e) }
      } catch (e2) {
        return { success: false, error: String(e2) }
      }
    }
  })

  return { setMainWindow }
}
