import { chromium, type Browser, type BrowserContext, type Page, type CDPSession } from 'playwright'
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
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null
  private cdpSession: CDPSession | null = null
  private screencastActive: boolean = false
  private onFrameCallback: ((base64Jpeg: string) => void) | null = null
  private static readonly HEARTBEAT_INTERVAL = 5 * 60 * 1000
  private static readonly HEARTBEAT_URL = 'https://www.taobao.com'

  async ensureBrowser(
    auth: TaobaoAuth,
    cookieManager: CookieManager,
    emitStatus: (s: string) => void
  ): Promise<BrowserContext> {
    if (this.browser && !this.browser.isConnected()) {
      this.cleanup()
    }

    if (!this.browser) {
      emitStatus('正在提交订单...')
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
          '--headless=new',
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
      this.startHeartbeat()
      emitStatus('正在确认支付...')
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
    this.stopScreencast()
    this.stopHeartbeat()
    this.page = null
    this.context = null
    this.browser = null
    this.cdpSession = null
  }

  private startHeartbeat() {
    this.stopHeartbeat()
    this.heartbeatTimer = setInterval(async () => {
      if (!this.context || !this.browser?.isConnected()) {
        this.stopHeartbeat()
        return
      }
      try {
        const heartbeatPage = await this.context.newPage()
        await heartbeatPage.goto(BrowserManager.HEARTBEAT_URL, {
          waitUntil: 'domcontentloaded',
          timeout: 30000,
        })
        await heartbeatPage.waitForTimeout(2000)
        await heartbeatPage.close()
      } catch (e) {
        console.log(`[Taobao] Heartbeat: keep-alive ping failed: ${e}`)
      }
    }, BrowserManager.HEARTBEAT_INTERVAL)
  }

  private stopHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
  }

  async startScreencast(onFrame: (base64Jpeg: string) => void): Promise<void> {
    if (this.screencastActive) {
      return
    }

    if (!this.page) {
      throw new Error('Cannot start screencast: no active page')
    }

    this.onFrameCallback = onFrame
    this.cdpSession = await this.page.context().newCDPSession(this.page)

    this.cdpSession.on('Page.screencastFrame', async (event: { data: string; sessionId: number }) => {
      if (this.onFrameCallback) {
        this.onFrameCallback(event.data)
      }
      try {
        await this.cdpSession?.send('Page.screencastFrameAck', {
          sessionId: event.sessionId,
        })
      } catch {
        this.stopScreencast()
      }
    })

    await this.cdpSession.send('Page.startScreencast', {
      format: 'jpeg',
      quality: 85,
      maxWidth: 1280,
      maxHeight: 800,
      everyNthFrame: 1,
    })

    this.screencastActive = true
  }

  async stopScreencast(): Promise<void> {
    if (!this.screencastActive) {
      return
    }

    this.screencastActive = false
    this.onFrameCallback = null

    try {
      await this.cdpSession?.send('Page.stopScreencast')
    } catch { /* ignore */ }

    try {
      await this.cdpSession?.detach()
    } catch { /* ignore */ }

    this.cdpSession = null
  }

  isScreencasting(): boolean {
    return this.screencastActive
  }

  async close() {
    try { await this.context?.close() } catch { /* ignore */ }
    try { await this.browser?.close() } catch { /* ignore */ }
    this.cleanup()
  }
}
