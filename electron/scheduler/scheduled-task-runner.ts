import type { Database } from '../db/database'
import type { TaskScheduler } from './task-scheduler'
import type { PaymentMode } from '../../shared/types/platform.types'

export class ScheduledTaskRunner {
  private db: Database
  private scheduler: TaskScheduler
  private timer: NodeJS.Timeout | null = null
  private running = false

  constructor(db: Database, scheduler: TaskScheduler) {
    this.db = db
    this.scheduler = scheduler
  }

  start() {
    if (this.running) return
    this.running = true
    this.check()
    this.timer = setInterval(() => this.check(), 60000)
    console.log('[ScheduledTaskRunner] Started, checking every 60s')
  }

  stop() {
    this.running = false
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  private async check() {
    try {
      const dueTasks = this.db.getDueScheduledTasks()
      for (const task of dueTasks) {
        await this.executeTask(task)
      }
    } catch (e) {
      console.error('[ScheduledTaskRunner] Check error:', e)
    }
  }

  private async executeTask(task: Record<string, unknown>) {
    const id = task.id as number
    const instruction = task.instruction as string
    const repeatType = task.repeatType as string
    const dayOfWeek = task.dayOfWeek as number | null
    const dayOfMonth = task.dayOfMonth as number | null
    const taskPaymentMode = (task.paymentMode as string) || ''
    const platformName = (task.platform as string) || 'taobao'

    console.log(`[ScheduledTaskRunner] Executing scheduled task #${id}: ${instruction}`)
    this.db.markScheduledTaskRun(id)

    try {
      const preview = await this.scheduler.previewTask(instruction, platformName)
      let paymentMode: PaymentMode
      if (taskPaymentMode) {
        paymentMode = taskPaymentMode as PaymentMode
      } else {
        paymentMode = (this.db.getSetting('payment_mode') as PaymentMode) || 'cart_only'
      }
      await this.scheduler.confirmTask(instruction, preview.items, platformName, undefined, paymentMode, 'scheduled', repeatType, dayOfWeek, dayOfMonth)
    } catch (e) {
      console.error(`[ScheduledTaskRunner] Task #${id} execution failed:`, e)
    }

    if (repeatType === 'once') {
      this.db.updateScheduledTask(id, { enabled: false, nextRunAt: '' })
    } else {
      const nextRun = this.calculateNextRun(task)
      this.db.updateScheduledTask(id, { nextRunAt: nextRun })
    }
  }

  private calculateNextRun(task: Record<string, unknown>): string {
    const repeatType = task.repeatType as string
    const scheduledTime = task.scheduledTime as string
    const dayOfWeek = task.dayOfWeek as number | null
    const dayOfMonth = task.dayOfMonth as number | null

    const timePart = scheduledTime.includes('T')
      ? scheduledTime.split('T')[1].substring(0, 5)
      : scheduledTime.includes(' ')
        ? scheduledTime.split(' ')[1].substring(0, 5)
        : '09:00'

    const [hours, minutes] = timePart.split(':').map(Number)
    const now = new Date()

    if (repeatType === 'daily') {
      const next = new Date(now)
      next.setDate(next.getDate() + 1)
      next.setHours(hours, minutes, 0, 0)
      return this.toLocalString(next)
    }

    if (repeatType === 'weekly' && dayOfWeek != null) {
      const next = new Date(now)
      const currentDay = next.getDay()
      let daysUntil = dayOfWeek - currentDay
      if (daysUntil <= 0) daysUntil += 7
      next.setDate(next.getDate() + daysUntil)
      next.setHours(hours, minutes, 0, 0)
      return this.toLocalString(next)
    }

    if (repeatType === 'monthly' && dayOfMonth != null) {
      const next = new Date(now)
      next.setMonth(next.getMonth() + 1)
      next.setDate(Math.min(dayOfMonth, 28))
      next.setHours(hours, minutes, 0, 0)
      return this.toLocalString(next)
    }

    const next = new Date(now)
    next.setDate(next.getDate() + 1)
    next.setHours(hours, minutes, 0, 0)
    return this.toLocalString(next)
  }

  private toLocalString(date: Date): string {
    const pad = (n: number) => String(n).padStart(2, '0')
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:00`
  }
}
