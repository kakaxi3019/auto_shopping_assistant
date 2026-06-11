import type { BrowserContext, Page } from 'playwright'
import type { PayResult } from '../../../shared/types/platform.types'
import type { Database } from '../../../db/database'
import type { WindowManager } from '../infrastructure/window-manager'
import type { CookieManager } from '../infrastructure/cookie-manager'
import type { InteractionService } from './interaction.service'
import type { VerificationService } from './verification.service'
import type { TaobaoAuth } from '../taobao.auth'
import { setUserAgent, debugLog, humanDelay, humanClickAt, humanClickElement, execJS, injectOverlayBanner, injectCenterToast, rand, clickInShopWindow } from '../utils/page-helper'
import { APP_ICON, TIMEOUTS, WINDOW_SIZES, KEYWORDS } from '../utils/constants'
import { isCheckoutOrPayPage, isLoginPage, isIdentityVerifyPage, isBuyPage, isCartPage, isProductDetailPage } from '../utils/url-helper'
import { TAOBAO_SELECTORS } from '../taobao.selectors'


export class PaymentService {
  private windowManager: WindowManager
  private cookieManager: CookieManager
  private interactionService: InteractionService
  private verificationService: VerificationService
  private auth: TaobaoAuth
  private db: Database
  private emitStatus: (status: string) => void
  private getContext: () => BrowserContext | null
  private getPage: () => Page | null
  private setPage: (page: Page) => void
  private isDestroyed: () => boolean

  constructor(
    windowManager: WindowManager,
    cookieManager: CookieManager,
    interactionService: InteractionService,
    verificationService: VerificationService,
    auth: TaobaoAuth,
    db: Database,
    emitStatus: (status: string) => void,
    getContext: () => BrowserContext | null,
    getPage: () => Page | null,
    setPage: (page: Page) => void,
    isDestroyed: () => boolean,
  ) {
    this.windowManager = windowManager
    this.cookieManager = cookieManager
    this.interactionService = interactionService
    this.verificationService = verificationService
    this.auth = auth
    this.db = db
    this.emitStatus = emitStatus
    this.getContext = getContext
    this.getPage = getPage
    this.setPage = setPage
    this.isDestroyed = isDestroyed
  }

  async pay(totalAmount?: number, dryRun?: boolean, paymentMode?: string): Promise<PayResult> {
    debugLog(`[Taobao-Payment] pay invoked: totalAmount=${totalAmount}, dryRun=${dryRun}, paymentMode=${paymentMode}`)
    if (dryRun) {
      this.emitStatus(`测试模式：跳过实际支付（预计金额 ¥${totalAmount?.toFixed(2)}）`)
      debugLog('[Taobao-Payment] dryRun is true, skipping actual payment')
      const shopWin = this.windowManager.getShopWindow()
      if (shopWin && !shopWin.isDestroyed()) {
        await this.windowManager.closeShopWindow(async () => {
          await this.cookieManager.syncCookiesFromElectron(this.getContext(), this.auth)
        })
      }
      return { success: true, transactionId: 'TEST_MODE_SKIPPED' }
    }

    const shopWindow = this.windowManager.getShopWindow()
    if (!shopWindow || shopWindow.isDestroyed()) {
      debugLog('[Taobao-Payment] pay failed: no available payment window')
      return { success: false, error: '没有可用的支付窗口' }
    }

    // 从页面读取真实应付金额，而非依赖传入的估算值
    const realAmount = await this.readAmountFromPage(shopWindow)
    const amountForCheck = realAmount ?? totalAmount
    debugLog(`[Taobao-Payment] amount check: realAmount=${realAmount}, passedAmount=${totalAmount}, using=${amountForCheck}`)

    const payFreeLimit = parseFloat(this.db.getSetting('pay_free_limit') || '0') || 0
    const exceedsLimit = payFreeLimit > 0 && amountForCheck !== undefined && amountForCheck > payFreeLimit

    if (exceedsLimit) {
      debugLog(`[Taobao-Payment] amount ¥${amountForCheck} exceeds limit ¥${payFreeLimit}. User confirmation required.`)
      shopWindow.setSize(WINDOW_SIZES.CONFIRMATION.width, WINDOW_SIZES.CONFIRMATION.height)
      shopWindow.setTitle(`金额超过免密支付上限 - 需要手动确认付款`)
      const mainWindow = this.windowManager.getMainWindow()
      if (mainWindow) shopWindow.setParentWindow(mainWindow)
      const bannerMsg = `⚠️ 自动支付已暂停：订单金额 ¥${amountForCheck!.toFixed(2)} 超过免密支付上限 ¥${payFreeLimit.toFixed(2)}，为保障资金安全需要您手动确认。请在下方完成付款后点击"已完成"`
      injectOverlayBanner(shopWindow, bannerMsg)
      injectCenterToast(shopWindow, "请完成付款后点击已完成")
      shopWindow.show()
      const confirmed = await this.interactionService.waitForUserConfirmation(
        shopWindow,
        `订单金额 ¥${amountForCheck!.toFixed(2)} 超过免密支付上限 ¥${payFreeLimit.toFixed(2)}，为保障资金安全需要您手动确认付款。请在弹出的窗口中完成支付，然后点击"已完成"`,
        `金额超过免密支付上限 - 需要手动确认付款`,
        bannerMsg,
        'payment',
      )
      if (confirmed) {
        debugLog('[Taobao-Payment] user confirmed payment completion.')
        await this.cookieManager.syncCookiesFromElectron(this.getContext(), this.auth)
        await this.windowManager.closeShopWindow(async () => {
          await this.cookieManager.syncCookiesFromElectron(this.getContext(), this.auth)
        })
        this.emitStatus('支付完成')
        return { success: true }
      }
      debugLog('[Taobao-Payment] user cancelled or payment incomplete.')
      return { success: false, error: '支付未完成' }
    }

    this.emitStatus(amountForCheck !== undefined
      ? `正在自动支付（¥${amountForCheck.toFixed(2)}）...`
      : '正在自动支付...'
    )

    try {
      debugLog('[Taobao-Payment] clicking submit order button in shop window')
      const payResult = await clickInShopWindow(
        shopWindow,
        TAOBAO_SELECTORS.CHECKOUT.SUBMIT_ORDER_SELECTORS as unknown as string[],
        ['免密支付', '立即支付', '确认支付', '提交订单', '确认订单', '去支付', '立即付款']
      )
      debugLog(`[Taobao-Payment] submit order click result: ${JSON.stringify(payResult)}`)
      if (payResult.clicked) {
        await humanDelay(3000)

        const currentShopWindow = this.windowManager.getShopWindow()
        if (currentShopWindow && !currentShopWindow.isDestroyed()) {
          const currentUrl = currentShopWindow.webContents.getURL()
          if (isIdentityVerifyPage(currentUrl) || currentUrl.includes('nocaptcha') || currentUrl.includes('slider')) {
            debugLog(`[Taobao-Payment] identity verification page / slide slider detected: ${currentUrl}`)
            await currentShopWindow.webContents.executeJavaScript(`
              (function() {
                try {
                  Object.defineProperty(Document.prototype, 'visibilityState', { get: function() { return document.hidden ? 'hidden' : 'visible'; }, configurable: true });
                  Object.defineProperty(Document.prototype, 'hidden', { get: function() { return !document.hasFocus(); }, configurable: true });
                  Object.defineProperty(document, 'visibilityState', { get: function() { return document.hidden ? 'hidden' : 'visible'; }, configurable: true });
                  Object.defineProperty(document, 'hidden', { get: function() { return !document.hasFocus(); }, configurable: true });
                } catch(e) {}
              })()
            `).catch(() => {})
            currentShopWindow.setSize(WINDOW_SIZES.CONFIRMATION.width, WINDOW_SIZES.CONFIRMATION.height)
            currentShopWindow.setTitle('淘宝安全验证 - 需要手动操作')
            const mainWindow = this.windowManager.getMainWindow()
            if (mainWindow) currentShopWindow.setParentWindow(mainWindow)
            const verifyBanner = '🔐 自动支付已暂停：淘宝检测到异常操作，要求进行安全验证。请拖动滑块完成验证，然后点击"已完成"'
            injectOverlayBanner(currentShopWindow, verifyBanner)
            injectCenterToast(currentShopWindow, "请拖动滑块完成验证")
            currentShopWindow.show()

            const verified = await this.interactionService.waitForUserConfirmation(
              currentShopWindow,
              '淘宝检测到异常操作，要求进行安全验证（滑块验证）。请在弹出的窗口中拖动滑块完成验证，然后点击"已完成"，系统将继续自动完成后续流程',
              '淘宝安全验证 - 需要手动操作',
              verifyBanner,
              'verification',
            )
            if (verified) {
              await this.cookieManager.syncCookiesFromElectron(this.getContext(), this.auth)
              await this.windowManager.closeShopWindow(async () => {
                await this.cookieManager.syncCookiesFromElectron(this.getContext(), this.auth)
              })
              this.emitStatus('验证完成')
              return { success: true }
            }
            return { success: false, error: '安全验证未完成' }
          }

          const hasCaptcha = await currentShopWindow.webContents.executeJavaScript(`
            (function() {
              var captchaSelectors = [
                '#nocaptcha', '#nc_1_wrapper', '[class*="nc-container"]', '[class*="nc_wrapper"]',
                '[class*="slider"]', '[class*="captcha"]', '[class*="Captcha"]', '[id*="captcha"]',
                'iframe[src*="nocaptcha"]', 'iframe[src*="captcha"]', 'iframe[src*="slider"]'
              ];
              for (var i = 0; i < captchaSelectors.length; i++) {
                var el = document.querySelector(captchaSelectors[i]);
                if (el) {
                  var rect = el.getBoundingClientRect();
                  if (rect.width > 50 && rect.height > 20) return { found: true, selector: captchaSelectors[i], w: Math.round(rect.width), h: Math.round(rect.height) };
                }
              }
              var iframes = document.querySelectorAll('iframe');
              for (var j = 0; j < iframes.length; j++) {
                var src = iframes[j].src || '';
                if (src.includes('captcha') || src.includes('nocaptcha') || src.includes('slider') || src.includes('verify')) {
                  return { found: true, selector: 'iframe[src*=' + src.substring(0, 30) + ']', w: 0, h: 0 };
                }
              }
              var bodyText = (document.body?.innerText || '').substring(0, 500);
              var captchaHints = ${JSON.stringify([...KEYWORDS.CAPTCHA_HINTS, '验证', '安全验证', '拖动滑块'])};
              for (var k = 0; k < captchaHints.length; k++) {
                if (bodyText.includes(captchaHints[k])) return { found: true, hint: captchaHints[k], w: 0, h: 0 };
              }
              return { found: false };
            })()
          `)

          if (hasCaptcha && hasCaptcha.found) {
            currentShopWindow.setSize(WINDOW_SIZES.CONFIRMATION.width, WINDOW_SIZES.CONFIRMATION.height)
            currentShopWindow.setTitle('淘宝安全验证 - 需要手动操作')
            const mainWindow = this.windowManager.getMainWindow()
            if (mainWindow) currentShopWindow.setParentWindow(mainWindow)
            const captchaBanner = '🔐 自动支付已暂停：淘宝检测到异常操作，要求进行验证码验证。请完成验证后点击"已完成"，系统将继续自动完成后续流程'
            injectOverlayBanner(currentShopWindow, captchaBanner)
            injectCenterToast(currentShopWindow, "请完成验证码验证")
            currentShopWindow.show()

            const verified = await this.interactionService.waitForUserConfirmation(
              currentShopWindow,
              '淘宝检测到异常操作，要求进行验证码验证。请在弹出的窗口中完成验证（滑块或验证码），然后点击"已完成"，系统将继续自动完成后续流程',
              '淘宝安全验证 - 需要手动操作',
              captchaBanner,
              'verification',
            )
            if (verified) {
              await this.cookieManager.syncCookiesFromElectron(this.getContext(), this.auth)
              await this.windowManager.closeShopWindow(async () => {
                await this.cookieManager.syncCookiesFromElectron(this.getContext(), this.auth)
              })
              this.emitStatus('验证完成')
              return { success: true }
            }
            return { success: false, error: '安全验证未完成' }
          }

          if (paymentMode === 'auto_pay') {
            this.emitStatus('正在等待支付结果...')
            let paymentWindowShown = false
            for (let i = 0; i < 30; i++) {
              await humanDelay(2000)
              const win = this.windowManager.getShopWindow()
              if (!win || win.isDestroyed()) break
              const payUrl = win.webContents.getURL()

              if (payUrl.includes('payresult') || payUrl.includes('trade_success') || payUrl.includes('tradeDetail') || payUrl.includes('buyerPaySuccess')) {
                await this.cookieManager.syncCookiesFromElectron(this.getContext(), this.auth)
                await this.windowManager.closeShopWindow(async () => {
                  await this.cookieManager.syncCookiesFromElectron(this.getContext(), this.auth)
                })
                this.emitStatus('支付完成')
                return { success: true }
              }

              if (payUrl.includes('cashier') || payUrl.includes('alipay')) {
                if (!paymentWindowShown) {
                  paymentWindowShown = true
                  win.setSize(WINDOW_SIZES.CONFIRMATION.width, WINDOW_SIZES.CONFIRMATION.height)
                  win.setTitle('需要输入支付密码 - 需要手动操作')
                  const mainWindow = this.windowManager.getMainWindow()
                  if (mainWindow) win.setParentWindow(mainWindow)
                  injectOverlayBanner(win, '💳 自动支付已暂停：订单金额超过免密支付限额，支付宝需要您输入支付密码。请在下方输入密码完成支付，系统将自动检测支付结果')
                  injectCenterToast(win, "请输入支付密码完成支付")
                  win.show()
                }
                continue
              }

              try {
                const pageText = await win.webContents.executeJavaScript(`document.body?.innerText?.substring(0, 500) || ''`)
                if (KEYWORDS.PAY_SUCCESS.some(k => pageText.includes(k)) || pageText.includes('已付款') || pageText.includes('支付完成')) {
                  await this.cookieManager.syncCookiesFromElectron(this.getContext(), this.auth)
                  await this.windowManager.closeShopWindow(async () => {
                    await this.cookieManager.syncCookiesFromElectron(this.getContext(), this.auth)
                  })
                  this.emitStatus('支付完成')
                  return { success: true }
                }
                if (pageText.includes('支付失败') || pageText.includes('余额不足') || pageText.includes('交易关闭')) {
                  await this.windowManager.closeShopWindow(async () => {
                    await this.cookieManager.syncCookiesFromElectron(this.getContext(), this.auth)
                  })
                  return { success: false, error: '支付失败：' + pageText.substring(0, 50) }
                }
                if (!paymentWindowShown && (pageText.includes('请输入支付密码') || pageText.includes('请确认支付') || pageText.includes('收银台') || pageText.includes('确认付款'))) {
                  paymentWindowShown = true
                  win.setSize(WINDOW_SIZES.CONFIRMATION.width, WINDOW_SIZES.CONFIRMATION.height)
                  win.setTitle('需要输入支付密码 - 需要手动操作')
                  const mainWindow = this.windowManager.getMainWindow()
                  if (mainWindow) win.setParentWindow(mainWindow)
                  injectOverlayBanner(win, '💳 自动支付已暂停：订单金额超过免密支付限额，支付宝需要您输入支付密码。请在下方输入密码完成支付，系统将自动检测支付结果')
                  injectCenterToast(win, "请输入支付密码完成支付")
                  win.show()
                }
              } catch { /* ignore */ }
            }
            const finalWin = this.windowManager.getShopWindow()
            if (finalWin && !finalWin.isDestroyed()) {
              finalWin.setSize(WINDOW_SIZES.CONFIRMATION.width, WINDOW_SIZES.CONFIRMATION.height)
              finalWin.setTitle('支付结果确认 - 需要手动确认')
              const mainWindow = this.windowManager.getMainWindow()
              if (mainWindow) finalWin.setParentWindow(mainWindow)
              injectOverlayBanner(finalWin, '📋 自动支付超时：系统等待支付结果超过60秒未能自动检测到。请在下方确认是否已完成支付，然后点击"已完成"')
              injectCenterToast(finalWin, "请确认是否已完成支付")
              finalWin.show()
              const confirmed = await this.interactionService.waitForUserConfirmation(
                finalWin,
                '系统等待支付结果超过60秒未能自动检测到。请在弹出的窗口中确认是否已完成支付，然后点击"已完成"',
                '支付结果确认 - 需要手动确认',
                '📋 自动支付超时：系统等待支付结果超过60秒未能自动检测到。请在下方确认是否已完成支付，然后点击"已完成"',
                'payment',
              )
              if (confirmed) {
                await this.cookieManager.syncCookiesFromElectron(this.getContext(), this.auth)
                await this.windowManager.closeShopWindow(async () => {
                  await this.cookieManager.syncCookiesFromElectron(this.getContext(), this.auth)
                })
                this.emitStatus('支付完成')
                return { success: true }
              }
            }
            return { success: false, error: '支付未完成' }
          }

          currentShopWindow.setSize(WINDOW_SIZES.CONFIRMATION.width, WINDOW_SIZES.CONFIRMATION.height)
          currentShopWindow.setTitle('请完成支付 - 需要手动操作')
          const mainWindow = this.windowManager.getMainWindow()
          if (mainWindow) currentShopWindow.setParentWindow(mainWindow)
          injectOverlayBanner(currentShopWindow, '📋 订单已提交成功，当前支付模式为手动支付，请在下方完成支付后点击"已完成"')
          injectCenterToast(currentShopWindow, "请完成支付后点击已完成")
          currentShopWindow.show()

          const confirmed = await this.interactionService.waitForUserConfirmation(
            currentShopWindow,
            '订单已提交成功，当前支付模式为手动支付，需要您手动完成支付。请在弹出的窗口中完成支付，然后点击"已完成"',
            '请完成支付 - 需要手动操作',
            '📋 订单已提交成功，当前支付模式为手动支付，请在下方完成支付后点击"已完成"',
            'payment',
          )
          if (confirmed) {
            await this.cookieManager.syncCookiesFromElectron(this.getContext(), this.auth)
            await this.windowManager.closeShopWindow(async () => {
              await this.cookieManager.syncCookiesFromElectron(this.getContext(), this.auth)
            })
            this.emitStatus('支付完成')
            return { success: true }
          }
          return { success: false, error: '支付未完成' }
        }

        return { success: false, error: '支付窗口已关闭' }
      }

      await this.windowManager.closeShopWindow(async () => {
        await this.cookieManager.syncCookiesFromElectron(this.getContext(), this.auth)
      })
      return { success: false, error: '未找到支付按钮' }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  }

  async showPaymentWindow(title?: string, silent?: boolean): Promise<{ paid: boolean }> {
    const shopWindow = this.windowManager.getShopWindow()
    if (!shopWindow || shopWindow.isDestroyed()) return { paid: false }
    shopWindow.setSize(WINDOW_SIZES.CONFIRMATION.width, WINDOW_SIZES.CONFIRMATION.height)
    shopWindow.setTitle(title || '请完成支付')
    const mainWindow = this.windowManager.getMainWindow()
    if (mainWindow) {
      shopWindow.setParentWindow(mainWindow)
    }
    if (!silent) {
      injectOverlayBanner(shopWindow, title || '💰 请在页面中完成支付后关闭窗口')
      injectCenterToast(shopWindow, "请完成付款后关闭窗口")
    }
    shopWindow.show()

    let paymentDetected = false

    const paymentUrlHandler = () => {
      try {
        const url = this.windowManager.getShopWindow()?.webContents?.getURL() || ''
        if (url.includes('cashier') && url.includes('success')) {
          paymentDetected = true
        } else if (url.includes('payresult') && url.includes('success')) {
          paymentDetected = true
        } else if (url.includes('trade.tmall.com') && url.includes('paySuccess')) {
          paymentDetected = true
        } else if (url.includes('taobao.com') && url.includes('paySuccess')) {
          paymentDetected = true
        } else if (url.includes('alipay.com') && (url.includes('success') || url.includes('tradeNo'))) {
          paymentDetected = true
        }
      } catch { /* ignore */ }
    }

    const didNavigateHandler = () => {
      paymentUrlHandler()
    }

    shopWindow.webContents.on('did-navigate', didNavigateHandler)
    shopWindow.webContents.on('did-navigate-in-page', didNavigateHandler)

    await new Promise<void>((resolve) => {
      const checkClosed = setInterval(() => {
        const win = this.windowManager.getShopWindow()
        if (!win || win.isDestroyed()) {
          clearInterval(checkClosed)
          resolve()
        }
      }, 1000)
      shopWindow?.on('closed', () => {
        clearInterval(checkClosed)
        resolve()
      })
    })

    try {
      const win = this.windowManager.getShopWindow()
      win?.webContents?.removeListener('did-navigate', didNavigateHandler)
      win?.webContents?.removeListener('did-navigate-in-page', didNavigateHandler)
    } catch { /* ignore */ }

    return { paid: paymentDetected }
  }

  private async readAmountFromPage(shopWindow: BrowserWindow): Promise<number | undefined> {
    try {
      const priceStr = await shopWindow.webContents.executeJavaScript(`
        (function() {
          // 优先从价格元素读取
          var selectors = [
            '[class*="realPrice"]', '[class*="real-price"]',
            '[class*="totalPrice"]', '[class*="total-price"]',
            '[class*="payPrice"]', '[class*="pay-price"]',
            '[class*="amount"]', '[class*="Amount"]',
            '[class*="sumPrice"]', '[class*="sum-price"]',
            '[class*="orderPrice"]', '[class*="order-price"]',
          ];
          for (var i = 0; i < selectors.length; i++) {
            var els = document.querySelectorAll(selectors[i]);
            for (var j = 0; j < els.length; j++) {
              var text = (els[j].textContent || '').trim();
              var m = text.match(/¥?([\\d,]+\\.?\\d*)/);
              if (m) {
                var val = parseFloat(m[1].replace(/,/g, ''));
                if (val > 0 && val < 999999) return String(val);
              }
            }
          }
          // 从页面文本匹配
          var bodyText = document.body?.innerText || '';
          var patterns = [
            /实付[：:]\\s*¥?([\\d,]+\\.?\\d*)/,
            /应付[：:]\\s*¥?([\\d,]+\\.?\\d*)/,
            /合计[：:]\\s*¥?([\\d,]+\\.?\\d*)/,
            /总计[：:]\\s*¥?([\\d,]+\\.?\\d*)/,
            /付款[：:]\\s*¥?([\\d,]+\\.?\\d*)/,
          ];
          for (var k = 0; k < patterns.length; k++) {
            var pm = bodyText.match(patterns[k]);
            if (pm) {
              var pv = parseFloat(pm[1].replace(/,/g, ''));
              if (pv > 0 && pv < 999999) return String(pv);
            }
          }
          return null;
        })()
      `)
      if (priceStr) {
        const val = parseFloat(priceStr)
        if (!isNaN(val) && val > 0) {
          debugLog(`[Taobao-Payment] readAmountFromPage: ¥${val}`)
          return val
        }
      }
      debugLog('[Taobao-Payment] readAmountFromPage: no price found')
      return undefined
    } catch (e) {
      debugLog(`[Taobao-Payment] readAmountFromPage error: ${e}`)
      return undefined
    }
  }

}
