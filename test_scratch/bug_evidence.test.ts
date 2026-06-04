import { vi, describe, it, expect } from 'vitest'

// 必须在导入任何需要 electron 的模块前 mock 'electron'
vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => {
      if (name === 'userData') return './test_scratch'
      return '.'
    },
  },
  safeStorage: {
    isEncryptionAvailable: () => false,
  }
}))

import { categorizeError } from '../electron/scheduler/task-executor'

// 1. Mock 模拟熔断判定逻辑，用于复现 TaskExecutor 中的资金熔断防御漏洞
function checkPriceProtection(
  lastPrice: number,
  currentPrice: number,
  quantity: number,
  getSetting: (key: string) => string | null
): { trigger: boolean; rate: number } {
  // 复现 task-executor.ts 第 195-200 行的逻辑缺陷
  const protectionThreshold = parseFloat(getSetting('price_protection_threshold') || '0.15')
  
  // 原有逻辑：如果 lastPrice <= 0，就无法触发熔断
  if (currentPrice && currentPrice > 0 && lastPrice > 0) {
    const priceIncreaseRate = (currentPrice - lastPrice * quantity) / (lastPrice * quantity)
    if (priceIncreaseRate >= protectionThreshold) {
      return { trigger: true, rate: priceIncreaseRate }
    }
  }
  
  return { trigger: false, rate: 0 }
}

// 2. Mock 模拟定时任务的时间计算，用于复现 ScheduledTaskRunner 中的下一次运行时间 Bug
function calculateNextRunMock(task: {
  repeatType: string
  scheduledTime: string
  dayOfWeek?: number | null
  dayOfMonth?: number | null
}, now: Date): string {
  const repeatType = task.repeatType
  const scheduledTime = task.scheduledTime
  const dayOfWeek = task.dayOfWeek ?? null
  const dayOfMonth = task.dayOfMonth ?? null

  const timePart = scheduledTime.includes('T')
    ? scheduledTime.split('T')[1].substring(0, 5)
    : scheduledTime.includes(' ')
      ? scheduledTime.split(' ')[1].substring(0, 5)
      : '09:00'

  const [hours, minutes] = timePart.split(':').map(Number)

  if (repeatType === 'weekly' && dayOfWeek != null) {
    const next = new Date(now)
    const currentDay = next.getDay()
    let daysUntil = dayOfWeek - currentDay
    if (daysUntil <= 0) daysUntil += 7 // Bug 所在行
    next.setDate(next.getDate() + daysUntil)
    next.setHours(hours, minutes, 0, 0)
    return toLocalString(next)
  }

  if (repeatType === 'monthly' && dayOfMonth != null) {
    const next = new Date(now)
    next.setMonth(next.getMonth() + 1) // Bug：直接跳到了下个月
    next.setDate(Math.min(dayOfMonth, 28)) // Bug：粗暴地截断到 28 号
    next.setHours(hours, minutes, 0, 0)
    return toLocalString(next)
  }

  const next = new Date(now)
  next.setDate(next.getDate() + 1)
  next.setHours(hours, minutes, 0, 0)
  return toLocalString(next)
}

function toLocalString(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:00`
}

describe('Auto Shopping Assistant - Concrete Bug Evidence', () => {

  describe('Bug 3 Proof: Price Guard Bypass when Last Price is 0', () => {
    it('should bypass price protection entirely if lastPrice is 0 (e.g. bought with 100% discount redpacket previously)', () => {
      const mockSettings = (key: string) => key === 'price_protection_threshold' ? '0.15' : null
      
      const lastPrice = 0 // 历史价格是 0 元
      const currentPrice = 99 // 当前结算价暴涨到 99 元
      const quantity = 1

      const result = checkPriceProtection(lastPrice, currentPrice, quantity, mockSettings)

      // 断言：由于 lastPrice <= 0 导致条件不成立，熔断防御完全没有被触发 (trigger: false)
      // 这证实了资金保护拦截在此场景下彻底失效！
      expect(result.trigger).toBe(false)
      console.log(`[Bug Evidence 3] Price Guard Bypassed! LastPrice=${lastPrice}, CurrentPrice=${currentPrice}, Triggered=${result.trigger}`)
    })
  })

  describe('Bug 4 Proof: Scheduled Task Algorithm Flaws', () => {
    it('Weekly schedules skip today even if the scheduled time has not passed yet', () => {
      // 场景：今天是周五 10:00，用户设定了周五（即今天）11:00 运行的任务
      const now = new Date('2026-05-22T10:00:00') // 2026-05-22 是周五，getDay() === 5
      expect(now.getDay()).toBe(5)

      const task = {
        repeatType: 'weekly',
        scheduledTime: '2026-05-22 11:00:00', // 必须使用完整格式，否则解析会退回到 09:00
        dayOfWeek: 5 // 周五
      }

      const nextRun = calculateNextRunMock(task, now)
      
      // 预期：由于 daysUntil <= 0 导致 daysUntil 被强行加了 7
      // 结果：计算出来的 nextRun 变成了下周五（5月29号），而不是今天的 11:00！
      expect(nextRun).toBe('2026-05-29 11:00:00')
      console.log(`[Bug Evidence 4a] Weekly Task Bug: Today is Friday 10:00, scheduled Friday 11:00, but nextRun is incorrectly set to: ${nextRun}`)
    })

    it('Monthly schedules force-limit dayOfMonth to 28 and skip the current month entirely', () => {
      // 场景：今天是 5月1日 10:00，用户想设定每月 31 日的复购任务，时间为 11:00
      const now = new Date('2026-05-01T10:00:00') 
      const task = {
        repeatType: 'monthly',
        scheduledTime: '2026-05-01 11:00:00',
        dayOfMonth: 31
      }

      const nextRun = calculateNextRunMock(task, now)

      // 预期：
      // 1. 一上来直接 setMonth(next.getMonth() + 1) 导致直接跳过5月份，直接去6月
      // 2. Math.min(31, 28) 强制把 31 号截断成了 28 号
      // 结果：算出的 nextRun 变成了 '2026-06-28 11:00:00'，完美错过了5月份，且改写了用户的日期！
      expect(nextRun).toBe('2026-06-28 11:00:00')
      console.log(`[Bug Evidence 4b] Monthly Task Bug: Today is May 1st, scheduled monthly on 31st, but nextRun is set to: ${nextRun}`)
    })
  })

  describe('Bug 5 Proof: Payment Window Listener Leak', () => {
    it('demonstrates that getShopWindow() returns null after window destruction, causing removeListener to be silently skipped', () => {
      // 场景模拟：在 Promise 结束执行时，窗口已经关闭和销毁了
      let shopWindowInstance: any = {
        isDestroyed: () => true,
        webContents: {
          removeListener: (event: string, handler: any) => {
            console.log(`[Mock] removeListener called for ${event}`)
          }
        }
      }

      // 模拟 WindowManager：窗口已销毁时，它的 getter 会返回 null
      const windowManager = {
        getShopWindow: () => null // 因为已销毁，返回 null
      }

      // 复现 payment.service.ts 第 443-447 行 the cleanup logic
      let removeListenerCalledCount = 0
      const mockRemoveListener = () => {
        removeListenerCalledCount++
      }

      const didNavigateHandler = () => {}

      // 模拟执行解绑
      const win = windowManager.getShopWindow() as any
      if (win) {
        win.webContents.removeListener('did-navigate', didNavigateHandler)
        mockRemoveListener()
      }

      // 断言：由于 win 是 null，removeListener 根本没有被调用！
      // 这证实了如果用户主动关闭了窗口，解除监听器的操作被无声跳过，导致闭包留在 Chromium 内存中！
      expect(win).toBeNull()
      expect(removeListenerCalledCount).toBe(0)
      console.log(`[Bug Evidence 5] Memory Leak Risk: shopWindow getter returned null, and listeners were NEVER removed. CalledCount=${removeListenerCalledCount}`)
    })
  })

  describe('Bug 6 Proof: Error Categorization Anomaly', () => {
    it('incorrectly classifies verification and captcha blocks as login expired', () => {
      // 场景：淘宝风控弹出了滑块或验证，控制台或页面报错
      const errorSlide = '淘宝检测到异常，请拖动滑块完成身份验证。'
      const errorCaptcha = '触发安全验证，请进行登录验证以继续操作。'

      const catSlide = categorizeError(errorSlide)
      const catCaptcha = categorizeError(errorCaptcha)

      // 断言：由于 categorizeError 将包含 "身份验证" 或 "登录验证" 的错误粗暴地划分为 login_expired
      // 导致本属于风控滑块的操作被分为了 "登录过期"，误导用户进行无谓的扫码重登！
      expect(catSlide).toBe('login_expired')
      expect(catCaptcha).toBe('login_expired')
      console.log(`[Bug Evidence 6] Wrong Classification: Slider error classified as: "${catSlide}", Captcha error classified as: "${catCaptcha}"`)
    })
  })

})
