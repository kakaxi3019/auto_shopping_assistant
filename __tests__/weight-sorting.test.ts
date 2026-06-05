import { vi, describe, it, expect } from 'vitest'

vi.mock('electron', () => {
  return {
    app: {
      getPath: (name: string) => {
        if (name === 'userData') return './test-user-data'
        return '.'
      }
    }
  }
})

import { TaskExecutor } from '../electron/scheduler/task-executor'
import type { Database } from '../electron/db/database'

// Mock 数据库
class MockDatabase {
  private stats: Record<string, { count: number; lastPurchasedAt: string }> = {}

  setStats(stats: Record<string, { count: number; lastPurchasedAt: string }>) {
    this.stats = stats
  }

  getProductStats(productNames: string[]) {
    const result: Record<string, { count: number; lastPurchasedAt: string }> = {}
    for (const name of productNames) {
      if (this.stats[name]) {
        result[name] = this.stats[name]
      }
    }
    return result
  }
}

describe('商品历史匹配权重逻辑测试', () => {
  const db = new MockDatabase() as unknown as Database
  const executor = new TaskExecutor(db)

  it('规则一：当购买次数不同时，次数多的商品应该排在前面', () => {
    // 准备数据：
    // 商品 A: 购买过 5 次
    // 商品 B: 购买过 2 次
    ;(db as unknown as MockDatabase).setStats({
      '商品A': { count: 5, lastPurchasedAt: '2026-05-01 12:00:00' },
      '商品B': { count: 2, lastPurchasedAt: '2026-06-01 12:00:00' },
    })

    const candidates = [
      { id: 2, productName: '商品B', price: 15 },
      { id: 1, productName: '商品A', price: 20 },
    ]

    const sorted = (executor as any).sortCandidatesByUserPreference(candidates)
    expect(sorted[0].productName).toBe('商品A') // A 次数多，排前面
    expect(sorted[1].productName).toBe('商品B')
  })

  it('规则二：当购买次数相同，但购买时间相差大于 7 天时，近期购买的商品排在前面', () => {
    // 准备数据：
    // 商品 A: 购买过 2 次，最近购买时间 2026-05-01
    // 商品 B: 购买过 2 次，最近购买时间 2026-06-01 (比 A 近 31 天)
    ;(db as unknown as MockDatabase).setStats({
      '商品A': { count: 2, lastPurchasedAt: '2026-05-01 12:00:00' },
      '商品B': { count: 2, lastPurchasedAt: '2026-06-01 12:00:00' },
    })

    const candidates = [
      { id: 1, productName: '商品A', price: 20 },
      { id: 2, productName: '商品B', price: 15 },
    ]

    const sorted = (executor as any).sortCandidatesByUserPreference(candidates)
    expect(sorted[0].productName).toBe('商品B') // B 更近期，排前面
    expect(sorted[1].productName).toBe('商品A')
  })

  it('规则三：当购买次数相同，且购买时间在 7 天内，由价格决定（低价格优先）', () => {
    // 准备数据：
    // 商品 A: 购买 2 次，最近购买时间 2026-06-01，价格 20 元
    // 商品 B: 购买 2 次，最近购买时间 2026-06-03 (与 A 仅差 2 天，视为相同)，价格 15 元
    ;(db as unknown as MockDatabase).setStats({
      '商品A': { count: 2, lastPurchasedAt: '2026-06-01 12:00:00' },
      '商品B': { count: 2, lastPurchasedAt: '2026-06-03 12:00:00' },
    })

    const candidates = [
      { id: 1, productName: '商品A', price: 20 },
      { id: 2, productName: '商品B', price: 15 },
    ]

    const sorted = (executor as any).sortCandidatesByUserPreference(candidates)
    expect(sorted[0].productName).toBe('商品B') // B 价格更便宜，排前面
    expect(sorted[1].productName).toBe('商品A')
  })

  it('兜底逻辑：若次数、时间和价格完全一致，按 id 降序排列', () => {
    ;(db as unknown as MockDatabase).setStats({
      '商品A': { count: 1, lastPurchasedAt: '2026-06-01 12:00:00' },
      '商品B': { count: 1, lastPurchasedAt: '2026-06-01 12:00:00' },
    })

    const candidates = [
      { id: 1, productName: '商品A', price: 20 },
      { id: 2, productName: '商品B', price: 20 },
    ]

    const sorted = (executor as any).sortCandidatesByUserPreference(candidates)
    expect(sorted[0].id).toBe(2) // id 2 排在 id 1 前面
  })
})
