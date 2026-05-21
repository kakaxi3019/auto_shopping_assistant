import { chromium, type Browser, type BrowserContext, type Page } from 'playwright'
import { getChromiumPath } from '../utils/page-helper'
import { CHROME_UA } from '../utils/constants'
import { HUMAN_SIM_JS } from '../utils/human-sim'
import { ANTI_DETECT_JS } from '../utils/anti-detect'
import type { TaobaoAuth } from '../taobao.auth'
import type { CookieManager } from './cookie-manager'

export class BrowserManager {
  private browser: Browser | null = null
  private context: BrowserContext | null = null
  private page: Page | null = null

  async ensureBrowser(
    auth: TaobaoAuth,
    cookieManager: CookieManager,
    emitStatus: (s: string) => void
  ): Promise<BrowserContext> {
    if (this.browser && !this.browser.isConnected()) {
      this.cleanup()
    }

    if (!this.browser) {
      emitStatus('正在启动自动化引擎...')
      const executablePath = getChromiumPath()
      this.browser = await chromium.launch({
        headless: true,
        executablePath,
        args: [
          '--disable-blink-features=AutomationControlled',
          '--disable-gpu',
          '--no-sandbox',
          '--disable-infobars',
          '--window-size=1280,800',
        ],
      })

      this.browser.on('disconnected', () => {
        this.cleanup()
      })

      this.context = await this.browser.newContext({
        userAgent: CHROME_UA,
        viewport: { width: 1280, height: 800 },
        locale: 'zh-CN',
        timezoneId: 'Asia/Shanghai',
      })

      await this.context.addInitScript(HUMAN_SIM_JS)
      await this.context.addInitScript(ANTI_DETECT_JS)

      await auth.loadCookies(this.context)

      const currentCookies = await this.context.cookies()
      const hasLoginCookie = currentCookies.some(c =>
        (c.name === 'cookie2' || c.name === 'sgcookie' || c.name === '_tb_token_') &&
        c.domain.includes('taobao')
      )
      if (!hasLoginCookie) {
        console.log('[Taobao] Warning: No login cookies found in Playwright context after loading, may trigger verification')
      }

      cookieManager.resetToElectronSyncTimer()
      await cookieManager.syncCookiesToElectron(this.context, auth)

      this.page = await this.context.newPage()
      emitStatus('自动化引擎已就绪')
    }

    return this.context!
  }

  getContext(): BrowserContext | null {
    return this.context
  }

  getPage(): Page | null {
    return this.page
  }

  setPage(page: Page) {
    this.page = page
  }

  getBrowser(): Browser | null {
    return this.browser
  }

  cleanup() {
    this.page = null
    this.context = null
    this.browser = null
  }

  async close() {
    try { await this.context?.close() } catch { /* ignore */ }
    try { await this.browser?.close() } catch { /* ignore */ }
    this.cleanup()
  }
}
