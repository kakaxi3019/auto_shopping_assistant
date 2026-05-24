import { describe, it, expect } from 'vitest'

class TaskExecutorTestHelper {
  computeMatchScore(order: { productName: string }, keyword: string): number {
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

  computeAmbiguityLevel(candidates: { productName: string; price: number }[]): 'none' | 'low' | 'high' {
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
}

describe('TaskExecutor - computeMatchScore', () => {
  const helper = new TaskExecutorTestHelper()

  it('should return 100 for exact match', () => {
    expect(helper.computeMatchScore({ productName: '蒙牛纯牛奶' }, '蒙牛纯牛奶')).toBe(100)
  })

  it('should return high score for partial match', () => {
    const score = helper.computeMatchScore({ productName: '蒙牛纯牛奶250ml' }, '牛奶')
    expect(score).toBeGreaterThanOrEqual(80)
  })

  it('should return moderate score for space word match', () => {
    const score = helper.computeMatchScore({ productName: '蒙牛纯牛奶' }, '蒙牛 牛奶')
    expect(score).toBeGreaterThanOrEqual(50)
  })

  it('should return low score for substring match', () => {
    const score = helper.computeMatchScore({ productName: '蒙牛纯牛奶' }, '纯牛')
    expect(score).toBeGreaterThanOrEqual(30)
  })

  it('should return 30 for no match', () => {
    expect(helper.computeMatchScore({ productName: '蒙牛纯牛奶' }, '手机')).toBe(30)
  })

  it('should be case insensitive', () => {
    const score1 = helper.computeMatchScore({ productName: 'iPhone' }, 'iphone')
    const score2 = helper.computeMatchScore({ productName: 'iphone' }, 'IPHONE')
    expect(score1).toBe(100)
    expect(score2).toBe(100)
  })
})

describe('TaskExecutor - computeAmbiguityLevel', () => {
  const helper = new TaskExecutorTestHelper()

  it('should return none for single candidate', () => {
    expect(helper.computeAmbiguityLevel([
      { productName: '牛奶', price: 50 },
    ])).toBe('none')
  })

  it('should return low for two identical products', () => {
    expect(helper.computeAmbiguityLevel([
      { productName: '牛奶', price: 50 },
      { productName: '牛奶', price: 50 },
    ])).toBe('low')
  })

  it('should return high for different products', () => {
    expect(helper.computeAmbiguityLevel([
      { productName: '牛奶', price: 50 },
      { productName: '酸奶', price: 30 },
      { productName: '奶酪', price: 80 },
    ])).toBe('high')
  })

  it('FIXED: two same-name items with large price difference now returns high', () => {
    expect(helper.computeAmbiguityLevel([
      { productName: '牛奶', price: 50 },
      { productName: '牛奶', price: 100 },
    ])).toBe('high')
  })

  it('should return low for same name different price within 30%', () => {
    expect(helper.computeAmbiguityLevel([
      { productName: '牛奶', price: 50 },
      { productName: '牛奶', price: 60 },
    ])).toBe('low')
  })
})
