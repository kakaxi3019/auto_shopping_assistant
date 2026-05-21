import { BrowserWindow } from 'electron'
import type { Page, BrowserContext } from 'playwright'
import type { CheckoutResult } from '../../../shared/types/platform.types'
import { BrowserManager } from '../infrastructure/browser-manager'
import { WindowManager } from '../infrastructure/window-manager'
import { CookieManager } from '../infrastructure/cookie-manager'
import { VerificationService } from './verification.service'
import { TaobaoAuth } from '../taobao.auth'
import { setUserAgent, debugLog, humanDelay, humanClickAt, humanClickElement, execJS, injectOverlayBanner, rand } from '../utils/page-helper'
import { APP_ICON } from '../utils/constants'
import { isCheckoutOrPayPage, isLoginPage } from '../utils/url-helper'
import { TAOBAO_SELECTORS } from '../taobao.selectors'
import { HUMAN_SIM_JS } from '../utils/human-sim'

export class CheckoutService {
  private browserManager: BrowserManager
  private windowManager: WindowManager
  private cookieManager: CookieManager
  private verificationService: VerificationService
  private auth: TaobaoAuth
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
    auth: TaobaoAuth,
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
    this.auth = auth
    this.emitStatus = emitStatus
    this.getContext = getContext
    this.getPage = getPage
    this.setPage = setPage
    this.isDestroyed = isDestroyed
  }

  async checkout(directToPay = false, quantity = 1): Promise<CheckoutResult> {
    this.emitStatus('正在结算...')

    try {
      const shopWindow = this.windowManager.getShopWindow()
      if (shopWindow && !shopWindow.isDestroyed()) {
        console.log(`[Taobao] checkout: using existing shopWindow, quantity=${quantity}`)
        return await this.checkoutViaElectron(directToPay, quantity)
      }

      await this.browserManager.ensureBrowser(this.auth, this.cookieManager, this.emitStatus)
      if (!this.getPage()) return { success: false, error: '浏览器未初始化' }

      const currentUrl = this.getPage()!.url()
      console.log(`[Taobao] checkout: currentUrl=${currentUrl}, directToPay=${directToPay}`)

      if (isLoginPage(currentUrl)) {
        return { success: false, error: '登录已过期，请重新登录' }
      }

      if (directToPay || isCheckoutOrPayPage(currentUrl)) {
        console.log(`[Taobao] Already on checkout/pay page, submitting order directly`)
        return await this.submitOrder()
      }

      if (!currentUrl.includes('cart.taobao.com')) {
        this.emitStatus('正在跳转购物车...')
        await this.getPage()!.goto(TAOBAO_SELECTORS.CART.URL, { waitUntil: 'domcontentloaded', timeout: 30000 })
      }

      await humanDelay(2000)

      if (isLoginPage(this.getPage()!.url())) {
        return { success: false, error: '登录已过期，请重新登录' }
      }

      const checkoutClicked = await this.clickButtonByTextOrSelector(
        TAOBAO_SELECTORS.CART.CHECKOUT_SELECTORS as unknown as string[],
        ['结算', '去结算', '去购物车结算', '去支付']
      )

      console.log(`[Taobao] Checkout button click result:`, JSON.stringify(checkoutClicked))

      if (!checkoutClicked.clicked) {
        return { success: false, error: '未找到结算按钮' }
      }

      this.emitStatus('正在提交订单...')
      await humanDelay(3000)

      const afterUrl = this.getPage()!.url()
      if (isCheckoutOrPayPage(afterUrl)) {
        return await this.submitOrder()
      }

      return { success: true }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  }

  private async checkoutViaElectron(directToPay: boolean, quantity: number): Promise<CheckoutResult> {
    const shopWindow = this.windowManager.getShopWindow()
    if (!shopWindow || shopWindow.isDestroyed()) {
      return { success: false, error: '购物窗口已关闭' }
    }

    const wc = shopWindow.webContents
    const currentUrl = wc.getURL()
    console.log(`[Taobao] checkoutViaElectron: currentUrl=${currentUrl}, directToPay=${directToPay}, quantity=${quantity}`)

    if (isLoginPage(currentUrl)) {
      await this.closeShopWindow()
      return { success: false, error: '登录已过期，请重新登录' }
    }

    if (directToPay || isCheckoutOrPayPage(currentUrl)) {
      this.emitStatus('已到达确认订单页面')
      return { success: true }
    }

    if (!currentUrl.includes('cart.taobao.com')) {
      this.emitStatus('正在跳转购物车...')
      await wc.loadURL(TAOBAO_SELECTORS.CART.URL)
      await humanDelay(3000)

      if (isLoginPage(wc.getURL())) {
        await this.closeShopWindow()
        return { success: false, error: '登录已过期，请重新登录' }
      }
    }

    this.emitStatus('正在结算...')
    const checkoutResult = await this.clickInShopWindow(
      TAOBAO_SELECTORS.CART.CHECKOUT_SELECTORS as unknown as string[],
      ['结算', '去结算', '去购物车结算', '去支付']
    )

    console.log(`[Taobao] Electron checkout click result:`, JSON.stringify(checkoutResult))

    if (!checkoutResult.clicked) {
      await this.closeShopWindow()
      return { success: false, error: '未找到结算按钮' }
    }

    this.emitStatus('正在等待确认订单页面加载...')
    return await this.waitForCheckoutPage(quantity)
  }

  private async waitForCheckoutPage(quantity = 1): Promise<CheckoutResult> {
    for (let attempt = 0; attempt < 15; attempt++) {
      const delay = attempt === 0 ? 500 : 1500
      await humanDelay(delay)

      const shopWindow = this.windowManager.getShopWindow()
      if (!shopWindow || shopWindow.isDestroyed()) {
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
        console.log(`[Taobao] waitForCheckoutPage attempt ${attempt + 1}: url=${diag.url}, bodyLen=${diag.bodyLen}, buttons=${diag.buttons.length}`)
        for (const b of diag.buttons) {
          console.log(`  ${b.tag} "${b.text}" cls="${b.cls}"`)
        }

        const hasPayButton = diag.buttons.some((b: { text: string }) => {
          const t = b.text.replace(/\s+/g, '')
          return t.includes('免密支付') || t.includes('立即支付') || t.includes('提交订单') || t.includes('去支付') || t.includes('立即付款')
        })

        if (diag.bodyLen > 100 && hasPayButton) {
          if (quantity > 1) {
            await this.setQuantity(quantity)
          }
          const currentPrice = await this.extractCheckoutPrice(shopWindow)
          this.emitStatus('已到达确认订单页面')
          return { success: true, currentPrice }
        }
      } catch (e) {
        console.log(`[Taobao] waitForCheckoutPage error: ${e}`)
      }
    }

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
      console.log(`[Taobao] setQuantity result:`, JSON.stringify(result))
      if (result?.found) {
        await humanDelay(1000)
      }
    } catch (e) {
      console.log(`[Taobao] setQuantity error: ${e}`)
    }
  }

  private async clickInShopWindow(selectors: string[], textTargets: string[]): Promise<{ clicked: boolean; selector?: string; text?: string }> {
    const shopWindow = this.windowManager.getShopWindow()
    if (!shopWindow || shopWindow.isDestroyed()) return { clicked: false }

    try {
      const result = await humanClickElement(shopWindow, selectors, textTargets)
      if (result.clicked) {
        return { clicked: true, selector: 'humanClick', text: result.text?.substring(0, 30) }
      }

      const fallbackResult = await execJS(shopWindow, `
        (function(args) {
          var loginKeywords = ['登录', '注册', '扫码', '快速进入', '密码登录', '短信登录'];
          var allEls = document.querySelectorAll('button, a, [role="button"], span, div, input[type="submit"]');
          for (var j = 0; j < allEls.length; j++) {
            var el = allEls[j];
            var text = (el.textContent || el.value || '').trim();
            if (!text) continue;
            var normalized = text.replace(/\\s+/g, '');
            var isLogin = loginKeywords.some(function(k) { return normalized.includes(k); });
            if (isLogin) continue;
            var isMatch = args.textTargets.some(function(t) { return normalized.includes(t); });
            if (isMatch) {
              var rect = el.getBoundingClientRect();
              if (rect.width > 0 && rect.height > 0) {
                var x = rect.left + rect.width * (0.3 + Math.random() * 0.4);
                var y = rect.top + rect.height * (0.3 + Math.random() * 0.4);
                return { clicked: true, text: text.substring(0, 30), x: Math.round(x), y: Math.round(y) };
              }
            }
          }
          return { clicked: false };
        })(${JSON.stringify({ selectors, textTargets })})
      `)
      if (fallbackResult && fallbackResult.clicked && fallbackResult.x !== undefined) {
        await humanClickAt(shopWindow, fallbackResult.x, fallbackResult.y)
        return { clicked: true, selector: 'text:' + (fallbackResult.text || '').substring(0, 20), text: fallbackResult.text?.substring(0, 30) }
      }
      return { clicked: false }
    } catch (e) {
      console.log(`[Taobao] clickInShopWindow error: ${e}`)
      return { clicked: false }
    }
  }

  private async submitOrder(): Promise<CheckoutResult> {
    const page = this.getPage()
    const orderDiag = await page!.evaluate(() => {
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
    console.log(`[Taobao] Order page: ${orderDiag.url}`)
    console.log(`[Taobao] Order buttons (${orderDiag.buttons.length}):`)
    for (const b of orderDiag.buttons) {
      console.log(`  ${b.tag} "${b.text}" cls="${b.cls}" id="${b.id}"`)
    }

    const orderClicked = await this.clickButtonByTextOrSelector(
      TAOBAO_SELECTORS.CHECKOUT.SUBMIT_ORDER_SELECTORS as unknown as string[],
      ['提交订单', '确认订单', '提交', '去支付', '立即支付', '立即付款', '免密支付']
    )

    console.log(`[Taobao] Submit order click result:`, JSON.stringify(orderClicked))

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
      console.log(`[Taobao] clickButtonByTextOrSelector: on login page, skipping`)
      return { clicked: false }
    }

    for (const frame of page.frames()) {
      try {
        const frameUrl = frame.url()
        if (isLoginPage(frameUrl)) continue

        await frame.evaluate(HUMAN_SIM_JS).catch(() => {})
        const locateResult = await frame.evaluate((args: { selectors: string[]; textTargets: string[] }) => {
          const loginKeywords = ['登录', '注册', '扫码', '快速进入', '密码登录', '短信登录']
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
        }, { selectors, textTargets })

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
          } catch (e) {
            console.log(`[Taobao] Playwright click failed for selector "${locateResult.selector}": ${e}`)
          }
        }
      } catch (e) {
        console.log(`[Taobao] clickButtonByTextOrSelector frame error: ${e}`)
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
        const price = parseFloat(priceStr)
        console.log(`[Taobao] extractCheckoutPrice: ${price}`)
        return price
      }
    } catch (e) {
      console.log(`[Taobao] extractCheckoutPrice error: ${e}`)
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
