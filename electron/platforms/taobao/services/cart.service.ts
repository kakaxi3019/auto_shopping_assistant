﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿import { BrowserWindow } from 'electron'
import type { Page, BrowserContext } from 'playwright'
import type { Database } from '../../../db/database'
import type { AddToCartResult, Order } from '../../../../shared/types/platform.types'
import { BrowserManager } from '../infrastructure/browser-manager'
import { WindowManager } from '../infrastructure/window-manager'
import { CookieManager } from '../infrastructure/cookie-manager'
import { VerificationService } from './verification.service'
import { InteractionService } from './interaction.service'
import { TaobaoAuth } from '../taobao.auth'
import { setUserAgent, debugLog, humanDelay, humanClickAt, humanClickElement, execJS, injectOverlayBanner, injectCenterToast, rand, ListenerTracker, cleanupForCaptcha, resetCaptchaMode } from '../utils/page-helper'
import { APP_ICON, WINDOW_SIZES, TIMEOUTS, KEYWORDS } from '../utils/constants'
import { isCheckoutOrPayPage, isLoginPage, isIdentityVerifyPage, isBuyPage, isCartPage, isProductDetailPage, isOrderArchivePage, isOrderDetailPage, isErrorPage } from '../utils/url-helper'
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
    debugLog(`[Taobao-Cart] addToCart invoked: productUrl=${productUrl}, sku=${sku}, orderId=${orderId}, cartOnly=${cartOnly}`)

    if (!orderId) {
      this.emitStatus('没有订单号，无法再买一单')
      debugLog('[Taobao-Cart] addToCart failed: missing orderId')
      return { success: false, error: '没有订单号' }
    }

    try {
      const result = await this.runInHiddenWindow(orderId, productUrl, cartOnly)
      if (result) return result

      return { success: false, error: '再买一单操作未返回结果' }
    } catch (e: unknown) {
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
          sandbox: false,
          backgroundThrottling: false,
        },
      })
      this.windowManager.setShopWindow(newShopWindow)
      setUserAgent(newShopWindow)
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

          if (isErrorPage(url)) {
            this.windowManager.closeShopWindow()
            this.emitStatus('⚠️ 商品页面无法访问，可能已下架或活动已结束')
            doResolve({ success: false, error: '商品页面无法访问（跳转到了错误页面）' })
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
          return { action: 'allow', overrideBrowserWindowOptions: { show: false, webPreferences: { backgroundThrottling: false } } }
        })

        lt.on(currentShopWindow.webContents, 'did-create-window', (newWindow) => {
          setUserAgent(newWindow)
          newWindow.setIcon(APP_ICON)
          this.windowManager.trackWindow(newWindow)

          const handlePopupUrl = async (popupUrl: string) => {
            if (resolved) return

            if (isErrorPage(popupUrl)) {
              this.windowManager.closeShopWindow()
              this.emitStatus('⚠️ 商品页面无法访问，可能已下架或活动已结束')
              doResolve({ success: false, error: '商品页面无法访问（跳转到了错误页面）' })
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
                  return { action: 'allow', overrideBrowserWindowOptions: { show: false, webPreferences: { backgroundThrottling: false } } }
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
        sandbox: false,
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
          sandbox: false,
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

          if (isErrorPage(url)) {
            this.windowManager.closeShopWindow()
            this.emitStatus('⚠️ 商品页面无法访问，可能已下架或活动已结束')
            doResolve({ success: false, error: '商品页面无法访问（跳转到了错误页面）' })
            return
          }

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
          return { action: 'allow', overrideBrowserWindowOptions: { show: false, webPreferences: { backgroundThrottling: false } } }
        })

        lt.on(currentShopWindow.webContents, 'did-create-window', (newWindow) => {
          setUserAgent(newWindow)
          newWindow.setIcon(APP_ICON)
          this.windowManager.trackWindow(newWindow)

          const handlePopupUrl = async (popupUrl: string) => {
            if (resolved) return

            if (isErrorPage(popupUrl)) {
              this.windowManager.closeShopWindow()
              this.emitStatus('⚠️ 商品页面无法访问，可能已下架或活动已结束')
              doResolve({ success: false, error: '商品页面无法访问（跳转到了错误页面）' })
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
                var buyTexts = ${JSON.stringify(KEYWORDS.BUY_BUTTONS)};
                var btns = document.querySelectorAll('button, a, [class*="btn"], [class*="Button"], [role="button"], [class*="action"], [class*="submit"]');
                var hasBuyButton = false;
                for (var j = 0; j < btns.length; j++) {
                  var btnText = (btns[j].textContent || '').replace(/\\s+/g, '');
                  var rect = btns[j].getBoundingClientRect();
                  if (rect.width <= 0 || rect.height <= 0) continue;
                  for (var k = 0; k < buyTexts.length; k++) {
                    if (btnText.includes(buyTexts[k])) { hasBuyButton = true; break; }
                  }
                  if (hasBuyButton) break;
                }
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
                  return { action: 'allow', overrideBrowserWindowOptions: { show: false, webPreferences: { backgroundThrottling: false } } }
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
      debugLog('[Taobao-Cart] runInHiddenWindow failed: mainWindow is null')
      return null
    }
    const bizOrderId = orderId.replace(/_\d+$/, '')
    const detailUrl = `https://buyertrade.taobao.com/trade/detail/trade_item_detail.htm?bizOrderId=${bizOrderId}`
    const detailUrlLoadOptions = { httpReferrer: 'https://buyertrade.taobao.com/trade/itemlist/list_bought_items.htm' }
    this.emitStatus('正在打开订单详情页...')
    debugLog(`[Taobao-Cart] runInHiddenWindow: detailUrl=${detailUrl}, cartOnly=${cartOnly}`)

    await this.cookieManager.syncCookiesFromElectron(this.getContext(), this.auth, true)
    await this.cookieManager.syncCookiesToElectron(this.getContext(), this.auth, true)

    await this.windowManager.closeShopWindow(async () => { await this.cookieManager.syncCookiesFromElectron(this.getContext(), this.auth) })

    // Create window first, then do session warmup before loading order detail page
    const newShopWindow = new BrowserWindow({
      width: WINDOW_SIZES.SHOP.width,
      height: WINDOW_SIZES.SHOP.height,
      show: false,
      autoHideMenuBar: true,
      icon: APP_ICON,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: false,
        backgroundThrottling: false,
      },
    })
    this.windowManager.setShopWindow(newShopWindow)
    setUserAgent(newShopWindow)
    if (mainWindow) {
      newShopWindow.setParentWindow(mainWindow)
    }

    // Session warmup: navigate to taobao.com first to trigger cross-domain SSO token exchange.
    // Without this, the order detail page (which requires full auth) may redirect to login
    // even though cookies are present, because the new BrowserWindow hasn't completed SSO handshake.
    try {
      debugLog('[Taobao-Cart] Starting SSO warmup navigate to www.taobao.com')
      await new Promise<void>((warmupResolve) => {
        let done = false
        const onDone = () => { if (!done) { done = true; warmupResolve() } }
        setTimeout(onDone, 8000)
        if (newShopWindow.isDestroyed()) { onDone(); return }
        newShopWindow.webContents.once('did-finish-load', onDone)
        newShopWindow.loadURL('https://www.taobao.com/')
      })
      if (!newShopWindow.isDestroyed()) {
        debugLog('[Taobao-Cart] SSO warmup completed, syncing cookies from Electron')
        await this.cookieManager.syncCookiesFromElectron(this.getContext(), this.auth, true)
      }
    } catch (e: any) {
      debugLog(`[Taobao-Cart] SSO warmup error: ${e.message || String(e)}`)
    }

    if (newShopWindow.isDestroyed()) {
      return null
    }

    return new Promise<AddToCartResult | null>((resolve) => {
      const lt = new ListenerTracker()
      newShopWindow.loadURL(detailUrl, detailUrlLoadOptions)

      newShopWindow.webContents.setWindowOpenHandler(({ url: openUrl }) => {
        return { action: 'allow', overrideBrowserWindowOptions: { show: false, webPreferences: { sandbox: false, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } } }
      })

      lt.on(newShopWindow.webContents, 'did-create-window', (newWindow) => {
        debugLog('[Taobao-Cart] popup window created via click inside detail window')
        setUserAgent(newWindow)
        newWindow.setIcon(APP_ICON)
        this.windowManager.trackWindow(newWindow)

        let skuHandled = false

        const handlePopupUrl = async (popupUrl: string) => {
          if (resolved) return
          debugLog(`[Taobao-Cart] handlePopupUrl: ${popupUrl}`)

          if (isErrorPage(popupUrl)) {
            debugLog(`[Taobao-Cart] encountered error page: ${popupUrl}`)
            this.windowManager.closeShopWindow()
            this.emitStatus('⚠️ 商品页面无法访问，可能已下架或活动已结束')
            doResolve({ success: false, error: '商品页面无法访问（跳转到了错误页面）' })
            return
          }

          if (isBuyPage(popupUrl)) {
            debugLog(`[Taobao-Cart] buy page detected, directToPay flow: ${popupUrl}`)
            if (cartOnly) {
              this.windowManager.closeShopWindow(async () => { await this.cookieManager.syncCookiesFromElectron(this.getContext(), this.auth) })
              this.emitStatus('该商品不支持加入购物车，点击后直接进入了结算页面')
              debugLog('[Taobao-Cart] product does not support cart, directly entered buy page during cartOnly mode')
              doResolve({ success: false, error: '该商品不支持加入购物车，点击后直接进入了结算页面' })
              return
            }
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
            doResolve({ success: true, directToPay: true })
            return
          }
          if (isCartPage(popupUrl)) {
            debugLog(`[Taobao-Cart] cart page detected, item added to cart successfully: ${popupUrl}`)
            const sw = this.windowManager.getShopWindow()
            if (sw && !sw.isDestroyed()) sw.hide()
            this.windowManager.setShopWindow(newWindow)
            await this.cookieManager.syncCookiesFromElectron(this.getContext(), this.auth)
            this.emitStatus('已加入购物车')
            doResolve({ success: true, directToPay: false })
            return
          }
          if (isIdentityVerifyPage(popupUrl)) {
            debugLog(`[Taobao-Cart] security identity verification page detected: ${popupUrl}`)
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
            debugLog(`[Taobao-Cart] login page detected on popup, trying auto login: ${popupUrl}`)
            await this.verificationService.tryAutoLoginThenShow(newWindow)
            return
          }
          if (popupUrl.includes('taobao.com') && !popupUrl.includes('login') && !isProductDetailPage(popupUrl)) {
            await this.cookieManager.syncCookiesFromElectron(this.getContext(), this.auth)
          }
          if (isProductDetailPage(popupUrl)) {
            if (skuHandled) return
            skuHandled = true
            await humanDelay(1500)
            try {
              const popupOffShelf = await checkOffShelf(newWindow)
              if (popupOffShelf) {
                this.windowManager.closeShopWindow(async () => { await this.cookieManager.syncCookiesFromElectron(this.getContext(), this.auth) })
                this.emitStatus(`商品不可购买（${popupOffShelf}）`)
                doResolve({ success: false, error: `商品不可购买（${popupOffShelf}）` })
                return
              }
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
                debugLog(`[Taobao-Cart] click buy button result: ${JSON.stringify(clickResult)}`)

                if (cartOnly && !clickResult?.clicked) {
                  debugLog('[Taobao-Cart] cartOnly button click failed')
                  this.windowManager.closeShopWindow(async () => { await this.cookieManager.syncCookiesFromElectron(this.getContext(), this.auth) })
                  this.emitStatus('该商品不支持加入购物车（未找到加购按钮）')
                  doResolve({ success: false, error: '该商品不支持加入购物车（未找到加购按钮）' })
                  return
                }
                await humanDelay(2000)

                const currentPopupUrl = newWindow.webContents.getURL()
                if (isIdentityVerifyPage(currentPopupUrl) || currentPopupUrl.includes('nocaptcha') || currentPopupUrl.includes('slider')) {
                  debugLog(`[Taobao-Cart] security identity/captcha page detected: ${currentPopupUrl}`)
                  cleanupForCaptcha(newWindow)
                  newWindow.setSize(WINDOW_SIZES.CONFIRMATION.width, WINDOW_SIZES.CONFIRMATION.height)
                  newWindow.setTitle('淘宝安全验证')
                  newWindow.setAlwaysOnTop(true)
                  if (newWindow.isMinimized()) {
                    newWindow.restore()
                  }
                  injectOverlayBanner(newWindow, '🔐 自动购物助手：淘宝要求安全验证，请在下方拖动滑块完成验证')
                  injectCenterToast(newWindow, '请拖动滑块完成验证')
                  newWindow.show()
                  newWindow.focus()
                  const verified = await this.interactionService.waitForUserConfirmation(
                    newWindow,
                    '淘宝要求安全验证（滑块验证），请在弹出的窗口中完成验证，完成后点击"已完成"',
                    '淘宝安全验证',
                    '🔐 请拖动滑块完成验证',
                    'verification',
                  )
                  if (verified) {
                    resetCaptchaMode(newWindow)

                    const sw = this.windowManager.getShopWindow()
                    if (sw && !sw.isDestroyed()) sw.hide()
                    this.windowManager.setShopWindow(newWindow)
                    await this.cookieManager.syncCookiesFromElectron(this.getContext(), this.auth)
                    await humanDelay(1500)
                    const afterVerifyUrl = newWindow.webContents.getURL()
                    if (isCartPage(afterVerifyUrl)) {
                      this.emitStatus('验证完成，已加入购物车')
                      doResolve({ success: true, directToPay: false })
                    } else if (isBuyPage(afterVerifyUrl)) {
                      this.emitStatus('验证完成，已进入结算页面')
                      doResolve({ success: true, directToPay: true })
                    } else if (isProductDetailPage(afterVerifyUrl)) {
                      this.emitStatus('验证完成，请在弹出的窗口中选择规格并购买')
                      newWindow.setSize(WINDOW_SIZES.CONFIRMATION.width, WINDOW_SIZES.CONFIRMATION.height)
                      newWindow.setTitle('请选择规格并购买')
                      const mw = this.windowManager.getMainWindow()
                      if (mw) newWindow.setParentWindow(mw)
                      injectOverlayBanner(newWindow, '🛒 自动购物助手：验证通过，请选择规格并点击"立即购买"或"加入购物车"')
                      injectCenterToast(newWindow, '验证通过，请选择规格并购买')
                      newWindow.show()
                      const confirmed = await this.interactionService.waitForUserConfirmation(
                        newWindow,
                        '验证通过，已进入商品详情页，请在弹出的窗口中选择规格并购买，完成后点击"已完成"',
                        '选择规格并购买',
                        '🛒 验证通过，请选择规格并购买',
                        'add-to-cart',
                      )
                      if (!confirmed || newWindow.isDestroyed()) {
                        if (!newWindow.isDestroyed()) this.windowManager.closeShopWindow(async () => { await this.cookieManager.syncCookiesFromElectron(this.getContext(), this.auth) })
                        doResolve({ success: false, error: '用户取消了购买' })
                      } else {
                        let afterUrl = ''
                        try { afterUrl = newWindow.webContents.getURL() } catch { /* window destroyed */ }
                        await this.cookieManager.syncCookiesFromElectron(this.getContext(), this.auth)
                        if (isBuyPage(afterUrl)) {
                          this.emitStatus('已进入结算页面')
                          doResolve({ success: true, directToPay: true })
                        } else if (isCartPage(afterUrl)) {
                          this.emitStatus('已加入购物车')
                          doResolve({ success: true, directToPay: false })
                        } else {
                          this.emitStatus('操作完成')
                          doResolve({ success: true, directToPay: true })
                        }
                      }
                    } else {
                      this.emitStatus('验证完成，请继续操作')
                      doResolve({ success: true, directToPay: true })
                    }
                  } else {
                    doResolve({ success: false, error: '安全验证未完成' })
                  }
                  return
                }
                if (isBuyPage(currentPopupUrl)) {
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

                if (pageDiag.hasCaptcha) {
                  cleanupForCaptcha(newWindow)
                  newWindow.setSize(WINDOW_SIZES.CONFIRMATION.width, WINDOW_SIZES.CONFIRMATION.height)
                  newWindow.setTitle('淘宝安全验证')
                  newWindow.setAlwaysOnTop(true)
                  if (newWindow.isMinimized()) {
                    newWindow.restore()
                  }
                  injectOverlayBanner(newWindow, '🔐 自动购物助手：淘宝要求安全验证，请在下方拖动滑块完成验证')
                  injectCenterToast(newWindow, '请拖动滑块完成验证')
                  newWindow.show()
                  newWindow.focus()
                  const captchaConfirmed = await this.interactionService.waitForUserConfirmation(
                    newWindow,
                    '淘宝要求安全验证（滑块验证），请在弹出的窗口中完成验证，完成后点击"已完成"',
                    '淘宝安全验证',
                    '🔐 请拖动滑块完成验证',
                    'verification',
                  )
                  if (captchaConfirmed) {
                    resetCaptchaMode(newWindow)

                    const sw = this.windowManager.getShopWindow()
                    if (sw && !sw.isDestroyed()) sw.hide()
                    this.windowManager.setShopWindow(newWindow)
                    await this.cookieManager.syncCookiesFromElectron(this.getContext(), this.auth)
                    await humanDelay(1500)
                    const afterVerifyUrl = newWindow.webContents.getURL()
                    if (isCartPage(afterVerifyUrl)) {
                      this.emitStatus('验证完成，已加入购物车')
                      doResolve({ success: true, directToPay: false })
                    } else if (isBuyPage(afterVerifyUrl)) {
                      this.emitStatus('验证完成，已进入结算页面')
                      doResolve({ success: true, directToPay: true })
                    } else if (isProductDetailPage(afterVerifyUrl)) {
                      this.emitStatus('验证完成，请在弹出的窗口中选择规格并购买')
                      newWindow.setSize(WINDOW_SIZES.CONFIRMATION.width, WINDOW_SIZES.CONFIRMATION.height)
                      newWindow.setTitle('请选择规格并购买')
                      const mw = this.windowManager.getMainWindow()
                      if (mw) newWindow.setParentWindow(mw)
                      injectOverlayBanner(newWindow, '🛒 自动购物助手：验证通过，请选择规格并点击"立即购买"或"加入购物车"')
                      injectCenterToast(newWindow, '验证通过，请选择规格并购买')
                      newWindow.show()
                      const confirmed = await this.interactionService.waitForUserConfirmation(
                        newWindow,
                        '验证通过，已进入商品详情页，请在弹出的窗口中选择规格并购买，完成后点击"已完成"',
                        '选择规格并购买',
                        '🛒 验证通过，请选择规格并购买',
                        'add-to-cart',
                      )
                      if (!confirmed || newWindow.isDestroyed()) {
                        if (!newWindow.isDestroyed()) this.windowManager.closeShopWindow(async () => { await this.cookieManager.syncCookiesFromElectron(this.getContext(), this.auth) })
                        doResolve({ success: false, error: '用户取消了购买' })
                      } else {
                        let afterUrl = ''
                        try { afterUrl = newWindow.webContents.getURL() } catch { /* window destroyed */ }
                        await this.cookieManager.syncCookiesFromElectron(this.getContext(), this.auth)
                        if (isBuyPage(afterUrl)) {
                          this.emitStatus('已进入结算页面')
                          doResolve({ success: true, directToPay: true })
                        } else if (isCartPage(afterUrl)) {
                          this.emitStatus('已加入购物车')
                          doResolve({ success: true, directToPay: false })
                        } else {
                          this.emitStatus('操作完成')
                          doResolve({ success: true, directToPay: true })
                        }
                      }
                    } else {
                      this.emitStatus('验证完成，请继续操作')
                      doResolve({ success: true, directToPay: true })
                    }
                  } else {
                    doResolve({ success: false, error: '安全验证未完成' })
                  }
                  return
                }
                const checkResult = { needSelect: pageDiag.needSelect, hint: pageDiag.hint }

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
                    const sw = this.windowManager.getShopWindow()
                    if (sw && !sw.isDestroyed()) sw.hide()
                    this.windowManager.setShopWindow(newWindow)
                    await this.cookieManager.syncCookiesFromElectron(this.getContext(), this.auth)
                    const currentUrl = newWindow.webContents.getURL()
                    if (isCartPage(currentUrl)) {
                      this.emitStatus('已加入购物车')
                      doResolve({ success: true, directToPay: false })
                    } else {
                      this.emitStatus('已进入结算页面')
                      doResolve({ success: true, directToPay: true })
                    }
                  } else {
                    doResolve({ success: false, error: '用户取消操作' })
                  }
                  return
                }
                let fallbackReason = '点击购买后页面未跳转到结算页'
                if (pageDiag.visibleDialogs && pageDiag.visibleDialogs.length > 0) {
                  fallbackReason = `点击购买后出现弹窗（${pageDiag.visibleDialogs.map((d: any) => d.cls?.substring(0, 20) || '未知').join(', ')}），页面未跳转到结算页`
                } else if (pageDiag.hint) {
                  fallbackReason = `页面提示"${pageDiag.hint}"，自动购买无法继续`
                } else if (!pageDiag.hasBuyBtn) {
                  fallbackReason = '页面上未找到可点击的购买按钮'
                }
                debugLog(`[Taobao-Cart] manual fallback required: fallbackReason="${fallbackReason}", pageDiag=${JSON.stringify(pageDiag)}`)
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
                  const sw = this.windowManager.getShopWindow()
                  if (sw && !sw.isDestroyed()) sw.hide()
                  this.windowManager.setShopWindow(newWindow)
                  await this.cookieManager.syncCookiesFromElectron(this.getContext(), this.auth)
                  const currentUrl = newWindow.webContents.getURL()
                  if (isCartPage(currentUrl)) {
                    this.emitStatus('已加入购物车')
                    doResolve({ success: true, directToPay: false })
                  } else {
                    this.emitStatus('已进入结算页面')
                    doResolve({ success: true, directToPay: true })
                  }
                } else {
                  doResolve({ success: false, error: '用户取消操作' })
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
                    var buyTexts = ${cartOnly} ? ${JSON.stringify(KEYWORDS.CART_BUTTONS)} : ${JSON.stringify(KEYWORDS.BUY_BUTTONS)};
                    var btns = document.querySelectorAll('button, a, [class*="btn"], [class*="Button"], [role="button"], [class*="action"], [class*="submit"]');
                    var hasBuyButton = false;
                    for (var j = 0; j < btns.length; j++) {
                      var btnText = (btns[j].textContent || '').replace(/\\s+/g, '');
                      var rect = btns[j].getBoundingClientRect();
                      if (rect.width <= 0 || rect.height <= 0) continue;
                      for (var k = 0; k < buyTexts.length; k++) {
                        if (btnText.includes(buyTexts[k])) { hasBuyButton = true; break; }
                      }
                      if (hasBuyButton) break;
                    }
                    return { offShelf: matchedKeyword !== '', keyword: matchedKeyword, hasBuyButton: hasBuyButton };
                  })()
                `)

                if (pageStatus.offShelf && !pageStatus.hasBuyButton) {
                  this.windowManager.closeShopWindow(async () => { await this.cookieManager.syncCookiesFromElectron(this.getContext(), this.auth) })
                  this.emitStatus(`商品不可购买（${pageStatus.keyword}）`)
                  doResolve({ success: false, error: `商品不可购买（${pageStatus.keyword}）` })
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

                  if (cartOnly && !noSkuClickResult?.clicked) {
                    this.windowManager.closeShopWindow(async () => { await this.cookieManager.syncCookiesFromElectron(this.getContext(), this.auth) })
                    this.emitStatus('该商品不支持加入购物车（未找到加购按钮）')
                    doResolve({ success: false, error: '该商品不支持加入购物车（未找到加购按钮）' })
                    return
                  }
                  await humanDelay(2000)

                  const afterClickUrl = newWindow.webContents.getURL()

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

                  const afterClickCheck = { needSelect: afterClickDiag.needSelect, hint: afterClickDiag.hint }

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
                      const sw = this.windowManager.getShopWindow()
                      if (sw && !sw.isDestroyed()) sw.hide()
                      this.windowManager.setShopWindow(newWindow)
                      await this.cookieManager.syncCookiesFromElectron(this.getContext(), this.auth)
                      const currentUrl = newWindow.webContents.getURL()
                      if (isCartPage(currentUrl)) {
                        this.emitStatus('已加入购物车')
                        doResolve({ success: true, directToPay: false })
                      } else {
                        this.emitStatus('已进入结算页面')
                        doResolve({ success: true, directToPay: true })
                      }
                    } else {
                      doResolve({ success: false, error: '用户取消操作' })
                    }
                    return
                  }
                  if (isBuyPage(afterClickUrl)) {
                    await handlePopupUrl(afterClickUrl)
                    return
                  }
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
                    const sw = this.windowManager.getShopWindow()
                    if (sw && !sw.isDestroyed()) sw.hide()
                    this.windowManager.setShopWindow(newWindow)
                    await this.cookieManager.syncCookiesFromElectron(this.getContext(), this.auth)
                    const currentUrl = newWindow.webContents.getURL()
                    if (isCartPage(currentUrl)) {
                      this.emitStatus('已加入购物车')
                      doResolve({ success: true, directToPay: false })
                    } else {
                      this.emitStatus('已进入结算页面')
                      doResolve({ success: true, directToPay: true })
                    }
                  } else {
                    doResolve({ success: false, error: '用户取消操作' })
                  }
                  return
                } else if (cartOnly) {
                  this.windowManager.closeShopWindow(async () => { await this.cookieManager.syncCookiesFromElectron(this.getContext(), this.auth) })
                  this.emitStatus('该商品不支持加入购物车（未找到加购按钮）')
                  doResolve({ success: false, error: '该商品不支持加入购物车（未找到加购按钮）' })
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

        newWindow.webContents.setWindowOpenHandler(({ url: openUrl }: { url: string }) => {
          if (isBuyPage(openUrl) || isCartPage(openUrl)) {
            return { action: 'allow', overrideBrowserWindowOptions: { webPreferences: { backgroundThrottling: false } } }
          }
          return { action: 'allow', overrideBrowserWindowOptions: { webPreferences: { backgroundThrottling: false } } }
        })

        lt.on(newWindow.webContents, 'did-create-window', (childWindow) => {
          setUserAgent(childWindow)
          childWindow.setIcon(APP_ICON)
          this.windowManager.trackWindow(childWindow)

          lt.on(childWindow.webContents, 'did-finish-load', async () => {
            const childUrl = childWindow.webContents.getURL()
            await handlePopupUrl(childUrl)
          })

          lt.on(childWindow.webContents, 'did-navigate', async () => {
            const childUrl = childWindow.webContents.getURL()
            await handlePopupUrl(childUrl)
          })
        })

        const popupCheck = setInterval(async () => {
          if (resolved) { clearInterval(popupCheck); return }
          if (this.isDestroyed() || newWindow.isDestroyed()) {
            clearInterval(popupCheck)
            if (!resolved) {
              doResolve({ success: false, error: '任务已取消' })
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
        clearInterval(checkInterval)
        lt.dispose()
        if (!result?.directToPay) {
          const sw = this.windowManager.getShopWindow()
          if (sw && !sw.isDestroyed()) {
            try { sw.close() } catch { /* ignore */ }
            this.windowManager.setShopWindow(null)
          }
        }
        resolve(result)
      }
      let sameUrlCount = 0
      let rebuyRetryCount = 0
      const MAX_REBUY_RETRIES = 3
      const REBUY_TIMEOUT = 45000 // 提升至 45 秒，为用户处理滑块验证和页面载入留出足够时间
      const timeout = setTimeout(() => {
        if (!resolved) {
          doResolve(null)
          this.windowManager.closeShopWindow(async () => { await this.cookieManager.syncCookiesFromElectron(this.getContext(), this.auth) })
          this.emitStatus('⚠️ 再买一单操作超时，请尝试手动操作')
        }
      }, REBUY_TIMEOUT)

      const checkOffShelf = async (win: BrowserWindow): Promise<string> => {
        try {
          const result = await execJS(win, `
            (function() {
              var bodyText = (document.body?.innerText || '');
              var keywords = ${JSON.stringify(KEYWORDS.OFF_SHELF)};
              var extraKeywords = ['下架啦', '已经下架', '已下架啦', '悄悄别的', '看看别的'];
              var allKeywords = keywords.concat(extraKeywords);
              var matchedKeyword = '';
              for (var i = 0; i < allKeywords.length; i++) {
                if (bodyText.includes(allKeywords[i])) {
                  matchedKeyword = allKeywords[i];
                  break;
                }
              }
              if (!matchedKeyword) return '';
              var buyTexts = ${JSON.stringify(KEYWORDS.BUY_BUTTONS)};
              var btns = document.querySelectorAll('button, a, [class*="btn"], [class*="Button"], [role="button"], [class*="action"], [class*="submit"]');
              for (var j = 0; j < btns.length; j++) {
                var btnText = (btns[j].textContent || '').replace(/\\s+/g, '');
                var rect = btns[j].getBoundingClientRect();
                if (rect.width <= 0 || rect.height <= 0) continue;
                for (var k = 0; k < buyTexts.length; k++) {
                  if (btnText.includes(buyTexts[k])) return '';
                }
              }
              return matchedKeyword;
            })()
          `)
          return result || ''
        } catch {
          return ''
        }
      }

      const tryClickRebuy = async () => {
        const sw = this.windowManager.getShopWindow()
        if (resolved || this.isDestroyed() || !sw || sw.isDestroyed()) {
          return
        }
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

              if (cartResultDetected?.type === 'success') {
                await this.cookieManager.syncCookiesFromElectron(this.getContext(), this.auth)
                this.windowManager.closeShopWindow()
                this.emitStatus('已加入购物车')
                doResolve({ success: true, directToPay: false })
                return
              }
              if (cartResultDetected?.type === 'error') {
                this.windowManager.closeShopWindow(async () => { await this.cookieManager.syncCookiesFromElectron(this.getContext(), this.auth) })
                const errorMsg = `商品不可购买（${cartResultDetected.hint}）`
                this.emitStatus(errorMsg)
                doResolve({ success: false, error: errorMsg })
                return
              }
            } else {
              this.emitStatus('已点击再买一单，等待页面跳转...')
              await humanDelay(3000)
              if (resolved) return

              const afterClickUrl = sw.webContents.getURL()
              if (isProductDetailPage(afterClickUrl)) {
                const offShelfKeyword = await checkOffShelf(sw)
                if (offShelfKeyword) {
                  this.windowManager.closeShopWindow(async () => { await this.cookieManager.syncCookiesFromElectron(this.getContext(), this.auth) })
                  this.emitStatus(`商品不可购买（${offShelfKeyword}）`)
                  doResolve({ success: false, error: `商品不可购买（${offShelfKeyword}）` })
                  return
                }
              } else if (!isOrderDetailPage(afterClickUrl) && !afterClickUrl.includes('orderDetail')) {
                const offShelfKeyword = await checkOffShelf(sw)
                if (offShelfKeyword) {
                  this.windowManager.closeShopWindow(async () => { await this.cookieManager.syncCookiesFromElectron(this.getContext(), this.auth) })
                  this.emitStatus(`商品不可购买（${offShelfKeyword}）`)
                  doResolve({ success: false, error: `商品不可购买（${offShelfKeyword}）` })
                  return
                }
              }
            }
            return
          }
          const frames = sw.webContents.mainFrame.framesInSubtree
          for (const frame of frames) {
            if (frame === sw!.webContents.mainFrame) continue
            try {
              const frameUrl = frame.url
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
              const fr = frameResult as Record<string, unknown> | null
              if (fr && fr.clicked) {
                if (fr.isCart) {
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

                  if (frameCartResult?.type === 'success') {
                    await this.cookieManager.syncCookiesFromElectron(this.getContext(), this.auth)
                    this.windowManager.closeShopWindow()
                    this.emitStatus('已加入购物车')
                    doResolve({ success: true, directToPay: false })
                    return
                  }
                  if (frameCartResult?.type === 'error') {
                    this.windowManager.closeShopWindow(async () => { await this.cookieManager.syncCookiesFromElectron(this.getContext(), this.auth) })
                    const errorMsg = `商品不可购买（${frameCartResult.hint}）`
                    this.emitStatus(errorMsg)
                    doResolve({ success: false, error: errorMsg })
                    return
                  }
                } else {
                  this.emitStatus('已点击再买一单，等待页面跳转...')
                  await humanDelay(3000)
                  if (resolved) return

                  const afterFrameClickUrl = sw.webContents.getURL()
                  if (isProductDetailPage(afterFrameClickUrl)) {
                    const offShelfKeyword = await checkOffShelf(sw)
                    if (offShelfKeyword) {
                      this.windowManager.closeShopWindow(async () => { await this.cookieManager.syncCookiesFromElectron(this.getContext(), this.auth) })
                      this.emitStatus(`商品不可购买（${offShelfKeyword}）`)
                      doResolve({ success: false, error: `商品不可购买（${offShelfKeyword}）` })
                      return
                    }
                  } else if (!isOrderDetailPage(afterFrameClickUrl) && !afterFrameClickUrl.includes('orderDetail')) {
                    const offShelfKeyword = await checkOffShelf(sw)
                    if (offShelfKeyword) {
                      this.windowManager.closeShopWindow(async () => { await this.cookieManager.syncCookiesFromElectron(this.getContext(), this.auth) })
                      this.emitStatus(`商品不可购买（${offShelfKeyword}）`)
                      doResolve({ success: false, error: `商品不可购买（${offShelfKeyword}）` })
                      return
                    }
                  }
                }
                return
              }
            } catch (e: unknown) {
            }
          }
          this.windowManager.closeShopWindow(async () => { await this.cookieManager.syncCookiesFromElectron(this.getContext(), this.auth) })
          this.emitStatus('未找到再买一单入口')
          doResolve({ success: false, error: '未找到再买一单入口' })
        } catch (e: unknown) {

          this.windowManager.closeShopWindow(async () => { await this.cookieManager.syncCookiesFromElectron(this.getContext(), this.auth) })
          doResolve({ success: false, error: String(e) })
        }
      }
      let loginRetryCount = 0
      let processingDidFinishLoad = false

      const currentSw = this.windowManager.getShopWindow()!
      lt.on(currentSw.webContents, 'did-finish-load', async () => {
        if (resolved) {
          return
        }
        if (processingDidFinishLoad) {
          debugLog('[Taobao-Cart] Ignore concurrent did-finish-load event')
          return
        }
        processingDidFinishLoad = true
        try {
          const sw = this.windowManager.getShopWindow()
          const url = sw?.webContents.getURL()
          if (!url) return

        if (isErrorPage(url)) {
          this.windowManager.closeShopWindow()
          this.emitStatus('⚠️ 商品页面无法访问，可能已下架或活动已结束')
          doResolve({ success: false, error: '商品页面无法访问（跳转到了错误页面）' })
          return
        }

        const hasCaptcha = await this.verificationService.detectCaptcha(sw!)
        if (hasCaptcha) {
          cleanupForCaptcha(sw!)
          sw?.setSize(WINDOW_SIZES.CONFIRMATION.width, WINDOW_SIZES.CONFIRMATION.height)
          sw?.setTitle('淘宝安全验证')
          sw?.setAlwaysOnTop(true)
          if (sw?.isMinimized()) {
            sw.restore()
          }
          injectOverlayBanner(sw!, '🔐 自动购物助手：淘宝要求安全验证，请在下方拖动滑块完成验证')
          injectCenterToast(sw!, '请拖动滑块完成验证')
          sw?.show()
          sw?.focus()
          this.emitStatus('需要进行滑块验证，请在弹出的窗口中完成验证...')
          const verified = await this.interactionService.waitForUserConfirmation(
            sw!,
            '淘宝要求安全验证（滑块验证），请在弹出的窗口中拖动滑块完成验证，然后点击"已完成"',
            '淘宝安全验证',
            '🔐 请拖动滑块完成验证',
            'verification',
          )
          if (!verified) {
            this.windowManager.closeShopWindow(async () => { await this.cookieManager.syncCookiesFromElectron(this.getContext(), this.auth) })
            doResolve({ success: false, error: '安全验证未完成' })
            return
          }
          resetCaptchaMode(sw!)
          const swAfterVerify = this.windowManager.getShopWindow()
          if (!swAfterVerify || swAfterVerify.isDestroyed()) {
            const vWin = this.interactionService.getVerificationWindow()
            if (vWin && !vWin.isDestroyed()) {
              this.windowManager.setShopWindow(vWin)
              this.emitStatus('验证完成，正在继续购买流程...')
              const vUrl = vWin.webContents.getURL()
              if (isOrderDetailPage(vUrl) || vUrl.includes('orderDetail')) {
                vWin.hide()
              }
            } else {
              doResolve({ success: false, error: '验证完成但操作窗口已关闭' })
              return
            }
          }
          await humanDelay(1500)
          const currentSw = this.windowManager.getShopWindow()
          if (currentSw && !currentSw.isDestroyed()) {
            const afterVerifyUrl = currentSw.webContents.getURL()
            if (isBuyPage(afterVerifyUrl)) {
              await this.cookieManager.syncCookiesFromElectron(this.getContext(), this.auth)
              if (cartOnly) {
                this.windowManager.closeShopWindow()
                this.emitStatus('该商品不支持加入购物车，点击后直接进入了结算页面')
                doResolve({ success: false, error: '该商品不支持加入购物车，点击后直接进入了结算页面' })
              } else {
                this.emitStatus('验证完成，已进入结算页面')
                doResolve({ success: true, directToPay: true })
              }
              return
            }
            if (isCartPage(afterVerifyUrl)) {
              await this.cookieManager.syncCookiesFromElectron(this.getContext(), this.auth)
              this.emitStatus('验证完成，已加入购物车')
              doResolve({ success: true, directToPay: false })
              return
            }
            if (isProductDetailPage(afterVerifyUrl)) {
              this.emitStatus('验证完成，请在弹出的窗口中选择规格并购买')
              currentSw.setSize(WINDOW_SIZES.CONFIRMATION.width, WINDOW_SIZES.CONFIRMATION.height)
              currentSw.setTitle('请选择规格并购买')
              const mw = this.windowManager.getMainWindow()
              if (mw) currentSw.setParentWindow(mw)
              injectOverlayBanner(currentSw, '🛒 自动购物助手：验证通过，请选择规格并点击"立即购买"或"加入购物车"')
              injectCenterToast(currentSw, '验证通过，请选择规格并购买')
              currentSw.show()
              const confirmed = await this.interactionService.waitForUserConfirmation(
                currentSw,
                '验证通过，已进入商品详情页，请在弹出的窗口中选择规格并购买，完成后点击"已完成"',
                '选择规格并购买',
                '🛒 验证通过，请选择规格并购买',
                'add-to-cart',
              )
              if (!confirmed || currentSw.isDestroyed()) {
                if (!currentSw.isDestroyed()) this.windowManager.closeShopWindow(async () => { await this.cookieManager.syncCookiesFromElectron(this.getContext(), this.auth) })
                doResolve({ success: false, error: '用户取消了购买' })
                return
              }
              let afterUrl = ''
              try { afterUrl = currentSw.webContents.getURL() } catch { /* window destroyed */ }
              if (isBuyPage(afterUrl)) {
                await this.cookieManager.syncCookiesFromElectron(this.getContext(), this.auth)
                this.emitStatus('已进入结算页面')
                doResolve({ success: true, directToPay: true })
              } else if (isCartPage(afterUrl)) {
                await this.cookieManager.syncCookiesFromElectron(this.getContext(), this.auth)
                this.emitStatus('已加入购物车')
                doResolve({ success: true, directToPay: false })
              } else {
                await this.cookieManager.syncCookiesFromElectron(this.getContext(), this.auth)
                this.emitStatus('操作完成')
                doResolve({ success: true, directToPay: true })
              }
              return
            }
          }
          return
        }
        if (isLoginPage(url)) {
          if (loginRetryCount < 2) {
            loginRetryCount++
            this.emitStatus('检测到登录页面，正在重新同步登录状态...')
            await this.cookieManager.syncCookiesFromElectron(this.getContext(), this.auth, true)
            await this.cookieManager.syncCookiesToElectron(this.getContext(), this.auth, true)
            await humanDelay(500)
            if (sw && !sw.isDestroyed()) sw.loadURL(detailUrl, detailUrlLoadOptions)
            return
          }
          this.windowManager.closeShopWindow()
          this.emitStatus('登录已过期，请重新登录')
          doResolve({ success: false, error: '登录已过期' })
          return
        }
        const directToPay = isBuyPage(url)
        if (directToPay) {
          await this.cookieManager.syncCookiesFromElectron(this.getContext(), this.auth)
          if (cartOnly) {
            this.windowManager.closeShopWindow()
            this.emitStatus('该商品不支持加入购物车，点击后直接进入了结算页面')
            doResolve({ success: false, error: '该商品不支持加入购物车，点击后直接进入了结算页面' })
          } else {
            this.emitStatus('已进入结算页面')
            doResolve({ success: true, directToPay: true })
          }
          return
        }
        if (isCartPage(url)) {
          await this.cookieManager.syncCookiesFromElectron(this.getContext(), this.auth)
          this.emitStatus('已加入购物车')
          doResolve({ success: true, directToPay: false })
          return
        }
        if (isOrderArchivePage(url)) {

          this.windowManager.closeShopWindow(async () => { await this.cookieManager.syncCookiesFromElectron(this.getContext(), this.auth) })
          this.emitStatus('未找到再买一单入口')
          doResolve({ success: false, error: '未找到再买一单入口' })
          return
        }
        if (isProductDetailPage(url)) {
          const offShelfKeyword = await checkOffShelf(sw!)
          if (offShelfKeyword) {
            this.windowManager.closeShopWindow(async () => { await this.cookieManager.syncCookiesFromElectron(this.getContext(), this.auth) })
            this.emitStatus(`商品不可购买（${offShelfKeyword}）`)
            doResolve({ success: false, error: `商品不可购买（${offShelfKeyword}）` })
            return
          }
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
            if (!sw!.isDestroyed()) this.windowManager.closeShopWindow(async () => { await this.cookieManager.syncCookiesFromElectron(this.getContext(), this.auth) })
            doResolve({ success: false, error: '用户取消了购买' })
            return
          }
          let afterUrl = ''
          try { afterUrl = sw!.webContents.getURL() } catch { /* window destroyed */ }
          if (isBuyPage(afterUrl)) {
            await this.cookieManager.syncCookiesFromElectron(this.getContext(), this.auth)
            this.emitStatus('已进入结算页面')
            doResolve({ success: true, directToPay: true })
            return
          }
          if (isCartPage(afterUrl)) {
            await this.cookieManager.syncCookiesFromElectron(this.getContext(), this.auth)
            this.emitStatus('已加入购物车')
            doResolve({ success: true, directToPay: false })
            return
          }
          await this.cookieManager.syncCookiesFromElectron(this.getContext(), this.auth)
          this.emitStatus('已加入购物车')
          doResolve({ success: true, directToPay: false })
          return
        }
        const btnSearchSelectors = ['button', 'a', '[class*="btn"]', '[class*="Button"]', '[role="button"]', '[class*="action"]', '[class*="submit"]', '[class*="rebuy"]', '[class*="Rebuy"]', '[class*="buy-again"]', '[class*="BuyAgain"]', '[data-spm*="rebuy"]', '[data-spm*="buy"]', 'span[class*="click"]', 'div[class*="click"]']
        let rebuyBtnFound = false
        const btnSearchTargets = cartOnly ? [...KEYWORDS.CART_BUTTONS, ...KEYWORDS.REBUY_BUTTONS] : [...KEYWORDS.REBUY_BUTTONS]
        const MAX_RETRIES = 10
        const RETRY_DELAYS = [500, 500, 500, 1000, 1000, 1000, 2000, 2000, 2000, 2000]
        let prevBodyLen = 0
        let stableCount = 0
        for (let retry = 0; retry < MAX_RETRIES; retry++) {
          if (resolved || this.isDestroyed()) {
            break
          }
          try {
            const hsCheck = await execJS(sw, `(function() { return typeof _hs !== 'undefined'; })()`)
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
            if (mainHasBtn?.found) { rebuyBtnFound = true; break }
            const currentBodyLen = mainHasBtn?.bodyLen || 0
            const frames = sw!.webContents.mainFrame.framesInSubtree
            for (const frame of frames) {
              if (frame === sw!.webContents.mainFrame) continue
              const fUrl = frame.url
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
                const fhb = fHasBtn as Record<string, unknown> | null
                if (fhb?.found) { rebuyBtnFound = true; break }
              } catch (e: unknown) {
              }
            }
            if (retry >= 2 && currentBodyLen > 0 && currentBodyLen === prevBodyLen) {
              stableCount++
              if (stableCount >= 3) {
                break
              }
            } else {
              stableCount = 0
            }
            prevBodyLen = currentBodyLen
          } catch (e: unknown) {
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
          this.emitStatus('未找到再买一单按钮，将搜索替代商品...')
          doResolve({ success: false, error: '未找到再买一单入口' })
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
              var buyTexts = ${JSON.stringify(KEYWORDS.BUY_BUTTONS)};
              var btns = document.querySelectorAll('button, a, [class*="btn"], [class*="Button"], [role="button"], [class*="action"], [class*="submit"]');
              for (var j = 0; j < btns.length; j++) {
                var btnText = (btns[j].textContent || '').replace(/\\s+/g, '');
                var rect = btns[j].getBoundingClientRect();
                if (rect.width <= 0 || rect.height <= 0) continue;
                for (var k = 0; k < buyTexts.length; k++) {
                  if (btnText.includes(buyTexts[k])) return { offShelf: false, keyword: '' };
                }
              }
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
                    var buyTexts = ${JSON.stringify(KEYWORDS.BUY_BUTTONS)};
                    var btns = document.querySelectorAll('button, a, [class*="btn"], [class*="Button"], [role="button"], [class*="action"], [class*="submit"]');
                    for (var j = 0; j < btns.length; j++) {
                      var btnText = (btns[j].textContent || '').replace(/\\s+/g, '');
                      var rect = btns[j].getBoundingClientRect();
                      if (rect.width <= 0 || rect.height <= 0) continue;
                      for (var k = 0; k < buyTexts.length; k++) {
                        if (btnText.includes(buyTexts[k])) return { offShelf: false, keyword: '' };
                      }
                    }
                    return { offShelf: true, keyword: matchedKeyword };
                  })()
                `)
                if ((fOffShelf as Record<string, unknown> | null)?.offShelf) { offShelfResult = fOffShelf as { offShelf: boolean; keyword: string }; break }
              } catch { /* ignore */ }
            }
          }
          if (isOrderDetailPage(url)) {
            sameUrlCount++
            if (sameUrlCount >= 15) {
              rebuyRetryCount++
              if (rebuyRetryCount > MAX_REBUY_RETRIES) {

                this.windowManager.closeShopWindow(async () => { await this.cookieManager.syncCookiesFromElectron(this.getContext(), this.auth) })
                this.emitStatus('多次点击再买一单后页面未跳转，请尝试搜索购买')
                doResolve({ success: false, error: '多次点击再买一单后页面未跳转' })
                return
              }
              sameUrlCount = 0
              tryClickRebuy()
            }
          } else {
            sameUrlCount = 0
          }
        } catch { /* ignore */ }
        if (offShelfResult?.offShelf) {
          this.windowManager.closeShopWindow(async () => { await this.cookieManager.syncCookiesFromElectron(this.getContext(), this.auth) })
          this.emitStatus(`商品不可购买（${offShelfResult.keyword}）`)
          doResolve({ success: false, error: `商品不可购买（${offShelfResult.keyword}）` })
          return
        }
        await tryClickRebuy()
        } finally {
          processingDidFinishLoad = false
        }
      })

      lt.on(currentSw.webContents, 'did-navigate', async (_event, navUrl: string) => {
        if (resolved) return
        await humanDelay(1500)
        const sw = this.windowManager.getShopWindow()
        if (!sw || sw.isDestroyed()) return
        const url = sw.webContents.getURL()

        if (isErrorPage(url)) {
          this.windowManager.closeShopWindow()
          this.emitStatus('⚠️ 商品页面无法访问，可能已下架或活动已结束')
          doResolve({ success: false, error: '商品页面无法访问（跳转到了错误页面）' })
          return
        }

        if (isBuyPage(url)) {
          await this.cookieManager.syncCookiesFromElectron(this.getContext(), this.auth)
          if (cartOnly) {
            this.windowManager.closeShopWindow()
            this.emitStatus('该商品不支持加入购物车，点击后直接进入了结算页面')
            doResolve({ success: false, error: '该商品不支持加入购物车，点击后直接进入了结算页面' })
          } else {
            this.emitStatus('已进入结算页面')
            doResolve({ success: true, directToPay: true })
          }
          return
        }
        if (isCartPage(url)) {
          await this.cookieManager.syncCookiesFromElectron(this.getContext(), this.auth)
          this.emitStatus('已加入购物车')
          doResolve({ success: true, directToPay: false })
          return
        }
        if (isProductDetailPage(url)) {
          const offShelfKeyword = await checkOffShelf(sw)
          if (offShelfKeyword) {
            this.windowManager.closeShopWindow(async () => { await this.cookieManager.syncCookiesFromElectron(this.getContext(), this.auth) })
            this.emitStatus(`商品不可购买（${offShelfKeyword}）`)
            doResolve({ success: false, error: `商品不可购买（${offShelfKeyword}）` })
            return
          }
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
            if (!sw.isDestroyed()) this.windowManager.closeShopWindow(async () => { await this.cookieManager.syncCookiesFromElectron(this.getContext(), this.auth) })
            doResolve({ success: false, error: '用户取消了购买' })
            return
          }
          let afterUrl = ''
          try { afterUrl = sw.webContents.getURL() } catch { /* window destroyed */ }
          if (isBuyPage(afterUrl)) {
            await this.cookieManager.syncCookiesFromElectron(this.getContext(), this.auth)
            this.emitStatus('已进入结算页面')
            doResolve({ success: true, directToPay: true })
            return
          }
          if (isCartPage(afterUrl)) {
            await this.cookieManager.syncCookiesFromElectron(this.getContext(), this.auth)
            this.emitStatus('已加入购物车')
            doResolve({ success: true, directToPay: false })
            return
          }
          await this.cookieManager.syncCookiesFromElectron(this.getContext(), this.auth)
          this.emitStatus('已加入购物车')
          doResolve({ success: true, directToPay: false })
          return
        }
        if (isOrderArchivePage(url)) {

          this.windowManager.closeShopWindow(async () => { await this.cookieManager.syncCookiesFromElectron(this.getContext(), this.auth) })
          this.emitStatus('未找到再买一单入口')
          doResolve({ success: false, error: '未找到再买一单入口' })
          return
        }
        if (isLoginPage(url)) {
          if (loginRetryCount < 2) {
            loginRetryCount++
            this.emitStatus('检测到登录页面，正在重新同步登录状态...')
            await this.cookieManager.syncCookiesFromElectron(this.getContext(), this.auth, true)
            await this.cookieManager.syncCookiesToElectron(this.getContext(), this.auth, true)
            await humanDelay(500)
            if (sw && !sw.isDestroyed()) sw.loadURL(detailUrl, detailUrlLoadOptions)
            return
          }
          this.windowManager.closeShopWindow()
          this.emitStatus('登录已过期，请重新登录')
          doResolve({ success: false, error: '登录已过期' })
          return
        }
      })

      lt.on(currentSw.webContents, 'did-navigate-in-page', async (_event, navUrl: string) => {
        if (resolved) return
        const sw = this.windowManager.getShopWindow()
        if (!sw || sw.isDestroyed()) return

        if (isBuyPage(navUrl)) {
          await this.cookieManager.syncCookiesFromElectron(this.getContext(), this.auth)
          if (cartOnly) {
            this.windowManager.closeShopWindow()
            this.emitStatus('该商品不支持加入购物车，点击后直接进入了结算页面')
            doResolve({ success: false, error: '该商品不支持加入购物车，点击后直接进入了结算页面' })
          } else {
            this.emitStatus('已进入结算页面')
            doResolve({ success: true, directToPay: true })
          }
          return
        }
        if (isCartPage(navUrl)) {
          await this.cookieManager.syncCookiesFromElectron(this.getContext(), this.auth)
          this.emitStatus('已加入购物车')
          doResolve({ success: true, directToPay: false })
          return
        }
        if (isProductDetailPage(navUrl)) {
          const offShelfKeyword = await checkOffShelf(sw)
          if (offShelfKeyword) {
            this.windowManager.closeShopWindow(async () => { await this.cookieManager.syncCookiesFromElectron(this.getContext(), this.auth) })
            this.emitStatus(`商品不可购买（${offShelfKeyword}）`)
            doResolve({ success: false, error: `商品不可购买（${offShelfKeyword}）` })
            return
          }
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
            if (!sw.isDestroyed()) this.windowManager.closeShopWindow(async () => { await this.cookieManager.syncCookiesFromElectron(this.getContext(), this.auth) })
            doResolve({ success: false, error: '用户取消了购买' })
            return
          }
          let afterUrl = ''
          try { afterUrl = sw.webContents.getURL() } catch { /* window destroyed */ }
          await this.cookieManager.syncCookiesFromElectron(this.getContext(), this.auth)
          if (isBuyPage(afterUrl)) {
            this.emitStatus('已进入结算页面')
            doResolve({ success: true, directToPay: true })
          } else if (isCartPage(afterUrl)) {
            this.emitStatus('已加入购物车')
            doResolve({ success: true, directToPay: false })
          } else {
            this.emitStatus('已加入购物车')
            doResolve({ success: true, directToPay: false })
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

            await this.cookieManager.syncCookiesFromElectron(this.getContext(), this.auth)
            if (cartOnly) {
              this.windowManager.closeShopWindow()
              this.emitStatus('该商品不支持加入购物车，点击后直接进入了结算页面')
              doResolve({ success: false, error: '该商品不支持加入购物车，点击后直接进入了结算页面' })
            } else {
              this.emitStatus('已进入结算页面')
              doResolve({ success: true, directToPay: true })
            }
            return
          }
          if (isCartPage(frameUrl)) {

            await this.cookieManager.syncCookiesFromElectron(this.getContext(), this.auth)
            this.emitStatus('已加入购物车')
            doResolve({ success: true, directToPay: false })
            return
          }
          if (isProductDetailPage(frameUrl)) {
            const offShelfKeyword = await checkOffShelf(sw)
            if (offShelfKeyword) {
              this.windowManager.closeShopWindow(async () => { await this.cookieManager.syncCookiesFromElectron(this.getContext(), this.auth) })
              this.emitStatus(`商品不可购买（${offShelfKeyword}）`)
              doResolve({ success: false, error: `商品不可购买（${offShelfKeyword}）` })
              return
            }

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
              doResolve({ success: false, error: '用户取消了购买' })
            } else {
              let afterUrl = ''
              try { afterUrl = sw.webContents.getURL() } catch { /* window destroyed */ }
              await this.cookieManager.syncCookiesFromElectron(this.getContext(), this.auth)
              if (isBuyPage(afterUrl)) {
                this.emitStatus('已进入结算页面')
                doResolve({ success: true, directToPay: true })
              } else if (isCartPage(afterUrl)) {
                this.emitStatus('已加入购物车')
                doResolve({ success: true, directToPay: false })
              } else {
                this.emitStatus('已加入购物车')
                doResolve({ success: true, directToPay: false })
              }
            }
            return
          }
        }
      })

      const checkInterval = setInterval(async () => {
        if (resolved) { return }
        if (this.isDestroyed()) {
          if (!resolved) {
            doResolve({ success: false, error: '任务已取消' })
          }
          return
        }
        try {
          const sw = this.windowManager.getShopWindow()
          if (!sw || sw.isDestroyed()) {
            if (!resolved) {
              if (this.interactionService.hasPendingConfirmation()) {
                return
              }
              doResolve({ success: false, error: '操作窗口已关闭' })
            }
            return
          }
          const url = sw.webContents.getURL()
          if (!url) return

          const hasCaptcha = await this.verificationService.detectCaptcha(sw)
          if (hasCaptcha) {
            cleanupForCaptcha(sw)
            sw.setSize(WINDOW_SIZES.CONFIRMATION.width, WINDOW_SIZES.CONFIRMATION.height)
            sw.setTitle('淘宝安全验证')
            sw.setAlwaysOnTop(true)
            if (sw.isMinimized()) {
              sw.restore()
            }
            injectOverlayBanner(sw, '🔐 自动购物助手：淘宝要求安全验证，请在下方拖动滑块完成验证')
            injectCenterToast(sw, '请拖动滑块完成验证')
            sw.show()
            sw.focus()
            this.emitStatus('需要进行滑块验证，请在弹出的窗口中完成验证...')
            const verified = await this.interactionService.waitForUserConfirmation(
              sw,
              '淘宝要求安全验证（滑块验证），请在弹出的窗口中拖动滑块完成验证，然后点击"已完成"',
              '淘宝安全验证',
              '🔐 请拖动滑块完成验证',
              'verification',
            )
            if (!verified) {
              this.windowManager.closeShopWindow(async () => { await this.cookieManager.syncCookiesFromElectron(this.getContext(), this.auth) })
              doResolve({ success: false, error: '安全验证未完成' })
              return
            }
            resetCaptchaMode(sw)
            const swAfterVerify = this.windowManager.getShopWindow()
            if (!swAfterVerify || swAfterVerify.isDestroyed()) {
              doResolve({ success: false, error: '验证完成但操作窗口已关闭' })
              return
            }
            await humanDelay(1500)
            const checkSw = this.windowManager.getShopWindow()
            if (checkSw && !checkSw.isDestroyed()) {
              const afterVerifyUrl = checkSw.webContents.getURL()
              if (isBuyPage(afterVerifyUrl)) {
                await this.cookieManager.syncCookiesFromElectron(this.getContext(), this.auth)
                if (cartOnly) {
                  this.windowManager.closeShopWindow()
                  this.emitStatus('该商品不支持加入购物车，点击后直接进入了结算页面')
                  doResolve({ success: false, error: '该商品不支持加入购物车，点击后直接进入了结算页面' })
                } else {
                  this.emitStatus('验证完成，已进入结算页面')
                  doResolve({ success: true, directToPay: true })
                }
                return
              }
              if (isCartPage(afterVerifyUrl)) {
                await this.cookieManager.syncCookiesFromElectron(this.getContext(), this.auth)
                this.emitStatus('验证完成，已加入购物车')
                doResolve({ success: true, directToPay: false })
                return
              }
              if (isProductDetailPage(afterVerifyUrl)) {
                this.emitStatus('验证完成，请在弹出的窗口中选择规格并购买')
                checkSw.setSize(WINDOW_SIZES.CONFIRMATION.width, WINDOW_SIZES.CONFIRMATION.height)
                checkSw.setTitle('请选择规格并购买')
                const mw = this.windowManager.getMainWindow()
                if (mw) checkSw.setParentWindow(mw)
                injectOverlayBanner(checkSw, '🛒 自动购物助手：验证通过，请选择规格并点击"立即购买"或"加入购物车"')
                injectCenterToast(checkSw, '验证通过，请选择规格并购买')
                checkSw.show()
                const confirmed = await this.interactionService.waitForUserConfirmation(
                  checkSw,
                  '验证通过，已进入商品详情页，请在弹出的窗口中选择规格并购买，完成后点击"已完成"',
                  '选择规格并购买',
                  '🛒 验证通过，请选择规格并购买',
                  'add-to-cart',
                )
                if (!confirmed || checkSw.isDestroyed()) {
                  if (!checkSw.isDestroyed()) this.windowManager.closeShopWindow(async () => { await this.cookieManager.syncCookiesFromElectron(this.getContext(), this.auth) })
                  doResolve({ success: false, error: '用户取消了购买' })
                } else {
                  let afterUrl = ''
                  try { afterUrl = checkSw.webContents.getURL() } catch { /* window destroyed */ }
                  await this.cookieManager.syncCookiesFromElectron(this.getContext(), this.auth)
                  if (isBuyPage(afterUrl)) {
                    this.emitStatus('已进入结算页面')
                    doResolve({ success: true, directToPay: true })
                  } else if (isCartPage(afterUrl)) {
                    this.emitStatus('已加入购物车')
                    doResolve({ success: true, directToPay: false })
                  } else {
                    this.emitStatus('操作完成')
                    doResolve({ success: true, directToPay: true })
                  }
                }
                return
              }
            }
            return
          }

          if (isLoginPage(url)) {
            if (loginRetryCount < 2) {
              loginRetryCount++
              this.emitStatus('检测到登录页面，正在重新同步登录状态...')
              await this.cookieManager.syncCookiesFromElectron(this.getContext(), this.auth, true)
              await this.cookieManager.syncCookiesToElectron(this.getContext(), this.auth, true)
              await humanDelay(500)
              if (sw && !sw.isDestroyed()) sw.loadURL(detailUrl, detailUrlLoadOptions)
              return
            }
            this.windowManager.closeShopWindow()
            this.emitStatus('登录已过期，请重新登录')
            doResolve({ success: false, error: '登录已过期' })
            return
          }

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
              await this.cookieManager.syncCookiesFromElectron(this.getContext(), this.auth)
              this.windowManager.closeShopWindow()
              this.emitStatus('已加入购物车')
              doResolve({ success: true, directToPay: false })
              return
            }
            if (intervalCartResult?.type === 'error') {
              this.windowManager.closeShopWindow(async () => { await this.cookieManager.syncCookiesFromElectron(this.getContext(), this.auth) })
              const errorMsg = `商品不可购买（${intervalCartResult.hint}）`
              this.emitStatus(errorMsg)
              doResolve({ success: false, error: errorMsg })
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

                await this.cookieManager.syncCookiesFromElectron(this.getContext(), this.auth)
                if (cartOnly) {
                  this.windowManager.closeShopWindow()
                  this.emitStatus('该商品不支持加入购物车，点击后直接进入了结算页面')
                  doResolve({ success: false, error: '该商品不支持加入购物车，点击后直接进入了结算页面' })
                } else {
                  this.emitStatus('已进入结算页面')
                  doResolve({ success: true, directToPay: true })
                }
                return
              }
              if (isCartPage(frameUrl)) {

                await this.cookieManager.syncCookiesFromElectron(this.getContext(), this.auth)
                this.emitStatus('已加入购物车')
                doResolve({ success: true, directToPay: false })
                return
              }
              if (isProductDetailPage(frameUrl)) {
                const offShelfKeyword = await checkOffShelf(sw!)
                if (offShelfKeyword) {
                  this.windowManager.closeShopWindow(async () => { await this.cookieManager.syncCookiesFromElectron(this.getContext(), this.auth) })
                  this.emitStatus(`商品不可购买（${offShelfKeyword}）`)
                  doResolve({ success: false, error: `商品不可购买（${offShelfKeyword}）` })
                  return
                }

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
                  doResolve({ success: false, error: '用户取消了购买' })
                } else {
                  let afterUrl = ''
                  try { afterUrl = sw!.webContents.getURL() } catch { /* window destroyed */ }
                  if (isBuyPage(afterUrl)) {
                    await this.cookieManager.syncCookiesFromElectron(this.getContext(), this.auth)
                    this.emitStatus('已进入结算页面')
                    doResolve({ success: true, directToPay: true })
                  } else if (isCartPage(afterUrl)) {
                    await this.cookieManager.syncCookiesFromElectron(this.getContext(), this.auth)
                    this.emitStatus('已加入购物车')
                    doResolve({ success: true, directToPay: false })
                  } else {
                    await this.cookieManager.syncCookiesFromElectron(this.getContext(), this.auth)
                    this.emitStatus('已加入购物车')
                    doResolve({ success: true, directToPay: false })
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

                  this.windowManager.closeShopWindow(async () => { await this.cookieManager.syncCookiesFromElectron(this.getContext(), this.auth) })
                  this.emitStatus('多次点击再买一单后页面未跳转，请尝试搜索购买')
                  doResolve({ success: false, error: '多次点击再买一单后页面未跳转' })
                  return
                }
                sameUrlCount = 0
                tryClickRebuy()
              }
            } else {
              sameUrlCount = 0
            }
          }
          if (isBuyPage(url)) {
            await this.cookieManager.syncCookiesFromElectron(this.getContext(), this.auth)
            if (cartOnly) {
              this.windowManager.closeShopWindow()
              this.emitStatus('该商品不支持加入购物车，点击后直接进入了结算页面')
              doResolve({ success: false, error: '该商品不支持加入购物车，点击后直接进入了结算页面' })
            } else {
              this.emitStatus('已进入结算页面')
              doResolve({ success: true, directToPay: true })
            }
          } else if (isCartPage(url)) {
            await this.cookieManager.syncCookiesFromElectron(this.getContext(), this.auth)
            this.emitStatus('已加入购物车')
            doResolve({ success: true, directToPay: false })
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
                var buyTexts = ${JSON.stringify(KEYWORDS.BUY_BUTTONS)};
                var btns = document.querySelectorAll('button, a, [class*="btn"], [class*="Button"], [role="button"], [class*="action"], [class*="submit"]');
                for (var j = 0; j < btns.length; j++) {
                  var btnText = (btns[j].textContent || '').replace(/\\s+/g, '');
                  var rect = btns[j].getBoundingClientRect();
                  if (rect.width <= 0 || rect.height <= 0) continue;
                  for (var k = 0; k < buyTexts.length; k++) {
                    if (btnText.includes(buyTexts[k])) return '';
                  }
                }
                return matchedKeyword;
              })()
            `).catch(() => '')
            if (offShelfCheck) {
              this.windowManager.closeShopWindow(async () => { await this.cookieManager.syncCookiesFromElectron(this.getContext(), this.auth) })
              this.emitStatus(`商品不可购买（${offShelfCheck}）`)
              doResolve({ success: false, error: `商品不可购买（${offShelfCheck}）` })
            } else {
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
                if (!sw!.isDestroyed()) this.windowManager.closeShopWindow(async () => { await this.cookieManager.syncCookiesFromElectron(this.getContext(), this.auth) })
                doResolve({ success: false, error: '用户取消了购买' })
                return
              }
              let afterUrl = ''
              try { afterUrl = sw!.webContents.getURL() } catch { /* window destroyed */ }
              if (isBuyPage(afterUrl)) {
                await this.cookieManager.syncCookiesFromElectron(this.getContext(), this.auth)
                this.emitStatus('已进入结算页面')
                doResolve({ success: true, directToPay: true })
                return
              }
              if (isCartPage(afterUrl)) {
                await this.cookieManager.syncCookiesFromElectron(this.getContext(), this.auth)
                this.emitStatus('已加入购物车')
                doResolve({ success: true, directToPay: false })
                return
              }
              await this.cookieManager.syncCookiesFromElectron(this.getContext(), this.auth)
              this.emitStatus('已加入购物车')
              doResolve({ success: true, directToPay: false })
              return
            }
          } else if (!isOrderDetailPage(url) && !url.includes('orderDetail') && !isLoginPage(url)) {
            const offShelfKeyword = await checkOffShelf(sw!)
            if (offShelfKeyword) {
              this.windowManager.closeShopWindow(async () => { await this.cookieManager.syncCookiesFromElectron(this.getContext(), this.auth) })
              this.emitStatus(`商品不可购买（${offShelfKeyword}）`)
              doResolve({ success: false, error: `商品不可购买（${offShelfKeyword}）` })
              return
            }
          }
        } catch { /* ignore */ }
      }, 2000)

      currentSw.on('closed', async () => {
        if (!resolved) {
          if (this.interactionService.hasPendingConfirmation()) {
            this.windowManager.setShopWindow(null)
            return
          }
          await this.cookieManager.syncCookiesFromElectron(this.getContext(), this.auth)
          this.windowManager.setShopWindow(null)
          doResolve(null)
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
      this.emitStatus('正在打开订单详情页（Playwright）...')
      await page.goto(detailUrl, { waitUntil: 'domcontentloaded', timeout: TIMEOUTS.PAGE_LOAD })

      const pageUrl = page.url()
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

      return { success: false, error: '未找到再买一单入口' }
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

      if (isIdentityVerifyPage(popupUrl)) {
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
      this.emitStatus('已进入结算页面')
      return { success: true, directToPay: true }
    }

    this.emitStatus('已加入购物车')
    return { success: true, directToPay: false }
  }

  private async clickRebuyButton(): Promise<boolean> {
    const page = this.browserManager.getPage()
    if (!page) return false

    const targets = [...KEYWORDS.REBUY_BUTTONS]
    const selectors = ['button', 'a', '[class*="btn"]', '[class*="Button"]', '[role="button"]', '[class*="action"]', '[class*="submit"]', '[class*="rebuy"]', '[class*="Rebuy"]', '[class*="buy-again"]', '[class*="BuyAgain"]', '[data-spm*="rebuy"]', '[data-spm*="buy"]', 'span[class*="click"]', 'div[class*="click"]']

    try {
      const frames = page.frames()

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

            if (clicked.clicked) return true
          }
        } catch (e: unknown) {
          console.log(`[Taobao] clickRebuyButton frame error: ${e}`)
        }
      }

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

          if (cssResult.clicked) return true
        } catch (e: unknown) {
          console.log(`[Taobao] clickRebuyButton CSS frame error: ${e}`)
        }
      }

      return false
    } catch (e: unknown) {
      console.log(`[Taobao] clickRebuyButton error: ${e}`)
    }

    return false
  }
}
 
