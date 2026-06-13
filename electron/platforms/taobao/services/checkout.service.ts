import { BrowserWindow } from 'electron'
import type { Page, BrowserContext } from 'playwright'
import type { CheckoutResult } from '../../../../shared/types/platform.types'
import { BrowserManager } from '../infrastructure/browser-manager'
import { WindowManager } from '../infrastructure/window-manager'
import { CookieManager } from '../infrastructure/cookie-manager'
import { VerificationService } from './verification.service'
import { TaobaoAuth } from '../taobao.auth'
import { debugLog, humanDelay, execJS, clickInShopWindow } from '../utils/page-helper'
import { TIMEOUTS, KEYWORDS } from '../utils/constants'
import { isBuyPage, isLoginPage, isCartPage } from '../utils/url-helper'
import { TAOBAO_SELECTORS } from '../taobao.selectors'
import { HUMAN_SIM_JS } from '../utils/human-sim'

export class CheckoutService {
  private browserManager: BrowserManager
  private windowManager: WindowManager
  private cookieManager: CookieManager
  private auth: TaobaoAuth
  private emitStatus: (status: string) => void
  private getContext: () => BrowserContext | null
  private getPage: () => Page | null

  constructor(
    browserManager: BrowserManager,
    windowManager: WindowManager,
    cookieManager: CookieManager,
    _verificationService: VerificationService,
    auth: TaobaoAuth,
    emitStatus: (status: string) => void,
    getContext: () => BrowserContext | null,
    getPage: () => Page | null,
    _setPage: (page: Page) => void,
    _isDestroyed: () => boolean
  ) {
    this.browserManager = browserManager
    this.windowManager = windowManager
    this.cookieManager = cookieManager
    this.auth = auth
    this.emitStatus = emitStatus
    this.getContext = getContext
    this.getPage = getPage
  }

  async checkout(directToPay = false, quantity = 1): Promise<CheckoutResult> {
    this.emitStatus('正在结算...')
    debugLog(`[Taobao-Checkout] checkout called: directToPay=${directToPay}, quantity=${quantity}`)

    try {
      const shopWindow = this.windowManager.getShopWindow()
      if (shopWindow && !shopWindow.isDestroyed()) {
        return await this.checkoutViaElectron(directToPay, quantity)
      }

      debugLog('[Taobao-Checkout] fallback to browser context (no Electron shopWindow)')
      await this.browserManager.ensureBrowser(this.auth, this.cookieManager, this.emitStatus)
      if (!this.getPage()) return { success: false, error: '浏览器未初始化' }

      const currentUrl = this.getPage()!.url()
      if (isLoginPage(currentUrl)) {
        debugLog('[Taobao-Checkout] login required on page')
        return { success: false, error: '登录已过期，请重新登录' }
      }

      if (directToPay || isBuyPage(currentUrl)) {
        debugLog(`[Taobao-Checkout] already on buy page: ${currentUrl}, submitting order`)
        return await this.submitOrder()
      }

      if (!isCartPage(currentUrl)) {
        this.emitStatus('正在跳转购物车...')
        debugLog(`[Taobao-Checkout] navigating to cart: ${TAOBAO_SELECTORS.CART.URL}`)
        await this.getPage()!.goto(TAOBAO_SELECTORS.CART.URL, { waitUntil: 'domcontentloaded', timeout: TIMEOUTS.PAGE_LOAD })
      }

      await humanDelay(2000)

      if (isLoginPage(this.getPage()!.url())) {
        debugLog('[Taobao-Checkout] login required after cart load')
        return { success: false, error: '登录已过期，请重新登录' }
      }

      const checkoutClicked = await this.clickButtonByTextOrSelector(
        TAOBAO_SELECTORS.CART.CHECKOUT_SELECTORS as unknown as string[],
        ['结算', '去结算', '去购物车结算', '去支付']
      )
      debugLog(`[Taobao-Checkout] checkoutClicked: ${JSON.stringify(checkoutClicked)}`)

      if (!checkoutClicked.clicked) {
        return { success: false, error: '未找到结算按钮' }
      }

      this.emitStatus('正在提交订单...')
      await humanDelay(3000)

      const afterUrl = this.getPage()!.url()
      if (isBuyPage(afterUrl)) {
        return await this.submitOrder()
      }

      return { success: true }
    } catch (e: unknown) {
      debugLog(`[Taobao-Checkout] checkout error: ${e}`)
      return { success: false, error: String(e) }
    }
  }

  private async checkoutViaElectron(directToPay: boolean, quantity: number): Promise<CheckoutResult> {
    const shopWindow = this.windowManager.getShopWindow()
    if (!shopWindow || shopWindow.isDestroyed()) {
      debugLog('[Taobao-Checkout] checkoutViaElectron failed: shopWindow is null or destroyed')
      return { success: false, error: '购物窗口已关闭' }
    }

    const wc = shopWindow.webContents
    const currentUrl = wc.getURL()
    debugLog(`[Taobao-Checkout] checkoutViaElectron started: url=${currentUrl}, directToPay=${directToPay}`)
    if (isLoginPage(currentUrl)) {
      debugLog('[Taobao-Checkout] login required inside electron shopWindow')
      await this.closeShopWindow()
      return { success: false, error: '登录已过期，请重新登录' }
    }

    if (directToPay || isBuyPage(currentUrl)) {
      this.emitStatus('正在等待确认订单页面加载...')
      debugLog('[Taobao-Checkout] directToPay is true or currently on buy page, waiting for checkout page')
      return await this.waitForCheckoutPage(quantity)
    }

    if (!isCartPage(currentUrl)) {
      this.emitStatus('正在跳转购物车...')
      debugLog(`[Taobao-Checkout] loading cart page url: ${TAOBAO_SELECTORS.CART.URL}`)
      await wc.loadURL(TAOBAO_SELECTORS.CART.URL)
      await humanDelay(3000)

      if (isLoginPage(wc.getURL())) {
        debugLog('[Taobao-Checkout] login required after cart page load')
        await this.closeShopWindow()
        return { success: false, error: '登录已过期，请重新登录' }
      }
    }

    this.emitStatus('正在结算...')
    debugLog('[Taobao-Checkout] clicking checkout button in cart page')
    const checkoutResult = await clickInShopWindow(
      shopWindow,
      TAOBAO_SELECTORS.CART.CHECKOUT_SELECTORS as unknown as string[],
      ['结算', '去结算', '去购物车结算', '去支付']
    )
    debugLog(`[Taobao-Checkout] checkout click result: ${JSON.stringify(checkoutResult)}`)

    if (!checkoutResult.clicked) {
      await this.closeShopWindow()
      return { success: false, error: '未找到结算按钮' }
    }

    this.emitStatus('正在等待确认订单页面加载...')
    return await this.waitForCheckoutPage(quantity)
  }

  private async waitForCheckoutPage(quantity = 1): Promise<CheckoutResult> {
    debugLog(`[Taobao-Checkout] waitForCheckoutPage started: quantity=${quantity}`)
    for (let attempt = 0; attempt < 15; attempt++) {
      const delay = attempt === 0 ? 500 : 1500
      await humanDelay(delay)

      const shopWindow = this.windowManager.getShopWindow()
      if (!shopWindow || shopWindow.isDestroyed()) {
        debugLog('[Taobao-Checkout] waitForCheckoutPage failed: shopWindow is null or destroyed')
        return { success: false, error: '购物窗口已关闭' }
      }

      try {
        const diag = await shopWindow.webContents.executeJavaScript(`
          (function() {
            var buttons = [];
            document.querySelectorAll('button, a, [role="button"], span, div, input[type="submit"]').forEach(function(el) {
              var text = (el.textContent || el.value || '').trim();
              if (!text || text.length > 50) return;
              var rect = el.getBoundingClientRect();
              if (rect.width <= 0 || rect.height <= 0) return;
              buttons.push({ tag: el.tagName, text: text.substring(0, 40), cls: (el.className || '').substring(0, 60) });
            });
            return { url: location.href, buttons: buttons, bodyLen: (document.body?.innerText || '').length };
          })()
        `)
        const hasPayButton = diag.buttons.some((b: { text: string }) => {
          const t = b.text.replace(/\s+/g, '')
          return t.includes('免密支付') || t.includes('立即支付') || t.includes('提交订单') || t.includes('去支付') || t.includes('立即付款')
        })

        debugLog(`[Taobao-Checkout] waitForCheckoutPage attempt=${attempt}, url=${diag.url}, bodyLen=${diag.bodyLen}, hasPayButton=${hasPayButton}`)

        if (diag.bodyLen > 100 && hasPayButton) {
          if (quantity > 1) {
            debugLog(`[Taobao-Checkout] quantity is ${quantity}, setting quantity...`)
            await this.setQuantity(quantity)
          }
          const currentPrice = await this.extractCheckoutPrice(shopWindow)
          this.emitStatus('已到达确认订单页面')
          debugLog(`[Taobao-Checkout] arrived checkout page! currentPrice=${currentPrice}`)
          return { success: true, currentPrice }
        }
      } catch (e: unknown) {
        debugLog(`[Taobao-Checkout] waitForCheckoutPage evaluation error: ${e}`)
      }
    }

    debugLog('[Taobao-Checkout] checkout page load timeout')
    await this.closeShopWindow()
    return { success: false, error: '确认订单页面加载超时' }
  }

  private async setQuantity(quantity: number): Promise<void> {
    const shopWindow = this.windowManager.getShopWindow()
    if (!shopWindow || shopWindow.isDestroyed()) return

    this.emitStatus(`正在修改数量为 ${quantity}...`)
    try {
      const result = await execJS(shopWindow, `
        (function() {
          var quantity = ${quantity};
          var inputs = document.querySelectorAll('input[type="text"], input[type="number"], input:not([type])');
          for (var i = 0; i < inputs.length; i++) {
            var input = inputs[i];
            var rect = input.getBoundingClientRect();
            if (rect.width <= 0 || rect.height <= 0) continue;
            var parent = input.closest('[class*="quantity"], [class*="amount"], [class*="qty"], [class*="count"], [class*="num"]');
            var sibling = input.parentElement;
            var nearMinus = sibling && (sibling.querySelector('[class*="minus"]') || sibling.querySelector('[class*="decrease"]'));
            var nearPlus = sibling && (sibling.querySelector('[class*="plus"]') || sibling.querySelector('[class*="increase"]') || sibling.querySelector('[class*="add"]'));
            if (parent || nearMinus || nearPlus) {
              var nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
              nativeInputValueSetter.call(input, String(quantity));
              input.dispatchEvent(new Event('input', { bubbles: true }));
              input.dispatchEvent(new Event('change', { bubbles: true }));
              return { found: true, method: 'input', oldValue: input.defaultValue };
            }
          }
          var minusBtns = document.querySelectorAll('[class*="minus"], [class*="decrease"], [class*="reduce"]');
          var plusBtns = document.querySelectorAll('[class*="plus"], [class*="increase"], [class*="add"]');
          if (plusBtns.length > 0 && minusBtns.length > 0) {
            var currentQty = 1;
            for (var j = 0; j < quantity - 1 && j < 20; j++) {
              _hs.click(plusBtns[0]);
              currentQty++;
            }
            return { found: true, method: 'plus_click', clicked: quantity - 1 };
          }
          return { found: false };
        })()
      `)
      if (result?.found) {
        await humanDelay(1000)
      }
    } catch (e: unknown) {
    }
  }

  private async submitOrder(): Promise<CheckoutResult> {
    const page = this.getPage()
    await page!.evaluate(() => {
      const buttons: { tag: string; text: string; cls: string; id: string }[] = []
      document.querySelectorAll('button, a, [role="button"], [onclick], [class*="btn"], [class*="submit"], [class*="go"], [class*="pay"]').forEach(el => {
        const text = (el.textContent || '').trim().substring(0, 40)
        if (!text) return
        buttons.push({
          tag: el.tagName,
          text,
          cls: (el as HTMLElement).className?.substring?.(0, 80) || '',
          id: (el as HTMLElement).id || '',
        })
      })
      return { url: location.href, buttons }
    })
    const orderClicked = await this.clickButtonByTextOrSelector(
      TAOBAO_SELECTORS.CHECKOUT.SUBMIT_ORDER_SELECTORS as unknown as string[],
      ['提交订单', '确认订单', '提交', '去支付', '立即支付', '立即付款', '免密支付']
    )

    if (orderClicked.clicked) {
      await humanDelay(2000)
      this.emitStatus('订单已提交')
      return { success: true }
    }

    return { success: false, error: '未找到提交订单按钮' }
  }

  private async clickButtonByTextOrSelector(selectors: string[], textTargets: string[]): Promise<{ clicked: boolean; selector?: string; text?: string }> {
    const page = this.getPage()
    if (!page) return { clicked: false }

    if (isLoginPage(page.url())) {
      return { clicked: false }
    }

    for (const frame of page.frames()) {
      try {
        const frameUrl = frame.url()
        if (isLoginPage(frameUrl)) continue

        await frame.evaluate(HUMAN_SIM_JS).catch(() => {})
        const locateResult = await frame.evaluate((args: { selectors: string[]; textTargets: string[]; loginKeywords: string[] }) => {
          const loginKeywords = [...args.loginKeywords, '快速进入', '密码登录', '短信登录']
          for (const sel of args.selectors) {
            try {
              const el = document.querySelector(sel) as HTMLElement | null
              if (el) {
                const elText = (el.textContent || '').trim()
                if (loginKeywords.some(k => elText.includes(k))) continue
                const rect = el.getBoundingClientRect()
                if (rect.width > 0 && rect.height > 0) {
                  return { found: true, selector: sel, text: elText.substring(0, 30) }
                }
              }
            } catch { /* ignore */ }
          }

          for (const el of document.querySelectorAll('button, a, [role="button"], span, div, input[type="submit"]')) {
            const text = (el.textContent || (el as HTMLInputElement).value || '').trim()
            if (!text) continue
            const normalized = text.replace(/\s+/g, '')
            if (loginKeywords.some(k => normalized.includes(k))) continue
            if (args.textTargets.some(t => normalized.includes(t))) {
              const rect = el.getBoundingClientRect()
              if (rect.width > 0 && rect.height > 0) {
                return { found: true, selector: `text:${text.substring(0, 20)}`, text: text.substring(0, 30) }
              }
            }
          }

          return { found: false }
        }, { selectors, textTargets, loginKeywords: [...KEYWORDS.LOGIN] })

        if (locateResult.found && locateResult.selector) {
          try {
            const selector = locateResult.selector.startsWith('text:')
              ? locateResult.selector.replace('text:', '').trim()
              : locateResult.selector
            const locator = frame.locator(selector).first()
            if (await locator.isVisible({ timeout: 2000 })) {
              await locator.click({ timeout: 3000 })
              return { clicked: true, selector: locateResult.selector, text: locateResult.text }
            }
          } catch (e: unknown) {
          }
        }
      } catch (e: unknown) {
      }
    }

    return { clicked: false }
  }

  private async extractCheckoutPrice(shopWindow: BrowserWindow): Promise<number | undefined> {
    try {
      const priceStr = await shopWindow.webContents.executeJavaScript(`
        (function() {
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
        return parseFloat(priceStr)
      }
    } catch (e: unknown) {
    }
    return undefined
  }

  private async closeShopWindow() {
    const shopWindow = this.windowManager.getShopWindow()
    if (shopWindow && !shopWindow.isDestroyed()) {
      try {
        await this.cookieManager.syncCookiesFromElectron(this.getContext(), this.auth)
      } catch { /* ignore */ }
      shopWindow.close()
    }
    this.windowManager.setShopWindow(null)
  }
}
