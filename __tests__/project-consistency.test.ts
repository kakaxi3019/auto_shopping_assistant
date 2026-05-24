import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'

const projectRoot = path.resolve(__dirname, '..')

describe('Project Structure Consistency', () => {
  it('FIXED: registry.ts now imports TaobaoPlatform from taobao.platform.new', () => {
    const indexPath = fs.readFileSync(path.join(projectRoot, 'electron/platforms/taobao/index.ts'), 'utf-8')
    const registryPath = fs.readFileSync(path.join(projectRoot, 'electron/platforms/registry.ts'), 'utf-8')

    const indexExports = [...indexPath.matchAll(/export\s+.*from\s+['"]([^'"]+)['"]/g)].map(m => m[1])
    const registryImports = [...registryPath.matchAll(/import\s+.*from\s+['"]([^'"]+)['"]/g)].map(m => m[1])

    const indexTaobaoExport = indexExports.find(e => e.includes('taobao.platform'))
    const registryTaobaoImport = registryImports.find(e => e.includes('taobao.platform'))

    expect(indexTaobaoExport).toContain('.new')
    expect(registryTaobaoImport).toContain('.new')
  })

  it('FIXED: old taobao.platform.ts has been deleted', () => {
    const oldFile = fs.existsSync(path.join(projectRoot, 'electron/platforms/taobao/taobao.platform.ts'))
    const newFile = fs.existsSync(path.join(projectRoot, 'electron/platforms/taobao/taobao.platform.new.ts'))
    expect(oldFile).toBe(false)
    expect(newFile).toBe(true)
  })
})

describe('Code Quality Issues', () => {
  it('FIXED: task-executor.ts executeSingle now has taskId parameter', () => {
    const content = fs.readFileSync(path.join(projectRoot, 'electron/scheduler/task-executor.ts'), 'utf-8')

    const methodSignature = content.match(/async executeSingle\s*\(([^)]*)\)/)
    expect(methodSignature).toBeTruthy()
    const params = methodSignature![1]
    expect(params).toContain('taskId')
  })

  it('FIXED: handlers.ts orders:sync now unsubscribes onStatusChange callback', () => {
    const content = fs.readFileSync(path.join(projectRoot, 'electron/ipc/handlers.ts'), 'utf-8')

    const syncStart = content.indexOf("ipcMain.handle('orders:sync'")
    expect(syncStart).toBeGreaterThan(-1)

    const syncSection = content.substring(syncStart, syncStart + 1500)
    expect(syncSection).toContain('adapter.onStatusChange')
    expect(syncSection).toContain('unsubscribe')
    expect(syncSection).toContain('finally')
  })

  it('FIXED: cancelTask now only resolves confirmation for the task platform', () => {
    const content = fs.readFileSync(path.join(projectRoot, 'electron/scheduler/task-scheduler.ts'), 'utf-8')

    const cancelStart = content.indexOf('cancelTask(taskId: number)')
    expect(cancelStart).toBeGreaterThan(-1)

    const cancelSection = content.substring(cancelStart, cancelStart + 500)
    expect(cancelSection).not.toContain('this.registry.getAll()')
    expect(cancelSection).toContain('this.registry.get')
  })

  it('FIXED: ScheduledTaskRunner now uses platform from scheduled task data', () => {
    const content = fs.readFileSync(path.join(projectRoot, 'electron/scheduler/scheduled-task-runner.ts'), 'utf-8')
    expect(content).toContain('task.platform')
    expect(content).toContain('platformName')
  })

  it('FIXED: search.service.ts searchProduct no longer has variable shadowing with timeout', () => {
    const content = fs.readFileSync(path.join(projectRoot, 'electron/platforms/taobao/services/search.service.ts'), 'utf-8')

    const searchProductStart = content.indexOf('async searchProduct(')
    const openSearchPageStart = content.indexOf('async openSearchPage(')
    const searchProductBody = content.substring(searchProductStart, openSearchPageStart)

    const timeoutCount = (searchProductBody.match(/const timeout/g) || []).length
    expect(timeoutCount).toBe(0)
    expect(searchProductBody).toContain('loadTimeout')
    expect(searchProductBody).toContain('pollTimeout')
  })

  it('BUG: emitStatus in taobao.platform.new.ts deduplicates by exact string', () => {
    const content = fs.readFileSync(path.join(projectRoot, 'electron/platforms/taobao/taobao.platform.new.ts'), 'utf-8')
    expect(content).toContain('this._lastEmittedStatus')
  })
})

describe('Security Issues', () => {
  it('should not have hardcoded API keys', () => {
    const files = [
      'electron/llm/parser.ts',
      'electron/main.ts',
      'electron/ipc/handlers.ts',
    ]
    for (const file of files) {
      const content = fs.readFileSync(path.join(projectRoot, file), 'utf-8')
      const hasHardcodedKey = /sk-[a-zA-Z0-9]{20,}/.test(content)
      expect(hasHardcodedKey).toBe(false)
    }
  })

  it('should have contextIsolation enabled in main window', () => {
    const content = fs.readFileSync(path.join(projectRoot, 'electron/main.ts'), 'utf-8')
    expect(content).toContain('contextIsolation: true')
    expect(content).toContain('nodeIntegration: false')
  })

  it('BUG: sandbox is disabled in main window', () => {
    const content = fs.readFileSync(path.join(projectRoot, 'electron/main.ts'), 'utf-8')
    expect(content).toContain('sandbox: false')
  })

  it('BUG: main window will-navigate allows any localhost port', () => {
    const content = fs.readFileSync(path.join(projectRoot, 'electron/main.ts'), 'utf-8')
    expect(content).toContain("'http://localhost:'")
  })
})

describe('Database Migration Issues', () => {
  it('should have sequential migration versions', () => {
    const content = fs.readFileSync(path.join(projectRoot, 'electron/db/migrations.ts'), 'utf-8')
    for (let i = 2; i <= 11; i++) {
      expect(content).toContain(`MIGRATION_V${i}`)
    }
  })

  it('FIXED: deleteOrder now clears foreign key references before deleting', () => {
    const dbContent = fs.readFileSync(path.join(projectRoot, 'electron/db/database.ts'), 'utf-8')
    const deleteOrderMethod = dbContent.match(/deleteOrder\(id: number\)[\s\S]*?\n  \}/)
    expect(deleteOrderMethod).toBeTruthy()

    const methodBody = deleteOrderMethod![0]
    expect(methodBody).toContain('UPDATE tasks SET order_id = NULL')
    expect(methodBody).toContain('UPDATE pending_confirmations SET order_id = NULL')

    const updateTasksPos = methodBody.indexOf('UPDATE tasks')
    const deleteOrdersPos = methodBody.indexOf('DELETE FROM orders')
    expect(updateTasksPos).toBeLessThan(deleteOrdersPos)
  })

  it('deleteTask correctly deletes pending_confirmations before tasks', () => {
    const dbContent = fs.readFileSync(path.join(projectRoot, 'electron/db/database.ts'), 'utf-8')
    const deleteTaskMethod = dbContent.match(/deleteTask\(id: number\)[\s\S]*?\n  \}/)
    expect(deleteTaskMethod).toBeTruthy()

    const pendingPos = deleteTaskMethod![0].indexOf('pending_confirmations')
    const tasksPos = deleteTaskMethod![0].indexOf('DELETE FROM tasks')
    expect(pendingPos).toBeLessThan(tasksPos)
  })
})

describe('IPC Channel Consistency', () => {
  it('should have matching IPC channels between preload and handlers/main', () => {
    const preloadContent = fs.readFileSync(path.join(projectRoot, 'electron/preload.ts'), 'utf-8')
    const handlersContent = fs.readFileSync(path.join(projectRoot, 'electron/ipc/handlers.ts'), 'utf-8')
    const mainContent = fs.readFileSync(path.join(projectRoot, 'electron/main.ts'), 'utf-8')

    const invokeChannels = [...preloadContent.matchAll(/ipcRenderer\.invoke\(['"]([^'"]+)['"]/g)].map(m => m[1])
    const handlerChannels = [...handlersContent.matchAll(/ipcMain\.handle\(['"]([^'"]+)['"]/g)].map(m => m[1])
    const mainChannels = [...mainContent.matchAll(/ipcMain\.handle\(['"]([^'"]+)['"]/g)].map(m => m[1])

    const allHandlerChannels = new Set([...handlerChannels, ...mainChannels])

    const eventChannels = new Set([
      'task:status-update',
      'app:ready',
      'sync:status-update',
      'task:notification-click',
    ])

    const missingInHandlers = invokeChannels.filter(ch => !eventChannels.has(ch) && !allHandlerChannels.has(ch))
    expect(missingInHandlers).toEqual([])
  })
})

describe('Payment Mode Consistency', () => {
  it('FIXED: paymentMode defaults are now consistent (cart_only)', () => {
    const dbContent = fs.readFileSync(path.join(projectRoot, 'electron/db/database.ts'), 'utf-8')
    const migrationContent = fs.readFileSync(path.join(projectRoot, 'electron/db/migrations.ts'), 'utf-8')

    const createTaskDefault = dbContent.match(/paymentMode\s*=\s*'(\w+)'/)?.[1]
    expect(createTaskDefault).toBe('cart_only')

    const v11Migration = migrationContent.match(/MIGRATION_V11[\s\S]*?UPDATE tasks SET payment_mode = 'cart_only'/)
    expect(v11Migration).toBeTruthy()
  })
})
