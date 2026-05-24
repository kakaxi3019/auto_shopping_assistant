import { Notification, app } from 'electron'
import type { BrowserWindow } from 'electron'
import type { ParsedShoppingItem, TaskPreview, PaymentMode } from '../../shared/types/platform.types'
import type { ItemResult } from '../../shared/types/task.types'
import type { Database } from '../db/database'
import { PlatformRegistry } from '../platforms/registry'
import { LlmParser } from '../llm/parser'
import { TaskExecutor } from './task-executor'
import { appendFileSync, writeFileSync } from 'fs'
import { join } from 'path'

const SCHEDULER_LOG_FILE = join(app.getPath('userData'), 'preview-debug.log')

function schedulerLog(msg: string) {
  const ts = new Date().toISOString()
  const line = `[${ts}] ${msg}\n`
  console.log(msg)
  try {
    appendFileSync(SCHEDULER_LOG_FILE, line, 'utf-8')
  } catch {}
}

export class TaskScheduler {
  private db: Database
  private registry: PlatformRegistry
  private parser: LlmParser
  private executor: TaskExecutor
  private mainWindow: BrowserWindow | null = null
  private taskQueue: Array<{ taskId: number; fn: () => Promise<void> }> = []
  private isExecuting = false

  constructor(db: Database) {
    this.db = db
    this.registry = new PlatformRegistry(db)
    this.parser = new LlmParser(db)
    this.executor = new TaskExecutor(db)
  }

  getPlatform(platformName = 'taobao') {
    return this.registry.get(platformName) || null
  }

  setMainWindow(win: BrowserWindow) {
    this.mainWindow = win
    for (const platform of this.registry.getAll()) {
      if (platform.setMainWindow) {
        platform.setMainWindow(win)
      }
    }
  }

  private lastProgressPerTask = new Map<number, string>()

  private simplifyProgress(msg: string): string {
    const patterns: [RegExp, string][] = [
      [/正在.*LLM.*匹配/i, '翻阅历史订单'],
      [/LLM 精确匹配/i, 'LLM匹配结果'],
      [/LLM.*匹配/i, '翻阅历史订单'],
      [/正在查找.*订单/i, '查找购买记录'],
      [/查找.*订单/i, '查找购买记录'],
      [/匹配.*历史/i, '匹配历史订单'],
      [/正在打开订单详情/i, '打开订单详情'],
      [/执行再买一单/i, '一键复购'],
      [/再买一单失败/i, '复购失败'],
      [/未找到再买一单/i, '复购不可用'],
      [/已点击再买一单/i, '点击复购按钮'],
      [/点击.*再买一单/i, '点击复购按钮'],
      [/再买一单/i, '一键复购'],
      [/正在选择商品规格/i, '选择商品规格'],
      [/选择.*SKU/i, '选择商品规格'],
      [/SKU.*选择/i, '匹配商品规格'],
      [/自动选择.*规格/i, '自动选择规格'],
      [/正在点击购买/i, '点击购买'],
      [/正在点击加入购物车/i, '点击加入购物车'],
      [/正在点击立即购买/i, '点击立即购买'],
      [/已点击购买按钮/i, '点击购买'],
      [/已点击加入购物车/i, '加入购物车'],
      [/加入购物车/i, '加入购物车'],
      [/已进入结算/i, '进入结算'],
      [/正在结算/i, '结算'],
      [/正在提交订单/i, '提交订单'],
      [/正在.*支付/i, '支付'],
      [/购买完成/i, '购买完成'],
      [/支付完成/i, '支付完成'],
      [/验证完成/i, '验证完成'],
      [/已下架/i, '商品已下架'],
      [/登录.*过期/i, '登录过期'],
      [/身份验证/i, '身份验证'],
      [/超时/i, '操作超时'],
      [/搜索替代/i, '搜索替代商品'],
      [/搜索.*商品/i, '搜索替代商品'],
      [/打开.*窗口/i, '打开操作窗口'],
      [/弹.*窗口/i, '弹出操作窗口'],
      [/操作窗口已关闭/i, '操作窗口关闭'],
    ]
    for (const [regex, replacement] of patterns) {
      if (regex.test(msg)) return replacement
    }
    return msg.replace(/["""]/g, '"').replace(/订单\s*\S+/g, '订单').replace(/#\d+/g, '#').replace(/\s+/g, ' ').trim()
  }

  private isDuplicateProgress(taskId: number, progress: string): boolean {
    const last = this.lastProgressPerTask.get(taskId)
    if (!last) return false
    if (last === progress) return true
    return this.simplifyProgress(last) === this.simplifyProgress(progress)
  }

  private emitUpdate(taskId: number, status: string, error?: string, progress?: string, itemResults?: string, instruction?: string) {
    if (progress) {
      if (!this.isDuplicateProgress(taskId, progress)) {
        this.db.appendTaskProgressLog(taskId, progress)
        this.lastProgressPerTask.set(taskId, progress)
      }
    }
    const payload: Record<string, unknown> = { taskId, status, error, progress }
    if (itemResults !== undefined) {
      payload.itemResults = itemResults
    }
    if (this.mainWindow && !this.mainWindow.isDestroyed() && !this.mainWindow.webContents.isCrashed()) {
      try {
        this.mainWindow.webContents.send('task:status-update', payload)
      } catch (e) {
        console.error(`[Scheduler] emitUpdate failed to send to renderer:`, e)
      }
    } else {
      console.warn(`[Scheduler] emitUpdate: mainWindow not available (destroyed=${this.mainWindow?.isDestroyed()}, crashed=${this.mainWindow?.webContents?.isCrashed()})`)
    }

    if (['failed', 'partial', 'cancelled'].includes(status)) {
      const dnd = this.db.getSetting('do_not_disturb')
      if (dnd !== 'true') {
        const displayInstruction = instruction || this.db.getTaskById(taskId)?.instruction || `任务 #${taskId}`
        const statusMessages: Record<string, { title: string; body: string }> = {
          failed: { title: '任务失败', body: error || displayInstruction },
          partial: { title: '待处理', body: `${displayInstruction} - 有商品需要您确认` },
          cancelled: { title: '任务已取消', body: displayInstruction },
        }
        const msg = statusMessages[status]
        if (msg) {
          try {
            const notification = new Notification({
              title: msg.title,
              body: msg.body,
              silent: false,
            })
            notification.on('click', () => {
              if (this.mainWindow) {
                if (this.mainWindow.isMinimized()) this.mainWindow.restore()
                this.mainWindow.focus()
                this.mainWindow.webContents.send('task:notification-click', { taskId })
              }
            })
            notification.show()
          } catch { /* ignore */ }
        }
      }
    }
  }

  async previewTask(instruction: string, platformName = 'taobao'): Promise<TaskPreview> {
    try { writeFileSync(SCHEDULER_LOG_FILE, '', 'utf-8') } catch {}
    const parsedItems = await this.parser.parse(instruction)

    const items = parsedItems.map(item =>
      this.executor.previewCandidateOrders(item, platformName, instruction)
    )

    return {
      instruction,
      items,
      platform: platformName,
    }
  }

  async confirmTask(instruction: string, items: ParsedShoppingItem[], platformName = 'taobao', dryRun?: boolean, paymentMode?: PaymentMode): Promise<number> {
    const taskId = this.db.createTask(instruction, JSON.stringify(items), platformName, paymentMode || 'cart_only')
    this.executeTask(taskId, items, platformName, instruction, dryRun, paymentMode)
    return taskId
  }

  async createTask(instruction: string, platformName = 'taobao'): Promise<number> {
    // Parse instruction with LLM
    const parsedItems = await this.parser.parse(instruction)

    // Create task in DB
    const taskId = this.db.createTask(instruction, JSON.stringify(parsedItems), platformName)

    // Execute async
    this.executeTask(taskId, parsedItems, platformName, instruction)

    return taskId
  }

  private async executeTask(taskId: number, parsedItems: ParsedShoppingItem[], platformName: string, instruction?: string, dryRun?: boolean, paymentMode?: PaymentMode) {
    this.lastProgressPerTask.delete(taskId)
    const taskFn = async () => {
      const platform = this.registry.get(platformName)
      if (!platform) {
        this.db.updateTaskStatus(taskId, 'failed', `平台 "${platformName}" 不支持`)
        this.emitUpdate(taskId, 'failed', `平台 "${platformName}" 不支持`)
        return
      }

      this.db.updateTaskStatus(taskId, 'running')
      this.emitUpdate(taskId, 'running')

      const unsubscribe = platform.onStatusChange((status) => {
        this.emitUpdate(taskId, 'running', undefined, status)
      })

      try {
        const execResult = await this.executor.execute(taskId, parsedItems, platform, (msg) => {
          this.emitUpdate(taskId, 'running', undefined, msg)
        }, instruction, dryRun, paymentMode)

        const hasPending = execResult.itemResults.some(r => r.status === 'pending')
        const hasPendingPayment = execResult.itemResults.some(r => r.status === 'success' && r.pendingPayment)
        let status: string
        if (execResult.success) {
          status = 'success'
        } else if (hasPending || hasPendingPayment) {
          status = 'partial'
        } else {
          status = 'failed'
        }
        const error = execResult.error
        this.db.updateTaskStatus(taskId, status, error)
        this.emitUpdate(taskId, status, error, undefined, undefined, instruction)
        this.db.updateTaskItemResults(taskId, JSON.stringify(execResult.itemResults))
      } catch (e) {
        const errorMsg = e instanceof Error ? e.message : String(e)
        this.db.updateTaskStatus(taskId, 'failed', errorMsg)
        this.emitUpdate(taskId, 'failed', errorMsg, undefined, undefined, instruction)
      } finally {
        unsubscribe()
      }
    }

    const isQueued = this.isExecuting || this.taskQueue.length > 0
    this.taskQueue.push({ taskId, fn: taskFn })

    if (isQueued) {
      this.db.updateTaskStatus(taskId, 'running')
      this.emitUpdate(taskId, 'running', undefined, '排队中，等待前一个任务完成...')
    }

    this.processQueue()
  }

  private async processQueue() {
    if (this.isExecuting) return
    this.isExecuting = true

    while (this.taskQueue.length > 0) {
      const { fn } = this.taskQueue.shift()!
      try {
        await fn()
      } catch (e) {
        console.error('[TaskScheduler] Task execution error:', e)
      }
    }

    this.isExecuting = false
  }

  cancelTask(taskId: number) {
    this.taskQueue = this.taskQueue.filter(t => t.taskId !== taskId)
    this.db.dismissPendingConfirmationsForTask(taskId)

    const task = this.db.getTaskById(taskId)
    const platformName = task?.platform || 'taobao'
    const platform = this.registry.get(platformName)
    if (platform?.resolveConfirmation) {
      platform.resolveConfirmation(false).catch(() => {})
    }
    if (platform?.cleanup) {
      platform.cleanup().catch(() => {})
    }

    this.db.updateTaskStatus(taskId, 'cancelled')
    this.emitUpdate(taskId, 'cancelled')
  }

  async retryTaskItem(taskId: number, itemName: string): Promise<{ success: boolean; error?: string }> {
    const task = this.db.getTaskById(taskId)
    if (!task) return { success: false, error: '任务不存在' }

    let parsedItems: ParsedShoppingItem[] = []
    try {
      parsedItems = JSON.parse(task.parsedItems)
    } catch {
      return { success: false, error: '任务数据解析失败' }
    }

    const item = parsedItems.find(p => p.name === itemName)
    if (!item) return { success: false, error: `商品 "${itemName}" 不在任务中` }

    const platformName = task.platform || 'taobao'
    const platform = this.registry.get(platformName)
    if (!platform) return { success: false, error: `平台 "${platformName}" 不支持` }

    this.db.updateTaskStatus(taskId, 'running')
    this.db.clearTaskProgressLog(taskId)
    this.lastProgressPerTask.delete(taskId)

    const retryItemResult: ItemResult = { name: itemName, quantity: item.quantity, status: 'pending' }
    const itemResults: ItemResult[] = [retryItemResult]
    const itemResultsJson = JSON.stringify(itemResults)
    this.db.updateTaskItemResults(taskId, itemResultsJson)
    this.emitUpdate(taskId, 'running', undefined, `正在重试 "${itemName}"...`, itemResultsJson)

    const unsubscribe = platform.onStatusChange((status) => {
      this.emitUpdate(taskId, 'running', undefined, status)
    })

    try {
      const result = await this.executor.executeSingle(taskId, item, platform, (msg) => {
        this.emitUpdate(taskId, 'running', undefined, msg)
      }, task.instruction, undefined, task.paymentMode)

      itemResults[0] = result
      const updatedItemResultsJson = JSON.stringify(itemResults)
      this.db.updateTaskItemResults(taskId, updatedItemResultsJson)

      const successCount = itemResults.filter(r => r.status === 'success').length
      const failedCount = itemResults.filter(r => r.status === 'failed').length
      const pendingCount = itemResults.filter(r => r.status === 'pending').length
      let newStatus: string
      let newError: string | undefined
      if (failedCount === 0 && pendingCount === 0) {
        newStatus = 'success'
      } else if (successCount > 0) {
        newStatus = 'partial'
        newError = pendingCount > 0
          ? `已找到替代商品，请选择：${itemResults.filter(r => r.status === 'pending').map(r => r.name).join('、')}`
          : undefined
      } else if (pendingCount > 0) {
        newStatus = 'partial'
        newError = `已找到替代商品，请选择：${itemResults.filter(r => r.status === 'pending').map(r => r.name).join('、')}`
      } else {
        newStatus = 'failed'
        newError = `任务失败：${itemResults.filter(r => r.status === 'failed').map(r => r.name).join('、')}`
      }

      this.db.updateTaskStatus(taskId, newStatus, newError)
      this.emitUpdate(taskId, newStatus, newError)

      return { success: result.status === 'success', error: result.error }
    } catch (e) {
      const errorMsg = e instanceof Error ? e.message : String(e)
      this.emitUpdate(taskId, 'failed', errorMsg)
      return { success: false, error: errorMsg }
    } finally {
      unsubscribe()
    }
  }

  confirmPayment(taskId: number, itemName: string): { success: boolean; error?: string } {
    const task = this.db.getTaskById(taskId)
    if (!task) return { success: false, error: '任务不存在' }

    let itemResults: ItemResult[] = []
    try {
      if (task.itemResults) itemResults = JSON.parse(task.itemResults)
    } catch { /* ignore */ }

    const item = itemResults.find(r => r.name === itemName && r.pendingPayment)
    if (!item) return { success: false, error: '未找到待付款商品' }

    item.pendingPayment = false
    this.db.updateTaskItemResults(taskId, JSON.stringify(itemResults))

    const pendingPaymentCount = itemResults.filter(r => r.status === 'success' && r.pendingPayment).length
    const failedCount = itemResults.filter(r => r.status === 'failed').length
    const pendingCount = itemResults.filter(r => r.status === 'pending').length

    if (pendingPaymentCount === 0 && failedCount === 0 && pendingCount === 0) {
      this.db.updateTaskStatus(taskId, 'success')
      this.emitUpdate(taskId, 'success')
    } else if (failedCount > 0 || pendingCount > 0) {
      this.emitUpdate(taskId, task.status, task.error || undefined)
    }

    return { success: true }
  }

  markUnpaid(taskId: number, itemName: string): { success: boolean; error?: string } {
    const task = this.db.getTaskById(taskId)
    if (!task) return { success: false, error: '任务不存在' }

    let itemResults: ItemResult[] = []
    try {
      if (task.itemResults) itemResults = JSON.parse(task.itemResults)
    } catch { /* ignore */ }

    const idx = itemResults.findIndex(r => r.name === itemName && r.pendingPayment)
    if (idx < 0) return { success: false, error: '未找到待付款商品' }

    itemResults[idx].status = 'failed'
    itemResults[idx].pendingPayment = false
    itemResults[idx].error = '未完成付款'
    this.db.updateTaskItemResults(taskId, JSON.stringify(itemResults))

    const successCount = itemResults.filter(r => r.status === 'success' && !r.pendingPayment).length
    const pendingPaymentCount = itemResults.filter(r => r.status === 'success' && r.pendingPayment).length
    const failedCount = itemResults.filter(r => r.status === 'failed').length
    const pendingCount = itemResults.filter(r => r.status === 'pending').length

    let newStatus: string
    let newError: string | undefined
    if (successCount > 0 && failedCount === 0 && pendingCount === 0 && pendingPaymentCount === 0) {
      newStatus = 'success'
    } else if (failedCount === 0 && pendingCount === 0 && pendingPaymentCount === 0) {
      newStatus = 'failed'
      newError = '任务失败：未完成付款'
    } else {
      newStatus = 'partial'
      newError = pendingCount > 0
        ? `已找到替代商品，请选择：${itemResults.filter(r => r.status === 'pending').map(r => r.name).join('、')}`
        : undefined
    }

    this.db.updateTaskStatus(taskId, newStatus, newError)
    this.emitUpdate(taskId, newStatus, newError)

    return { success: true }
  }

  stop() {
    for (const platform of this.registry.getAll()) {
      if (platform.destroy) {
        platform.destroy()
      }
    }
  }

  getRegistry() {
    return this.registry
  }

  getParser() {
    return this.parser
  }
}
