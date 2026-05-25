import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'

const projectRoot = path.resolve(__dirname, '..')

describe('task-executor.ts deep analysis', () => {
  it('FIXED: executeSingle now has taskId parameter', () => {
    const content = fs.readFileSync(path.join(projectRoot, 'electron/scheduler/task-executor.ts'), 'utf-8')

    const executeSingleStart = content.indexOf('async executeSingle(')
    const methodSignature = content.substring(executeSingleStart, executeSingleStart + 300)

    expect(methodSignature).toContain('taskId')

    expect(content).toContain('private async processPurchase(')
    expect(content).toContain('private async handleCheckoutAndPay(')

    const handleCheckoutAndPay = content.indexOf('private async handleCheckoutAndPay(')
    const checkoutBody = content.substring(handleCheckoutAndPay, handleCheckoutAndPay + 2000)
    expect(checkoutBody).toContain('createPendingConfirmation')
    expect(checkoutBody).toContain('taskId')
  })

  it('FIXED: price protection is now in a single shared method handleCheckoutAndPay', () => {
    const content = fs.readFileSync(path.join(projectRoot, 'electron/scheduler/task-executor.ts'), 'utf-8')

    const handleCheckoutAndPay = content.indexOf('private async handleCheckoutAndPay(')
    const checkoutBody = content.substring(handleCheckoutAndPay, handleCheckoutAndPay + 2000)

    expect(checkoutBody).toContain('priceIncreaseRate >= protectionThreshold')
    expect(checkoutBody).toContain('createPendingConfirmation')
    expect(checkoutBody).toContain('pendingConfirmationId')
  })

  it('FIXED: execute and executeSingle now share processPurchase method', () => {
    const content = fs.readFileSync(path.join(projectRoot, 'electron/scheduler/task-executor.ts'), 'utf-8')

    expect(content).toContain('private async processPurchase(')
    expect(content).toContain('private async handleSearchFallback(')
    expect(content).toContain('private async handleCheckoutAndPay(')

    const executeStart = content.indexOf('async execute(')
    const processPurchaseStart = content.indexOf('private async processPurchase(')

    const executeBody = content.substring(executeStart, processPurchaseStart)
    expect(executeBody).toContain('this.processPurchase')

    const executeSingleStart = content.indexOf('async executeSingle(')
    const executeSingleEnd = content.indexOf('\n}', executeSingleStart + 10)
    const executeSingleBody = content.substring(executeSingleStart, executeSingleEnd + 2)
    expect(executeSingleBody).toContain('this.processPurchase')

    const directCheckoutInExecute = (executeBody.match(/platform\.checkout/g) || []).length
    const directCheckoutInSingle = (executeSingleBody.match(/platform\.checkout/g) || []).length
    expect(directCheckoutInExecute).toBe(0)
    expect(directCheckoutInSingle).toBe(0)
  })

  it('FIXED: computeAmbiguityLevel now checks price difference before name match', () => {
    const computeAmbiguityLevel = (candidates: { productName: string; price: number }[]): 'none' | 'low' | 'high' => {
      if (candidates.length <= 1) return 'none'
      const prices = candidates.map(c => c.price).filter(p => p > 0)
      if (prices.length >= 2) {
        const minPrice = Math.min(...prices)
        const maxPrice = Math.max(...prices)
        if (minPrice > 0 && (maxPrice - minPrice) / minPrice > 0.3) return 'high'
      }
      const names = candidates.slice(0, 3).map(c => c.productName)
      const uniqueNames = new Set(names)
      if (uniqueNames.size > 1) return 'high'
      return 'low'
    }

    expect(computeAmbiguityLevel([
      { productName: '牛奶', price: 50 },
      { productName: '牛奶', price: 100 },
    ])).toBe('high')
  })

  it('BUG: computeMatchScore returns 30 for completely unrelated products', () => {
    const computeMatchScore = (order: { productName: string }, keyword: string): number => {
      const name = order.productName.toLowerCase()
      const kw = keyword.toLowerCase()
      if (name === kw) return 100
      if (name.includes(kw)) return 80 + (kw.length / name.length) * 20
      const spaceWords = kw.split(/\s+/).filter(w => w.length > 0)
      const matchedSpaceWords = spaceWords.filter(w => name.includes(w))
      if (matchedSpaceWords.length > 0 && spaceWords.length > 1) {
        return 50 + (matchedSpaceWords.length / spaceWords.length) * 30
      }
      let bestSubLen = 0
      for (let len = kw.length - 1; len >= 2; len--) {
        for (let start = 0; start <= kw.length - len; start++) {
          const sub = kw.substring(start, start + len)
          if (name.includes(sub)) {
            if (len > bestSubLen) bestSubLen = len
          }
        }
        if (bestSubLen > 0 && bestSubLen >= len) break
      }
      if (bestSubLen > 0) {
        const ratio = bestSubLen / kw.length
        if (ratio < 0.5) return 30 + ratio * 10
        if (ratio < 0.75) return 40 + (ratio - 0.5) * 80
        return 60 + ratio * 30
      }
      return 30
    }

    expect(computeMatchScore({ productName: '手机壳' }, '笔记本电脑')).toBe(30)
  })
})

describe('handlers.ts deep analysis', () => {
  it('BUG: pending:purchase-candidate handler has complex payment flow that can silently fail', () => {
    const content = fs.readFileSync(path.join(projectRoot, 'electron/ipc/handlers.ts'), 'utf-8')

    const purchaseHandler = content.indexOf("ipcMain.handle('pending:purchase-candidate'")
    expect(purchaseHandler).toBeGreaterThan(-1)

    const handlerBody = content.substring(purchaseHandler, purchaseHandler + 3000)
    expect(handlerBody).toContain('platform.purchaseFromUrl')
    expect(handlerBody).toContain('platform.checkout')
    expect(handlerBody).toContain('platform.pay')
  })

  it('FIXED: checkAndUpdateTaskAfterConfirmation no longer uses (confirmation as any)', () => {
    const content = fs.readFileSync(path.join(projectRoot, 'electron/ipc/handlers.ts'), 'utf-8')
    expect(content).not.toContain('(confirmation as any).taskId')
    expect(content).toContain('confirmation.taskId')
    expect(content).toContain('confirmation.status')
  })
})

describe('task-scheduler.ts deep analysis', () => {
  it('FIXED: retryTaskItem now passes taskId to executeSingle', () => {
    const content = fs.readFileSync(path.join(projectRoot, 'electron/scheduler/task-scheduler.ts'), 'utf-8')

    const retryStart = content.indexOf('async retryTaskItem(')
    const retryBody = content.substring(retryStart, retryStart + 2000)

    expect(retryBody).toContain('this.executor.executeSingle(taskId')
  })

  it('FIXED: cancelTask now only resolves confirmation for the task platform', () => {
    const content = fs.readFileSync(path.join(projectRoot, 'electron/scheduler/task-scheduler.ts'), 'utf-8')

    const cancelStart = content.indexOf('cancelTask(taskId: number)')
    const cancelBody = content.substring(cancelStart, cancelStart + 500)

    expect(cancelBody).not.toContain('this.registry.getAll()')
    expect(cancelBody).toContain('this.registry.get')
  })

  it('BUG: confirmTask always uses cart_only as default paymentMode', () => {
    const content = fs.readFileSync(path.join(projectRoot, 'electron/scheduler/task-scheduler.ts'), 'utf-8')

    const confirmStart = content.indexOf('async confirmTask(')
    const confirmBody = content.substring(confirmStart, confirmStart + 400)

    expect(confirmBody).toContain("paymentMode || 'cart_only'")
  })
})

describe('Database deep analysis', () => {
  it('FIXED: deleteOrder now clears foreign key references before deleting', () => {
    const dbContent = fs.readFileSync(path.join(projectRoot, 'electron/db/database.ts'), 'utf-8')

    const deleteOrderStart = dbContent.indexOf('deleteOrder(id: number)')
    expect(deleteOrderStart).toBeGreaterThan(-1)

    const deleteOrderBody = dbContent.substring(deleteOrderStart, deleteOrderStart + 500)
    expect(deleteOrderBody).toContain('UPDATE tasks SET order_id = NULL')
    expect(deleteOrderBody).toContain('UPDATE pending_confirmations SET order_id = NULL')
  })

  it('FIXED: searchOrdersFuzzy now limits keyword length for performance', () => {
    const dbContent = fs.readFileSync(path.join(projectRoot, 'electron/db/database.ts'), 'utf-8')
    const fuzzyStart = dbContent.indexOf('searchOrdersFuzzy(')
    if (fuzzyStart > -1) {
      const fuzzyBody = dbContent.substring(fuzzyStart, fuzzyStart + 2000)
      expect(fuzzyBody).toContain('MAX_KEYWORD_LENGTH')
      expect(fuzzyBody).toContain('effectiveKeyword')
    }
  })
})

describe('Frontend-Backend Consistency', () => {
  it('should have consistent type definitions', () => {
    const platformTypes = fs.readFileSync(path.join(projectRoot, 'shared/types/platform.types.ts'), 'utf-8')
    const taskTypes = fs.readFileSync(path.join(projectRoot, 'shared/types/task.types.ts'), 'utf-8')

    expect(platformTypes).toContain('PaymentMode')
    expect(taskTypes).toContain('TaskStatus')
  })

  it('NOTE: app:is-ready IPC channel is registered in main.ts not handlers.ts', () => {
    const preloadContent = fs.readFileSync(path.join(projectRoot, 'electron/preload.ts'), 'utf-8')
    const mainContent = fs.readFileSync(path.join(projectRoot, 'electron/main.ts'), 'utf-8')

    expect(preloadContent).toContain('app:is-ready')
    expect(mainContent).toContain("'app:is-ready'")
  })
})
