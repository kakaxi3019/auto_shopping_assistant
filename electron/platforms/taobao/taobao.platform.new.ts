import { BrowserWindow, session } from 'electron'
import type { PlatformAdapter, Order, CheckoutResult, PayResult, AddToCartResult, SearchResult } from '../../../shared/types/platform.types'
import { TaobaoAuth } from './taobao.auth'
import type { Database } from '../../db/database'
import { BrowserManager } from './infrastructure/browser-manager'
import { WindowManager } from './infrastructure/window-manager'
import { CookieManager } from './infrastructure/cookie-manager'
import { InteractionService } from './services/interaction.service'
import { VerificationService } from './services/verification.service'
import { OrderService } from './services/order.service'
import { SearchService } from './services/search.service'
import { CartService } from './services/cart.service'
import { CheckoutService } from './services/checkout.service'
import { PaymentService } from './services/payment.service'
import { setUserAgent, debugLog, injectOverlayBanner, injectCenterToast } from './utils/page-helper'
import { APP_ICON } from './utils/constants'
import { isLoginPage, isIdentityVerifyPage, isCheckoutOrPayPage } from './utils/url-helper'
import { TAOBAO_SELECTORS } from './taobao.selectors'

export class TaobaoPlatform implements PlatformAdapter {
  name = 'taobao'

  private auth: TaobaoAuth
  private db: Database
  private destroyed = false
  private _statusCallbacks = new Map<number, (status: string) => void>()
  private _nextCallbackId = 0
  private _lastEmittedStatus = ''
  private _lastEmitTime = 0

  private browserManager: BrowserManager
  private windowManager: WindowManager
  private cookieManager: CookieManager
  private interactionService: InteractionService
  private verificationService: VerificationService
  private orderService: OrderService
  private searchService: SearchService
  private cartService: CartService
  private checkoutService: CheckoutService
  private paymentService: PaymentService

  constructor(db: Database) {
    this.db = db
    this.auth = new TaobaoAuth()

    this.browserManager = new BrowserManager()
    this.windowManager = new WindowManager()
    this.cookieManager = new CookieManager()

    this.interactionService = new InteractionService(
      this.windowManager,
      this.cookieManager,
      this.auth,
      (s: string) => this.emitStatus(s)
    )

    this.verificationService = new VerificationService(
      this.windowManager,
      this.cookieManager,
      this.auth,
      (s: string) => this.emitStatus(s),
      () => this.browserManager.getContext(),
      () => this.browserManager.getPage(),
      (p) => this.browserManager.setPage(p),
      () => this.destroyed
    )

    this.orderService = new OrderService(
      this.windowManager,
      this.cookieManager,
      this.auth,
      this.db,
      (s: string) => this.emitStatus(s)
    )

    this.searchService = new SearchService(
      this.windowManager,
      this.cookieManager,
      this.auth,
      (s: string) => this.emitStatus(s)
    )

    this.cartService = new CartService(
      this.browserManager,
      this.windowManager,
      this.cookieManager,
      this.verificationService,
      this.interactionService,
      this.auth,
      this.db,
      (s: string) => this.emitStatus(s),
      () => this.browserManager.getContext(),
      () => this.browserManager.getPage(),
      (p) => this.browserManager.setPage(p),
      () => this.destroyed
    )

    this.checkoutService = new CheckoutService(
      this.browserManager,
      this.windowManager,
      this.cookieManager,
      this.verificationService,
      this.auth,
      (s: string) => this.emitStatus(s),
      () => this.browserManager.getContext(),
      () => this.browserManager.getPage(),
      (p) => this.browserManager.setPage(p),
      () => this.destroyed
    )

    this.paymentService = new PaymentService(
      this.windowManager,
      this.cookieManager,
      this.interactionService,
      this.verificationService,
      this.auth,
      this.db,
      (s: string) => this.emitStatus(s),
      () => this.browserManager.getContext(),
      () => this.browserManager.getPage(),
      (p) => this.browserManager.setPage(p),
      () => this.destroyed
    )
  }

  private emitStatus(status: string) {
    const now = Date.now()
    if (status === this._lastEmittedStatus && now - this._lastEmitTime < 2000) return
    this._lastEmittedStatus = status
    this._lastEmitTime = now
    for (const callback of this._statusCallbacks.values()) {
      try { callback(status) } catch { /* ignore */ }
    }
  }

  onStatusChange(callback: (status: string) => void): () => void {
    const id = this._nextCallbackId++
    this._statusCallbacks.set(id, callback)
    return () => this._statusCallbacks.delete(id)
  }

  setMainWindow(win: BrowserWindow) {
    this.windowManager.setMainWindow(win)
  }

  destroy() {
    this.destroyed = true
    this.windowManager.cleanup()
    this.browserManager.cleanup()
  }

  async login(): Promise<boolean> {
    this.emitStatus('正在打开淘宝登录页...')

    this.windowManager.closeLoginWindow()

    return new Promise<boolean>((resolve) => {
      const mainWindow = this.windowManager.getMainWindow()
      if (!mainWindow) {
        this.emitStatus('主窗口未就绪')
        resolve(false)
        return
      }

      const loginWindow = this.windowManager.createLoginWindow()
      loginWindow.loadURL(TAOBAO_SELECTORS.LOGIN.LOGIN_PAGE)
      this.emitStatus('请在弹出的窗口中扫码登录...')

      let resolved = false
      const timeout = setTimeout(() => {
        if (!resolved) {
          resolved = true
          this.windowManager.closeLoginWindow()
          this.emitStatus('登录超时')
          resolve(false)
        }
      }, 1800000)

      const saveCookiesAndClose = async () => {
        if (resolved) return
        resolved = true
        clearTimeout(timeout)

        const allCookies = await session.defaultSession.cookies.get({})
        const taobaoCookies = allCookies.filter(
          (c) => c.domain.includes('taobao') || c.domain.includes('tmall') || c.domain.includes('alipay')
        )

        this.auth.saveElectronCookies(taobaoCookies)

        const context = this.browserManager.getContext()
        if (context && taobaoCookies.length > 0) {
          try {
            const playwrightCookies = taobaoCookies.map((c) => {
              let sameSite: 'Strict' | 'Lax' | 'None' = 'Lax'
              if (c.sameSite === 'no_restriction' || c.sameSite === 'None') {
                sameSite = c.secure ? 'None' : 'Lax'
              } else if (c.sameSite === 'strict' || c.sameSite === 'Strict') {
                sameSite = 'Strict'
              } else if (c.secure) {
                sameSite = 'None'
              }
              return {
                name: c.name,
                value: c.value,
                domain: c.domain,
                path: c.path,
                secure: c.secure,
                httpOnly: c.httpOnly,
                sameSite,
                ...(c.expirationDate && c.expirationDate > 0 ? { expires: c.expirationDate } : {}),
              }
            })
            await context.addCookies(playwrightCookies)
            console.log(`[Taobao] Synced ${playwrightCookies.length} cookies from login to Playwright context`)
          } catch (e) {
            console.log(`[Taobao] Failed to sync cookies to Playwright after login: ${e}`)
          }
        }

        this.windowManager.closeLoginWindow()
        this.emitStatus('登录成功，登录状态已保存')
        resolve(true)
      }

      loginWindow.webContents.on('did-navigate', async (_event, url) => {
        if (resolved) return
        if (url.includes('taobao.com') && !url.includes('login')) {
          await saveCookiesAndClose()
        }
      })

      loginWindow.webContents.on('did-finish-load', async () => {
        if (resolved) return
        try {
          const url = loginWindow?.webContents.getURL()
          if (url && url.includes('taobao.com') && !url.includes('login')) {
            await saveCookiesAndClose()
          }
        } catch { /* ignore */ }
      })

      loginWindow.on('closed', () => {
        if (!resolved) {
          resolved = true
          clearTimeout(timeout)
          this.windowManager.setLoginWindow(null)
          this.emitStatus('登录已取消')
          resolve(false)
        }
      })
    })
  }

  async isLoggedIn(): Promise<boolean> {
    return this.auth.hasSavedCookies()
  }

  getCookieAge(): string | null {
    return this.auth.getCookieAge()
  }

  async logout(): Promise<void> {
    this.auth.clearCookies()
    this.windowManager.closeLoginWindow()
    this.emitStatus('已退出登录')
  }

  async fetchOrderHistory(page?: number, timeRange?: { beginTime?: string; endTime?: string }): Promise<Order[]> {
    await this.cookieManager.syncCookiesToElectron(this.browserManager.getContext(), this.auth)
    return this.orderService.fetchOrderHistory(page, timeRange)
  }

  async searchOrders(keyword: string): Promise<Order[]> {
    return this.orderService.searchOrders(keyword)
  }

  async searchProduct(keyword: string): Promise<SearchResult[]> {
    await this.cookieManager.syncCookiesToElectron(this.browserManager.getContext(), this.auth)
    return this.searchService.searchProduct(keyword)
  }

  async openSearchPage(keyword: string): Promise<string | null> {
    await this.cookieManager.syncCookiesToElectron(this.browserManager.getContext(), this.auth)
    return this.searchService.openSearchPage(keyword)
  }

  getProductUrl(order: Order): string {
    return order.productUrl
  }

  async addToCart(productUrl: string, sku?: string, orderId?: string, cartOnly?: boolean): Promise<AddToCartResult> {
    return this.cartService.addToCart(productUrl, sku, orderId, cartOnly)
  }

  async openProductPage(productUrl: string): Promise<void> {
    this.emitStatus('正在打开商品页面...')

    if (!productUrl) {
      throw new Error('没有商品链接')
    }

    let fullUrl = productUrl
    if (fullUrl.startsWith('//')) fullUrl = 'https:' + fullUrl

    await this.cookieManager.syncCookiesToElectron(this.browserManager.getContext(), this.auth)

    await this.windowManager.closeShopWindow(async () => {
      await this.cookieManager.syncCookiesFromElectron(this.browserManager.getContext(), this.auth)
    })

    const shopWindow = this.windowManager.createShopWindow({ width: 1100, height: 750, show: true })
    shopWindow.setTitle('商品页面 - 请选择规格并购买')
    shopWindow.loadURL(fullUrl)

    shopWindow.on('closed', async () => {
      this.windowManager.setShopWindow(null)
      await this.cookieManager.syncCookiesFromElectron(this.browserManager.getContext(), this.auth)
    })

    this.emitStatus('已打开商品页面，请在弹出的窗口中选择规格并购买')
  }

  async purchaseFromUrl(productUrl: string): Promise<AddToCartResult> {
    return this.cartService.purchaseFromUrl(productUrl)
  }

  async checkout(directToPay?: boolean, quantity?: number): Promise<CheckoutResult> {
    return this.checkoutService.checkout(directToPay, quantity)
  }

  async pay(totalAmount?: number, dryRun?: boolean, paymentMode?: string): Promise<PayResult> {
    return this.paymentService.pay(totalAmount, dryRun, paymentMode)
  }

  async showPaymentWindow(title?: string): Promise<{ paid: boolean }> {
    return this.paymentService.showPaymentWindow(title)
  }

  async cleanup(): Promise<void> {
    this.destroy()
  }

  async resolveConfirmation(confirmed: boolean): Promise<void> {
    await this.interactionService.resolveConfirmation(confirmed, async () => {
      await this.cookieManager.syncCookiesFromElectron(this.browserManager.getContext(), this.auth)
    })
  }

  async reopenConfirmationWindow(): Promise<void> {
    await this.interactionService.reopenConfirmationWindow()
  }

  async openInteractionWindow(url: string): Promise<{ success: boolean; error?: string }> {
    try {
      debugLog(`[Taobao] openInteractionWindow called, url: ${url}`)

      debugLog(`[Taobao] openInteractionWindow: syncing cookies...`)
      await this.cookieManager.syncCookiesToElectron(this.browserManager.getContext(), this.auth)

      const cookies = await session.defaultSession.cookies.get({})
      const taobaoCookies = cookies.filter(c => c.domain.includes('taobao') || c.domain.includes('tmall'))
      debugLog(`[Taobao] openInteractionWindow: session has ${cookies.length} total cookies, ${taobaoCookies.length} taobao/tmall cookies`)

      const win = this.windowManager.createInteractionWindow(url)

      debugLog(`[Taobao] openInteractionWindow: BrowserWindow created, UA set`)

      win.webContents.setWindowOpenHandler(({ url: openUrl }) => {
        console.log('[Taobao] Interaction window open: ' + openUrl)
        return { action: 'allow', overrideBrowserWindowOptions: { show: false } }
      })

      win.webContents.on('did-create-window', (newWindow) => {
        setUserAgent(newWindow)
        newWindow.setIcon(APP_ICON)

        newWindow.webContents.on('did-navigate', async () => {
          const popupUrl = newWindow.webContents.getURL()
          if (isLoginPage(popupUrl)) {
            await this.verificationService.tryAutoLoginThenShow(newWindow)
          }
        })
        newWindow.webContents.on('did-finish-load', async () => {
          const popupUrl = newWindow.webContents.getURL()
          if (isLoginPage(popupUrl)) {
            await this.verificationService.tryAutoLoginThenShow(newWindow)
          }
        })
      })

      win.webContents.on('did-start-loading', () => {
        debugLog(`[Taobao] openInteractionWindow: did-start-loading`)
      })

      win.webContents.on('did-finish-load', () => {
        debugLog(`[Taobao] openInteractionWindow: did-finish-load, url: ${win.webContents.getURL()}`)
      })

      win.webContents.on('did-fail-load', (_event, errorCode, errorDesc, validatedURL) => {
        debugLog(`[Taobao] openInteractionWindow: did-fail-load, code: ${errorCode}, desc: ${errorDesc}, url: ${validatedURL}`)
      })

      debugLog(`[Taobao] openInteractionWindow: loading URL: ${url}`)
      injectOverlayBanner(win, "🛒 自动购物助手：需要选择商品规格，请在下方选择后点击对应按钮")
      injectCenterToast(win, "请在下方选择商品规格")
      debugLog(`[Taobao] openInteractionWindow: window shown`)
      return { success: true }
    } catch (e) {
      debugLog(`[Taobao] openInteractionWindow error: ${e}`)
      return { success: false, error: String(e) }
    }
  }
}
