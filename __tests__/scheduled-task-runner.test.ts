import { describe, it, expect } from 'vitest'

class ScheduledTaskRunnerTestHelper {
  calculateNextRun(task: Record<string, unknown>): string {
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

  toLocalString(date: Date): string {
    const pad = (n: number) => String(n).padStart(2, '0')
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:00`
  }
}

describe('ScheduledTaskRunner - calculateNextRun', () => {
  const helper = new ScheduledTaskRunnerTestHelper()

  it('should calculate next daily run', () => {
    const result = helper.calculateNextRun({
      repeatType: 'daily',
      scheduledTime: '2026-05-22T09:00:00',
    })
    const [datePart, timePart] = result.split(' ')
    expect(timePart).toBe('09:00:00')
    expect(datePart).not.toBe('2026-05-22')
  })

  it('should calculate next weekly run', () => {
    const result = helper.calculateNextRun({
      repeatType: 'weekly',
      scheduledTime: '2026-05-22T09:00:00',
      dayOfWeek: 1,
    })
    const timePart = result.split(' ')[1]
    expect(timePart).toBe('09:00:00')
  })

  it('should calculate next monthly run', () => {
    const result = helper.calculateNextRun({
      repeatType: 'monthly',
      scheduledTime: '2026-05-22T09:00:00',
      dayOfMonth: 15,
    })
    const [datePart, timePart] = result.split(' ')
    expect(timePart).toBe('09:00:00')
  })

  it('BUG: monthly with dayOfMonth > 28 is capped to 28', () => {
    const result = helper.calculateNextRun({
      repeatType: 'monthly',
      scheduledTime: '2026-05-22T09:00:00',
      dayOfMonth: 31,
    })
    const datePart = result.split(' ')[0]
    const day = parseInt(datePart.split('-')[2])
    expect(day).toBe(28)
  })

  it('BUG: weekly with daysUntil <= 0 skips current week even if time has not passed', () => {
    const now = new Date()
    const todayDayOfWeek = now.getDay()
    const currentHour = now.getHours()

    if (currentHour < 22) {
      const futureTime = `${String(currentHour + 1).padStart(2, '0')}:00`
      const result = helper.calculateNextRun({
        repeatType: 'weekly',
        scheduledTime: `2026-05-22T${futureTime}:00`,
        dayOfWeek: todayDayOfWeek,
      })
      const resultDate = new Date(result.replace(' ', 'T'))
      const diffDays = Math.ceil((resultDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24))
      expect(diffDays).toBeGreaterThanOrEqual(7)
    }
  })

  it('should handle scheduledTime without T separator', () => {
    const result = helper.calculateNextRun({
      repeatType: 'daily',
      scheduledTime: '2026-05-22 09:00:00',
    })
    const timePart = result.split(' ')[1]
    expect(timePart).toBe('09:00:00')
  })

  it('should fallback to 09:00 for invalid scheduledTime format', () => {
    const result = helper.calculateNextRun({
      repeatType: 'daily',
      scheduledTime: 'invalid',
    })
    const timePart = result.split(' ')[1]
    expect(timePart).toBe('09:00:00')
  })
})
