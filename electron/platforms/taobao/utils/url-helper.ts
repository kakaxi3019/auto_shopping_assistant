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

export function isBuyPage(url: string): boolean {
  return isCheckoutOrPayPage(url) ||
    url.includes('buy.tmall.com') ||
    url.includes('buy.taobao.com')
}

export function isProductDetailPage(url: string): boolean {
  return url.includes('detail.tmall.com') ||
    url.includes('item.taobao.com') ||
    url.includes('detail.1688.com')
}

export function isCartPage(url: string): boolean {
  return url.includes('cart.taobao.com')
}

export function isOrderArchivePage(url: string): boolean {
  return url.includes('tradearchive.taobao.com')
}

export function isOrderDetailPage(url: string): boolean {
  return url.includes('trade.tmall.com') ||
    url.includes('trade.taobao.com') ||
    url.includes('buyertrade.taobao.com')
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

export function isErrorPage(url: string): boolean {
  if (!url) return false
  if (url.includes('index_error.html')) return true
  if (url.includes('error.html')) return true
  if (url.includes('huodong.m.taobao.com/hd/')) return true
  if (url.includes('page_not_found')) return true
  if (url.includes('item-not-found')) return true
  if (url.includes('notfound')) return true
  return false
}
