import { BrowserWindow, dialog } from 'electron'
import type { Page, BrowserContext } from 'playwright'
import { isCheckoutOrPayPage, isBuyPage, isCartPage } from '../utils/url-helper'
import type { CookieManager } from '../infrastructure/cookie-manager'
import type { WindowManager } from '../infrastructure/window-manager'
import type { TaobaoAuth } from '../taobao.auth'
import { setUserAgent, humanDelay } from '../utils/page-helper'
import { APP_ICON, TIMEOUTS, WINDOW_SIZES, TAOBAO_PRELOAD } from '../utils/constants'
import { tryAutoLoginThenShow } from '../utils/window-helper'
import type { AddToCartResult } from '../../../../shared/types/platform.types'

export class VerificationService {
  private windowManager: WindowManager
  private cookieManager: CookieManager
  private auth: TaobaoAuth
  private emitStatus: (status: string) => void
  private getContext: () => BrowserContext | null
  private getPage: () => Page | null
  private setPage: (page: Page) => void
  private isDestroyed: () => boolean

  constructor(
    windowManager: WindowManager,
    cookieManager: CookieManager,
    auth: TaobaoAuth,
    emitStatus: (status: string) => void,
    getContext: () => BrowserContext | null,
    getPage: () => Page | null,
    setPage: (page: Page) => void,
    isDestroyed: () => boolean
  ) {
    this.windowManager = windowManager
    this.cookieManager = cookieManager
    this.auth = auth
    this.emitStatus = emitStatus
    this.getContext = getContext
    this.getPage = getPage
    this.setPage = setPage
    this.isDestroyed = isDestroyed
  }

  async detectCaptcha(win: BrowserWindow): Promise<boolean> {
    try {
      const result = await win.webContents.executeJavaScript(`
        (function() {
          var captchaSelectors = [
            '#nc_1_wrapper', '#nc_1__scale_text', '#nocaptcha',
            '[class*="nc-container"]', '[class*="nc_wrapper"]',
            '[class*="slider"]', '[class*="captcha"]',
            '#baxia-dialog-content', '[class*="baxia"]',
            'iframe[src*="nocaptcha"]', 'iframe[src*="captcha"]',
            'iframe[src*="slider"]'
          ];
          for (var i = 0; i < captchaSelectors.length; i++) {
            var el = document.querySelector(captchaSelectors[i]);
            if (el) {
              var rect = el.getBoundingClientRect();
              if (rect.width > 0 && rect.height > 0) return true;
            }
          }
          var iframes = document.querySelectorAll('iframe');
          for (var j = 0; j < iframes.length; j++) {
            var src = iframes[j].src || '';
            if (src.includes('nocaptcha') || src.includes('captcha') || src.includes('slider') || src.includes('baxia')) {
              return true;
            }
          }
          var bodyText = (document.body?.innerText || '').substring(0, 2000);
          var captchaHints = ['请拖动滑块', '拖动滑块', '请完成验证', '安全验证', '滑动验证', '请按住滑块'];
          for (var k = 0; k < captchaHints.length; k++) {
            if (bodyText.includes(captchaHints[k])) return true;
          }
          return false;
        })()
      `)
      return !!result
    } catch {
      return false
    }
  }

  async tryAutoLoginThenShow(win: BrowserWindow): Promise<void> {
    await tryAutoLoginThenShow(win, this.cookieManager, this.windowManager, this.auth, this.emitStatus, this.getContext())
  }

  async handleIdentityVerification(verifyPage: Page): Promise<AddToCartResult | null> {
    this.emitStatus('需要进行身份验证，请在弹出的窗口中完成验证...')

    await this.cookieManager.syncCookiesToElectron(this.getContext(), this.auth)

    const mainWindow = this.windowManager.getMainWindow()
    if (mainWindow) {
      await dialog.showMessageBox(mainWindow, {
        type: 'info',
        title: '需要身份验证',
        message: '淘宝要求进行身份验证',
        detail: '点击"再买一单"后，淘宝需要进行身份验证才能继续。\n\n即将打开验证页面，请完成验证（扫码或输入验证码）。\n验证完成后将自动继续购买流程。',
        buttons: ['知道了'],
        noLink: true,
      })
    }

    const verifyUrl = verifyPage.url()

    return new Promise<AddToCartResult | null>((resolve) => {
      if (!mainWindow) {
        resolve(null)
        return
      }

      const verifyWindow = new BrowserWindow({
        width: WINDOW_SIZES.SMALL.width,
        height: WINDOW_SIZES.SMALL.height,
        title: '淘宝身份验证',
        icon: APP_ICON,
        parent: mainWindow,
        modal: true,
        autoHideMenuBar: true,
        webPreferences: {
          nodeIntegration: false,
          contextIsolation: true,
          sandbox: true,
          backgroundThrottling: false,
          preload: TAOBAO_PRELOAD,
        },
      })
      setUserAgent(verifyWindow)
      verifyWindow.loadURL(verifyUrl)

      let resolved = false
      const timeout = setTimeout(() => {
        if (!resolved) {
          resolved = true
          if (!verifyWindow.isDestroyed()) verifyWindow.close()
          this.emitStatus('身份验证超时')
          resolve({ success: false, error: '身份验证超时' })
        }
      }, TIMEOUTS.OPERATION)

      const checkInterval = setInterval(async () => {
        if (resolved || this.isDestroyed()) { clearInterval(checkInterval); return }
        try {
          const winUrl = verifyWindow.webContents.getURL()
          if (isBuyPage(winUrl) || isCartPage(winUrl)) {
            resolved = true
            clearTimeout(timeout)
            clearInterval(checkInterval)
            await this.cookieManager.syncCookiesFromElectron(this.getContext(), this.auth)
            if (!verifyWindow.isDestroyed()) verifyWindow.close()

            const directToPay = isCheckoutOrPayPage(winUrl)
            this.emitStatus(directToPay ? '验证成功，已进入结算页面' : '验证成功，已加入购物车')
            resolve({ success: true, directToPay })
          }
        } catch { /* ignore */ }
      }, 2000)

      verifyWindow.on('closed', async () => {
        if (!resolved) {
          resolved = true
          clearTimeout(timeout)
          clearInterval(checkInterval)
          await this.cookieManager.syncCookiesFromElectron(this.getContext(), this.auth)

          try {
            await humanDelay(3000)
            const context = this.getContext()
            if (context) {
              const allPages = context.pages()
              for (const p of allPages) {
                const pUrl = p.url()
                if (isCheckoutOrPayPage(pUrl)) {
                  this.setPage(p)
                  this.emitStatus('验证成功，已进入结算页面')
                  resolve({ success: true, directToPay: true })
                  return
                }
                if (isCartPage(pUrl)) {
                  this.setPage(p)
                  this.emitStatus('验证成功，已加入购物车')
                  resolve({ success: true, directToPay: false })
                  return
                }
              }
            }

            const page = this.getPage()
            if (page) {
              const mainUrl = page.url()
              if (isCheckoutOrPayPage(mainUrl)) {
                this.emitStatus('验证成功，已进入结算页面')
                resolve({ success: true, directToPay: true })
                return
              }
            }
          } catch { /* ignore */ }

          this.emitStatus('用户关闭了验证窗口')
          resolve({ success: false, error: '用户取消了身份验证' })
        }
      })
    })
  }
}
