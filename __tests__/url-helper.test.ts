import { describe, it, expect } from 'vitest'

function isCheckoutOrPayPage(url: string): boolean {
  return url.includes('buy.tmall.com') ||
    url.includes('buy.taobao.com') ||
    url.includes('order.tmall.com') ||
    url.includes('order.taobao.com') ||
    url.includes('cashier') ||
    url.includes('checkout') ||
    url.includes('settlement') ||
    url.includes('submitOrder')
}

function isLoginPage(url: string): boolean {
  return url.includes('login.taobao.com') ||
    url.includes('login.tmall.com') ||
    url.includes('havanaone/login')
}

function isIdentityVerifyPage(url: string): boolean {
  return url.includes('passport.taobao.com/iv/') ||
    url.includes('identity_verify') ||
    url.includes('iv/identity')
}

function isDisposableUrl(url: string): boolean {
  if (!url) return false
  if (url.includes('confirm_order')) return true
  if (url.includes('cashier.')) return true
  if (url.includes('alipay.com')) return true
  if (url.includes('payresult')) return true
  if (url.includes('trade_success')) return true
  if (url.includes('tradeDetail')) return true
  if (url.includes('buyerPaySuccess')) return true
  if (url.includes('TmallConfirmOrderError')) return true
  if (url.includes('buy.taobao.com') || url.includes('buy.tmall.com')) return true
  return false
}

describe('url-helper', () => {
  describe('isCheckoutOrPayPage', () => {
    it('should detect checkout/pay pages', () => {
      expect(isCheckoutOrPayPage('https://buy.tmall.com/order/confirm_order.htm')).toBe(true)
      expect(isCheckoutOrPayPage('https://buy.taobao.com/auction.htm')).toBe(true)
      expect(isCheckoutOrPayPage('https://order.tmall.com/trade.htm')).toBe(true)
      expect(isCheckoutOrPayPage('https://order.taobao.com/trade.htm')).toBe(true)
      expect(isCheckoutOrPayPage('https://cashier.tmall.com/pay')).toBe(true)
      expect(isCheckoutOrPayPage('https://www.taobao.com/checkout')).toBe(true)
      expect(isCheckoutOrPayPage('https://www.taobao.com/settlement')).toBe(true)
      expect(isCheckoutOrPayPage('https://www.taobao.com/submitOrder')).toBe(true)
    })

    it('should not detect non-checkout pages', () => {
      expect(isCheckoutOrPayPage('https://www.taobao.com')).toBe(false)
      expect(isCheckoutOrPayPage('https://cart.taobao.com/cart.htm')).toBe(false)
      expect(isCheckoutOrPayPage('https://detail.tmall.com/item.htm')).toBe(false)
    })

    it('BUG: "cashier" substring matches too broadly', () => {
      expect(isCheckoutOrPayPage('https://www.example.com/cashier-report')).toBe(true)
      expect(isCheckoutOrPayPage('https://www.example.com/checkout-center')).toBe(true)
      expect(isCheckoutOrPayPage('https://www.example.com/settlement-guide')).toBe(true)
    })
  })

  describe('isLoginPage', () => {
    it('should detect login pages', () => {
      expect(isLoginPage('https://login.taobao.com/member/login.jhtml')).toBe(true)
      expect(isLoginPage('https://login.tmall.com/member/login.jhtml')).toBe(true)
      expect(isLoginPage('https://www.taobao.com/havanaone/login.htm')).toBe(true)
    })

    it('should not detect non-login pages', () => {
      expect(isLoginPage('https://www.taobao.com')).toBe(false)
      expect(isLoginPage('https://detail.tmall.com/item.htm')).toBe(false)
    })
  })

  describe('isIdentityVerifyPage', () => {
    it('should detect identity verify pages', () => {
      expect(isIdentityVerifyPage('https://passport.taobao.com/iv/verify.htm')).toBe(true)
      expect(isIdentityVerifyPage('https://www.taobao.com/identity_verify')).toBe(true)
      expect(isIdentityVerifyPage('https://www.taobao.com/iv/identity')).toBe(true)
    })
  })

  describe('isDisposableUrl', () => {
    it('should detect disposable URLs', () => {
      expect(isDisposableUrl('https://buy.tmall.com/confirm_order.htm')).toBe(true)
      expect(isDisposableUrl('https://cashier.tmall.com/pay')).toBe(true)
      expect(isDisposableUrl('https://www.alipay.com/pay')).toBe(true)
      expect(isDisposableUrl('https://www.taobao.com/payresult')).toBe(true)
      expect(isDisposableUrl('https://www.taobao.com/trade_success')).toBe(true)
      expect(isDisposableUrl('https://www.taobao.com/tradeDetail')).toBe(true)
      expect(isDisposableUrl('https://www.taobao.com/buyerPaySuccess')).toBe(true)
      expect(isDisposableUrl('https://buy.taobao.com/auction.htm')).toBe(true)
      expect(isDisposableUrl('https://buy.tmall.com/order.htm')).toBe(true)
    })

    it('should not detect non-disposable URLs', () => {
      expect(isDisposableUrl('https://www.taobao.com')).toBe(false)
      expect(isDisposableUrl('https://detail.tmall.com/item.htm')).toBe(false)
      expect(isDisposableUrl('https://cart.taobao.com/cart.htm')).toBe(false)
    })

    it('should handle empty/null URL', () => {
      expect(isDisposableUrl('')).toBe(false)
    })
  })
})
