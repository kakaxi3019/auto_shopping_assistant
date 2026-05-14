import type { BrowserWindow } from 'electron'
import type { ParsedShoppingItem, TaskPreview } from '../../shared/types/platform.types'
import type { Database } from '../db/database'
import { PlatformRegistry } from '../platforms/registry'
import { LlmParser } from '../llm/parser'
import { TaskExecutor, type ItemResult } from './task-executor'

export class TaskScheduler {
  private db: Database
  private registry: PlatformRegistry
  private parser: LlmParser
  private executor: TaskExecutor
  private running = false
  private mainWindow: BrowserWindow | null = null

  constructor(db: Database) {
    this.db = db
    this.registry = new PlatformRegistry(db)
    this.parser = new LlmParser(db)
    this.executor = new TaskExecutor(db)
  }

  setMainWindow(win: BrowserWindow) {
    this.mainWindow = win
    for (const platform of this.registry.getAll()) {
      if ('setMainWindow' in platform && typeof (platform as any).setMainWindow === 'function') {
        (platform as any).setMainWindow(win)
      }
    }
  }

  private emitUpdate(taskId: number, status: string, error?: string, progress?: string) {
    this.mainWindow?.webContents.send('task:status-update', {
      taskId,
      status,
      error,
      progress,
    })
  }

  async previewTask(instruction: string, platformName = 'taobao'): Promise<TaskPreview> {
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

  async confirmTask(instruction: string, items: ParsedShoppingItem[], platformName = 'taobao', dryRun?: boolean): Promise<number> {
    const taskId = this.db.createTask(instruction, JSON.stringify(items), platformName)
    this.executeTask(taskId, items, platformName, instruction, dryRun)
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

  private async executeTask(taskId: number, parsedItems: ParsedShoppingItem[], platformName: string, instruction?: string, dryRun?: boolean) {
    const platform = this.registry.get(platformName)
    if (!platform) {
      this.db.updateTaskStatus(taskId, 'failed', `平台 "${platformName}" 不支持`)
      this.emitUpdate(taskId, 'failed', `平台 "${platformName}" 不支持`)
      return
    }

    this.db.updateTaskStatus(taskId, 'running')
    this.emitUpdate(taskId, 'running')

    platform.onStatusChange((status) => {
      this.emitUpdate(taskId, 'running', undefined, status)
    })

    try {
      const execResult = await this.executor.execute(taskId, parsedItems, platform, (msg) => {
        this.emitUpdate(taskId, 'running', undefined, msg)
      }, instruction, dryRun)

      const status = execResult.success ? 'success' : 'failed'
      const error = execResult.error
      this.db.updateTaskStatus(taskId, status, error)
      this.db.updateTaskItemResults(taskId, JSON.stringify(execResult.itemResults))
      this.emitUpdate(taskId, status, error)
    } catch (e) {
      const errorMsg = e instanceof Error ? e.message : String(e)
      this.db.updateTaskStatus(taskId, 'failed', errorMsg)
      this.emitUpdate(taskId, 'failed', errorMsg)
    }
  }

  cancelTask(taskId: number) {
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

    let itemResults: ItemResult[] = []
    try {
      if (task.itemResults) {
        itemResults = JSON.parse(task.itemResults)
      }
    } catch { /* ignore */ }

    const platformName = task.platform || 'taobao'
    const platform = this.registry.get(platformName)
    if (!platform) return { success: false, error: `平台 "${platformName}" 不支持` }

    this.emitUpdate(taskId, 'running', undefined, `正在重试 "${itemName}"...`)

    platform.onStatusChange((status) => {
      this.emitUpdate(taskId, 'running', undefined, status)
    })

    try {
      const result = await this.executor.executeSingle(item, platform, (msg) => {
        this.emitUpdate(taskId, 'running', undefined, msg)
      }, task.instruction)

      const existingIdx = itemResults.findIndex(r => r.name === itemName)
      if (existingIdx >= 0) {
        itemResults[existingIdx] = result
      } else {
        itemResults.push(result)
      }

      this.db.updateTaskItemResults(taskId, JSON.stringify(itemResults))

      const successCount = itemResults.filter(r => r.status === 'success').length
      const failedCount = itemResults.filter(r => r.status === 'failed').length
      const newStatus = failedCount === 0 ? 'success' : (successCount > 0 ? 'failed' : 'failed')
      const newError = failedCount > 0
        ? `购买失败：${itemResults.filter(r => r.status === 'failed').map(r => r.name).join('、')}`
        : undefined

      this.db.updateTaskStatus(taskId, newStatus, newError)
      this.emitUpdate(taskId, newStatus, newError)

      return { success: result.status === 'success', error: result.error }
    } catch (e) {
      const errorMsg = e instanceof Error ? e.message : String(e)
      this.emitUpdate(taskId, 'failed', errorMsg)
      return { success: false, error: errorMsg }
    }
  }

  stop() {
    this.running = false
  }

  getRegistry() {
    return this.registry
  }

  getParser() {
    return this.parser
  }
}
