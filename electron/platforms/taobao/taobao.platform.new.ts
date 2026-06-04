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
import { CabinController } from '../../cabin/cabin-controller'
import { setUserAgent, injectOverlayBanner, injectCenterToast } from './utils/page-helper'
import { APP_ICON } from './utils/constants'
import { isLoginPage, isIdentityVerifyPage, isCheckoutOrPayPage } from './utils/url-helper'
import { TAOBAO_SELECTORS } from './taobao.selectors'
import { debugLog } from '../../utils/debug-log'

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
  private cabinController: CabinController | null = null
  private _cabinPayResolve: ((confirmed: boolean) => void) | null = null
  private _cabinCartResolve: ((confirmed: boolean) => void) | null = null
  private _cabinSearchResolve: ((confirmed: boolean) => void) | null = null

  constructor(db: Database) {
    this.db = db
    this.auth = new TaobaoAuth()

    this.browserManager = new BrowserManager()
    this.windowManager = new WindowManager()
    this.cookieManager = new CookieManager()

    this.interactionService = new InteractionService(
      this.cookieManager,
      this.windowManager,
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
    this.cabinController = new CabinController(this.windowManager)
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
    this.cabinController?.setMainWindow(win)
  }

  destroy() {
    this.destroyed = true
    this.cabinController?.cleanup()
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
              const sameSite = this.cookieManager.toPlaywrightSameSite(c.sameSite, c.secure)
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

  cancelSync() {
    this.orderService.cancelSync()
  }

  async searchOrders(keyword: string): Promise<Order[]> {
    return this.orderService.searchOrders(keyword)
  }

  async searchProduct(keyword: string): Promise<SearchResult[]> {
    await this.cookieManager.syncCookiesToElectron(this.browserManager.getContext(), this.auth)
    return this.searchService.searchProduct(keyword)
  }

  async openSearchPage(keyword: string): Promise<string | null> {
    if (this.windowManager.cabinOpen && this.cabinController) {
      return this.cabinOpenSearchPage(keyword)
    }
    await this.cookieManager.syncCookiesToElectron(this.browserManager.getContext(), this.auth)
    return this.searchService.openSearchPage(keyword)
  }

  getProductUrl(order: Order): string {
    return order.productUrl
  }

  async addToCart(productUrl: string, sku?: string, orderId?: string, cartOnly?: boolean): Promise<AddToCartResult> {
    debugLog('DIAG', `[addToCart] 入口触发. cabinOpen=${this.windowManager.cabinOpen}, cabinController=${!!this.cabinController}, orderId=${orderId}`)
    console.log(`[DIAG] [addToCart] 入口触发. cabinOpen=${this.windowManager.cabinOpen}, cabinController=${!!this.cabinController}, orderId=${orderId}`)
    if (this.windowManager.cabinOpen && this.cabinController) {
      debugLog('DIAG', `[addToCart] 走向 Webview 舱内加购分支 (cabinAddToCart)`)
      console.log(`[DIAG] [addToCart] 走向 Webview 舱内加购分支 (cabinAddToCart)`)
      return this.cabinAddToCart(productUrl, sku, orderId, cartOnly)
    }
    debugLog('DIAG', `[addToCart] 走向后台 Playwright 静默加购分支 (cartService.addToCart)`)
    console.log(`[DIAG] [addToCart] 走向后台 Playwright 静默加购分支 (cartService.addToCart)`)
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
    if (this.windowManager.cabinOpen && this.cabinController) {
      return this.cabinPurchaseFromUrl(productUrl)
    }
    return this.cartService.purchaseFromUrl(productUrl)
  }

  async checkout(directToPay?: boolean, quantity?: number): Promise<CheckoutResult> {
    if (this.windowManager.cabinOpen && this.cabinController) {
      return this.cabinCheckout(directToPay, quantity)
    }
    return this.checkoutService.checkout(directToPay, quantity)
  }

  async pay(totalAmount?: number, dryRun?: boolean, paymentMode?: string): Promise<PayResult> {
    if (dryRun) {
      this.emitStatus(`测试模式：跳过实际支付（预计金额 ¥${totalAmount?.toFixed(2)}）`)
      return { success: true, transactionId: 'TEST_MODE_SKIPPED' }
    }
    if (this.windowManager.cabinOpen && this.cabinController) {
      return this.cabinPay(totalAmount, paymentMode)
    }
    return this.paymentService.pay(totalAmount, dryRun, paymentMode)
  }

  async showPaymentWindow(title?: string): Promise<{ paid: boolean }> {
    return this.paymentService.showPaymentWindow(title)
  }

  async cleanup(): Promise<void> {
    this.windowManager.cleanup()
  }

  async resolveConfirmation(confirmed: boolean): Promise<void> {
    // 如果有 cabin 支付等待中，先处理
    if (this._cabinPayResolve) {
      const resolve = this._cabinPayResolve
      this._cabinPayResolve = null
      resolve(confirmed)
      return
    }
    // 如果有 cabin 加购等待中，先处理
    if (this._cabinCartResolve) {
      const resolve = this._cabinCartResolve
      this._cabinCartResolve = null
      resolve(confirmed)
      return
    }
    // 如果有 cabin 搜索等待中，先处理
    if (this._cabinSearchResolve) {
      const resolve = this._cabinSearchResolve
      this._cabinSearchResolve = null
      resolve(confirmed)
      return
    }
    if (confirmed) {
      await this.cookieManager.syncCookiesFromElectron(this.browserManager.getContext(), this.auth)
    }
    await this.interactionService.resolveConfirmation(confirmed)
    this.windowManager.cabinDisplayMode = 'auto'
  }

  async reopenConfirmationWindow(): Promise<void> {
    await this.interactionService.reopenConfirmationWindow()
  }

  async openInteractionWindow(url: string, bannerMessage?: string): Promise<{ success: boolean; error?: string }> {
    try {
      await this.cookieManager.syncCookiesToElectron(this.browserManager.getContext(), this.auth)

      const win = this.windowManager.createInteractionWindow(url)

      win.webContents.setWindowOpenHandler(({ url: openUrl }) => {
        return { action: 'allow', overrideBrowserWindowOptions: { show: false, webPreferences: { backgroundThrottling: false } } }
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

      win.webContents.on('did-finish-load', () => {
      })

      win.webContents.on('did-fail-load', (_event, errorCode, errorDesc, validatedURL) => {
        console.error(`[Taobao] openInteractionWindow: did-fail-load, code: ${errorCode}, desc: ${errorDesc}, url: ${validatedURL}`)
      })

      injectOverlayBanner(win, bannerMessage || "🛒 自动购物助手：需要选择商品规格，请在下方选择后点击对应按钮")
      injectCenterToast(win, bannerMessage ? bannerMessage.replace(/^[^\s]+\s/, '') : "请在下方选择商品规格")
      return { success: true }
    } catch (e) {
      console.error(`[Taobao] openInteractionWindow error: ${e}`)
      return { success: false, error: String(e) }
    }
  }

  /**
   * 操作舱内的加购流程
   */
  private async cabinAddToCart(productUrl: string, sku?: string, orderId?: string, cartOnly?: boolean): Promise<AddToCartResult> {
    const cabin = this.cabinController!
    debugLog('DIAG', `[cabinAddToCart] 开始执行. productUrl=${productUrl}, orderId=${orderId}`)
    console.log(`[DIAG] [cabinAddToCart] 开始执行. productUrl=${productUrl}, orderId=${orderId}`)
    await this.cookieManager.syncCookiesToElectron(this.browserManager.getContext(), this.auth, true)
    
    // 如果有历史订单 ID，走复购加购逻辑
    if (orderId) {
      this.emitStatus('正在打开订单详情页...')
      let shopName = ''
      try {
        const localOrders = this.db.getOrders('taobao', 1000)
        const matchedOrder = localOrders.find(o => o.orderId === orderId)
        if (matchedOrder) {
          shopName = matchedOrder.shopName || ''
          debugLog('DIAG', `[cabinAddToCart] 获取本地订单成功. shopName=${shopName}`)
        }
      } catch (e) {
        debugLog('DIAG', `[cabinAddToCart] 获取本地订单 shopName 失败: ${e}`)
      }

      let orderUrl = `https://buyertrade.taobao.com/trade/detail/trade_item_detail.htm?bizOrderId=${orderId}`
      const isTmall = (productUrl && (productUrl.includes('tmall.com') || productUrl.includes('tmall.hk') || productUrl.includes('tmall.cn'))) ||
                      (shopName && (shopName.includes('旗舰店') || shopName.includes('专卖店') || shopName.includes('专营店') || shopName.includes('天猫') || shopName.toLowerCase().includes('tmall')))
      if (isTmall) {
        orderUrl = `https://trade.tmall.com/detail/orderDetail.htm?bizOrderId=${orderId}`
        debugLog('DIAG', `[cabinAddToCart] 判定该商品为天猫订单，直接直连天猫原生 URL: ${orderUrl}`)
      } else {
        debugLog('DIAG', `[cabinAddToCart] 判定该商品为淘宝订单，加载淘宝买家详情页 URL: ${orderUrl}`)
      }
      await cabin.navigate(orderUrl)
      // 强制视觉停留 4.5 秒，让用户清晰确认订单详情加载过程
      await new Promise(r => setTimeout(r, 4500))

      // 检查当前页面状态
      let features = await cabin.detectPageFeatures()
      if (features.hasLoginForm) {
        return { success: false, error: '登录已过期，请重新登录' }
      }

      if (features.hasCaptcha) {
        cabin.setMode('interactive')
        this.emitStatus('需要完成安全验证，请在操作舱中操作')
        const newUrl = await cabin.waitForUrlMatch(['trade_item_detail', 'cart', 'buy'], 300000)
        cabin.setMode('auto')
        if (!newUrl) {
          return { success: false, error: '安全验证超时' }
        }
        features = await cabin.detectPageFeatures()
      }

      this.emitStatus('正在点击"再买一单"按钮...')
      const clicked = await cabin.findAndClickButton(['再买一单', '再次购买', '追加'])
      if (!clicked) {
        // 按钮点击失败，立即启动大诊断探针，抓取页面实时状态
        const diagFeatures = await cabin.detectPageFeatures()
        const bodyHtml = await cabin.executeJs(`document.body?.innerHTML?.substring(0, 800)`).catch(() => 'unknown')
        debugLog('DIAG', `[cabinAddToCart] 再买一单点击失败诊断. 当前实际加载的 URL: ${diagFeatures.url}`)
        debugLog('DIAG', `[cabinAddToCart] 诊断 bodyText: ${diagFeatures.bodyTextPreview}`)
        debugLog('DIAG', `[cabinAddToCart] 诊断 bodyHtml(前800字): ${bodyHtml}`)

        // 只有当前页面确实是订单详情页时，才判断下架特征
        const isOrderDetailUrl = diagFeatures.url.includes('trade_item_detail') || diagFeatures.url.includes('detail.htm') || diagFeatures.url.includes('orderDetail')
        if (isOrderDetailUrl && (diagFeatures.bodyTextPreview.includes('下架') || diagFeatures.bodyTextPreview.includes('失效') || diagFeatures.bodyTextPreview.includes('不存在'))) {
          this.emitStatus('⚠️ 提示：检测到该订单商品已下架或失效，正在为您原地打开搜索兜底...')
          await new Promise(r => setTimeout(r, 3500))
          return { success: false, error: '商品不可购买（下架啦）' }
        }
        
        // 如果被跳到了其它页面（比如首页），代表登录失效或状态异常，提示接管
        if (!isOrderDetailUrl) {
          cabin.setMode('interactive')
          this.emitStatus('未能成功加载订单详情，请在操作舱内手动登录或操作，完成后点击下方"我已完成"')
          return new Promise<AddToCartResult>((resolve) => {
            this._cabinCartResolve = async (confirmed: boolean) => {
              cabin.setMode('auto')
              if (confirmed) {
                const finalFeatures = await cabin.detectPageFeatures()
                const isBuyPage = finalFeatures.url.includes('buy.taobao.com') || finalFeatures.url.includes('buy.tmall.com')
                resolve({ success: true, directToPay: isBuyPage })
              } else {
                resolve({ success: false, error: '未能成功打开订单页' })
              }
            }
          })
        }
        
        return { success: false, error: '未在订单详情页找到"再买一单"按钮' }
      }

      this.emitStatus('已点击再买一单，等待页面跳转...')
      
      // 自动击穿天猫或淘宝可能弹出的"即将进行页面跳转"二次拦截确认框
      // 快速连续探测 3 次，间隔 800ms，确保捕获到刚渲染的确认按钮
      for (let probeIdx = 0; probeIdx < 3; probeIdx++) {
        try {
          await new Promise(r => setTimeout(r, 800))
          const popped = await cabin.findAndClickButton(['继续访问', '确定', '继续', '确定继续', '允许', '我知道了', '仍要离开', '离开此页'])
          if (popped) {
            debugLog('DIAG', `[cabinAddToCart] 第${probeIdx + 1}次探测成功击穿跳转确认弹窗！`)
            break
          }
          debugLog('DIAG', `[cabinAddToCart] 第${probeIdx + 1}次探测未发现确认按钮，继续...`)
        } catch (e) {
          debugLog('DIAG', `[cabinAddToCart] 第${probeIdx + 1}次探测击穿跳转确认弹窗报错: ${e}`)
        }
      }
      
      // 等待跳转并识别最终页面特征
      for (let attempt = 0; attempt < 15; attempt++) {
        await new Promise(r => setTimeout(r, 1500))
        let pageFeatures = await cabin.detectPageFeatures()

        // 核心突破：在跳转大循环中，高频自动检测并击穿任何可能悬浮或重定向的"即将进行页面跳转"中转页或 HTML 确认浮层
        try {
          const hasJumpFeature = pageFeatures.url.includes('link.taobao') || 
                                 pageFeatures.url.includes('jump') || 
                                 pageFeatures.bodyTextPreview.includes('即将进行页面') ||
                                 pageFeatures.bodyTextPreview.includes('继续访问') ||
                                 pageFeatures.bodyTextPreview.includes('安全提示') ||
                                 pageFeatures.bodyTextPreview.includes('即将离开') ||
                                 pageFeatures.bodyTextPreview.includes('即将离开淘宝') ||
                                 pageFeatures.bodyTextPreview.includes('即将离开天猫');
          
          if (hasJumpFeature) {
            debugLog('DIAG', `[cabinAddToCart] 循环检测中发现跳转中转/拦截浮层特征! URL: ${pageFeatures.url}`)
            this.emitStatus('正在击穿"即将页面跳转"拦截警告...')
            const popped = await cabin.findAndClickButton(['继续访问', '继续', '确定', '确定继续', '允许', '我知道了', '仍要离开', '离开此页'])
            if (popped) {
              debugLog('DIAG', `[cabinAddToCart] 成功击穿了二次跳转拦截，已自动点击"继续/确定"！`)
              await new Promise(r => setTimeout(r, 1200))
              pageFeatures = await cabin.detectPageFeatures()
            }
          }
        } catch (jumpErr) {
          debugLog('DIAG', `[cabinAddToCart] 循环击穿跳转确认弹窗报错: ${jumpErr}`)
        }

        if (pageFeatures.hasLoginForm) {
          return { success: false, error: '登录已过期' }
        }

        if (pageFeatures.hasCaptcha) {
          cabin.setMode('interactive')
          this.emitStatus('需要完成安全验证，请在操作舱中操作')
          await cabin.waitForUrlMatch(['cart.taobao.com', 'buy.taobao.com', 'buy.tmall.com', 'item.taobao.com', 'detail.tmall.com'], 300000)
          cabin.setMode('auto')
          continue
        }

        // 检测如果跳转到商品详情页，可能需要选 SKU 等
        if (pageFeatures.url.includes('item.taobao.com') || pageFeatures.url.includes('detail.tmall.com') || pageFeatures.url.includes('item.htm')) {
          this.emitStatus('已进入商品详情页')
          
          // 如果页面直接提示下架或不可购买
          if (pageFeatures.bodyTextPreview.includes('下架') || pageFeatures.bodyTextPreview.includes('失效') || pageFeatures.bodyTextPreview.includes('此宝贝已下架')) {
            return { success: false, error: '商品不可购买（下架啦）' }
          }

          // 尝试自动点击加购/购买
          const autoClickBuy = await cabin.findAndClickButton(['立即购买', '立即付款', '加入购物车'])
          if (autoClickBuy) {
            await new Promise(r => setTimeout(r, 1500))
            const checkFeatures = await cabin.detectPageFeatures()
            if (checkFeatures.url.includes('buy.taobao.com') || checkFeatures.url.includes('buy.tmall.com')) {
              return { success: true, directToPay: true }
            }
            if (checkFeatures.url.includes('cart.taobao.com')) {
              return { success: true, directToPay: false }
            }
          }

          // 如果需要选择规格或无法自动购买，则转入人工交互
          cabin.setMode('interactive')
          this.emitStatus('请在操作舱内选择商品规格并点击购买，完成后点击下方"我已完成"')

          return new Promise<AddToCartResult>((resolve) => {
            this._cabinCartResolve = async (confirmed: boolean) => {
              cabin.setMode('auto')
              if (confirmed) {
                const finalFeatures = await cabin.detectPageFeatures()
                const isBuyPage = finalFeatures.url.includes('buy.taobao.com') || finalFeatures.url.includes('buy.tmall.com')
                resolve({ success: true, directToPay: isBuyPage })
              } else {
                resolve({ success: false, error: '用户取消了购买' })
              }
            }
          })
        }

        // 检测到直接跳转到购物车或结算页
        if (pageFeatures.url.includes('cart.taobao.com') || pageFeatures.url.includes('cart.tmall.com')) {
          this.emitStatus('已成功加购到购物车')
          return { success: true, directToPay: false }
        }

        if (pageFeatures.url.includes('buy.taobao.com') || pageFeatures.url.includes('buy.tmall.com')) {
          this.emitStatus('已成功进入结算页面')
          return { success: true, directToPay: true }
        }
      }

      // 如果加载超时，但其实已经在购物车或结算，依然算成功
      const lastFeatures = await cabin.detectPageFeatures()
      if (lastFeatures.url.includes('cart.taobao.com')) {
        return { success: true, directToPay: false }
      }
      if (lastFeatures.url.includes('buy.taobao.com')) {
        return { success: true, directToPay: true }
      }

      return { success: false, error: '再买一单跳转超时' }
    }

    // 没有 orderId，即直接通过商品 URL 购买
    return this.cabinPurchaseFromUrl(productUrl)
  }

  /**
   * 操作舱内直接商品 URL 加购流程
   */
  private async cabinPurchaseFromUrl(productUrl: string): Promise<AddToCartResult> {
    const cabin = this.cabinController!
    await this.cookieManager.syncCookiesToElectron(this.browserManager.getContext(), this.auth)
    this.emitStatus('正在打开商品详情页...')
    
    let targetUrl = productUrl
    if (targetUrl.startsWith('//')) targetUrl = 'https:' + targetUrl
    await cabin.navigate(targetUrl)
    await new Promise(r => setTimeout(r, 2000))

    const features = await cabin.detectPageFeatures()
    if (features.bodyTextPreview.includes('下架') || features.bodyTextPreview.includes('此宝贝已下架')) {
      return { success: false, error: '商品不可购买（下架啦）' }
    }

    // 尝试直接自动购买
    const autoClickBuy = await cabin.findAndClickButton(['立即购买', '立即付款', '加入购物车'])
    if (autoClickBuy) {
      await new Promise(r => setTimeout(r, 1500))
      const checkFeatures = await cabin.detectPageFeatures()
      if (checkFeatures.url.includes('buy.taobao.com') || checkFeatures.url.includes('buy.tmall.com')) {
        return { success: true, directToPay: true }
      }
      if (checkFeatures.url.includes('cart.taobao.com')) {
        return { success: true, directToPay: false }
      }
    }

    cabin.setMode('interactive')
    this.emitStatus('请选择规格并点击"立即购买"或"加入购物车"，然后点击下方"我已完成"')

    return new Promise<AddToCartResult>((resolve) => {
      this._cabinCartResolve = async (confirmed: boolean) => {
        cabin.setMode('auto')
        if (confirmed) {
          const finalFeatures = await cabin.detectPageFeatures()
          const isBuyPage = finalFeatures.url.includes('buy.taobao.com') || finalFeatures.url.includes('buy.tmall.com')
          resolve({ success: true, directToPay: isBuyPage })
        } else {
          resolve({ success: false, error: '用户取消了购买' })
        }
      }
    })
  }

  /**
   * 操作舱内搜索降级流程
   */
  private async cabinOpenSearchPage(keyword: string): Promise<string | null> {
    const cabin = this.cabinController!
    await this.cookieManager.syncCookiesToElectron(this.browserManager.getContext(), this.auth)
    const searchUrl = `https://s.taobao.com/search?q=${encodeURIComponent(keyword)}`
    this.emitStatus('正在打开搜索页面...')
    await cabin.navigate(searchUrl)
    
    cabin.setMode('interactive')
    this.emitStatus('请在搜索结果中找到对应商品并点击进入，然后点击下方"我已完成"')

    return new Promise<string | null>((resolve) => {
      this._cabinSearchResolve = async (confirmed: boolean) => {
        cabin.setMode('auto')
        if (confirmed) {
          const finalFeatures = await cabin.detectPageFeatures()
          resolve(finalFeatures.url)
        } else {
          resolve(null)
        }
      }
    })
  }

  /**
   * 操作舱内的结算流程
   * 在前端 webview 中执行结算操作，不创建额外窗口
   */
  private async cabinCheckout(directToPay?: boolean, quantity?: number): Promise<CheckoutResult> {
    const cabin = this.cabinController!
    this.emitStatus('正在结算...')
    await this.cookieManager.syncCookiesToElectron(this.browserManager.getContext(), this.auth, true)

    try {
      // 检查当前页面状态
      const features = await cabin.detectPageFeatures()

      // 如果已经在结算页面且有提交订单按钮
      if (features.hasSubmitOrder || features.hasPayButton) {
        this.emitStatus('已到达确认订单页面')
        // 尝试提取价格
        const priceResult = await cabin.executeJs(`
          (function() {
            var selectors = ['[class*="realPrice"]', '[class*="totalPrice"]', '[class*="payPrice"]', '[class*="amount"]', '[class*="sumPrice"]'];
            for (var i = 0; i < selectors.length; i++) {
              var els = document.querySelectorAll(selectors[i]);
              for (var j = 0; j < els.length; j++) {
                var text = (els[j].textContent || '').trim();
                var m = text.match(/¥?([\\d,]+\\.?\\d*)/);
                if (m) { var val = parseFloat(m[1].replace(/,/g, '')); if (val > 0 && val < 999999) return val; }
              }
            }
            return null;
          })()
        `).catch(() => null)
        return { success: true, currentPrice: priceResult || undefined }
      }

      // 如果当前在购物车页面，点击结算按钮
      const isCartUrl = features.url.includes('cart.taobao.com') || features.url.includes('cart.tmall.com')
      if (isCartUrl || !directToPay) {
        if (!isCartUrl) {
          this.emitStatus('正在跳转购物车...')
          await cabin.navigate('https://cart.taobao.com/cart.htm')
          await new Promise(r => setTimeout(r, 3000))
        }

        this.emitStatus('正在点击结算按钮...')
        const clicked = await cabin.findAndClickButton(['结算', '去结算', '去购物车结算', '去支付'])
        if (!clicked) {
          return { success: false, error: '未找到结算按钮' }
        }
      }

      // 等待确认订单页面加载
      this.emitStatus('正在等待确认订单页面加载...')
      for (let attempt = 0; attempt < 15; attempt++) {
        await new Promise(r => setTimeout(r, attempt === 0 ? 500 : 1500))
        const pageFeatures = await cabin.detectPageFeatures()

        // 检测登录过期
        if (pageFeatures.hasLoginForm) {
          return { success: false, error: '登录已过期，请重新登录' }
        }

        // 检测验证码 - 切换到交互模式
        if (pageFeatures.hasCaptcha) {
          cabin.setMode('interactive')
          this.emitStatus('需要完成安全验证，请在操作舱中操作')
          // 等待用户验证完成（通过 resolveConfirmation 或 URL 变化）
          const newUrl = await cabin.waitForUrlMatch(['buy.tmall.com', 'buy.taobao.com', 'cart.taobao.com'], 300000)
          cabin.setMode('auto')
          if (!newUrl) {
            return { success: false, error: '安全验证超时' }
          }
          continue // 重新检测页面状态
        }

        if (pageFeatures.hasSubmitOrder || pageFeatures.hasPayButton) {
          // 如果需要修改数量
          if (quantity && quantity > 1) {
            await cabin.executeJs(`
              (function() {
                var inputs = document.querySelectorAll('input[type="text"], input[type="number"], input:not([type])');
                for (var i = 0; i < inputs.length; i++) {
                  var input = inputs[i];
                  var rect = input.getBoundingClientRect();
                  if (rect.width <= 0 || rect.height <= 0) continue;
                  var parent = input.closest('[class*="quantity"], [class*="amount"], [class*="qty"], [class*="count"]');
                  if (parent) {
                    var nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
                    nativeInputValueSetter.call(input, String(${quantity}));
                    input.dispatchEvent(new Event('input', { bubbles: true }));
                    input.dispatchEvent(new Event('change', { bubbles: true }));
                    return true;
                  }
                }
                return false;
              })()
            `).catch(() => {})
            await new Promise(r => setTimeout(r, 1000))
          }

          const priceResult = await cabin.executeJs(`
            (function() {
              var selectors = ['[class*="realPrice"]', '[class*="totalPrice"]', '[class*="payPrice"]', '[class*="amount"]', '[class*="sumPrice"]'];
              for (var i = 0; i < selectors.length; i++) {
                var els = document.querySelectorAll(selectors[i]);
                for (var j = 0; j < els.length; j++) {
                  var text = (els[j].textContent || '').trim();
                  var m = text.match(/¥?([\\d,]+\\.?\\d*)/);
                  if (m) { var val = parseFloat(m[1].replace(/,/g, '')); if (val > 0 && val < 999999) return val; }
                }
              }
              return null;
            })()
          `).catch(() => null)

          this.emitStatus('已到达确认订单页面')
          return { success: true, currentPrice: priceResult || undefined }
        }
      }

      return { success: false, error: '确认订单页面加载超时' }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  }

  /**
   * 操作舱内的支付流程
   * 在前端 webview 中执行支付操作
   */
  private async cabinPay(totalAmount?: number, paymentMode?: string): Promise<PayResult> {
    const cabin = this.cabinController!
    await this.cookieManager.syncCookiesToElectron(this.browserManager.getContext(), this.auth, true)
    const payFreeLimit = parseFloat(this.db.getSetting('pay_free_limit') || '0') || 0
    const exceedsLimit = payFreeLimit > 0 && totalAmount !== undefined && totalAmount > payFreeLimit

    // 显示支付信息条
    if (totalAmount !== undefined) {
      cabin.showPaymentInfo(totalAmount, paymentMode || 'auto_pay')
    }

    try {
      // 金额超限 或 手动支付模式 - 切换到交互模式让用户手动支付
      if (exceedsLimit || paymentMode === 'checkout_only') {
        cabin.setMode('interactive')
        const reason = exceedsLimit
          ? `订单金额 ¥${totalAmount!.toFixed(2)} 超过免密支付上限 ¥${payFreeLimit.toFixed(2)}，需要手动确认付款`
          : '当前为手动支付模式，请在操作舱中完成支付'
        this.emitStatus(reason)

        // 等待用户完成支付（通过 resolveConfirmation 回调）
        return new Promise<PayResult>((resolve) => {
          // 用户点击"我已完成"时 resolveConfirmation(true) 会被调用
          // 设置一个标记让 resolveConfirmation 知道需要resolve这个promise
          this._cabinPayResolve = (confirmed: boolean) => {
            cabin.setMode('auto')
            cabin.hidePaymentInfo()
            if (confirmed) {
              this.emitStatus('支付完成')
              resolve({ success: true })
            } else {
              resolve({ success: false, error: '支付未完成' })
            }
          }
        })
      }

      // 自动支付模式
      this.emitStatus(totalAmount !== undefined
        ? `正在自动支付（¥${totalAmount.toFixed(2)}）...`
        : '正在自动支付...'
      )

      // 点击支付按钮
      const clicked = await cabin.findAndClickButton(['免密支付', '立即支付', '确认支付', '提交订单', '确认订单', '去支付', '立即付款'])
      if (!clicked) {
        cabin.hidePaymentInfo()
        return { success: false, error: '未找到支付按钮' }
      }

      await new Promise(r => setTimeout(r, 3000))

      // 等待并检测支付结果
      this.emitStatus('正在等待支付结果...')
      for (let i = 0; i < 30; i++) {
        await new Promise(r => setTimeout(r, 2000))
        const features = await cabin.detectPageFeatures()

        // 检测支付成功
        if (features.hasPaySuccess) {
          cabin.hidePaymentInfo()
          this.emitStatus('支付完成')
          return { success: true }
        }

        // 检测验证码 - 切换交互模式
        if (features.hasCaptcha) {
          cabin.setMode('interactive')
          this.emitStatus('需要完成安全验证，请在操作舱中操作')
          // 等待 URL 变化表示验证通过
          const newUrl = await cabin.waitForUrlMatch(['payresult', 'trade_success', 'paySuccess', 'cashier', 'alipay'], 300000)
          cabin.setMode('auto')
          if (!newUrl) {
            cabin.hidePaymentInfo()
            return { success: false, error: '安全验证超时' }
          }
          continue
        }

        // 检测需要输入支付密码（cashier/alipay 页面）
        if (features.url.includes('cashier') || features.url.includes('alipay')) {
          cabin.setMode('interactive')
          this.emitStatus('需要输入支付密码，请在操作舱中完成支付')
          // 等待支付完成
          const payUrl = await cabin.waitForUrlMatch(['payresult', 'trade_success', 'paySuccess', 'buyerPaySuccess'], 300000)
          cabin.setMode('auto')
          if (payUrl) {
            cabin.hidePaymentInfo()
            this.emitStatus('支付完成')
            return { success: true }
          }
          cabin.hidePaymentInfo()
          return { success: false, error: '支付未完成' }
        }

        // 检测登录过期
        if (features.hasLoginForm) {
          cabin.hidePaymentInfo()
          return { success: false, error: '登录已过期，请重新登录' }
        }

        // 检测支付失败
        if (features.bodyTextPreview.includes('支付失败') || features.bodyTextPreview.includes('余额不足')) {
          cabin.hidePaymentInfo()
          return { success: false, error: '支付失败：' + features.bodyTextPreview.substring(0, 50) }
        }
      }

      // 超时后切到交互模式让用户确认
      cabin.setMode('interactive')
      this.emitStatus('等待支付结果超时，请确认是否已完成支付，然后点击"我已完成"')
      return new Promise<PayResult>((resolve) => {
        this._cabinPayResolve = (confirmed: boolean) => {
          cabin.setMode('auto')
          cabin.hidePaymentInfo()
          if (confirmed) {
            this.emitStatus('支付完成')
            resolve({ success: true })
          } else {
            resolve({ success: false, error: '支付未完成' })
          }
        }
      })
    } catch (e) {
      cabin.hidePaymentInfo()
      return { success: false, error: String(e) }
    }
  }

  private cabinCaptureTimer: ReturnType<typeof setInterval> | null = null
  private cabinOnFrame: ((base64Jpeg: string) => void) | null = null
  private cabinActive: boolean = false

  async startScreencast(onFrame: (base64Jpeg: string) => void): Promise<void> {
    this.cabinOnFrame = onFrame
    this.cabinActive = true
    this.startCabinCapture()
  }

  async stopScreencast(): Promise<void> {
    this.cabinActive = false
    this.cabinOnFrame = null
    this.stopCabinCapture()
  }

  isScreencasting(): boolean {
    return this.cabinActive
  }

  private cabinCapturePausedLogged = false
  private cabinCaptureShopWinState = ''

  private startCabinCapture() {
    this.stopCabinCapture()
    if (!this.cabinActive || !this.cabinOnFrame) return

    // 如果 cabin webview 模式启用，不需要截图流
    if (this.windowManager.cabinOpen && this.cabinController) {
      return
    }

    this.cabinCaptureTimer = setInterval(async () => {
      if (!this.cabinActive || !this.cabinOnFrame) {
        this.stopCabinCapture()
        return
      }

      if (this.windowManager.cabinCapturePaused) {
        if (!this.cabinCapturePausedLogged) {
          debugLog('DIAG', `cabinCapture: PAUSED (cabinCapturePaused=true), will skip until resumed`)
          this.cabinCapturePausedLogged = true
        }
        return
      }
      if (this.cabinCapturePausedLogged) {
        debugLog('DIAG', `cabinCapture: RESUMED (cabinCapturePaused=false)`)
        this.cabinCapturePausedLogged = false
      }

      try {
        if (this.browserManager.isScreencasting()) return

        const lastCabinWin = this.windowManager.getLastCabinWindow()
        if (lastCabinWin) {
          const image = await lastCabinWin.webContents.capturePage()
          const base64 = image.toJPEG(85).toString('base64')
          this.cabinOnFrame(base64)
          return
        }

        const pwPage = this.browserManager.getPage()
        if (pwPage && this.browserManager.getBrowser()?.isConnected()) {
          await this.browserManager.startScreencast(this.cabinOnFrame)
          return
        }

        const shopWindow = this.windowManager.getShopWindow()
        if (shopWindow && !shopWindow.isDestroyed()) {
          const winState = `vis=${shopWindow.isVisible()},min=${shopWindow.isMinimized()}`
          if (winState !== this.cabinCaptureShopWinState) {
            debugLog('DIAG', `cabinCapture: capturing shopWindow state changed: ${winState} (was: ${this.cabinCaptureShopWinState})`)
            this.cabinCaptureShopWinState = winState
          }
          const image = await shopWindow.webContents.capturePage()
          const base64 = image.toJPEG(85).toString('base64')
          this.cabinOnFrame(base64)
          return
        }

        const loginWindow = this.windowManager.getLoginWindow()
        if (loginWindow && !loginWindow.isDestroyed()) {
          const image = await loginWindow.webContents.capturePage()
          const base64 = image.toJPEG(85).toString('base64')
          this.cabinOnFrame(base64)
          return
        }
      } catch { /* ignore */ }
    }, 100)
  }

  private stopCabinCapture() {
    if (this.cabinCaptureTimer) {
      clearInterval(this.cabinCaptureTimer)
      this.cabinCaptureTimer = null
    }
    if (this.browserManager.isScreencasting()) {
      this.browserManager.stopScreencast().catch(() => {})
    }
  }
}
