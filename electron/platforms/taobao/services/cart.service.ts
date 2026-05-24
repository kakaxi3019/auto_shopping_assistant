import { BrowserWindow, dialog } from 'electron'
import type { Page, BrowserContext } from 'playwright'
import type { Database } from '../../../db/database'
import type { AddToCartResult, Order } from '../../../../shared/types/platform.types'
import { BrowserManager } from '../infrastructure/browser-manager'
import { WindowManager } from '../infrastructure/window-manager'
import { CookieManager } from '../infrastructure/cookie-manager'
import { VerificationService } from './verification.service'
import { InteractionService } from './interaction.service'
import { TaobaoAuth } from '../taobao.auth'
import { setUserAgent, debugLog, humanDelay, humanClickAt, humanClickElement, execJS, injectOverlayBanner, injectCenterToast, rand, ListenerTracker } from '../utils/page-helper'
import { APP_ICON, WINDOW_SIZES, TIMEOUTS, KEYWORDS } from '../utils/constants'
import { isCheckoutOrPayPage, isLoginPage, isIdentityVerifyPage, isBuyPage, isCartPage, isProductDetailPage, isOrderArchivePage, isOrderDetailPage } from '../utils/url-helper'
import { TAOBAO_SELECTORS } from '../taobao.selectors'
import { HUMAN_SIM_JS } from '../utils/human-sim'

export class CartService {
  private browserManager: BrowserManager
  private windowManager: WindowManager
  private cookieManager: CookieManager
  private verificationService: VerificationService
  private interactionService: InteractionService
  private auth: TaobaoAuth
  private db: Database
  private emitStatus: (status: string) => void
  private getContext: () => BrowserContext | null
  private getPage: () => Page | null
  private setPage: (page: Page) => void
  private isDestroyed: () => boolean

  constructor(
    browserManager: BrowserManager,
    windowManager: WindowManager,
    cookieManager: CookieManager,
    verificationService: VerificationService,
    interactionService: InteractionService,
    auth: TaobaoAuth,
    db: Database,
    emitStatus: (status: string) => void,
    getContext: () => BrowserContext | null,
    getPage: () => Page | null,
    setPage: (page: Page) => void,
    isDestroyed: () => boolean
  ) {
    this.browserManager = browserManager
    this.windowManager = windowManager
    this.cookieManager = cookieManager
    this.verificationService = verificationService
    this.interactionService = interactionService
    this.auth = auth
    this.db = db
    this.emitStatus = emitStatus
    this.getContext = getContext
    this.getPage = getPage
    this.setPage = setPage
    this.isDestroyed = isDestroyed
  }

  async addToCart(productUrl: string, sku?: string, orderId?: string, cartOnly?: boolean): Promise<AddToCartResult> {
    this.emitStatus('正在再买一单...')

    debugLog(`[Taobao] addToCart called with orderId: "${orderId}", productUrl: "${productUrl}", cartOnly: ${cartOnly}`)

    if (!orderId) {
      this.emitStatus('没有订单号，无法再买一单')
      return { success: false, error: '没有订单号' }
    }

    try {
      const result = await this.runInHiddenWindow(orderId, productUrl, cartOnly)
      if (result) return result

      return { success: false, error: '再买一单操作未返回结果' }
    } catch (e: unknown) {
      debugLog(`[Taobao] addToCart error: ${e}`)
      this.emitStatus(`再买一单失败: ${e}`)
      return { success: false, error: String(e) }
    }
  }

  private async addToCartDirectly(productUrl: string, sku?: string): Promise<AddToCartResult> {
    this.emitStatus('正在打开商品页面加入购物车...')

    if (!productUrl) {
      return { success: false, error: '没有商品链接' }
    }

    let fullUrl = productUrl
    if (fullUrl.startsWith('//')) fullUrl = 'https:' + fullUrl

    try {
      this.cookieManager.resetToElectronSyncTimer()
      await this.cookieManager.syncCookiesToElectron(this.getContext(), this.auth)

      const shopWindow = this.windowManager.getShopWindow()
      if (shopWindow && !shopWindow.isDestroyed()) {
        shopWindow.close()
        this.windowManager.setShopWindow(null)
      }

      const newShopWindow = new BrowserWindow({
        width: WINDOW_SIZES.SHOP.width,
        height: WINDOW_SIZES.SHOP.height,
        show: true,
        autoHideMenuBar: true,
        icon: APP_ICON,
        webPreferences: {
          nodeIntegration: false,
          contextIsolation: true,
          backgroundThrottling: false,
        },
      })
      this.windowManager.setShopWindow(newShopWindow)
      setUserAgent(newShopWindow)
      const mainWindow = this.windowManager.getMainWindow()
      if (mainWindow) {
        newShopWindow.setParentWindow(mainWindow)
      }
      newShopWindow.minimize()

      return new Promise<AddToCartResult>((resolve) => {
        let resolved = false
        const lt = new ListenerTracker()

        const doResolve = (result: AddToCartResult) => {
          if (resolved) return
          resolved = true
          clearTimeout(timeout)
          lt.dispose()
          resolve(result)
        }

        const timeout = setTimeout(() => {
          if (!resolved) {
            this.windowManager.closeShopWindow(async () => { await this.cookieManager.syncCookiesFromElectron(this.getContext(), this.auth) })
            this.emitStatus('加入购物车超时')
            doResolve({ success: false, error: '加入购物车超时' })
          }
        }, TIMEOUTS.OPERATION)

        const handleNavigation = async (url: string) => {
          if (resolved) return

          if (isCartPage(url)) {
            const sw = this.windowManager.getShopWindow()
            if (sw && !sw.isDestroyed()) sw.hide()
            await this.cookieManager.syncCookiesFromElectron(this.getContext(), this.auth)
            this.emitStatus('已加入购物车')
            doResolve({ success: true, directToPay: false })
            return
          }

          if (isBuyPage(url)) {
            const sw = this.windowManager.getShopWindow()
            if (sw && !sw.isDestroyed()) sw.hide()
            await this.cookieManager.syncCookiesFromElectron(this.getContext(), this.auth)
            this.emitStatus('已进入结算页面（商品可能不支持加入购物车）')
            doResolve({ success: true, directToPay: true })
            return
          }
        }

        const currentShopWindow = this.windowManager.getShopWindow()!

        currentShopWindow.webContents.setWindowOpenHandler(({ url: openUrl }) => {
          console.log('[Taobao] addToCartDirectly window open: ' + openUrl)
          return { action: 'allow', overrideBrowserWindowOptions: { show: false } }
        })

        lt.on(currentShopWindow.webContents, 'did-create-window', (newWindow) => {
          setUserAgent(newWindow)
          newWindow.setIcon(APP_ICON)
          this.windowManager.trackWindow(newWindow)

          const handlePopupUrl = async (popupUrl: string) => {
            if (resolved) return

            if (isCartPage(popupUrl)) {
              const sw = this.windowManager.getShopWindow()
              if (sw && !sw.isDestroyed()) sw.hide()
              this.windowManager.setShopWindow(newWindow)
              await this.cookieManager.syncCookiesFromElectron(this.getContext(), this.auth)
              this.emitStatus('已加入购物车')
              doResolve({ success: true, directToPay: false })
              return
            }

            if (isBuyPage(popupUrl)) {
              const sw = this.windowManager.getShopWindow()
              if (sw && !sw.isDestroyed()) sw.hide()
              this.windowManager.setShopWindow(newWindow)
              await this.cookieManager.syncCookiesFromElectron(this.getContext(), this.auth)
              this.emitStatus('已进入结算页面')
              doResolve({ success: true, directToPay: true })
              return
            }

            if (isIdentityVerifyPage(popupUrl)) {
              this.emitStatus('需要进行身份验证，请在弹出的窗口中完成验证...')
              newWindow.setSize(WINDOW_SIZES.SMALL.width, WINDOW_SIZES.SMALL.height)
              newWindow.setTitle('淘宝身份验证')
              const mw = this.windowManager.getMainWindow()
              if (mw) newWindow.setParentWindow(mw)
              injectOverlayBanner(newWindow, "🔐 自动购物助手：淘宝要求身份验证，请在下方完成验证后继续")
              injectCenterToast(newWindow, "请完成身份验证")
              newWindow.show()
              return
            }

            if (isLoginPage(popupUrl)) {
              await this.verificationService.tryAutoLoginThenShow(newWindow)
              return
            }
          }

          lt.on(newWindow.webContents, 'did-finish-load', async () => {
            await handlePopupUrl(newWindow.webContents.getURL())
          })
          lt.on(newWindow.webContents, 'did-navigate', async () => {
            await handlePopupUrl(newWindow.webContents.getURL())
          })
        })

        lt.on(currentShopWindow.webContents, 'did-navigate', async (_event, url) => {
          await handleNavigation(url)
        })

        lt.on(currentShopWindow.webContents, 'did-finish-load', async () => {
          if (resolved) return

          const sw = this.windowManager.getShopWindow()
          const currentUrl = sw!.webContents.getURL()
          await handleNavigation(currentUrl)
          if (resolved) return

          await humanDelay(2000)

          try {
            const pageStatus = await execJS(sw!, `
              (function() {
                var bodyText = (document.body?.innerText || '');
                var offShelfKeywords = ${JSON.stringify(KEYWORDS.OFF_SHELF)};
                var matchedKeyword = '';
                for (var i = 0; i < offShelfKeywords.length; i++) {
                  if (bodyText.includes(offShelfKeywords[i])) { matchedKeyword = offShelfKeywords[i]; break; }
                }
                var found = _hs.findVisible(['button', 'a', '[class*="btn"]', '[class*="Button"]', '[role="button"]', '[class*="action"]', '[class*="submit"]'], ${JSON.stringify(KEYWORDS.CART_BUTTONS)});
                var hasCartButton = found.length > 0;
                return { offShelf: matchedKeyword !== '', keyword: matchedKeyword, hasCartButton: hasCartButton };
              })()
            `)

            if (pageStatus.offShelf && !pageStatus.hasCartButton) {
              this.windowManager.closeShopWindow(async () => { await this.cookieManager.syncCookiesFromElectron(this.getContext(), this.auth) })
              this.emitStatus('商品不可购买（' + pageStatus.keyword + '）')
              doResolve({ success: false, error: '商品不可购买（' + pageStatus.keyword + '）' })
              return
            }

            if (pageStatus.hasCartButton) {
              this.emitStatus('正在选择商品规格...')
              await execJS(sw!, `
                (function() {
                  var skuItems = document.querySelectorAll('[class*="skuItem"], [class*="sku-item"], [class*="SkuItem"], [data-sku], [class*="skuInfo"] [class*="item"], [class*="valueItem"], [class*="ValueItem"]');
                  var clicked = 0;
                  for (var i = 0; i < skuItems.length; i++) {
                    var item = skuItems[i];
                    var rect = item.getBoundingClientRect();
                    if (rect.width <= 0 || rect.height <= 0) continue;
                    var parent = item.parentElement;
                    var siblings = parent ? parent.querySelectorAll('[class*="skuItem"], [class*="sku-item"], [class*="SkuItem"], [data-sku], [class*="valueItem"], [class*="ValueItem"]') : [];
                    var isAlreadySelected = false;
                    var classList = item.className || '';
                    if (classList.includes('selected') || classList.includes('active') || classList.includes('current')) isAlreadySelected = true;
                    if (!isAlreadySelected && siblings.length > 0) {
                      var isFirst = true;
                      for (var j = 0; j < siblings.length; j++) {
                        var sRect = siblings[j].getBoundingClientRect();
                        if (sRect.width > 0 && sRect.height > 0) {
                          if (siblings[j] !== item) { isFirst = false; break; }
                        }
                      }
                      if (isFirst || siblings.length === 1) {
                        _hs.click(item);
                        clicked++;
                      }
                    }
                  }
                  return clicked;
                })()
              `)

              this.emitStatus('正在点击加入购物车...')
              await execJS(sw!, `
                (function() {
                  var result = _hs.findAndClick(
                    ['button', 'a', '[class*="btn"]', '[class*="Button"]', '[role="button"]', '[class*="action"]', '[class*="submit"]'],
                    ${JSON.stringify(KEYWORDS.CART_BUTTONS)}
                  );
                  return result ? { clicked: true, text: result.text } : { clicked: false };
                })()
              `)

              await humanDelay(5000)

              if (resolved) return

              const afterUrl = sw!.webContents.getURL()
              if (isCartPage(afterUrl)) {
                if (!sw?.isDestroyed()) sw?.hide()
                await this.cookieManager.syncCookiesFromElectron(this.getContext(), this.auth)
                this.emitStatus('已加入购物车')
                doResolve({ success: true, directToPay: false })
                return
              }

              if (isBuyPage(afterUrl)) {
                if (!sw?.isDestroyed()) sw?.hide()
                await this.cookieManager.syncCookiesFromElectron(this.getContext(), this.auth)
                this.emitStatus('已进入结算页面（商品可能不支持加入购物车）')
                doResolve({ success: true, directToPay: true })
                return
              }

              const cartSuccessDetected = await sw!.webContents.executeJavaScript(`
                (function() {
                  var bodyText = (document.body?.innerText || '');
                  var successHints = ${JSON.stringify(KEYWORDS.CART_SUCCESS)};
                  for (var i = 0; i < successHints.length; i++) {
                    if (bodyText.includes(successHints[i])) return true;
                  }
                  var toastEl = document.querySelector('[class*="toast"], [class*="Toast"], [class*="message"], [class*="Message"], [class*="notice"], [class*="Notice"], [class*="success"], [class*="Success"]');
                  if (toastEl) {
                    var toastText = (toastEl.textContent || '').trim();
                    if (toastText.includes('购物车') || toastText.includes('成功') || toastText.includes('添加')) return true;
                  }
                  return false;
                })()
              `)

              if (cartSuccessDetected) {
                await this.cookieManager.syncCookiesFromElectron(this.getContext(), this.auth)
                this.windowManager.closeShopWindow()
                this.emitStatus('已加入购物车')
                doResolve({ success: true, directToPay: false })
                return
              }

              const hasSkuDialog = await sw!.webContents.executeJavaScript(`
                (function() {
                  var dialogs = document.querySelectorAll('[class*="sku"], [class*="Sku"], [class*="dialog"], [class*="Dialog"], [class*="modal"], [class*="Modal"], [class*="popup"], [class*="Popup"]');
                  for (var i = 0; i < dialogs.length; i++) {
                    var rect = dialogs[i].getBoundingClientRect();
                    if (rect.width > 100 && rect.height > 100) return true;
                  }
                  return false;
                })()
              `)

              if (hasSkuDialog) {
                this.emitStatus('需要选择商品规格，请在弹出的窗口中选择后点击"加入购物车"')
                sw!.setSize(WINDOW_SIZES.VERIFICATION.width, WINDOW_SIZES.VERIFICATION.height)
                sw!.setTitle('请选择商品规格，选好后点击"加入购物车"')
                const mw = this.windowManager.getMainWindow()
                if (mw) sw!.setParentWindow(mw)
                injectOverlayBanner(sw!, "🛒 自动购物助手：需要选择商品规格，请在下方选择后点击\"加入购物车\"")
                injectCenterToast(sw!, "请选择规格后点击加入购物车")
                sw!.show()

                lt.on(sw!.webContents, 'did-navigate', async (_evt, url: string) => {
                  await handleNavigation(url)
                })
                sw!.webContents.setWindowOpenHandler(({ url: openUrl }) => {
                  console.log('[Taobao] addToCartDirectly sku-select window open: ' + openUrl)
                  return { action: 'allow', overrideBrowserWindowOptions: { show: false } }
                })
                lt.on(sw!.webContents, 'did-create-window', (newWin) => {
                  setUserAgent(newWin)
                  newWin.setIcon(APP_ICON)
                  this.windowManager.trackWindow(newWin)
                  lt.on(newWin.webContents, 'did-finish-load', async () => {
                    const popupUrl = newWin.webContents.getURL()
                    if (isCartPage(popupUrl)) {
                      const s = this.windowManager.getShopWindow()
                      if (s && !s.isDestroyed()) s.hide()
                      this.windowManager.setShopWindow(newWin)
                      await this.cookieManager.syncCookiesFromElectron(this.getContext(), this.auth)
                      this.emitStatus('已加入购物车')
                      doResolve({ success: true, directToPay: false })
                    }
                  })
                })
                return
              }

              this.emitStatus('已点击加入购物车按钮，等待结果...')
            }
          } catch (e: unknown) {
            console.log('[Taobao] addToCartDirectly page check error: ' + e)
          }
        })

        currentShopWindow.loadURL(fullUrl)
      })
    } catch (e: unknown) {
      console.log('[Taobao] addToCartDirectly error: ' + e)
      return { success: false, error: String(e) }
    }
  }

  async openProductPage(productUrl: string): Promise<void> {
    this.emitStatus('正在打开商品页面...')

    if (!productUrl) {
      throw new Error('没有商品链接')
    }

    let fullUrl = productUrl
    if (fullUrl.startsWith('//')) fullUrl = 'https:' + fullUrl

    await this.cookieManager.syncCookiesToElectron(this.getContext(), this.auth)

    const shopWindow = this.windowManager.getShopWindow()
    if (shopWindow && !shopWindow.isDestroyed()) {
      shopWindow.close()
      this.windowManager.setShopWindow(null)
    }

    const newShopWindow = new BrowserWindow({
      width: 1100,
      height: 750,
      autoHideMenuBar: true,
      title: '商品页面 - 请选择规格并购买',
      icon: APP_ICON,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        backgroundThrottling: false,
      },
    })
    this.windowManager.setShopWindow(newShopWindow)
    setUserAgent(newShopWindow)

    const mainWindow = this.windowManager.getMainWindow()
    if (mainWindow) {
      newShopWindow.setParentWindow(mainWindow)
    }

    newShopWindow.loadURL(fullUrl)

    newShopWindow.on('closed', async () => {
      this.windowManager.setShopWindow(null)
      await this.cookieManager.syncCookiesFromElectron(this.getContext(), this.auth)
    })

    this.emitStatus('已打开商品页面，请在弹出的窗口中选择规格并购买')
  }

  async purchaseFromUrl(productUrl: string): Promise<AddToCartResult> {
    this.emitStatus('正在打开商品页面...')

    if (!productUrl) {
      return { success: false, error: '没有商品链接' }
    }

    let fullUrl = productUrl
    if (fullUrl.startsWith('//')) fullUrl = 'https:' + fullUrl

    try {
      await this.cookieManager.syncCookiesToElectron(this.getContext(), this.auth)

      const shopWindow = this.windowManager.getShopWindow()
      if (shopWindow && !shopWindow.isDestroyed()) {
        shopWindow.close()
        this.windowManager.setShopWindow(null)
      }

      const newShopWindow = new BrowserWindow({
        width: WINDOW_SIZES.SHOP.width,
        height: WINDOW_SIZES.SHOP.height,
        show: false,
        autoHideMenuBar: true,
        icon: APP_ICON,
        webPreferences: {
          nodeIntegration: false,
          contextIsolation: true,
          backgroundThrottling: false,
        },
      })
      this.windowManager.setShopWindow(newShopWindow)
      setUserAgent(newShopWindow)

      return new Promise<AddToCartResult>((resolve) => {
        let resolved = false
        const lt = new ListenerTracker()

        const doResolve = (result: AddToCartResult) => {
          if (resolved) return
          resolved = true
          clearTimeout(timeout)
          lt.dispose()
          resolve(result)
        }

        const timeout = setTimeout(() => {
          if (!resolved) {
            this.windowManager.closeShopWindow(async () => { await this.cookieManager.syncCookiesFromElectron(this.getContext(), this.auth) })
            this.emitStatus('操作超时')
            doResolve({ success: false, error: '操作超时' })
          }
        }, TIMEOUTS.OPERATION)

        const handleNavigation = async (url: string) => {
          if (resolved) return

          if (isBuyPage(url)) {
            const sw = this.windowManager.getShopWindow()
            if (sw && !sw.isDestroyed()) sw.hide()
            await this.cookieManager.syncCookiesFromElectron(this.getContext(), this.auth)
            this.emitStatus('已进入结算页面')
            doResolve({ success: true, directToPay: true })
            return
          }

          if (isCartPage(url)) {
            const sw = this.windowManager.getShopWindow()
            if (sw && !sw.isDestroyed()) sw.hide()
            await this.cookieManager.syncCookiesFromElectron(this.getContext(), this.auth)
            this.emitStatus('已加入购物车')
            doResolve({ success: true, directToPay: false })
            return
          }
        }

        const currentShopWindow = this.windowManager.getShopWindow()!

        currentShopWindow.webContents.setWindowOpenHandler(({ url: openUrl }) => {
          console.log('[Taobao] purchaseFromUrl window open: ' + openUrl)
          return { action: 'allow', overrideBrowserWindowOptions: { show: false } }
        })

        lt.on(currentShopWindow.webContents, 'did-create-window', (newWindow) => {
          setUserAgent(newWindow)
          newWindow.setIcon(APP_ICON)
          this.windowManager.trackWindow(newWindow)

          const handlePopupUrl = async (popupUrl: string) => {
            if (resolved) return

            if (isBuyPage(popupUrl)) {
              const sw = this.windowManager.getShopWindow()
              if (sw && !sw.isDestroyed()) sw.hide()
              this.windowManager.setShopWindow(newWindow)
              await this.cookieManager.syncCookiesFromElectron(this.getContext(), this.auth)
              this.emitStatus('已进入结算页面')
              doResolve({ success: true, directToPay: true })
              return
            }

            if (isCartPage(popupUrl)) {
              const sw = this.windowManager.getShopWindow()
              if (sw && !sw.isDestroyed()) sw.hide()
              this.windowManager.setShopWindow(newWindow)
              await this.cookieManager.syncCookiesFromElectron(this.getContext(), this.auth)
              this.emitStatus('已加入购物车')
              doResolve({ success: true, directToPay: false })
              return
            }

            if (isIdentityVerifyPage(popupUrl)) {
              this.emitStatus('需要进行身份验证，请在弹出的窗口中完成验证...')
              newWindow.setSize(WINDOW_SIZES.SMALL.width, WINDOW_SIZES.SMALL.height)
              newWindow.setTitle('淘宝身份验证')
              const mw = this.windowManager.getMainWindow()
              if (mw) newWindow.setParentWindow(mw)
              injectOverlayBanner(newWindow, "🔐 自动购物助手：淘宝要求身份验证，请在下方完成验证后继续")
              injectCenterToast(newWindow, "请完成身份验证")
              newWindow.show()
              return
            }

            if (isLoginPage(popupUrl)) {
              await this.verificationService.tryAutoLoginThenShow(newWindow)
              return
            }
          }

          lt.on(newWindow.webContents, 'did-finish-load', async () => {
            await handlePopupUrl(newWindow.webContents.getURL())
          })
          lt.on(newWindow.webContents, 'did-navigate', async () => {
            await handlePopupUrl(newWindow.webContents.getURL())
          })
        })

        lt.on(currentShopWindow.webContents, 'did-navigate', async (_event, url) => {
          await handleNavigation(url)
        })

        lt.on(currentShopWindow.webContents, 'did-finish-load', async () => {
          if (resolved) return

          const sw = this.windowManager.getShopWindow()
          const currentUrl = sw!.webContents.getURL()
          await handleNavigation(currentUrl)
          if (resolved) return

          await humanDelay(2000)

          try {
            const pageStatus = await execJS(sw!, `
              (function() {
                var bodyText = (document.body?.innerText || '');
                var offShelfKeywords = ${JSON.stringify(KEYWORDS.OFF_SHELF)};
                var matchedKeyword = '';
                for (var i = 0; i < offShelfKeywords.length; i++) {
                  if (bodyText.includes(offShelfKeywords[i])) { matchedKeyword = offShelfKeywords[i]; break; }
                }
                var found = _hs.findVisible(['button', 'a', '[class*="btn"]', '[class*="Button"]', '[role="button"]', '[class*="action"]', '[class*="submit"]'], ${JSON.stringify(KEYWORDS.BUY_BUTTONS)});
                var hasBuyButton = found.length > 0;
                return { offShelf: matchedKeyword !== '', keyword: matchedKeyword, hasBuyButton: hasBuyButton };
              })()
            `)

            if (pageStatus.offShelf && !pageStatus.hasBuyButton) {
              this.windowManager.closeShopWindow(async () => { await this.cookieManager.syncCookiesFromElectron(this.getContext(), this.auth) })
              this.emitStatus('商品不可购买（' + pageStatus.keyword + '）')
              doResolve({ success: false, error: '商品不可购买（' + pageStatus.keyword + '）' })
              return
            }

            if (pageStatus.hasBuyButton) {
              this.emitStatus('正在选择商品规格...')
              await execJS(sw!, `
                (function() {
                  var skuItems = document.querySelectorAll('[class*="skuItem"], [class*="sku-item"], [class*="SkuItem"], [data-sku], [class*="skuInfo"] [class*="item"], [class*="valueItem"], [class*="ValueItem"]');
                  var clicked = 0;
                  for (var i = 0; i < skuItems.length; i++) {
                    var item = skuItems[i];
                    var rect = item.getBoundingClientRect();
                    if (rect.width <= 0 || rect.height <= 0) continue;
                    var parent = item.parentElement;
                    var siblings = parent ? parent.querySelectorAll('[class*="skuItem"], [class*="sku-item"], [class*="SkuItem"], [data-sku], [class*="valueItem"], [class*="ValueItem"]') : [];
                    var isAlreadySelected = false;
                    var classList = item.className || '';
                    if (classList.includes('selected') || classList.includes('active') || classList.includes('current')) isAlreadySelected = true;
                    if (!isAlreadySelected && siblings.length > 0) {
                      var isFirst = true;
                      for (var j = 0; j < siblings.length; j++) {
                        var sRect = siblings[j].getBoundingClientRect();
                        if (sRect.width > 0 && sRect.height > 0) {
                          if (siblings[j] !== item) { isFirst = false; break; }
                        }
                      }
                      if (isFirst || siblings.length === 1) {
                        _hs.click(item);
                        clicked++;
                      }
                    }
                  }
                  return clicked;
                })()
              `)

              this.emitStatus('正在点击立即购买...')
              await execJS(sw!, `
                (function() {
                  var result = _hs.findAndClick(
                    ['button', 'a', '[class*="btn"]', '[class*="Button"]', '[role="button"]', '[class*="action"]', '[class*="submit"]'],
                    ${JSON.stringify(KEYWORDS.BUY_BUTTONS)}
                  );
                  if (result) { return true; }
                  return false;
                })()
              `)

              await humanDelay(5000)

              if (resolved) return

              const afterUrl = sw!.webContents.getURL()
              if (isBuyPage(afterUrl)) {
                if (!sw?.isDestroyed()) sw?.hide()
                await this.cookieManager.syncCookiesFromElectron(this.getContext(), this.auth)
                this.emitStatus('已进入结算页面')
                doResolve({ success: true, directToPay: true })
                return
              }

              if (isCartPage(afterUrl)) {
                if (!sw?.isDestroyed()) sw?.hide()
                await this.cookieManager.syncCookiesFromElectron(this.getContext(), this.auth)
                this.emitStatus('已加入购物车')
                doResolve({ success: true, directToPay: false })
                return
              }

              const hasSkuDialog = await sw!.webContents.executeJavaScript(`
                (function() {
                  var dialogs = document.querySelectorAll('[class*="sku"], [class*="Sku"], [class*="dialog"], [class*="Dialog"], [class*="modal"], [class*="Modal"], [class*="popup"], [class*="Popup"]');
                  for (var i = 0; i < dialogs.length; i++) {
                    var rect = dialogs[i].getBoundingClientRect();
                    if (rect.width > 100 && rect.height > 100) return true;
                  }
                  return false;
                })()
              `)

              if (hasSkuDialog) {
                this.emitStatus('需要选择商品规格，请在弹出的窗口中选择...')
                sw!.setSize(WINDOW_SIZES.VERIFICATION.width, WINDOW_SIZES.VERIFICATION.height)
                sw!.setTitle('请选择商品规格，选好后点击"立即购买"')
                const mw = this.windowManager.getMainWindow()
                if (mw) sw!.setParentWindow(mw)
                injectOverlayBanner(sw!, "🛒 自动购物助手：需要选择商品规格，请在下方选择后点击\"立即购买\"")
                injectCenterToast(sw!, "请选择规格后点击立即购买")
                sw!.show()

                lt.on(sw!.webContents, 'did-navigate', async (_evt, url: string) => {
                  await handleNavigation(url)
                })
                sw!.webContents.setWindowOpenHandler(({ url: openUrl }) => {
                  console.log('[Taobao] purchaseFromUrl sku-select window open: ' + openUrl)
                  return { action: 'allow', overrideBrowserWindowOptions: { show: false } }
                })
                lt.on(sw!.webContents, 'did-create-window', (newWindow) => {
                  setUserAgent(newWindow)
                  newWindow.setIcon(APP_ICON)
                  this.windowManager.trackWindow(newWindow)
                  lt.on(newWindow.webContents, 'did-finish-load', async () => {
                    const popupUrl = newWindow.webContents.getURL()
                    if (isBuyPage(popupUrl)) {
                      const s = this.windowManager.getShopWindow()
                      if (s && !s.isDestroyed()) s.hide()
                      this.windowManager.setShopWindow(newWindow)
                      await this.cookieManager.syncCookiesFromElectron(this.getContext(), this.auth)
                      this.emitStatus('已进入结算页面')
                      doResolve({ success: true, directToPay: true })
                    }
                  })
                })
                return
              }

              this.emitStatus('已点击购买按钮，等待页面跳转...')
            }
          } catch (e: unknown) {
            console.log('[Taobao] purchaseFromUrl page check error: ' + e)
          }
        })

        currentShopWindow.loadURL(fullUrl)
      })
    } catch (e: unknown) {
      console.log('[Taobao] purchaseFromUrl error: ' + e)
      return { success: false, error: String(e) }
    }
  }

  private async runInHiddenWindow(orderId: string, productUrl?: string, cartOnly?: boolean): Promise<AddToCartResult | null> {
    const mainWindow = this.windowManager.getMainWindow()
    if (!mainWindow) {
      debugLog(`[Taobao] runInHiddenWindow: mainWindow is null, returning null`)
      return null
    }

    const bizOrderId = orderId.replace(/_\d+$/, '')
    const detailUrl = `https://trade.tmall.com/detail/orderDetail.htm?bizOrderId=${bizOrderId}`
    debugLog(`[Taobao] runInHiddenWindow: ${detailUrl}`)
    this.emitStatus('正在打开订单详情页...')

    this.cookieManager.resetToElectronSyncTimer()
    await this.cookieManager.syncCookiesToElectron(this.getContext(), this.auth)

    const shopWindow = this.windowManager.getShopWindow()
    if (shopWindow && !shopWindow.isDestroyed()) {
      shopWindow.close()
      this.windowManager.setShopWindow(null)
    }

    return new Promise<AddToCartResult | null>((resolve) => {
      const lt = new ListenerTracker()
      const newShopWindow = new BrowserWindow({
        width: WINDOW_SIZES.SHOP.width,
        height: WINDOW_SIZES.SHOP.height,
        show: false,
        autoHideMenuBar: true,
        icon: APP_ICON,
        webPreferences: {
          nodeIntegration: false,
          contextIsolation: true,
          backgroundThrottling: false,
        },
      })
      this.windowManager.setShopWindow(newShopWindow)
      setUserAgent(newShopWindow)
      if (mainWindow) {
        newShopWindow.setParentWindow(mainWindow)
      }
      newShopWindow.loadURL(detailUrl)

      newShopWindow.webContents.setWindowOpenHandler(({ url: openUrl }) => {
        console.log(`[Taobao] Window open requested: ${openUrl}`)
        return { action: 'allow', overrideBrowserWindowOptions: { show: false } }
      })

      lt.on(newShopWindow.webContents, 'did-create-window', (newWindow) => {
        console.log(`[Taobao] Popup window created: ${newWindow.webContents.getURL()}`)
        setUserAgent(newWindow)
        newWindow.setIcon(APP_ICON)
        this.windowManager.trackWindow(newWindow)

        let skuHandled = false

        const handlePopupUrl = async (popupUrl: string) => {
          if (resolved) return
          debugLog(`[Taobao] Popup URL: ${popupUrl}`)

          if (isBuyPage(popupUrl)) {
            if (cartOnly) {
              resolved = true
              clearTimeout(timeout)
              clearInterval(checkInterval)
              this.windowManager.closeShopWindow(async () => { await this.cookieManager.syncCookiesFromElectron(this.getContext(), this.auth) })
              this.emitStatus('该商品不支持加入购物车，点击后直接进入了结算页面')
              resolve({ success: false, error: '该商品不支持加入购物车，点击后直接进入了结算页面' })
              return
            }
            resolved = true
            clearTimeout(timeout)
            clearInterval(checkInterval)
            const sw = this.windowManager.getShopWindow()
            if (sw && !sw.isDestroyed()) sw.hide()
            this.windowManager.setShopWindow(newWindow)
            await this.cookieManager.syncCookiesFromElectron(this.getContext(), this.auth)
            this.emitStatus('已进入结算页面')
            newWindow.setSize(WINDOW_SIZES.CONFIRMATION.width, WINDOW_SIZES.CONFIRMATION.height)
            newWindow.setTitle('请确认订单信息并提交')
            const mw = this.windowManager.getMainWindow()
            if (mw) {
              newWindow.setParentWindow(mw)
            }
            injectOverlayBanner(newWindow, "💳 自动购物助手：请确认订单信息并提交")
            injectCenterToast(newWindow, "请确认订单信息并提交")
            newWindow.show()
            resolve({ success: true, directToPay: true })
            return
          }

          if (isCartPage(popupUrl)) {
            resolved = true
            clearTimeout(timeout)
            clearInterval(checkInterval)
            const sw = this.windowManager.getShopWindow()
            if (sw && !sw.isDestroyed()) sw.hide()
            this.windowManager.setShopWindow(newWindow)
            await this.cookieManager.syncCookiesFromElectron(this.getContext(), this.auth)
            this.emitStatus('已加入购物车')
            resolve({ success: true, directToPay: false })
            return
          }

          if (isIdentityVerifyPage(popupUrl)) {
            console.log(`[Taobao] Identity verification required in popup, showing to user`)
            this.emitStatus('需要进行身份验证，请在弹出的窗口中完成验证...')
            newWindow.setSize(WINDOW_SIZES.SMALL.width, WINDOW_SIZES.SMALL.height)
            newWindow.setTitle('淘宝身份验证')
            const mw = this.windowManager.getMainWindow()
            if (mw) {
              newWindow.setParentWindow(mw)
            }
            injectOverlayBanner(newWindow, "🔐 自动购物助手：淘宝要求身份验证，请在下方完成验证后继续")
            injectCenterToast(newWindow, "请完成身份验证")
            newWindow.show()
            return
          }

          if (isLoginPage(popupUrl)) {
            console.log(`[Taobao] Login page in popup, trying auto login first`)
            await this.verificationService.tryAutoLoginThenShow(newWindow)
            return
          }

          if (popupUrl.includes('taobao.com') && !popupUrl.includes('login') && !isProductDetailPage(popupUrl)) {
            await this.cookieManager.syncCookiesFromElectron(this.getContext(), this.auth)
            console.log(`[Taobao] Popup navigated to taobao page after login/verify: ${popupUrl}`)
          }

          if (isProductDetailPage(popupUrl)) {
            if (skuHandled) return
            skuHandled = true
            debugLog(`[Taobao] SKU popup detected, url: ${popupUrl}`)
            await humanDelay(1500)
            try {
              if (popupUrl.includes('openSku=true') || popupUrl.includes('sku_properties=') || popupUrl.includes('skuId=')) {
                this.emitStatus('正在选择商品规格...')
                const skuClickCount = await execJS(newWindow, `
                  (function() {
                    var urlParams = new URLSearchParams(window.location.search);
                    var skuProps = urlParams.get('sku_properties');
                    var skuId = urlParams.get('skuId');
                    var clicked = 0;
                    if (skuProps) {
                      var pairs = skuProps.split(';');
                      for (var p = 0; p < pairs.length; p++) {
                        var pair = pairs[p].split(':');
                        if (pair.length !== 2) continue;
                        var valueId = pair[1];
                        var skuItems = document.querySelectorAll('[data-value], [data-sku-id], [class*="skuItem"], [class*="sku-item"], [class*="SkuItem"], [class*="valueItem"], [class*="ValueItem"]');
                        for (var i = 0; i < skuItems.length; i++) {
                          var val = skuItems[i].getAttribute('data-value') || skuItems[i].getAttribute('data-sku-id') || '';
                          if (val === valueId || val.endsWith(':' + valueId)) {
                            _hs.click(skuItems[i]);
                            clicked++;
                            break;
                          }
                        }
                      }
                    }
                    if (clicked === 0 && skuId) {
                      var allSkuItems = document.querySelectorAll('[data-value], [data-sku-id], [class*="skuItem"], [class*="sku-item"], [class*="SkuItem"], [class*="valueItem"], [class*="ValueItem"], [class*="sku"], [class*="Sku"]');
                      for (var j = 0; j < allSkuItems.length; j++) {
                        var itemVal = allSkuItems[j].getAttribute('data-value') || allSkuItems[j].getAttribute('data-sku-id') || '';
                        if (itemVal === skuId || itemVal.endsWith(':' + skuId)) {
                          _hs.click(allSkuItems[j]);
                          clicked++;
                          break;
                        }
                      }
                      if (clicked === 0) {
                        var skuBtns = document.querySelectorAll('[class*="sku"], [class*="Sku"]');
                        for (var k = 0; k < skuBtns.length; k++) {
                          var rect = skuBtns[k].getBoundingClientRect();
                          if (rect.width <= 0 || rect.height <= 0) continue;
                          var onclick = skuBtns[k].getAttribute('onclick') || '';
                          var dataAttrs = skuBtns[k].outerHTML.substring(0, 500);
                          if (dataAttrs.includes(skuId)) {
                            _hs.click(skuBtns[k]);
                            clicked++;
                            break;
                          }
                        }
                      }
                    }
                    return { skuProps: skuProps, skuId: skuId, clicked: clicked };
                  })()
                `)
                debugLog(`[Taobao] SKU select result: ${JSON.stringify(skuClickCount)}`)
                await humanDelay(1000)

                this.emitStatus(cartOnly ? '正在点击加入购物车...' : '正在点击购买...')
                const clickResult = await execJS(newWindow, `
                  (function() {
                    var priorityTargets = ${cartOnly} ? ${JSON.stringify(KEYWORDS.CART_BUTTONS)} : ${JSON.stringify(KEYWORDS.BUY_BUTTONS)};
                    var secondaryTargets = ${cartOnly} ? [] : ${JSON.stringify(KEYWORDS.CART_BUTTONS)};
                    var excludeTexts = ['万人加购', '人加购', '人购买', '万人团', '人收货', '人付款'];
                    var btnSelectors = ['button', 'a', '[class*="btn"]', '[class*="Button"]', '[role="button"]', '[class*="action"]', '[class*="submit"]'];
                    var allFound = _hs.findVisible(btnSelectors, priorityTargets.concat(secondaryTargets));
                    var bestPrimary = null;
                    var bestSecondary = null;
                    var allMatches = [];
                    for (var fi = 0; fi < allFound.length; fi++) {
                      var item = allFound[fi];
                      var normalized = item.text.replace(/\\s+/g, '');
                      var isExcluded = excludeTexts.some(function(e) { return normalized.includes(e); });
                      if (isExcluded) continue;
                      var isPrimary = priorityTargets.some(function(t) { return normalized === t || normalized.startsWith(t); });
                      var isSecondary = secondaryTargets.some(function(t) { return normalized === t || normalized.startsWith(t); });
                      if (isPrimary && (!bestPrimary || item.area < bestPrimary.area)) {
                        bestPrimary = { el: item.el, area: item.area, text: item.text.substring(0, 30) };
                      }
                      if (isSecondary && (!bestSecondary || item.area < bestSecondary.area)) {
                        bestSecondary = { el: item.el, area: item.area, text: item.text.substring(0, 30) };
                      }
                      if ((isPrimary || isSecondary) && allMatches.length < 5) {
                        allMatches.push({ tag: item.el.tagName, text: item.text.substring(0, 30), area: Math.round(item.area), isPrimary: isPrimary });
                      }
                    }
                    var chosen = bestPrimary || bestSecondary;
                    if (chosen) { _hs.click(chosen.el); return { clicked: true, text: chosen.text, matches: allMatches }; }
                    return { clicked: false, matches: allMatches };
                  })()
                `)
                debugLog(`[Taobao] SKU popup click result: ${JSON.stringify(clickResult)}`)

                if (cartOnly && !clickResult?.clicked) {
                  resolved = true
                  clearTimeout(timeout)
                  clearInterval(checkInterval)
                  this.windowManager.closeShopWindow(async () => { await this.cookieManager.syncCookiesFromElectron(this.getContext(), this.auth) })
                  this.emitStatus('该商品不支持加入购物车（未找到加购按钮）')
                  resolve({ success: false, error: '该商品不支持加入购物车（未找到加购按钮）' })
                  return
                }
                await humanDelay(2000)

                const currentPopupUrl = newWindow.webContents.getURL()
                debugLog(`[Taobao] After buy click, current URL: ${currentPopupUrl}`)
                if (isIdentityVerifyPage(currentPopupUrl) || currentPopupUrl.includes('nocaptcha') || currentPopupUrl.includes('slider')) {
                  await newWindow.webContents.executeJavaScript(`
                    (function() {
                      try {
                        Object.defineProperty(Document.prototype, 'visibilityState', { get: function() { return document.hidden ? 'hidden' : 'visible'; }, configurable: true });
                        Object.defineProperty(Document.prototype, 'hidden', { get: function() { return !document.hasFocus(); }, configurable: true });
                        Object.defineProperty(document, 'visibilityState', { get: function() { return document.hidden ? 'hidden' : 'visible'; }, configurable: true });
                        Object.defineProperty(document, 'hidden', { get: function() { return !document.hasFocus(); }, configurable: true });
                      } catch(e) {}
                    })()
                  `).catch(() => {})
                  newWindow.setSize(WINDOW_SIZES.CONFIRMATION.width, WINDOW_SIZES.CONFIRMATION.height)
                  newWindow.setTitle('淘宝安全验证')
                  const mw = this.windowManager.getMainWindow()
                  if (mw) newWindow.setParentWindow(mw)
                  const captchaBanner = '🔐 自动购物助手：淘宝要求安全验证，请拖动滑块或完成验证后继续'
                  injectOverlayBanner(newWindow, captchaBanner)
                  injectCenterToast(newWindow, "请完成安全验证")
                  newWindow.show()
                  const verified = await this.interactionService.waitForUserConfirmation(
                    newWindow,
                    '淘宝要求安全验证（滑块验证），请在弹出的窗口中完成验证，完成后点击"已完成"',
                    '淘宝安全验证',
                    captchaBanner,
                  )
                  if (verified) {
                    resolved = true
                    clearTimeout(timeout)
                    clearInterval(checkInterval)
                    const sw = this.windowManager.getShopWindow()
                    if (sw && !sw.isDestroyed()) sw.hide()
                    this.windowManager.setShopWindow(newWindow)
                    await this.cookieManager.syncCookiesFromElectron(this.getContext(), this.auth)
                    const afterVerifyUrl = newWindow.webContents.getURL()
                    if (isCartPage(afterVerifyUrl)) {
                      this.emitStatus('已加入购物车')
                      resolve({ success: true, directToPay: false })
                    } else if (isBuyPage(afterVerifyUrl)) {
                      this.emitStatus('已进入结算页面')
                      resolve({ success: true, directToPay: true })
                    } else {
                      this.emitStatus('验证完成，请继续操作')
                      resolve({ success: true, directToPay: true })
                    }
                  } else {
                    resolved = true
                    clearTimeout(timeout)
                    clearInterval(checkInterval)
                    resolve({ success: false, error: '安全验证未完成' })
                  }
                  return
                }

                if (isBuyPage(currentPopupUrl)) {
                  debugLog(`[Taobao] Detected checkout page, handling...`)
                  await handlePopupUrl(currentPopupUrl)
                  return
                }

                const pageDiag = await execJS(newWindow, `
                  (function() {
                    var bodyText = (document.body?.innerText || '').substring(0, 500);
                    var selectHints = ['请选择', '选择商品信息', '请选择规格', '请选择商品', '请选择您要的'];
                    var matchedHint = '';
                    for (var i = 0; i < selectHints.length; i++) {
                      if (bodyText.includes(selectHints[i])) { matchedHint = selectHints[i]; break; }
                    }
                    var btnSelectors = ['button', 'a', '[class*="btn"]', '[class*="Button"]', '[role="button"]', '[class*="action"]', '[class*="submit"]'];
                    var foundBtns = _hs.findVisible(btnSelectors, ${JSON.stringify([...KEYWORDS.BUY_BUTTONS, '万人加购', '确定'])});
                    var hasBuyBtn = foundBtns.length > 0;
                    var buyBtns = [];
                    for (var bi = 0; bi < foundBtns.length && buyBtns.length < 5; bi++) {
                      buyBtns.push({ tag: foundBtns[bi].el.tagName, text: foundBtns[bi].text.substring(0, 30), w: Math.round(foundBtns[bi].rect.width), h: Math.round(foundBtns[bi].rect.height) });
                    }
                    var dialogs = document.querySelectorAll('[class*="dialog"], [class*="Dialog"], [class*="modal"], [class*="Modal"], [class*="popup"], [class*="Popup"], [class*="toast"], [class*="Toast"]');
                    var visibleDialogs = [];
                    for (var k = 0; k < dialogs.length; k++) {
                      var r = dialogs[k].getBoundingClientRect();
                      if (r.width > 50 && r.height > 50) visibleDialogs.push({ cls: dialogs[k].className.substring(0, 50), w: Math.round(r.width), h: Math.round(r.height) });
                    }
                    var captchaSelectors = ['#nocaptcha', '#nc_1_wrapper', '[class*="nc-container"]', '[class*="nc_wrapper"]', '[class*="slider"]', '[class*="captcha"]', '[class*="Captcha"]', '[id*="captcha"]'];
                    var hasCaptcha = false;
                    var captchaInfo = '';
                    for (var ci = 0; ci < captchaSelectors.length; ci++) {
                      var cel = document.querySelector(captchaSelectors[ci]);
                      if (cel) { var cr = cel.getBoundingClientRect(); if (cr.width > 50 && cr.height > 20) { hasCaptcha = true; captchaInfo = captchaSelectors[ci]; break; } }
                    }
                    if (!hasCaptcha) {
                      var captchaHints = ['请拖动', '滑块', '请完成验证', '安全验证', '拖动滑块'];
                      for (var chi = 0; chi < captchaHints.length; chi++) {
                        if (bodyText.includes(captchaHints[chi])) { hasCaptcha = true; captchaInfo = captchaHints[chi]; break; }
                      }
                    }
                    return { needSelect: matchedHint !== '', hint: matchedHint, hasBuyBtn: hasBuyBtn, buyBtns: buyBtns, visibleDialogs: visibleDialogs, hasCaptcha: hasCaptcha, captchaInfo: captchaInfo, bodyPreview: bodyText.substring(0, 200) };
                  })()
                `)
                debugLog(`[Taobao] After buy click page diag: ${JSON.stringify(pageDiag)}`)

                if (pageDiag.hasCaptcha) {
                  debugLog(`[Taobao] Captcha detected in page diag: ${pageDiag.captchaInfo}`)
                  newWindow.setSize(WINDOW_SIZES.CONFIRMATION.width, WINDOW_SIZES.CONFIRMATION.height)
                  newWindow.setTitle('淘宝安全验证')
                  const mw = this.windowManager.getMainWindow()
                  if (mw) newWindow.setParentWindow(mw)
                  const captchaBanner = '🔐 自动购物助手：淘宝要求安全验证，请拖动滑块或完成验证后继续'
                  injectOverlayBanner(newWindow, captchaBanner)
                  injectCenterToast(newWindow, "请完成安全验证")
                  newWindow.show()
                  const captchaConfirmed = await this.interactionService.waitForUserConfirmation(
                    newWindow,
                    '淘宝要求安全验证（滑块验证），请在弹出的窗口中完成验证，完成后点击"已完成"',
                    '淘宝安全验证',
                    captchaBanner,
                  )
                  if (captchaConfirmed) {
                    resolved = true
                    clearTimeout(timeout)
                    clearInterval(checkInterval)
                    const sw = this.windowManager.getShopWindow()
                    if (sw && !sw.isDestroyed()) sw.hide()
                    this.windowManager.setShopWindow(newWindow)
                    await this.cookieManager.syncCookiesFromElectron(this.getContext(), this.auth)
                    const afterVerifyUrl = newWindow.webContents.getURL()
                    if (isCartPage(afterVerifyUrl)) {
                      this.emitStatus('已加入购物车')
                      resolve({ success: true, directToPay: false })
                    } else {
                      this.emitStatus('验证完成，请继续操作')
                      resolve({ success: true, directToPay: true })
                    }
                  } else {
                    resolved = true
                    clearTimeout(timeout)
                    clearInterval(checkInterval)
                    resolve({ success: false, error: '安全验证未完成' })
                  }
                  return
                }

                const checkResult = { needSelect: pageDiag.needSelect, hint: pageDiag.hint }
                debugLog(`[Taobao] After buy click check: ${JSON.stringify(checkResult)}`)

                if (checkResult.needSelect) {
                  const reopenUrl = newWindow.webContents.getURL()
                  const actionText = cartOnly ? '点击加入购物车' : '点击购买'
                  newWindow.setSize(WINDOW_SIZES.CONFIRMATION.width, WINDOW_SIZES.CONFIRMATION.height)
                  newWindow.setTitle(`请选择商品规格 - 选择后${actionText}`)
                  const mw = this.windowManager.getMainWindow()
                  if (mw) {
                    newWindow.setParentWindow(mw)
                  }
                  const bannerMsg = `⚠️ 自动购物助手：原商品规格信息已失效，请重新选择规格后${actionText}`
                  injectOverlayBanner(newWindow, bannerMsg)
                  injectCenterToast(newWindow, `请重新选择规格后${actionText}`)
                  newWindow.show()

                  const confirmed = await this.interactionService.waitForUserConfirmation(
                    newWindow,
                    `原商品规格信息已失效，请在弹出的窗口中重新选择规格后${actionText}，完成后点击"已完成"`,
                    `请选择商品规格 - 选择后${actionText}`,
                    bannerMsg,
                  )

                  if (confirmed) {
                    resolved = true
                    clearTimeout(timeout)
                    clearInterval(checkInterval)
                    const sw = this.windowManager.getShopWindow()
                    if (sw && !sw.isDestroyed()) sw.hide()
                    this.windowManager.setShopWindow(newWindow)
                    await this.cookieManager.syncCookiesFromElectron(this.getContext(), this.auth)
                    const currentUrl = newWindow.webContents.getURL()
                    if (isCartPage(currentUrl)) {
                      this.emitStatus('已加入购物车')
                      resolve({ success: true, directToPay: false })
                    } else {
                      this.emitStatus('已进入结算页面')
                      resolve({ success: true, directToPay: true })
                    }
                  } else {
                    resolved = true
                    clearTimeout(timeout)
                    clearInterval(checkInterval)
                    resolve({ success: false, error: '用户取消操作' })
                  }
                  return
                }

                debugLog(`[Taobao] SKU path: buy clicked but no checkout redirect and no needSelect, showing interaction window`)
                let fallbackReason = '点击购买后页面未跳转到结算页'
                if (pageDiag.visibleDialogs && pageDiag.visibleDialogs.length > 0) {
                  fallbackReason = `点击购买后出现弹窗（${pageDiag.visibleDialogs.map((d: any) => d.cls?.substring(0, 20) || '未知').join(', ')}），页面未跳转到结算页`
                } else if (pageDiag.hint) {
                  fallbackReason = `页面提示"${pageDiag.hint}"，自动购买无法继续`
                } else if (!pageDiag.hasBuyBtn) {
                  fallbackReason = '页面上未找到可点击的购买按钮'
                }
                newWindow.setSize(WINDOW_SIZES.CONFIRMATION.width, WINDOW_SIZES.CONFIRMATION.height)
                newWindow.setTitle('请手动完成购买操作')
                const mw = this.windowManager.getMainWindow()
                if (mw) {
                  newWindow.setParentWindow(mw)
                }
                const fallbackBanner = `⚠️ 自动购物助手：${fallbackReason}，请在下方手动完成购买操作`
                injectOverlayBanner(newWindow, fallbackBanner)
                injectCenterToast(newWindow, "请手动完成购买操作")
                newWindow.show()

                const confirmed = await this.interactionService.waitForUserConfirmation(
                  newWindow,
                  `${fallbackReason}，请在弹出的窗口中手动完成购买操作，完成后点击"已完成"`,
                  '请手动完成购买操作',
                  fallbackBanner,
                )

                if (confirmed) {
                  resolved = true
                  clearTimeout(timeout)
                  clearInterval(checkInterval)
                  const sw = this.windowManager.getShopWindow()
                  if (sw && !sw.isDestroyed()) sw.hide()
                  this.windowManager.setShopWindow(newWindow)
                  await this.cookieManager.syncCookiesFromElectron(this.getContext(), this.auth)
                  const currentUrl = newWindow.webContents.getURL()
                  if (isCartPage(currentUrl)) {
                    this.emitStatus('已加入购物车')
                    resolve({ success: true, directToPay: false })
                  } else {
                    this.emitStatus('已进入结算页面')
                    resolve({ success: true, directToPay: true })
                  }
                } else {
                  resolved = true
                  clearTimeout(timeout)
                  clearInterval(checkInterval)
                  resolve({ success: false, error: '用户取消操作' })
                }

                return
              } else {
                const pageStatus = await execJS(newWindow, `
                  (function() {
                    var bodyText = (document.body?.innerText || '');
                    var offShelfKeywords = ${JSON.stringify(KEYWORDS.OFF_SHELF)};
                    var matchedKeyword = '';
                    for (var i = 0; i < offShelfKeywords.length; i++) {
                      if (bodyText.includes(offShelfKeywords[i])) {
                        matchedKeyword = offShelfKeywords[i];
                        break;
                      }
                    }
                    var found = _hs.findVisible(['button', 'a', '[class*="btn"]', '[class*="Button"]', '[role="button"]', '[class*="action"]', '[class*="submit"]'], ${cartOnly} ? ${JSON.stringify(KEYWORDS.CART_BUTTONS)} : ${JSON.stringify(KEYWORDS.BUY_BUTTONS)});
                    var hasBuyButton = found.length > 0;
                    return { offShelf: matchedKeyword !== '', keyword: matchedKeyword, hasBuyButton: hasBuyButton };
                  })()
                `)
                debugLog(`[Taobao] Popup product page status: ${JSON.stringify(pageStatus)}`)

                if (pageStatus.offShelf && !pageStatus.hasBuyButton) {
                  resolved = true
                  clearTimeout(timeout)
                  clearInterval(checkInterval)
                  this.windowManager.closeShopWindow(async () => { await this.cookieManager.syncCookiesFromElectron(this.getContext(), this.auth) })
                  this.emitStatus(`商品不可购买（${pageStatus.keyword}）`)
                  resolve({ success: false, error: `商品不可购买（${pageStatus.keyword}）` })
                  return
                }

                if (pageStatus.hasBuyButton) {
                  this.emitStatus(cartOnly ? '正在点击加入购物车...' : '正在点击领券购买...')
                  const noSkuClickResult = await execJS(newWindow, `
                    (function() {
                      var result = _hs.findAndClick(
                        ['button', 'a', '[class*="btn"]', '[class*="Button"]', '[role="button"]', '[class*="action"]', '[class*="submit"]'],
                        ${cartOnly} ? ${JSON.stringify(KEYWORDS.CART_BUTTONS)} : ${JSON.stringify(KEYWORDS.BUY_BUTTONS)}
                      );
                      if (result) { return { clicked: true, text: result.text.substring(0, 30) }; }
                      return { clicked: false };
                    })()
                  `)
                  debugLog(`[Taobao] No-SKU popup click result: ${JSON.stringify(noSkuClickResult)}`)

                  if (cartOnly && !noSkuClickResult?.clicked) {
                    resolved = true
                    clearTimeout(timeout)
                    clearInterval(checkInterval)
                    this.windowManager.closeShopWindow(async () => { await this.cookieManager.syncCookiesFromElectron(this.getContext(), this.auth) })
                    this.emitStatus('该商品不支持加入购物车（未找到加购按钮）')
                    resolve({ success: false, error: '该商品不支持加入购物车（未找到加购按钮）' })
                    return
                  }

                  await humanDelay(2000)

                  const afterClickUrl = newWindow.webContents.getURL()
                  debugLog(`[Taobao] No-SKU after click URL: ${afterClickUrl}`)

                  const afterClickDiag = await execJS(newWindow, `
                    (function() {
                      var bodyText = (document.body?.innerText || '').substring(0, 500);
                      var selectHints = ['请选择', '选择商品信息', '请选择规格', '请选择商品', '请选择您要的', '选择颜色', '选择尺寸', '选择型号'];
                      var matchedHint = '';
                      for (var i = 0; i < selectHints.length; i++) {
                        if (bodyText.includes(selectHints[i])) { matchedHint = selectHints[i]; break; }
                      }
                      var skuPanels = document.querySelectorAll('[class*="sku"], [class*="Sku"], [class*="SKU"], [class*="selector"], [class*="Selector"], [class*="property"], [class*="Property"]');
                      var visibleSkuPanels = [];
                      for (var j = 0; j < skuPanels.length; j++) {
                        var rect = skuPanels[j].getBoundingClientRect();
                        if (rect.width > 100 && rect.height > 100) visibleSkuPanels.push({ cls: skuPanels[j].className.substring(0, 50), w: Math.round(rect.width), h: Math.round(rect.height) });
                      }
                      var btnSelectors = ['button', 'a', '[class*="btn"]', '[class*="Button"]', '[role="button"]', '[class*="action"]', '[class*="submit"]'];
                      var foundBtns = _hs.findVisible(btnSelectors, ${JSON.stringify([...KEYWORDS.BUY_BUTTONS, '万人加购', '确定'])});
                      var hasBuyBtn = foundBtns.length > 0;
                      var buyBtns = [];
                      for (var bi = 0; bi < foundBtns.length && buyBtns.length < 5; bi++) {
                        buyBtns.push({ tag: foundBtns[bi].el.tagName, text: foundBtns[bi].text.substring(0, 30), w: Math.round(foundBtns[bi].rect.width), h: Math.round(foundBtns[bi].rect.height) });
                      }
                      return { needSelect: matchedHint !== '' || visibleSkuPanels.length > 0, hint: matchedHint || (visibleSkuPanels.length > 0 ? 'SKU选择面板' : ''), hasBuyBtn: hasBuyBtn, buyBtns: buyBtns, visibleSkuPanels: visibleSkuPanels, bodyPreview: bodyText.substring(0, 200) };
                    })()
                  `)
                  debugLog(`[Taobao] No-SKU after click diag: ${JSON.stringify(afterClickDiag)}`)

                  const afterClickCheck = { needSelect: afterClickDiag.needSelect, hint: afterClickDiag.hint }
                  debugLog(`[Taobao] After buy click check: ${JSON.stringify(afterClickCheck)}`)

                  if (afterClickCheck.needSelect) {
                    const actionText2 = cartOnly ? '点击加入购物车' : '点击购买'
                    newWindow.setSize(WINDOW_SIZES.CONFIRMATION.width, WINDOW_SIZES.CONFIRMATION.height)
                    newWindow.setTitle(`请选择商品规格 - 选择后${actionText2}`)
                    const mw2 = this.windowManager.getMainWindow()
                    if (mw2) {
                      newWindow.setParentWindow(mw2)
                    }
                    const bannerMsg2 = `⚠️ 自动购物助手：原商品规格信息已失效，请重新选择规格后${actionText2}`
                    injectOverlayBanner(newWindow, bannerMsg2)
                    injectCenterToast(newWindow, `请重新选择规格后${actionText2}`)
                    newWindow.show()

                    const confirmed = await this.interactionService.waitForUserConfirmation(
                      newWindow,
                      `原商品规格信息已失效，请在弹出的窗口中重新选择规格后${actionText2}，完成后点击"已完成"`,
                      `请选择商品规格 - 选择后${actionText2}`,
                      bannerMsg2,
                    )

                    if (confirmed) {
                      resolved = true
                      clearTimeout(timeout)
                      clearInterval(checkInterval)
                      const sw = this.windowManager.getShopWindow()
                      if (sw && !sw.isDestroyed()) sw.hide()
                      this.windowManager.setShopWindow(newWindow)
                      await this.cookieManager.syncCookiesFromElectron(this.getContext(), this.auth)
                      const currentUrl = newWindow.webContents.getURL()
                      if (isCartPage(currentUrl)) {
                        this.emitStatus('已加入购物车')
                        resolve({ success: true, directToPay: false })
                      } else {
                        this.emitStatus('已进入结算页面')
                        resolve({ success: true, directToPay: true })
                      }
                    } else {
                      resolved = true
                      clearTimeout(timeout)
                      clearInterval(checkInterval)
                      resolve({ success: false, error: '用户取消操作' })
                    }
                    return
                  }

                  debugLog(`[Taobao] No-SKU path: checking URL after click: ${afterClickUrl}`)
                  if (isBuyPage(afterClickUrl)) {
                    await handlePopupUrl(afterClickUrl)
                    return
                  }

                  debugLog(`[Taobao] No-SKU path: buy clicked but no checkout redirect, showing interaction window`)
                  let fallbackReason2 = '点击购买后页面未跳转到结算页'
                  if (afterClickDiag) {
                    if (afterClickDiag.visibleSkuPanels && afterClickDiag.visibleSkuPanels.length > 0) {
                      fallbackReason2 = `点击购买后出现规格选择面板，可能需要手动选择规格`
                    } else if (afterClickDiag.hint) {
                      fallbackReason2 = `页面提示"${afterClickDiag.hint}"，自动购买无法继续`
                    } else if (!afterClickDiag.hasBuyBtn) {
                      fallbackReason2 = '页面上未找到可点击的购买按钮'
                    }
                  }
                  newWindow.setSize(WINDOW_SIZES.CONFIRMATION.width, WINDOW_SIZES.CONFIRMATION.height)
                  newWindow.setTitle('请手动完成购买操作')
                  const mw3 = this.windowManager.getMainWindow()
                  if (mw3) {
                    newWindow.setParentWindow(mw3)
                  }
                  const fallbackBanner2 = `⚠️ 自动购物助手：${fallbackReason2}，请在下方手动完成购买操作`
                  injectOverlayBanner(newWindow, fallbackBanner2)
                  injectCenterToast(newWindow, "请手动完成购买操作")
                  newWindow.show()

                  const confirmed2 = await this.interactionService.waitForUserConfirmation(
                    newWindow,
                    `${fallbackReason2}，请在弹出的窗口中手动完成购买操作，完成后点击"已完成"`,
                    '请手动完成购买操作',
                    fallbackBanner2,
                  )

                  if (confirmed2) {
                    resolved = true
                    clearTimeout(timeout)
                    clearInterval(checkInterval)
                    const sw = this.windowManager.getShopWindow()
                    if (sw && !sw.isDestroyed()) sw.hide()
                    this.windowManager.setShopWindow(newWindow)
                    await this.cookieManager.syncCookiesFromElectron(this.getContext(), this.auth)
                    const currentUrl = newWindow.webContents.getURL()
                    if (isCartPage(currentUrl)) {
                      this.emitStatus('已加入购物车')
                      resolve({ success: true, directToPay: false })
                    } else {
                      this.emitStatus('已进入结算页面')
                      resolve({ success: true, directToPay: true })
                    }
                  } else {
                    resolved = true
                    clearTimeout(timeout)
                    clearInterval(checkInterval)
                    resolve({ success: false, error: '用户取消操作' })
                  }

                  return
                } else if (cartOnly) {
                  resolved = true
                  clearTimeout(timeout)
                  clearInterval(checkInterval)
                  this.windowManager.closeShopWindow(async () => { await this.cookieManager.syncCookiesFromElectron(this.getContext(), this.auth) })
                  this.emitStatus('该商品不支持加入购物车（未找到加购按钮）')
                  resolve({ success: false, error: '该商品不支持加入购物车（未找到加购按钮）' })
                  return
                }
              }
            } catch (e: unknown) {
              console.log(`[Taobao] Popup buy click error: ${e}`)
            }
          }
        }

        lt.on(newWindow.webContents, 'did-finish-load', async () => {
          const popupUrl = newWindow.webContents.getURL()
          await handlePopupUrl(popupUrl)
        })

        lt.on(newWindow.webContents, 'did-navigate', async () => {
          const popupUrl = newWindow.webContents.getURL()
          await handlePopupUrl(popupUrl)
        })

        newWindow.webContents.setWindowOpenHandler(({ url: openUrl }) => {
          debugLog(`[Taobao] Popup window opening: ${openUrl}`)
          if (isBuyPage(openUrl) || isCartPage(openUrl)) {
            return { action: 'allow' }
          }
          return { action: 'allow' }
        })

        lt.on(newWindow.webContents, 'did-create-window', (childWindow) => {
          debugLog(`[Taobao] Child window created`)
          setUserAgent(childWindow)
          childWindow.setIcon(APP_ICON)
          this.windowManager.trackWindow(childWindow)

          lt.on(childWindow.webContents, 'did-finish-load', async () => {
            const childUrl = childWindow.webContents.getURL()
            debugLog(`[Taobao] Child window loaded: ${childUrl}`)
            await handlePopupUrl(childUrl)
          })

          lt.on(childWindow.webContents, 'did-navigate', async () => {
            const childUrl = childWindow.webContents.getURL()
            debugLog(`[Taobao] Child window navigated: ${childUrl}`)
            await handlePopupUrl(childUrl)
          })
        })

        const popupCheck = setInterval(async () => {
          if (resolved) { clearInterval(popupCheck); return }
          if (this.isDestroyed() || newWindow.isDestroyed()) {
            clearInterval(popupCheck)
            if (!resolved) {
              resolved = true
              clearTimeout(timeout)
              resolve({ success: false, error: '任务已取消' })
            }
            return
          }
          try {
            const popupUrl = newWindow.webContents.getURL()
            await handlePopupUrl(popupUrl)
            if (resolved) return

            const allFrames = newWindow.webContents.mainFrame.framesInSubtree
            for (const frame of allFrames) {
              if (frame === newWindow.webContents.mainFrame) continue
              try {
                const frameUrl = frame.url
                if (isBuyPage(frameUrl)) {
                  await handlePopupUrl(frameUrl)
                  break
                }
              } catch { /* ignore */ }
            }
          } catch { /* ignore */ }
        }, 2000)

        newWindow.on('closed', async () => {
          clearInterval(popupCheck)
          lt.dispose()
          await this.cookieManager.syncCookiesFromElectron(this.getContext(), this.auth)
        })
      })

      let resolved = false
      const doResolve = (result: AddToCartResult | null) => {
        if (resolved) return
        resolved = true
        clearTimeout(timeout)
        lt.dispose()
        resolve(result)
      }
      let sameUrlCount = 0
      let rebuyRetryCount = 0
      const MAX_REBUY_RETRIES = 3
      const timeout = setTimeout(() => {
        if (!resolved) {
          doResolve(null)
          this.windowManager.closeShopWindow(async () => { await this.cookieManager.syncCookiesFromElectron(this.getContext(), this.auth) })
          this.emitStatus('操作超时')
        }
      }, TIMEOUTS.OPERATION)

      const tryClickRebuy = async () => {
        const sw = this.windowManager.getShopWindow()
        if (resolved || this.isDestroyed() || !sw || sw.isDestroyed()) return
        try {
          const cartTargets = cartOnly ? [...KEYWORDS.CART_BUTTONS] : []
          const rebuyTargets = [...KEYWORDS.REBUY_BUTTONS]
          const allTargets = [...cartTargets, ...rebuyTargets]

          const mainResult = await execJS(sw, `
            (function() {
              var allTargets = ${JSON.stringify(allTargets)};
              var cartTargets = ${JSON.stringify(cartTargets)};
              var selectors = ['button', 'a', '[class*="btn"]', '[class*="Button"]', '[role="button"]', '[class*="action"]', '[class*="submit"]', '[class*="rebuy"]', '[class*="Rebuy"]', '[class*="buy-again"]', '[class*="BuyAgain"]', '[data-spm*="rebuy"]', '[data-spm*="buy"]', 'span[class*="click"]', 'div[class*="click"]'];
              var found = _hs.findVisible(selectors, allTargets);
              var bestMatch = null;
              var bestCartMatch = null;
              var debugMatches = [];
              for (var fi = 0; fi < found.length; fi++) {
                var item = found[fi];
                var normalized = item.text.replace(/\\s+/g, '');
                var isCartTarget = cartTargets.some(function(t) { return normalized.includes(t); });
                if (isCartTarget && (!bestCartMatch || item.area < bestCartMatch.area)) {
                  bestCartMatch = { el: item.el, area: item.area, text: item.text.substring(0, 30) };
                }
                if (!bestMatch || item.area < bestMatch.area) {
                  bestMatch = { el: item.el, area: item.area, text: item.text.substring(0, 30) };
                }
                if (debugMatches.length < 5) {
                  debugMatches.push({ tag: item.el.tagName, text: item.text.substring(0, 40), w: Math.round(item.rect.width), h: Math.round(item.rect.height) });
                }
              }
              if (!bestMatch) {
                var broadFound = _hs.findByText(allTargets, 20);
                for (var bi = 0; bi < broadFound.length; bi++) {
                  var bItem = broadFound[bi];
                  var bNormalized = bItem.text.replace(/\\s+/g, '');
                  var bIsCart = cartTargets.some(function(t) { return bNormalized.includes(t); });
                  if (bIsCart && (!bestCartMatch || bItem.area < bestCartMatch.area)) {
                    bestCartMatch = { el: bItem.el, area: bItem.area, text: bItem.text.substring(0, 30) };
                  }
                  if (!bestMatch || bItem.area < bestMatch.area) {
                    bestMatch = { el: bItem.el, area: bItem.area, text: bItem.text.substring(0, 30) };
                  }
                  if (debugMatches.length < 5) {
                    debugMatches.push({ tag: bItem.el.tagName, text: bItem.text.substring(0, 40), w: Math.round(bItem.rect.width), h: Math.round(bItem.rect.height), method: 'findByText' });
                  }
                }
              }
              if (!bestMatch) {
                var shadowFound = _hs.findInShadowDOM(selectors, allTargets);
                for (var si = 0; si < shadowFound.length; si++) {
                  var sItem = shadowFound[si];
                  var sNormalized = sItem.text.replace(/\\s+/g, '');
                  var sIsCart = cartTargets.some(function(t) { return sNormalized.includes(t); });
                  if (sIsCart && (!bestCartMatch || sItem.area < bestCartMatch.area)) {
                    bestCartMatch = { el: sItem.el, area: sItem.area, text: sItem.text.substring(0, 30) };
                  }
                  if (!bestMatch || sItem.area < bestMatch.area) {
                    bestMatch = { el: sItem.el, area: sItem.area, text: sItem.text.substring(0, 30) };
                  }
                  if (debugMatches.length < 5) {
                    debugMatches.push({ tag: sItem.el.tagName, text: sItem.text.substring(0, 40), w: Math.round(sItem.rect.width), h: Math.round(sItem.rect.height), method: 'shadowDOM' });
                  }
                }
              }
              var chosen = bestCartMatch || bestMatch;
              if (chosen) {
                _hs.click(chosen.el);
                return { clicked: true, text: chosen.text, isCart: !!bestCartMatch, matches: debugMatches };
              }
              return { clicked: false, matches: debugMatches };
            })()
          `)
          debugLog(`[Taobao] Main frame rebuy result: ${JSON.stringify(mainResult)}`)

          if (mainResult && mainResult.clicked) {
            if (mainResult.isCart) {
              this.emitStatus('已点击加入购物车，等待结果...')
              await humanDelay(3000)
              if (resolved) return

              const cartResultDetected = await sw.webContents.executeJavaScript(`
                (function() {
                  var successHints = ${JSON.stringify(KEYWORDS.CART_SUCCESS)};
                  var errorHints = ${JSON.stringify(KEYWORDS.CART_ERROR)};
                  var toastSelectors = '[class*="toast"], [class*="Toast"], [class*="message"], [class*="Message"], [class*="notice"], [class*="Notice"], [class*="success"], [class*="Success"], [class*="dialog"], [class*="Dialog"], [class*="error"], [class*="Error"], [class*="warning"], [class*="Warning"], [class*="popup"], [class*="Popup"], [class*="layer"], [class*="Layer"]';
                  var toastEls = document.querySelectorAll(toastSelectors);
                  for (var k = 0; k < toastEls.length; k++) {
                    var t = (toastEls[k].textContent || '').trim();
                    for (var i = 0; i < errorHints.length; i++) {
                      if (t.includes(errorHints[i])) return { type: 'error', hint: errorHints[i] };
                    }
                    for (var j = 0; j < successHints.length; j++) {
                      if (t.includes(successHints[j])) return { type: 'success' };
                    }
                    if (t.includes('购物车') && (t.includes('成功') || t.includes('已'))) return { type: 'success' };
                  }
                  var bodyText = (document.body?.innerText || '');
                  for (var m = 0; m < errorHints.length; m++) {
                    if (bodyText.includes(errorHints[m])) return { type: 'error', hint: errorHints[m] };
                  }
                  for (var n = 0; n < successHints.length; n++) {
                    if (bodyText.includes(successHints[n])) return { type: 'success' };
                  }
                  return null;
                })()
              `)
              debugLog(`[Taobao] Cart result detected: ${JSON.stringify(cartResultDetected)}`)

              if (cartResultDetected?.type === 'success') {
                resolved = true
                clearTimeout(timeout)
                clearInterval(checkInterval)
                await this.cookieManager.syncCookiesFromElectron(this.getContext(), this.auth)
                this.windowManager.closeShopWindow()
                this.emitStatus('已加入购物车')
                resolve({ success: true, directToPay: false })
                return
              }

              if (cartResultDetected?.type === 'error') {
                resolved = true
                clearTimeout(timeout)
                clearInterval(checkInterval)
                this.windowManager.closeShopWindow(async () => { await this.cookieManager.syncCookiesFromElectron(this.getContext(), this.auth) })
                const errorMsg = `商品不可购买（${cartResultDetected.hint}）`
                this.emitStatus(errorMsg)
                resolve({ success: false, error: errorMsg })
                return
              }
            } else {
              this.emitStatus('已点击再买一单，等待页面跳转...')
            }
            return
          }

          const frames = sw.webContents.mainFrame.framesInSubtree
          console.log(`[Taobao] Main frame not found, searching ${frames.length} frames...`)
          for (const frame of frames) {
            if (frame === sw!.webContents.mainFrame) continue
            try {
              const frameUrl = frame.url
              debugLog(`[Taobao] Checking frame: ${frameUrl.substring(0, 100)}`)
              await frame.executeJavaScript(HUMAN_SIM_JS).catch(() => {})
              const frameResult = await frame.executeJavaScript(`
                (function() {
                  var allTargets = ${JSON.stringify(allTargets)};
                  var cartTargets = ${JSON.stringify(cartTargets)};
                  var selectors = ['button', 'a', '[class*="btn"]', '[class*="Button"]', '[role="button"]', '[class*="action"]', '[class*="submit"]', '[class*="rebuy"]', '[class*="Rebuy"]', '[class*="buy-again"]', '[class*="BuyAgain"]', '[data-spm*="rebuy"]', '[data-spm*="buy"]', 'span[class*="click"]', 'div[class*="click"]'];
                  var found = _hs.findVisible(selectors, allTargets);
                  var bestMatch = null;
                  var bestCartMatch = null;
                  var debugMatches = [];
                  for (var fi = 0; fi < found.length; fi++) {
                    var item = found[fi];
                    var normalized = item.text.replace(/\\s+/g, '');
                    var isCartTarget = cartTargets.some(function(t) { return normalized.includes(t); });
                    if (isCartTarget && (!bestCartMatch || item.area < bestCartMatch.area)) {
                      bestCartMatch = { el: item.el, area: item.area, text: item.text.substring(0, 30) };
                    }
                    if (!bestMatch || item.area < bestMatch.area) {
                      bestMatch = { el: item.el, area: item.area, text: item.text.substring(0, 30) };
                    }
                    if (debugMatches.length < 5) {
                      debugMatches.push({ tag: item.el.tagName, text: item.text.substring(0, 40), w: Math.round(item.rect.width), h: Math.round(item.rect.height) });
                    }
                  }
                  if (!bestMatch) {
                    var broadFound = _hs.findByText(allTargets, 20);
                    for (var bi = 0; bi < broadFound.length; bi++) {
                      var bItem = broadFound[bi];
                      var bNormalized = bItem.text.replace(/\\s+/g, '');
                      var bIsCart = cartTargets.some(function(t) { return bNormalized.includes(t); });
                      if (bIsCart && (!bestCartMatch || bItem.area < bestCartMatch.area)) {
                        bestCartMatch = { el: bItem.el, area: bItem.area, text: bItem.text.substring(0, 30) };
                      }
                      if (!bestMatch || bItem.area < bestMatch.area) {
                        bestMatch = { el: bItem.el, area: bItem.area, text: bItem.text.substring(0, 30) };
                      }
                      if (debugMatches.length < 5) {
                        debugMatches.push({ tag: bItem.el.tagName, text: bItem.text.substring(0, 40), w: Math.round(bItem.rect.width), h: Math.round(bItem.rect.height), method: 'findByText' });
                      }
                    }
                  }
                  if (!bestMatch) {
                    var shadowFound = _hs.findInShadowDOM(selectors, allTargets);
                    for (var si = 0; si < shadowFound.length; si++) {
                      var sItem = shadowFound[si];
                      var sNormalized = sItem.text.replace(/\\s+/g, '');
                      var sIsCart = cartTargets.some(function(t) { return sNormalized.includes(t); });
                      if (sIsCart && (!bestCartMatch || sItem.area < bestCartMatch.area)) {
                        bestCartMatch = { el: sItem.el, area: sItem.area, text: sItem.text.substring(0, 30) };
                      }
                      if (!bestMatch || sItem.area < bestMatch.area) {
                        bestMatch = { el: sItem.el, area: sItem.area, text: sItem.text.substring(0, 30) };
                      }
                      if (debugMatches.length < 5) {
                        debugMatches.push({ tag: sItem.el.tagName, text: sItem.text.substring(0, 40), w: Math.round(sItem.rect.width), h: Math.round(sItem.rect.height), method: 'shadowDOM' });
                      }
                    }
                  }
                  var chosen = bestCartMatch || bestMatch;
                  if (chosen) {
                    _hs.click(chosen.el);
                    return { clicked: true, text: chosen.text, isCart: !!bestCartMatch, matches: debugMatches };
                  }
                  return { clicked: false, matches: debugMatches };
                })()
              `)
              debugLog(`[Taobao] Frame ${frameUrl.substring(0, 80)} result: ${JSON.stringify(frameResult)}`)
              if (frameResult && frameResult.clicked) {
                if (frameResult.isCart) {
                  this.emitStatus('已点击加入购物车，等待结果...')
                  await humanDelay(3000)
                  if (resolved) return

                  const frameCartResult = await sw.webContents.executeJavaScript(`
                    (function() {
                      var successHints = ${JSON.stringify(KEYWORDS.CART_SUCCESS)};
                      var errorHints = ${JSON.stringify(KEYWORDS.CART_ERROR)};
                      var toastSelectors = '[class*="toast"], [class*="Toast"], [class*="message"], [class*="Message"], [class*="notice"], [class*="Notice"], [class*="success"], [class*="Success"], [class*="dialog"], [class*="Dialog"], [class*="error"], [class*="Error"], [class*="warning"], [class*="Warning"], [class*="popup"], [class*="Popup"], [class*="layer"], [class*="Layer"]';
                      var toastEls = document.querySelectorAll(toastSelectors);
                      for (var k = 0; k < toastEls.length; k++) {
                        var t = (toastEls[k].textContent || '').trim();
                        for (var i = 0; i < errorHints.length; i++) {
                          if (t.includes(errorHints[i])) return { type: 'error', hint: errorHints[i] };
                        }
                        for (var j = 0; j < successHints.length; j++) {
                          if (t.includes(successHints[j])) return { type: 'success' };
                        }
                        if (t.includes('购物车') && (t.includes('成功') || t.includes('已'))) return { type: 'success' };
                      }
                      var bodyText = (document.body?.innerText || '');
                      for (var m = 0; m < errorHints.length; m++) {
                        if (bodyText.includes(errorHints[m])) return { type: 'error', hint: errorHints[m] };
                      }
                      for (var n = 0; n < successHints.length; n++) {
                        if (bodyText.includes(successHints[n])) return { type: 'success' };
                      }
                      return null;
                    })()
                  `)
                  debugLog(`[Taobao] Frame cart result detected: ${JSON.stringify(frameCartResult)}`)

                  if (frameCartResult?.type === 'success') {
                    resolved = true
                    clearTimeout(timeout)
                    clearInterval(checkInterval)
                    await this.cookieManager.syncCookiesFromElectron(this.getContext(), this.auth)
                    this.windowManager.closeShopWindow()
                    this.emitStatus('已加入购物车')
                    resolve({ success: true, directToPay: false })
                    return
                  }

                  if (frameCartResult?.type === 'error') {
                    resolved = true
                    clearTimeout(timeout)
                    clearInterval(checkInterval)
                    this.windowManager.closeShopWindow(async () => { await this.cookieManager.syncCookiesFromElectron(this.getContext(), this.auth) })
                    const errorMsg = `商品不可购买（${frameCartResult.hint}）`
                    this.emitStatus(errorMsg)
                    resolve({ success: false, error: errorMsg })
                    return
                  }
                } else {
                  this.emitStatus('已点击再买一单，等待页面跳转...')
                }
                return
              }
            } catch (e: unknown) {
              debugLog(`[Taobao] Frame search error: ${e}`)
            }
          }

          resolved = true
          clearTimeout(timeout)
          clearInterval(checkInterval)
          this.windowManager.closeShopWindow(async () => { await this.cookieManager.syncCookiesFromElectron(this.getContext(), this.auth) })
          this.emitStatus('未找到再买一单入口')
          resolve({ success: false, error: '未找到再买一单入口' })
        } catch (e: unknown) {
          debugLog(`[Taobao] Hidden window rebuy click error: ${e}`)
          resolved = true
          clearTimeout(timeout)
          clearInterval(checkInterval)
          this.windowManager.closeShopWindow(async () => { await this.cookieManager.syncCookiesFromElectron(this.getContext(), this.auth) })
          resolve({ success: false, error: String(e) })
        }
      }

      let loginRetryCount = 0

      const currentSw = this.windowManager.getShopWindow()!
      lt.on(currentSw.webContents, 'did-finish-load', async () => {
        if (resolved) return
        const sw = this.windowManager.getShopWindow()
        const url = sw?.webContents.getURL()
        if (!url) return
        debugLog(`[Taobao] Hidden window loaded: ${url}`)

        const hasCaptcha = await this.verificationService.detectCaptcha(sw!)
        if (hasCaptcha) {
          await sw?.webContents.executeJavaScript(`
            (function() {
              try {
                Object.defineProperty(Document.prototype, 'visibilityState', { get: function() { return document.hidden ? 'hidden' : 'visible'; }, configurable: true });
                Object.defineProperty(Document.prototype, 'hidden', { get: function() { return !document.hasFocus(); }, configurable: true });
                Object.defineProperty(document, 'visibilityState', { get: function() { return document.hidden ? 'hidden' : 'visible'; }, configurable: true });
                Object.defineProperty(document, 'hidden', { get: function() { return !document.hasFocus(); }, configurable: true });
              } catch(e) {}
            })()
          `).catch(() => {})
          sw?.restore()
          sw?.setSize(WINDOW_SIZES.CONFIRMATION.width, WINDOW_SIZES.CONFIRMATION.height)
          sw?.setTitle('淘宝安全验证')
          injectOverlayBanner(sw!, '🔐 自动购物助手：淘宝要求安全验证，请拖动滑块完成验证')
          injectCenterToast(sw!, "请拖动滑块完成验证")
          this.emitStatus('需要进行滑块验证，请在弹出的窗口中完成验证...')
          const verified = await this.interactionService.waitForUserConfirmation(
            sw!,
            '淘宝要求安全验证（滑块验证），请在弹出的窗口中拖动滑块完成验证，然后点击"已完成"',
            '淘宝安全验证',
            '🔐 请拖动滑块完成验证',
          )
          if (!verified) {
            resolved = true
            clearTimeout(timeout)
            clearInterval(checkInterval)
            this.windowManager.closeShopWindow(async () => { await this.cookieManager.syncCookiesFromElectron(this.getContext(), this.auth) })
            resolve({ success: false, error: '安全验证未完成' })
            return
          }
          await humanDelay(1000)
          return
        }

        if (isLoginPage(url)) {
          if (loginRetryCount < 1) {
            loginRetryCount++
            debugLog(`[Taobao] Login page detected, re-syncing cookies and retrying...`)
            this.emitStatus('检测到登录页面，正在重新同步登录状态...')
            this.cookieManager.resetToElectronSyncTimer()
            await this.cookieManager.syncCookiesToElectron(this.getContext(), this.auth)
            await humanDelay(500)
            sw?.loadURL(detailUrl)
            return
          }
          resolved = true
          clearTimeout(timeout)
          this.windowManager.closeShopWindow(async () => { await this.cookieManager.syncCookiesFromElectron(this.getContext(), this.auth) })
          this.emitStatus('登录已过期，请重新登录')
          resolve({ success: false, error: '登录已过期' })
          return
        }

        const directToPay = isBuyPage(url)
        if (directToPay) {
          resolved = true
          clearTimeout(timeout)
          clearInterval(checkInterval)
          await this.cookieManager.syncCookiesFromElectron(this.getContext(), this.auth)
          if (cartOnly) {
            this.windowManager.closeShopWindow()
            this.emitStatus('该商品不支持加入购物车，点击后直接进入了结算页面')
            resolve({ success: false, error: '该商品不支持加入购物车，点击后直接进入了结算页面' })
          } else {
            this.emitStatus('已进入结算页面')
            resolve({ success: true, directToPay: true })
          }
          return
        }

        if (isCartPage(url)) {
          resolved = true
          clearTimeout(timeout)
          clearInterval(checkInterval)
          await this.cookieManager.syncCookiesFromElectron(this.getContext(), this.auth)
          this.emitStatus('已加入购物车')
          resolve({ success: true, directToPay: false })
          return
        }

        if (isOrderArchivePage(url)) {
          debugLog(`[Taobao] tradearchive page detected, no rebuy button available`)
          resolved = true
          clearTimeout(timeout)
          clearInterval(checkInterval)
          this.windowManager.closeShopWindow(async () => { await this.cookieManager.syncCookiesFromElectron(this.getContext(), this.auth) })
          this.emitStatus('未找到再买一单入口')
          resolve({ success: false, error: '未找到再买一单入口' })
          return
        }

        if (isProductDetailPage(url)) {
          debugLog(`[Taobao] Product detail page detected after rebuy click, showing to user`)
          this.emitStatus('再买一单后跳转到商品详情页，请在弹出的窗口中选择规格并购买')
          sw!.setSize(WINDOW_SIZES.CONFIRMATION.width, WINDOW_SIZES.CONFIRMATION.height)
          sw!.setTitle('请选择规格并购买')
          const mw = this.windowManager.getMainWindow()
          if (mw) sw!.setParentWindow(mw)
          injectOverlayBanner(sw!, '🛒 自动购物助手：请选择规格并点击"立即购买"或"加入购物车"')
          injectCenterToast(sw!, '请选择规格并购买')
          sw!.show()
          const confirmed = await this.interactionService.waitForUserConfirmation(
            sw!,
            '已进入商品详情页，请在弹出的窗口中选择规格并购买，完成后点击"已完成"',
            '选择规格并购买',
            '🛒 请选择规格并购买',
            'add-to-cart',
          )
          if (!confirmed || sw!.isDestroyed()) {
            resolved = true
            clearTimeout(timeout)
            clearInterval(checkInterval)
            if (!sw!.isDestroyed()) this.windowManager.closeShopWindow(async () => { await this.cookieManager.syncCookiesFromElectron(this.getContext(), this.auth) })
            resolve({ success: false, error: '用户取消了购买' })
            return
          }
          let afterUrl = ''
          try { afterUrl = sw!.webContents.getURL() } catch { /* window destroyed */ }
          if (isBuyPage(afterUrl)) {
            resolved = true
            clearTimeout(timeout)
            clearInterval(checkInterval)
            await this.cookieManager.syncCookiesFromElectron(this.getContext(), this.auth)
            this.emitStatus('已进入结算页面')
            resolve({ success: true, directToPay: true })
            return
          }
          if (isCartPage(afterUrl)) {
            resolved = true
            clearTimeout(timeout)
            clearInterval(checkInterval)
            await this.cookieManager.syncCookiesFromElectron(this.getContext(), this.auth)
            this.emitStatus('已加入购物车')
            resolve({ success: true, directToPay: false })
            return
          }
          resolved = true
          clearTimeout(timeout)
          clearInterval(checkInterval)
          await this.cookieManager.syncCookiesFromElectron(this.getContext(), this.auth)
          this.emitStatus('已加入购物车')
          resolve({ success: true, directToPay: false })
          return
        }

        const btnSearchSelectors = ['button', 'a', '[class*="btn"]', '[class*="Button"]', '[role="button"]', '[class*="action"]', '[class*="submit"]', '[class*="rebuy"]', '[class*="Rebuy"]', '[class*="buy-again"]', '[class*="BuyAgain"]', '[data-spm*="rebuy"]', '[data-spm*="buy"]', 'span[class*="click"]', 'div[class*="click"]']
        let rebuyBtnFound = false
        const btnSearchTargets = cartOnly ? [...KEYWORDS.CART_BUTTONS, ...KEYWORDS.REBUY_BUTTONS] : [...KEYWORDS.REBUY_BUTTONS]
        const MAX_RETRIES = 10
        const RETRY_DELAYS = [500, 500, 500, 1000, 1000, 1000, 2000, 2000, 2000, 2000]
        let prevBodyLen = 0
        let stableCount = 0
        for (let retry = 0; retry < MAX_RETRIES && !this.isDestroyed(); retry++) {
          try {
            if (retry === 0) {
              const pageDiag = await execJS(sw, `
                (function() {
                  var bodyText = (document.body?.innerText || '').substring(0, 2000);
                  var allTexts = [];
                  var foundEls = _hs.findVisible(['button', 'a', '[class*="btn"]', '[class*="Button"]', '[role="button"]', '[class*="action"]', '[class*="submit"]', 'span', 'div']);
                  for (var fi = 0; fi < foundEls.length; fi++) {
                    var t = foundEls[fi].text;
                    if (t && t.length <= 20 && t.length >= 2) {
                      allTexts.push(foundEls[fi].el.tagName + ':' + t);
                    }
                  }
                  var broadResults = _hs.findByText(${JSON.stringify(btnSearchTargets)}, 20);
                  var broadTexts = [];
                  for (var bi = 0; bi < broadResults.length; bi++) {
                    broadTexts.push(broadResults[bi].el.tagName + ':' + broadResults[bi].text.substring(0, 30));
                  }
                  return { url: location.href, bodyLen: bodyText.length, bodyPreview: bodyText.substring(0, 500), visibleTexts: allTexts.join('|'), broadMatchTexts: broadTexts.join('|') };
                })()
              `)
              debugLog(`[Taobao] PAGE DIAG: ${JSON.stringify(pageDiag)}`)
            }
            const mainHasBtn = await execJS(sw, `
              (function() {
                var targets = ${JSON.stringify(btnSearchTargets)};
                var found = _hs.findVisible(${JSON.stringify(btnSearchSelectors)}, targets);
                var foundItems = [];
                for (var fi = 0; fi < found.length; fi++) {
                  foundItems.push({ tag: found[fi].el.tagName, text: found[fi].text.substring(0, 40), w: Math.round(found[fi].rect.width), h: Math.round(found[fi].rect.height) });
                }
                if (found.length > 0) return { found: true, matches: foundItems, method: 'selector', bodyLen: (document.body?.innerText || '').length };
                var broadFound = _hs.findByText(targets, 20);
                for (var bi = 0; bi < broadFound.length; bi++) {
                  foundItems.push({ tag: broadFound[bi].el.tagName, text: broadFound[bi].text.substring(0, 40), w: Math.round(broadFound[bi].rect.width), h: Math.round(broadFound[bi].rect.height) });
                }
                if (broadFound.length > 0) return { found: true, matches: foundItems, method: 'findByText', bodyLen: (document.body?.innerText || '').length };
                var shadowFound = _hs.findInShadowDOM(${JSON.stringify(btnSearchSelectors)}, targets);
                for (var si = 0; si < shadowFound.length; si++) {
                  foundItems.push({ tag: shadowFound[si].el.tagName, text: shadowFound[si].text.substring(0, 40), w: Math.round(shadowFound[si].rect.width), h: Math.round(shadowFound[si].rect.height) });
                }
                if (shadowFound.length > 0) return { found: true, matches: foundItems, method: 'shadowDOM', bodyLen: (document.body?.innerText || '').length };
                return { found: false, matches: foundItems, bodyLen: (document.body?.innerText || '').length };
              })()
            `)
            debugLog(`[Taobao] rebuyBtnFound retry ${retry} main: ${JSON.stringify(mainHasBtn)}`)
            if (mainHasBtn?.found) { rebuyBtnFound = true; break }
            const currentBodyLen = mainHasBtn?.bodyLen || 0
            if (retry >= 2 && currentBodyLen > 0 && currentBodyLen === prevBodyLen) {
              stableCount++
              if (stableCount >= 3) {
                debugLog(`[Taobao] Page content stable for 3 consecutive checks (bodyLen=${currentBodyLen}), stopping early`)
                break
              }
            } else {
              stableCount = 0
            }
            prevBodyLen = currentBodyLen
            const frames = sw!.webContents.mainFrame.framesInSubtree
            for (const frame of frames) {
              if (frame === sw!.webContents.mainFrame) continue
              const fUrl = frame.url
              debugLog(`[Taobao] rebuyBtnFound retry ${retry} frame: ${fUrl.substring(0, 100)}`)
              try {
                await frame.executeJavaScript(HUMAN_SIM_JS).catch(() => {})
                const fHasBtn = await frame.executeJavaScript(`
                  (function() {
                    var targets = ${JSON.stringify(btnSearchTargets)};
                    var found = _hs.findVisible(${JSON.stringify(btnSearchSelectors)}, targets);
                    var foundItems = [];
                    for (var fi = 0; fi < found.length; fi++) {
                      foundItems.push({ tag: found[fi].el.tagName, text: found[fi].text.substring(0, 40), w: Math.round(found[fi].rect.width), h: Math.round(found[fi].rect.height) });
                    }
                    if (found.length > 0) return { found: true, matches: foundItems, method: 'selector' };
                    var broadFound = _hs.findByText(targets, 20);
                    for (var bi = 0; bi < broadFound.length; bi++) {
                      foundItems.push({ tag: broadFound[bi].el.tagName, text: broadFound[bi].text.substring(0, 40), w: Math.round(broadFound[bi].rect.width), h: Math.round(broadFound[bi].rect.height) });
                    }
                    if (broadFound.length > 0) return { found: true, matches: foundItems, method: 'findByText' };
                    var shadowFound = _hs.findInShadowDOM(${JSON.stringify(btnSearchSelectors)}, targets);
                    for (var si = 0; si < shadowFound.length; si++) {
                      foundItems.push({ tag: shadowFound[si].el.tagName, text: shadowFound[si].text.substring(0, 40), w: Math.round(shadowFound[si].rect.width), h: Math.round(shadowFound[si].rect.height) });
                    }
                    if (shadowFound.length > 0) return { found: true, matches: foundItems, method: 'shadowDOM' };
                    return { found: false, matches: foundItems };
                  })()
                `)
                debugLog(`[Taobao] rebuyBtnFound frame ${fUrl.substring(0, 60)}: ${JSON.stringify(fHasBtn)}`)
                if (fHasBtn?.found) { rebuyBtnFound = true; break }
              } catch (e: unknown) {
                debugLog(`[Taobao] rebuyBtnFound frame error: ${e}`)
              }
            }
          } catch (e: unknown) {
            debugLog(`[Taobao] rebuyBtnFound retry ${retry} error: ${e}`)
          }
          if (rebuyBtnFound) break
          if (retry === 1 || retry === 4 || retry === 7) {
            try {
              await sw?.webContents.executeJavaScript(`window.scrollTo(0, document.body.scrollHeight);`).catch(() => {})
              await humanDelay(300)
              await sw?.webContents.executeJavaScript(`window.scrollTo(0, 0);`).catch(() => {})
              await humanDelay(300)
            } catch { /* ignore */ }
          }
          const delay = RETRY_DELAYS[retry] || 2000
          await humanDelay(delay)
        }

        if (!rebuyBtnFound) {
          debugLog(`[Taobao] Rebuy button not found after 20 retries, skipping to search fallback`)
          this.emitStatus('未找到再买一单按钮，将搜索替代商品...')
          resolved = true
          clearTimeout(timeout)
          clearInterval(checkInterval)
          if (!sw!.isDestroyed()) this.windowManager.closeShopWindow(async () => { await this.cookieManager.syncCookiesFromElectron(this.getContext(), this.auth) })
          resolve({ success: false, error: '未找到再买一单入口' })
          return
        }

        let offShelfResult: { offShelf: boolean; keyword: string } | null = null
        try {
          const mainOffShelf = await execJS(sw, `
            (function() {
              var bodyText = (document.body?.innerText || '');
              var offShelfKeywords = ${JSON.stringify(KEYWORDS.OFF_SHELF)};
              var matchedKeyword = '';
              for (var i = 0; i < offShelfKeywords.length; i++) {
                if (bodyText.includes(offShelfKeywords[i])) {
                  matchedKeyword = offShelfKeywords[i];
                  break;
                }
              }
              if (!matchedKeyword) return { offShelf: false, keyword: '' };
              var buyFound = _hs.findVisible(['button', 'a', '[class*="btn"]', '[class*="Button"]', '[role="button"]', '[class*="action"]', '[class*="submit"]'], ${JSON.stringify(KEYWORDS.BUY_BUTTONS)});
              if (buyFound.length > 0) return { offShelf: false, keyword: '' };
              return { offShelf: true, keyword: matchedKeyword };
            })()
          `)
          if (mainOffShelf?.offShelf) {
            offShelfResult = mainOffShelf
          } else {
            const frames = sw!.webContents.mainFrame.framesInSubtree
            for (const frame of frames) {
              if (frame === sw!.webContents.mainFrame) continue
              const fUrl = frame.url
              if (!fUrl.includes('tmall.com') && !fUrl.includes('taobao.com')) continue
              try {
                await frame.executeJavaScript(HUMAN_SIM_JS).catch(() => {})
                const fOffShelf = await frame.executeJavaScript(`
                  (function() {
                    var bodyText = (document.body?.innerText || '');
                    var offShelfKeywords = ${JSON.stringify(KEYWORDS.OFF_SHELF)};
                    var matchedKeyword = '';
                    for (var i = 0; i < offShelfKeywords.length; i++) {
                      if (bodyText.includes(offShelfKeywords[i])) {
                        matchedKeyword = offShelfKeywords[i];
                        break;
                      }
                    }
                    if (!matchedKeyword) return { offShelf: false, keyword: '' };
                    var buyFound = _hs.findVisible(['button', 'a', '[class*="btn"]', '[class*="Button"]', '[role="button"]', '[class*="action"]', '[class*="submit"]'], ${JSON.stringify(KEYWORDS.BUY_BUTTONS)});
                    if (buyFound.length > 0) return { offShelf: false, keyword: '' };
                    return { offShelf: true, keyword: matchedKeyword };
                  })()
                `)
                if (fOffShelf?.offShelf) { offShelfResult = fOffShelf; break }
              } catch { /* ignore */ }
            }
          }
          if (isOrderDetailPage(url)) {
            sameUrlCount++
            if (sameUrlCount >= 15) {
              rebuyRetryCount++
              if (rebuyRetryCount > MAX_REBUY_RETRIES) {
                debugLog(`[Taobao] checkInterval: Max rebuy retries reached, giving up`)
                resolved = true
                clearTimeout(timeout)
                clearInterval(checkInterval)
                this.windowManager.closeShopWindow(async () => { await this.cookieManager.syncCookiesFromElectron(this.getContext(), this.auth) })
                this.emitStatus('多次点击再买一单后页面未跳转，请尝试搜索购买')
                resolve({ success: false, error: '多次点击再买一单后页面未跳转' })
                return
              }
              debugLog(`[Taobao] checkInterval: Page still on order detail after ${sameUrlCount * 2}s, retrying rebuy click (${rebuyRetryCount}/${MAX_REBUY_RETRIES})`)
              sameUrlCount = 0
              tryClickRebuy()
            }
          } else {
            sameUrlCount = 0
          }
        } catch { /* ignore */ }

        if (offShelfResult?.offShelf) {
          resolved = true
          clearTimeout(timeout)
          clearInterval(checkInterval)
          this.windowManager.closeShopWindow(async () => { await this.cookieManager.syncCookiesFromElectron(this.getContext(), this.auth) })
          this.emitStatus(`商品不可购买（${offShelfResult.keyword}）`)
          resolve({ success: false, error: `商品不可购买（${offShelfResult.keyword}）` })
          return
        }

        await tryClickRebuy()
      })

      lt.on(currentSw.webContents, 'did-navigate', async (_event, navUrl: string) => {
        if (resolved) return
        debugLog(`[Taobao] Hidden window navigated: ${navUrl}`)
        await humanDelay(1500)
        const sw = this.windowManager.getShopWindow()
        if (!sw || sw.isDestroyed()) return
        const url = sw.webContents.getURL()

        if (isBuyPage(url)) {
          resolved = true
          clearTimeout(timeout)
          clearInterval(checkInterval)
          await this.cookieManager.syncCookiesFromElectron(this.getContext(), this.auth)
          if (cartOnly) {
            this.windowManager.closeShopWindow()
            this.emitStatus('该商品不支持加入购物车，点击后直接进入了结算页面')
            resolve({ success: false, error: '该商品不支持加入购物车，点击后直接进入了结算页面' })
          } else {
            this.emitStatus('已进入结算页面')
            resolve({ success: true, directToPay: true })
          }
          return
        }

        if (isCartPage(url)) {
          resolved = true
          clearTimeout(timeout)
          clearInterval(checkInterval)
          await this.cookieManager.syncCookiesFromElectron(this.getContext(), this.auth)
          this.emitStatus('已加入购物车')
          resolve({ success: true, directToPay: false })
          return
        }

        if (isProductDetailPage(url)) {
          debugLog(`[Taobao] did-navigate: Product detail page detected, showing to user`)
          this.emitStatus('再买一单后跳转到商品详情页，请在弹出的窗口中选择规格并购买')
          sw.setSize(WINDOW_SIZES.CONFIRMATION.width, WINDOW_SIZES.CONFIRMATION.height)
          sw.setTitle('请选择规格并购买')
          const mw = this.windowManager.getMainWindow()
          if (mw) sw.setParentWindow(mw)
          injectOverlayBanner(sw, '🛒 自动购物助手：请选择规格并点击"立即购买"或"加入购物车"')
          injectCenterToast(sw, '请选择规格并购买')
          sw.show()
          const confirmed = await this.interactionService.waitForUserConfirmation(
            sw,
            '已进入商品详情页，请在弹出的窗口中选择规格并购买，完成后点击"已完成"',
            '选择规格并购买',
            '🛒 请选择规格并购买',
            'add-to-cart',
          )
          if (!confirmed || sw.isDestroyed()) {
            resolved = true
            clearTimeout(timeout)
            clearInterval(checkInterval)
            if (!sw.isDestroyed()) this.windowManager.closeShopWindow(async () => { await this.cookieManager.syncCookiesFromElectron(this.getContext(), this.auth) })
            resolve({ success: false, error: '用户取消了购买' })
            return
          }
          let afterUrl = ''
          try { afterUrl = sw.webContents.getURL() } catch { /* window destroyed */ }
          if (isBuyPage(afterUrl)) {
            resolved = true
            clearTimeout(timeout)
            clearInterval(checkInterval)
            await this.cookieManager.syncCookiesFromElectron(this.getContext(), this.auth)
            this.emitStatus('已进入结算页面')
            resolve({ success: true, directToPay: true })
            return
          }
          if (isCartPage(afterUrl)) {
            resolved = true
            clearTimeout(timeout)
            clearInterval(checkInterval)
            await this.cookieManager.syncCookiesFromElectron(this.getContext(), this.auth)
            this.emitStatus('已加入购物车')
            resolve({ success: true, directToPay: false })
            return
          }
          resolved = true
          clearTimeout(timeout)
          clearInterval(checkInterval)
          await this.cookieManager.syncCookiesFromElectron(this.getContext(), this.auth)
          this.emitStatus('已加入购物车')
          resolve({ success: true, directToPay: false })
          return
        }

        if (isOrderArchivePage(url)) {
          debugLog(`[Taobao] did-navigate: tradearchive page detected, no rebuy button available`)
          resolved = true
          clearTimeout(timeout)
          clearInterval(checkInterval)
          this.windowManager.closeShopWindow(async () => { await this.cookieManager.syncCookiesFromElectron(this.getContext(), this.auth) })
          this.emitStatus('未找到再买一单入口')
          resolve({ success: false, error: '未找到再买一单入口' })
          return
        }

        if (isLoginPage(url)) {
          if (loginRetryCount < 1) {
            loginRetryCount++
            debugLog(`[Taobao] did-navigate: Login page detected, re-syncing cookies and retrying...`)
            this.emitStatus('检测到登录页面，正在重新同步登录状态...')
            this.cookieManager.resetToElectronSyncTimer()
            await this.cookieManager.syncCookiesToElectron(this.getContext(), this.auth)
            await humanDelay(500)
            sw.loadURL(detailUrl)
            return
          }
          resolved = true
          clearTimeout(timeout)
          clearInterval(checkInterval)
          this.windowManager.closeShopWindow(async () => { await this.cookieManager.syncCookiesFromElectron(this.getContext(), this.auth) })
          this.emitStatus('登录已过期，请重新登录')
          resolve({ success: false, error: '登录已过期' })
          return
        }
      })

      lt.on(currentSw.webContents, 'did-navigate-in-page', async (_event, navUrl: string) => {
        if (resolved) return
        debugLog(`[Taobao] Hidden window in-page navigation: ${navUrl}`)
        const sw = this.windowManager.getShopWindow()
        if (!sw || sw.isDestroyed()) return

        if (isBuyPage(navUrl)) {
          resolved = true
          clearTimeout(timeout)
          clearInterval(checkInterval)
          await this.cookieManager.syncCookiesFromElectron(this.getContext(), this.auth)
          if (cartOnly) {
            this.windowManager.closeShopWindow()
            this.emitStatus('该商品不支持加入购物车，点击后直接进入了结算页面')
            resolve({ success: false, error: '该商品不支持加入购物车，点击后直接进入了结算页面' })
          } else {
            this.emitStatus('已进入结算页面')
            resolve({ success: true, directToPay: true })
          }
          return
        }

        if (isCartPage(navUrl)) {
          resolved = true
          clearTimeout(timeout)
          clearInterval(checkInterval)
          await this.cookieManager.syncCookiesFromElectron(this.getContext(), this.auth)
          this.emitStatus('已加入购物车')
          resolve({ success: true, directToPay: false })
          return
        }

        if (isProductDetailPage(navUrl)) {
          debugLog(`[Taobao] did-navigate-in-page: Product detail page detected, showing to user`)
          this.emitStatus('再买一单后跳转到商品详情页，请在弹出的窗口中选择规格并购买')
          sw.setSize(WINDOW_SIZES.CONFIRMATION.width, WINDOW_SIZES.CONFIRMATION.height)
          sw.setTitle('请选择规格并购买')
          const mw = this.windowManager.getMainWindow()
          if (mw) sw.setParentWindow(mw)
          injectOverlayBanner(sw, '🛒 自动购物助手：请选择规格并点击"立即购买"或"加入购物车"')
          injectCenterToast(sw, '请选择规格并购买')
          sw.show()
          const confirmed = await this.interactionService.waitForUserConfirmation(
            sw,
            '已进入商品详情页，请在弹出的窗口中选择规格并购买，完成后点击"已完成"',
            '选择规格并购买',
            '🛒 请选择规格并购买',
            'add-to-cart',
          )
          if (!confirmed || sw.isDestroyed()) {
            resolved = true
            clearTimeout(timeout)
            clearInterval(checkInterval)
            if (!sw.isDestroyed()) this.windowManager.closeShopWindow(async () => { await this.cookieManager.syncCookiesFromElectron(this.getContext(), this.auth) })
            resolve({ success: false, error: '用户取消了购买' })
            return
          }
          let afterUrl = ''
          try { afterUrl = sw.webContents.getURL() } catch { /* window destroyed */ }
          resolved = true
          clearTimeout(timeout)
          clearInterval(checkInterval)
          await this.cookieManager.syncCookiesFromElectron(this.getContext(), this.auth)
          if (isBuyPage(afterUrl)) {
            this.emitStatus('已进入结算页面')
            resolve({ success: true, directToPay: true })
          } else if (isCartPage(afterUrl)) {
            this.emitStatus('已加入购物车')
            resolve({ success: true, directToPay: false })
          } else {
            this.emitStatus('已加入购物车')
            resolve({ success: true, directToPay: false })
          }
          return
        }
      })

      lt.on(currentSw.webContents, 'frame-navigated', async (_event) => {
        if (resolved) return
        const sw = this.windowManager.getShopWindow()
        if (!sw || sw.isDestroyed()) return
        const frames = sw.webContents.mainFrame.framesInSubtree
        for (const frame of frames) {
          if (frame === sw.webContents.mainFrame) continue
          const frameUrl = frame.url
          if (isBuyPage(frameUrl)) {
            debugLog(`[Taobao] frame-navigated: Buy page detected in iframe: ${frameUrl}`)
            resolved = true
            clearTimeout(timeout)
            clearInterval(checkInterval)
            await this.cookieManager.syncCookiesFromElectron(this.getContext(), this.auth)
            if (cartOnly) {
              this.windowManager.closeShopWindow()
              this.emitStatus('该商品不支持加入购物车，点击后直接进入了结算页面')
              resolve({ success: false, error: '该商品不支持加入购物车，点击后直接进入了结算页面' })
            } else {
              this.emitStatus('已进入结算页面')
              resolve({ success: true, directToPay: true })
            }
            return
          }
          if (isCartPage(frameUrl)) {
            debugLog(`[Taobao] frame-navigated: Cart page detected in iframe: ${frameUrl}`)
            resolved = true
            clearTimeout(timeout)
            clearInterval(checkInterval)
            await this.cookieManager.syncCookiesFromElectron(this.getContext(), this.auth)
            this.emitStatus('已加入购物车')
            resolve({ success: true, directToPay: false })
            return
          }
          if (isProductDetailPage(frameUrl)) {
            debugLog(`[Taobao] frame-navigated: Product detail page detected in iframe: ${frameUrl}`)
            resolved = true
            clearTimeout(timeout)
            clearInterval(checkInterval)
            sw.setSize(WINDOW_SIZES.CONFIRMATION.width, WINDOW_SIZES.CONFIRMATION.height)
            sw.setTitle('请选择规格并购买')
            const mw = this.windowManager.getMainWindow()
            if (mw) sw.setParentWindow(mw)
            injectOverlayBanner(sw, '🛒 自动购物助手：请选择规格并点击"立即购买"或"加入购物车"')
            injectCenterToast(sw, '请选择规格并购买')
            sw.show()
            this.emitStatus('再买一单后跳转到商品详情页，请在弹出的窗口中选择规格并购买')
            const confirmed = await this.interactionService.waitForUserConfirmation(
              sw,
              '已进入商品详情页，请在弹出的窗口中选择规格并购买，完成后点击"已完成"',
              '选择规格并购买',
              '🛒 请选择规格并购买',
              'add-to-cart',
            )
            if (!confirmed || sw.isDestroyed()) {
              if (!sw.isDestroyed()) this.windowManager.closeShopWindow(async () => { await this.cookieManager.syncCookiesFromElectron(this.getContext(), this.auth) })
              resolve({ success: false, error: '用户取消了购买' })
            } else {
              let afterUrl = ''
              try { afterUrl = sw.webContents.getURL() } catch { /* window destroyed */ }
              resolved = true
              clearTimeout(timeout)
              clearInterval(checkInterval)
              await this.cookieManager.syncCookiesFromElectron(this.getContext(), this.auth)
              if (isBuyPage(afterUrl)) {
                this.emitStatus('已进入结算页面')
                resolve({ success: true, directToPay: true })
              } else if (isCartPage(afterUrl)) {
                this.emitStatus('已加入购物车')
                resolve({ success: true, directToPay: false })
              } else {
                this.emitStatus('已加入购物车')
                resolve({ success: true, directToPay: false })
              }
            }
            return
          }
        }
      })

      const checkInterval = setInterval(async () => {
        if (resolved) { clearInterval(checkInterval); return }
        if (this.isDestroyed()) {
          clearInterval(checkInterval)
          if (!resolved) {
            resolved = true
            clearTimeout(timeout)
            resolve({ success: false, error: '任务已取消' })
          }
          return
        }
        try {
          const sw = this.windowManager.getShopWindow()
          if (!sw || sw.isDestroyed()) {
            clearInterval(checkInterval)
            if (!resolved) {
              resolved = true
              clearTimeout(timeout)
              resolve({ success: false, error: '操作窗口已关闭' })
            }
            return
          }
          const url = sw.webContents.getURL()
          if (!url) return

          if (cartOnly && (isOrderDetailPage(url) || url.includes('orderDetail'))) {
            const intervalCartResult = await sw?.webContents.executeJavaScript(`
              (function() {
                var successHints = ${JSON.stringify(KEYWORDS.CART_SUCCESS)};
                var errorHints = ${JSON.stringify(KEYWORDS.CART_ERROR)};
                var toastSelectors = '[class*="toast"], [class*="Toast"], [class*="message"], [class*="Message"], [class*="notice"], [class*="Notice"], [class*="success"], [class*="Success"], [class*="dialog"], [class*="Dialog"], [class*="error"], [class*="Error"], [class*="warning"], [class*="Warning"], [class*="popup"], [class*="Popup"], [class*="layer"], [class*="Layer"], [class*="modal"], [class*="Modal"]';
                var toastEls = document.querySelectorAll(toastSelectors);
                for (var k = 0; k < toastEls.length; k++) {
                  var t = (toastEls[k].textContent || '').trim();
                  for (var i = 0; i < errorHints.length; i++) {
                    if (t.includes(errorHints[i])) return { type: 'error', hint: errorHints[i] };
                  }
                  for (var j = 0; j < successHints.length; j++) {
                    if (t.includes(successHints[j])) return { type: 'success' };
                  }
                  if (t.includes('购物车') && (t.includes('成功') || t.includes('已'))) return { type: 'success' };
                }
                var bodyText = (document.body?.innerText || '');
                for (var m = 0; m < errorHints.length; m++) {
                  if (bodyText.includes(errorHints[m])) return { type: 'error', hint: errorHints[m] };
                }
                for (var n = 0; n < successHints.length; n++) {
                  if (bodyText.includes(successHints[n])) return { type: 'success' };
                }
                return null;
              })()
            `).catch(() => null)
            if (intervalCartResult?.type === 'success') {
              resolved = true
              clearTimeout(timeout)
              clearInterval(checkInterval)
              await this.cookieManager.syncCookiesFromElectron(this.getContext(), this.auth)
              this.windowManager.closeShopWindow()
              this.emitStatus('已加入购物车')
              resolve({ success: true, directToPay: false })
              return
            }
            if (intervalCartResult?.type === 'error') {
              resolved = true
              clearTimeout(timeout)
              clearInterval(checkInterval)
              this.windowManager.closeShopWindow(async () => { await this.cookieManager.syncCookiesFromElectron(this.getContext(), this.auth) })
              const errorMsg = `商品不可购买（${intervalCartResult.hint}）`
              this.emitStatus(errorMsg)
              resolve({ success: false, error: errorMsg })
              return
            }
          }

          if (isOrderDetailPage(url) || url.includes('orderDetail')) {
            const frames = sw!.webContents.mainFrame.framesInSubtree
            let iframeNavigated = false
            for (const frame of frames) {
              if (frame === sw!.webContents.mainFrame) continue
              const frameUrl = frame.url
              if (isBuyPage(frameUrl)) {
                debugLog(`[Taobao] checkInterval: Buy page detected in iframe: ${frameUrl}`)
                resolved = true
                clearTimeout(timeout)
                clearInterval(checkInterval)
                await this.cookieManager.syncCookiesFromElectron(this.getContext(), this.auth)
                if (cartOnly) {
                  this.windowManager.closeShopWindow()
                  this.emitStatus('该商品不支持加入购物车，点击后直接进入了结算页面')
                  resolve({ success: false, error: '该商品不支持加入购物车，点击后直接进入了结算页面' })
                } else {
                  this.emitStatus('已进入结算页面')
                  resolve({ success: true, directToPay: true })
                }
                return
              }
              if (isCartPage(frameUrl)) {
                debugLog(`[Taobao] checkInterval: Cart page detected in iframe: ${frameUrl}`)
                resolved = true
                clearTimeout(timeout)
                clearInterval(checkInterval)
                await this.cookieManager.syncCookiesFromElectron(this.getContext(), this.auth)
                this.emitStatus('已加入购物车')
                resolve({ success: true, directToPay: false })
                return
              }
              if (isProductDetailPage(frameUrl)) {
                debugLog(`[Taobao] checkInterval: Product detail page detected in iframe: ${frameUrl}`)
                resolved = true
                clearTimeout(timeout)
                clearInterval(checkInterval)
                sw!.setSize(WINDOW_SIZES.CONFIRMATION.width, WINDOW_SIZES.CONFIRMATION.height)
                sw!.setTitle('请选择规格并购买')
                const mw = this.windowManager.getMainWindow()
                if (mw) sw!.setParentWindow(mw)
                injectOverlayBanner(sw!, '🛒 自动购物助手：请选择规格并点击"立即购买"或"加入购物车"')
                injectCenterToast(sw!, '请选择规格并购买')
                sw!.show()
                this.emitStatus('再买一单后跳转到商品详情页，请在弹出的窗口中选择规格并购买')
                const confirmed = await this.interactionService.waitForUserConfirmation(
                  sw!,
                  '已进入商品详情页，请在弹出的窗口中选择规格并购买，完成后点击"已完成"',
                  '选择规格并购买',
                  '🛒 请选择规格并购买',
                  'add-to-cart',
                )
                if (!confirmed || sw!.isDestroyed()) {
                  if (!sw!.isDestroyed()) this.windowManager.closeShopWindow(async () => { await this.cookieManager.syncCookiesFromElectron(this.getContext(), this.auth) })
                  resolve({ success: false, error: '用户取消了购买' })
                } else {
                  let afterUrl = ''
                  try { afterUrl = sw!.webContents.getURL() } catch { /* window destroyed */ }
                  if (isBuyPage(afterUrl)) {
                    await this.cookieManager.syncCookiesFromElectron(this.getContext(), this.auth)
                    this.emitStatus('已进入结算页面')
                    resolve({ success: true, directToPay: true })
                  } else if (isCartPage(afterUrl)) {
                    await this.cookieManager.syncCookiesFromElectron(this.getContext(), this.auth)
                    this.emitStatus('已加入购物车')
                    resolve({ success: true, directToPay: false })
                  } else {
                    await this.cookieManager.syncCookiesFromElectron(this.getContext(), this.auth)
                    this.emitStatus('已加入购物车')
                    resolve({ success: true, directToPay: false })
                  }
                }
                return
              }
              if (frameUrl.includes('taobao.com') || frameUrl.includes('tmall.com')) {
                iframeNavigated = true
              }
            }
            if (!iframeNavigated) {
              sameUrlCount++
              if (sameUrlCount >= 15) {
                rebuyRetryCount++
                if (rebuyRetryCount > MAX_REBUY_RETRIES) {
                  debugLog(`[Taobao] checkInterval: Max rebuy retries reached, giving up`)
                  resolved = true
                  clearTimeout(timeout)
                  clearInterval(checkInterval)
                  this.windowManager.closeShopWindow(async () => { await this.cookieManager.syncCookiesFromElectron(this.getContext(), this.auth) })
                  this.emitStatus('多次点击再买一单后页面未跳转，请尝试搜索购买')
                  resolve({ success: false, error: '多次点击再买一单后页面未跳转' })
                  return
                }
                debugLog(`[Taobao] checkInterval: Page still on order detail after ${sameUrlCount * 2}s, retrying rebuy click (${rebuyRetryCount}/${MAX_REBUY_RETRIES})`)
                sameUrlCount = 0
                tryClickRebuy()
              }
            } else {
              sameUrlCount = 0
            }
          }

          if (isBuyPage(url)) {
            resolved = true
            clearTimeout(timeout)
            clearInterval(checkInterval)
            await this.cookieManager.syncCookiesFromElectron(this.getContext(), this.auth)
            if (cartOnly) {
              this.windowManager.closeShopWindow()
              this.emitStatus('该商品不支持加入购物车，点击后直接进入了结算页面')
              resolve({ success: false, error: '该商品不支持加入购物车，点击后直接进入了结算页面' })
            } else {
              this.emitStatus('已进入结算页面')
              resolve({ success: true, directToPay: true })
            }
          } else if (isCartPage(url)) {
            resolved = true
            clearTimeout(timeout)
            clearInterval(checkInterval)
            await this.cookieManager.syncCookiesFromElectron(this.getContext(), this.auth)
            this.emitStatus('已加入购物车')
            resolve({ success: true, directToPay: false })
          } else if (isProductDetailPage(url)) {
            const offShelfCheck = await execJS(sw, `
              (function() {
                var bodyText = (document.body?.innerText || '');
                var keywords = ${JSON.stringify(KEYWORDS.OFF_SHELF)};
                var matchedKeyword = '';
                for (var i = 0; i < keywords.length; i++) {
                  if (bodyText.includes(keywords[i])) {
                    matchedKeyword = keywords[i];
                    break;
                  }
                }
                if (!matchedKeyword) return '';
                var buyFound = _hs.findVisible(['button', 'a', '[class*="btn"]', '[class*="Button"]', '[role="button"]', '[class*="action"]', '[class*="submit"]'], ${JSON.stringify(KEYWORDS.BUY_BUTTONS)});
                if (buyFound.length > 0) return '';
                return matchedKeyword;
              })()
            `).catch(() => '')
            if (offShelfCheck) {
              resolved = true
              clearTimeout(timeout)
              clearInterval(checkInterval)
              this.windowManager.closeShopWindow(async () => { await this.cookieManager.syncCookiesFromElectron(this.getContext(), this.auth) })
              this.emitStatus(`商品不可购买（${offShelfCheck}）`)
              resolve({ success: false, error: `商品不可购买（${offShelfCheck}）` })
            } else {
              debugLog(`[Taobao] checkInterval: Product detail page detected, showing to user`)
              this.emitStatus('再买一单后跳转到商品详情页，请在弹出的窗口中选择规格并购买')
              sw!.setSize(WINDOW_SIZES.CONFIRMATION.width, WINDOW_SIZES.CONFIRMATION.height)
              sw!.setTitle('请选择规格并购买')
              const mw = this.windowManager.getMainWindow()
              if (mw) sw!.setParentWindow(mw)
              injectOverlayBanner(sw!, '🛒 自动购物助手：请选择规格并点击"立即购买"或"加入购物车"')
              injectCenterToast(sw!, '请选择规格并购买')
              sw!.show()
              const confirmed = await this.interactionService.waitForUserConfirmation(
                sw!,
                '已进入商品详情页，请在弹出的窗口中选择规格并购买，完成后点击"已完成"',
                '选择规格并购买',
                '🛒 请选择规格并购买',
                'add-to-cart',
              )
              if (!confirmed || sw!.isDestroyed()) {
                resolved = true
                clearTimeout(timeout)
                clearInterval(checkInterval)
                if (!sw!.isDestroyed()) this.windowManager.closeShopWindow(async () => { await this.cookieManager.syncCookiesFromElectron(this.getContext(), this.auth) })
                resolve({ success: false, error: '用户取消了购买' })
                return
              }
              let afterUrl = ''
              try { afterUrl = sw!.webContents.getURL() } catch { /* window destroyed */ }
              if (isBuyPage(afterUrl)) {
                resolved = true
                clearTimeout(timeout)
                clearInterval(checkInterval)
                await this.cookieManager.syncCookiesFromElectron(this.getContext(), this.auth)
                this.emitStatus('已进入结算页面')
                resolve({ success: true, directToPay: true })
                return
              }
              if (isCartPage(afterUrl)) {
                resolved = true
                clearTimeout(timeout)
                clearInterval(checkInterval)
                await this.cookieManager.syncCookiesFromElectron(this.getContext(), this.auth)
                this.emitStatus('已加入购物车')
                resolve({ success: true, directToPay: false })
                return
              }
              resolved = true
              clearTimeout(timeout)
              clearInterval(checkInterval)
              await this.cookieManager.syncCookiesFromElectron(this.getContext(), this.auth)
              this.emitStatus('已加入购物车')
              resolve({ success: true, directToPay: false })
              return
            }
          }
        } catch { /* ignore */ }
      }, 2000)

      currentSw.on('closed', async () => {
        if (!resolved) {
          resolved = true
          clearTimeout(timeout)
          clearInterval(checkInterval)
          await this.cookieManager.syncCookiesFromElectron(this.getContext(), this.auth)
          this.windowManager.setShopWindow(null)
          resolve(null)
        }
      })
    })
  }

  async addToCartViaPlaywright(productUrl: string, orderId: string): Promise<AddToCartResult> {
    await this.browserManager.ensureBrowser(this.auth, this.cookieManager, this.emitStatus)
    const page = this.browserManager.getPage()
    if (!page) return { success: false, error: '浏览器未初始化' }

    try {
      const bizOrderId = orderId.replace(/_\d+$/, '')
      const detailUrl = `https://buyertrade.taobao.com/trade/detail/trade_item_detail.htm?bizOrderId=${bizOrderId}`
      console.log(`[Taobao] Playwright: Opening order detail: ${detailUrl}`)
      this.emitStatus('正在打开订单详情页（Playwright）...')
      await page.goto(detailUrl, { waitUntil: 'domcontentloaded', timeout: TIMEOUTS.PAGE_LOAD })

      const pageUrl = page.url()
      console.log(`[Taobao] Page URL after navigation: ${pageUrl}`)
      if (pageUrl.includes('login.taobao.com')) {
        this.emitStatus('登录已过期，请重新登录')
        return { success: false, error: '登录已过期' }
      }

      this.emitStatus('正在等待页面加载...')
      try {
        await page.waitForFunction(
          () => {
            const text = document.body?.innerText || ''
            return !text.includes('努力加载中') && text.length > 100
          },
          { timeout: 15000 }
        )
      } catch {
        console.log('[Taobao] waitForFunction timeout, proceeding anyway')
      }

      await page.evaluate(() => _hs.scrollSmooth(document.body.scrollHeight))
      await humanDelay(2000)
      await page.evaluate(() => _hs.scrollSmooth(0))
      await humanDelay(1000)

      this.emitStatus('正在查找再买一单按钮...')
      const clicked = await this.clickRebuyButton()
      if (clicked) {
        const result = await this.detectPageAfterRebuy()
        if (result) return result
      }

      this.emitStatus('未找到再买一单按钮，滚动页面重试...')
      await page.evaluate(async () => {
        const scrollHeight = document.body.scrollHeight
        const step = window.innerHeight
        for (let y = step; y < scrollHeight; y += step) {
          await _hs.scrollSmooth(y, _hs.rand(200, 500))
          await _hs.delay(50, 200)
        }
        await _hs.scrollSmooth(0, _hs.rand(400, 800))
      })
      await humanDelay(3000)

      const retryClicked = await this.clickRebuyButton()
      if (retryClicked) {
        const result = await this.detectPageAfterRebuy()
        if (result) return result
      }

      this.emitStatus('再次等待页面加载...')
      await humanDelay(5000)

      const retry2Clicked = await this.clickRebuyButton()
      if (retry2Clicked) {
        const result = await this.detectPageAfterRebuy()
        if (result) return result
      }

      return await this.fallbackManualAddToCart(productUrl)
    } catch (e: unknown) {
      console.log(`[Taobao] Playwright addToCart error: ${e}`)
      this.emitStatus(`再买一单失败: ${e}`)
      return { success: false, error: String(e) }
    }
  }

  private async detectPageAfterRebuy(): Promise<AddToCartResult | null> {
    const page = this.browserManager.getPage()
    const context = this.browserManager.getContext()
    if (!page || !context) return null

    const popupPromise = page.waitForEvent('popup', { timeout: 5000 }).catch(() => null)
    await humanDelay(3000)
    const popup = await popupPromise

    if (popup) {
      const popupUrl = popup.url()
      console.log(`[Taobao] New popup opened: ${popupUrl}`)

      if (isIdentityVerifyPage(popupUrl)) {
        console.log(`[Taobao] Identity verification required, showing to user`)
        const verifyResult = await this.verificationService.handleIdentityVerification(popup)
        if (verifyResult) return verifyResult
      }

      try {
        await popup.waitForLoadState('domcontentloaded', { timeout: 10000 })
      } catch { /* ignore */ }
      const loadedUrl = popup.url()
      if (isCheckoutOrPayPage(loadedUrl)) {
        this.browserManager.setPage(popup)
        this.emitStatus('已进入结算页面')
        return { success: true, directToPay: true }
      }
      if (isCartPage(loadedUrl)) {
        this.browserManager.setPage(popup)
        this.emitStatus('已加入购物车')
        return { success: true, directToPay: false }
      }
    }

    const allPages = context.pages()
    for (const p of allPages) {
      if (p === page || p === popup) continue
      const pUrl = p.url()
      if (isCheckoutOrPayPage(pUrl)) {
        this.browserManager.setPage(p)
        this.emitStatus('已进入结算页面（新标签页）')
        return { success: true, directToPay: true }
      }
      if (isCartPage(pUrl)) {
        this.browserManager.setPage(p)
        this.emitStatus('已加入购物车（新标签页）')
        return { success: true, directToPay: false }
      }
    }

    const afterUrl = page.url()
    console.log(`[Taobao] After rebuy click, URL: ${afterUrl}`)
    if (isCheckoutOrPayPage(afterUrl)) {
      this.emitStatus('已进入结算页面')
      return { success: true, directToPay: true }
    }
    if (isCartPage(afterUrl)) {
      this.emitStatus('已加入购物车')
      return { success: true, directToPay: false }
    }

    const hasCheckoutButton = await page.evaluate(() => {
      const targets = ['免密支付', '立即支付', '提交订单', '确认订单', '立即付款', '去支付']
      for (const el of document.querySelectorAll('button, a, [role="button"], span, div')) {
        const text = (el.textContent || '').trim().replace(/\s+/g, '')
        if (targets.some(t => text.includes(t))) {
          const rect = el.getBoundingClientRect()
          if (rect.width > 0 && rect.height > 0) return true
        }
      }
      return false
    })

    if (hasCheckoutButton) {
      console.log(`[Taobao] Checkout button found on current page, treating as directToPay`)
      this.emitStatus('已进入结算页面')
      return { success: true, directToPay: true }
    }

    this.emitStatus('已加入购物车')
    return { success: true, directToPay: false }
  }

  private async fallbackManualAddToCart(productUrl?: string): Promise<AddToCartResult> {
    const page = this.browserManager.getPage()
    if (!page) return { success: false, error: '浏览器未初始化' }

    this.emitStatus('自动再买一单失败，请在弹出的窗口中手动操作...')

    const orderDetailUrl = page.url()

    try {
      await this.cookieManager.syncCookiesToElectron(this.getContext(), this.auth)

      const mainWindow = this.windowManager.getMainWindow()
      if (mainWindow) {
        await dialog.showMessageBox(mainWindow, {
          type: 'info',
          title: '需要手动操作',
          message: '自动"再买一单"失败',
          detail: '该订单可能因商品下架、SKU变更等原因无法自动再买一单。\n\n即将打开您的购买记录详情页，请您手动操作下单。\n加入购物车后，窗口会自动关闭并继续后续流程。',
          buttons: ['知道了'],
          noLink: true,
        })
      }

      return new Promise<AddToCartResult>((resolve) => {
        if (!mainWindow) {
          resolve({ success: false, error: '主窗口未就绪' })
          return
        }

        const manualWindow = new BrowserWindow({
          width: 900,
          height: 750,
          title: '手动加入购物车',
          icon: APP_ICON,
          parent: mainWindow,
          modal: true,
          autoHideMenuBar: true,
          webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            backgroundThrottling: false,
          },
        })
        setUserAgent(manualWindow)
        manualWindow.loadURL(orderDetailUrl)

        let resolved = false
        const timeout = setTimeout(() => {
          if (!resolved) {
            resolved = true
            if (!manualWindow.isDestroyed()) manualWindow.close()
            this.emitStatus('手动操作超时')
            resolve({ success: false, error: '手动操作超时' })
          }
        }, TIMEOUTS.OPERATION)

        const checkDone = setInterval(async () => {
          if (resolved) return
          if (this.isDestroyed()) {
            clearInterval(checkDone)
            if (!resolved) {
              resolved = true
              clearTimeout(timeout)
              resolve({ success: false, error: '任务已取消' })
            }
            return
          }
          try {
            const pageUrl = manualWindow.webContents.getURL()
            if (isCartPage(pageUrl)) {
              resolved = true
              clearTimeout(timeout)
              clearInterval(checkDone)
              await this.cookieManager.syncCookiesFromElectron(this.getContext(), this.auth)
              if (!manualWindow.isDestroyed()) manualWindow.close()
              this.emitStatus('已加入购物车')
              resolve({ success: true, directToPay: false })
            } else if (isCheckoutOrPayPage(pageUrl)) {
              resolved = true
              clearTimeout(timeout)
              clearInterval(checkDone)
              await this.cookieManager.syncCookiesFromElectron(this.getContext(), this.auth)
              if (!manualWindow.isDestroyed()) manualWindow.close()
              this.emitStatus('已进入结算页面')
              resolve({ success: true, directToPay: true })
            }
          } catch { /* ignore */ }
        }, 2000)

        manualWindow.on('closed', async () => {
          if (!resolved) {
            resolved = true
            clearTimeout(timeout)
            clearInterval(checkDone)
            await this.cookieManager.syncCookiesFromElectron(this.getContext(), this.auth)
            this.emitStatus('用户关闭了手动操作窗口')
            resolve({ success: false, error: '用户关闭了窗口' })
          }
        })
      })
    } catch (e: unknown) {
      this.emitStatus(`手动操作失败: ${e}`)
      return { success: false, error: String(e) }
    }
  }

  private async clickRebuyButton(): Promise<boolean> {
    const page = this.browserManager.getPage()
    if (!page) return false

    const targets = [...KEYWORDS.REBUY_BUTTONS]
    const selectors = ['button', 'a', '[class*="btn"]', '[class*="Button"]', '[role="button"]', '[class*="action"]', '[class*="submit"]', '[class*="rebuy"]', '[class*="Rebuy"]', '[class*="buy-again"]', '[class*="BuyAgain"]', '[data-spm*="rebuy"]', '[data-spm*="buy"]', 'span[class*="click"]', 'div[class*="click"]']

    try {
      const frames = page.frames()
      console.log(`[Taobao] clickRebuyButton: searching ${frames.length} frames, targets: ${targets.join(',')}`)

      for (const frame of frames) {
        try {
          await frame.evaluate(HUMAN_SIM_JS).catch(() => {})
          const diag = await frame.evaluate((arg: { targets: string[]; selectors: string[] }) => {
            const nearMatches: { tag: string; text: string; cls: string; rect: string }[] = []

            const found = _hs.findVisible(arg.selectors, arg.targets)
            for (const item of found) {
              nearMatches.push({
                tag: item.el.tagName,
                text: item.text.substring(0, 60),
                cls: (item.el as HTMLElement).className?.substring?.(0, 80) || '',
                rect: `${Math.round(item.rect.width)}x${Math.round(item.rect.height)}@${Math.round(item.rect.x)},${Math.round(item.rect.y)}`,
              })
            }

            if (nearMatches.length === 0) {
              const broadFound = _hs.findByText(arg.targets, 20)
              for (const item of broadFound) {
                nearMatches.push({
                  tag: item.el.tagName,
                  text: item.text.substring(0, 60),
                  cls: (item.el as HTMLElement).className?.substring?.(0, 80) || '',
                  rect: `${Math.round(item.rect.width)}x${Math.round(item.rect.height)}@${Math.round(item.rect.x)},${Math.round(item.rect.y)}`,
                })
              }
            }

            return { nearMatches, bodyLen: document.body?.innerText?.length || 0 }
          }, { targets: [...KEYWORDS.REBUY_BUTTONS], selectors })

          console.log(`[Taobao] Frame ${frame.url().substring(0, 80)} nearMatches (${diag.nearMatches.length}):`)
          for (const m of diag.nearMatches) {
            console.log(`  ${m.tag} "${m.text}" cls="${m.cls}" rect=${m.rect}`)
          }

          if (diag.nearMatches.length > 0) {
            const clicked = await frame.evaluate((arg: { targets: string[]; selectors: string[] }) => {
              let result = _hs.findAndClick(arg.selectors, arg.targets)

              if (!result) {
                const broadFound = _hs.findByText(arg.targets, 20)
                if (broadFound.length > 0) {
                  broadFound.sort((a: { area: number }, b: { area: number }) => a.area - b.area)
                  if (_hs.click(broadFound[0].el)) {
                    result = broadFound[0]
                  }
                }
              }

              if (!result) {
                const shadowFound = _hs.findInShadowDOM(arg.selectors, arg.targets)
                if (shadowFound.length > 0) {
                  shadowFound.sort((a: { area: number }, b: { area: number }) => a.area - b.area)
                  if (_hs.click(shadowFound[0].el)) {
                    result = shadowFound[0]
                  }
                }
              }

              if (result) {
                return { clicked: true, tag: result.el.tagName, text: result.text.substring(0, 40), area: result.area }
              }

              return { clicked: false }
            }, { targets: [...KEYWORDS.REBUY_BUTTONS], selectors })

            console.log(`[Taobao] clickRebuyButton click result:`, JSON.stringify(clicked))
            if (clicked.clicked) return true
          }
        } catch (e: unknown) {
          console.log(`[Taobao] clickRebuyButton frame error: ${e}`)
        }
      }

      console.log(`[Taobao] clickRebuyButton: text search failed, trying CSS selectors...`)

      const cssSelectors = TAOBAO_SELECTORS.ORDER_DETAIL.REBUY_SELECTORS
      for (const frame of frames) {
        try {
          await frame.evaluate(HUMAN_SIM_JS).catch(() => {})
          const cssResult = await frame.evaluate((selectors: string[]) => {
            for (const sel of selectors) {
              try {
                const el = document.querySelector(sel) as HTMLElement | null
                if (el) {
                  const rect = el.getBoundingClientRect()
                  if (rect.width > 0 && rect.height > 0) {
                    _hs.click(el)
                    return { clicked: true, selector: sel, tag: el.tagName, text: (el.textContent || '').trim().substring(0, 40) }
                  }
                }
              } catch { /* ignore */ }
            }
            return { clicked: false }
          }, cssSelectors as unknown as string[])

          console.log(`[Taobao] clickRebuyButton CSS result:`, JSON.stringify(cssResult))
          if (cssResult.clicked) return true
        } catch (e: unknown) {
          console.log(`[Taobao] clickRebuyButton CSS frame error: ${e}`)
        }
      }

      console.log(`[Taobao] clickRebuyButton: no button found with any method`)
      return false
    } catch (e: unknown) {
      console.log(`[Taobao] clickRebuyButton error: ${e}`)
    }

    return false
  }
}
