import { describe, it, expect } from 'vitest'

function categorizeError(error?: string): 'out_of_stock' | 'login_expired' | 'not_supported' | 'network_error' | 'no_history' | 'other' {
  if (!error) return 'other'
  if (error.includes('已下架') || error.includes('商品已下架') || error.includes('已售罄') || error.includes('商品不存在')) return 'out_of_stock'
  if (error.includes('登录已过期') || error.includes('未登录') || error.includes('登录验证') || error.includes('身份验证')) return 'login_expired'
  if (error.includes('不支持再买一单') || error.includes('未找到再买一单') || error.includes('不支持再买')) return 'not_supported'
  if (error.includes('Timeout') || error.includes('timeout') || error.includes('网络') || error.includes('ERR_') || error.includes('net::')) return 'network_error'
  if (error.includes('未找到历史订单') || error.includes('没有历史')) return 'no_history'
  return 'other'
}

describe('task-executor - categorizeError', () => {
  it('should categorize out_of_stock errors', () => {
    expect(categorizeError('商品已下架')).toBe('out_of_stock')
    expect(categorizeError('已下架')).toBe('out_of_stock')
    expect(categorizeError('已售罄')).toBe('out_of_stock')
    expect(categorizeError('商品不存在')).toBe('out_of_stock')
  })

  it('should categorize login_expired errors', () => {
    expect(categorizeError('登录已过期')).toBe('login_expired')
    expect(categorizeError('未登录')).toBe('login_expired')
    expect(categorizeError('登录验证')).toBe('login_expired')
    expect(categorizeError('身份验证')).toBe('login_expired')
  })

  it('should categorize not_supported errors', () => {
    expect(categorizeError('不支持再买一单')).toBe('not_supported')
    expect(categorizeError('未找到再买一单')).toBe('not_supported')
    expect(categorizeError('不支持再买')).toBe('not_supported')
  })

  it('should categorize network_error errors', () => {
    expect(categorizeError('Timeout')).toBe('network_error')
    expect(categorizeError('timeout')).toBe('network_error')
    expect(categorizeError('网络错误')).toBe('network_error')
    expect(categorizeError('ERR_CONNECTION')).toBe('network_error')
    expect(categorizeError('net::ERR_FAILED')).toBe('network_error')
  })

  it('should categorize no_history errors', () => {
    expect(categorizeError('未找到历史订单')).toBe('no_history')
    expect(categorizeError('没有历史')).toBe('no_history')
  })

  it('should categorize other errors', () => {
    expect(categorizeError('未知错误')).toBe('other')
    expect(categorizeError('')).toBe('other')
    expect(categorizeError(undefined)).toBe('other')
  })

  it('BUG: "身份验证" is categorized as login_expired but could also mean captcha verification', () => {
    expect(categorizeError('身份验证')).toBe('login_expired')
  })
})
