export function isCheckoutOrPayPage(url: string): boolean {
  return url.includes('buy.tmall.com') ||
    url.includes('buy.taobao.com') ||
    url.includes('order.tmall.com') ||
    url.includes('order.taobao.com') ||
    url.includes('cashier') ||
    url.includes('checkout') ||
    url.includes('settlement') ||
    url.includes('submitOrder')
}

export function isLoginPage(url: string): boolean {
  return url.includes('login.taobao.com') ||
    url.includes('login.tmall.com') ||
    url.includes('havanaone/login')
}

export function isIdentityVerifyPage(url: string): boolean {
  return url.includes('passport.taobao.com/iv/') ||
    url.includes('identity_verify') ||
    url.includes('iv/identity')
}

export function isDisposableUrl(url: string): boolean {
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
