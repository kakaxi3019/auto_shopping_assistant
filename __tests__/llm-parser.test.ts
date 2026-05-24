import { describe, it, expect } from 'vitest'

class LlmParserTestHelper {
  extractJson(text: string): string {
    let trimmed = text.trim()

    const thinkEnd = trimmed.indexOf('</think')
    if (thinkEnd !== -1) {
      const afterThink = trimmed.substring(thinkEnd)
      const closeAngle = afterThink.indexOf('>')
      if (closeAngle !== -1) {
        trimmed = trimmed.substring(thinkEnd + closeAngle + 1).trim()
      }
    }

    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try { JSON.parse(trimmed); return trimmed } catch { /* continue */ }
    }
    const lastBrace = trimmed.lastIndexOf('}')
    if (lastBrace !== -1) {
      let depth = 0
      for (let i = lastBrace; i >= 0; i--) {
        if (trimmed[i] === '}') depth++
        else if (trimmed[i] === '{') depth--
        if (depth === 0) {
          const candidate = trimmed.slice(i, lastBrace + 1)
          try { JSON.parse(candidate); return candidate } catch { break }
        }
      }
    }
    const lastBracket = trimmed.lastIndexOf(']')
    if (lastBracket !== -1) {
      let depth = 0
      for (let i = lastBracket; i >= 0; i--) {
        if (trimmed[i] === ']') depth++
        else if (trimmed[i] === '[') depth--
        if (depth === 0) {
          const candidate = trimmed.slice(i, lastBracket + 1)
          try { JSON.parse(candidate); return candidate } catch { break }
        }
      }
    }
    return trimmed
  }

  parseContent(content: string): any[] {
    try {
      const jsonStr = this.extractJson(content)
      const parsed = JSON.parse(jsonStr)
      const items = Array.isArray(parsed) ? parsed : parsed.items || parsed.shopping_list || [parsed]
      return items.map((item: Record<string, unknown>) => {
        const matchedOrders = Array.isArray(item.matchedOrders || item.matched_orders)
          ? (item.matchedOrders || item.matched_orders).map((m: Record<string, unknown>) => ({
              orderRef: Number(m.orderRef || m.order_ref || m.orderId || m.order_id || 0),
              confidence: Math.min(100, Math.max(0, Number(m.confidence || m.score || 50))),
            })).filter((m: { orderRef: number }) => m.orderRef > 0)
          : undefined
        return {
          name: String(item.name || item.product || item.item || ''),
          quantity: Number(item.quantity || item.qty || item.count || 1),
          sku: item.sku ? String(item.sku) : undefined,
          platform: item.platform ? String(item.platform) : undefined,
          orderRef: item.orderRef || item.order_ref || item.orderId || item.order_id
            ? Number(item.orderRef || item.order_ref || item.orderId || item.order_id)
            : undefined,
          matchedOrders,
        }
      })
    } catch {
      throw new Error(`LLM 返回格式解析失败: ${content}`)
    }
  }
}

describe('LlmParser - extractJson', () => {
  const helper = new LlmParserTestHelper()

  it('should extract clean JSON', () => {
    const input = '{"items":[{"name":"牛奶","quantity":1}]}'
    expect(helper.extractJson(input)).toBe(input)
  })

  it('should extract JSON with whitespace', () => {
    const input = '  \n  {"items":[{"name":"牛奶","quantity":1}]}  \n  '
    const result = helper.extractJson(input)
    expect(JSON.parse(result)).toEqual({ items: [{ name: '牛奶', quantity: 1 }] })
  })

  it('should extract JSON from think tags', () => {
    const input = '<think reasoning here>some thinking</think {"items":[{"name":"牛奶","quantity":1}]}'
    const result = helper.extractJson(input)
    expect(JSON.parse(result)).toEqual({ items: [{ name: '牛奶', quantity: 1 }] })
  })

  it('should extract JSON from markdown code blocks', () => {
    const input = '```json\n{"items":[{"name":"牛奶","quantity":1}]}\n```'
    const result = helper.extractJson(input)
    expect(JSON.parse(result)).toEqual({ items: [{ name: '牛奶', quantity: 1 }] })
  })

  it('should extract JSON from text with surrounding content', () => {
    const input = 'Here is the result:\n{"items":[{"name":"牛奶","quantity":1}]}\nDone.'
    const result = helper.extractJson(input)
    expect(JSON.parse(result)).toEqual({ items: [{ name: '牛奶', quantity: 1 }] })
  })

  it('should handle empty input', () => {
    const result = helper.extractJson('')
    expect(result).toBe('')
  })

  it('should handle invalid JSON gracefully', () => {
    const input = 'not json at all'
    const result = helper.extractJson(input)
    expect(result).toBe('not json at all')
  })
})

describe('LlmParser - parseContent', () => {
  const helper = new LlmParserTestHelper()

  it('should parse standard format', () => {
    const input = '{"items":[{"name":"牛奶","quantity":2}]}'
    const result = helper.parseContent(input)
    expect(result).toHaveLength(1)
    expect(result[0].name).toBe('牛奶')
    expect(result[0].quantity).toBe(2)
  })

  it('should parse with matchedOrders', () => {
    const input = '{"items":[{"name":"牛奶","quantity":1,"orderRef":5,"matchedOrders":[{"orderRef":5,"confidence":95}]}]}'
    const result = helper.parseContent(input)
    expect(result).toHaveLength(1)
    expect(result[0].orderRef).toBe(5)
    expect(result[0].matchedOrders).toHaveLength(1)
    expect(result[0].matchedOrders[0].orderRef).toBe(5)
    expect(result[0].matchedOrders[0].confidence).toBe(95)
  })

  it('should parse with snake_case keys', () => {
    const input = '{"items":[{"name":"牛奶","quantity":1,"order_ref":5,"matched_orders":[{"order_ref":5,"confidence":95}]}]}'
    const result = helper.parseContent(input)
    expect(result[0].orderRef).toBe(5)
    expect(result[0].matchedOrders).toHaveLength(1)
  })

  it('should default quantity to 1', () => {
    const input = '{"items":[{"name":"牛奶"}]}'
    const result = helper.parseContent(input)
    expect(result[0].quantity).toBe(1)
  })

  it('should filter out orderRef <= 0 in matchedOrders', () => {
    const input = '{"items":[{"name":"牛奶","matchedOrders":[{"orderRef":0,"confidence":50}]}]}'
    const result = helper.parseContent(input)
    expect(result[0].matchedOrders).toHaveLength(0)
  })

  it('should clamp confidence to 0-100', () => {
    const input = '{"items":[{"name":"牛奶","matchedOrders":[{"orderRef":1,"confidence":150}]}]}'
    const result = helper.parseContent(input)
    expect(result[0].matchedOrders[0].confidence).toBe(100)
  })

  it('should handle array format', () => {
    const input = '[{"name":"牛奶","quantity":1}]'
    const result = helper.parseContent(input)
    expect(result).toHaveLength(1)
    expect(result[0].name).toBe('牛奶')
  })

  it('should handle shopping_list format', () => {
    const input = '{"shopping_list":[{"name":"牛奶","quantity":1}]}'
    const result = helper.parseContent(input)
    expect(result).toHaveLength(1)
  })

  it('should throw on invalid JSON', () => {
    expect(() => helper.parseContent('not json')).toThrow('LLM 返回格式解析失败')
  })

  it('BUG: name defaults to empty string when item has no name/product/item', () => {
    const input = '{"items":[{"quantity":1}]}'
    const result = helper.parseContent(input)
    expect(result[0].name).toBe('')
  })
})
