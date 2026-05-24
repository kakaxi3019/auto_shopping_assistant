import { BrowserWindow } from 'electron'
import { isDisposableUrl, isLoginPage, isIdentityVerifyPage, isCheckoutOrPayPage, isBuyPage, isCartPage } from '../utils/url-helper'
import { setUserAgent, injectOverlayBanner, injectCenterToast } from '../utils/page-helper'
import { APP_ICON } from '../utils/constants'
import { tryAutoLoginThenShow, showConfirmationWindow } from '../utils/window-helper'
import type { CookieManager } from '../infrastructure/cookie-manager'
import type { WindowManager } from '../infrastructure/window-manager'
import type { TaobaoAuth } from '../taobao.auth'

interface PendingConfirmation {
  id: string
  resolve: (confirmed: boolean) => void
  window: BrowserWindow | null
  windowUrl: string
  windowTitle: string
  bannerMessage: string
  scene?: 'verification' | 'add-to-cart' | 'payment'
}

const sceneFailLabels: Record<string, string> = {
  'verification': '无法完成验证',
  'add-to-cart': '商品无法购买',
  'payment': '支付遇到问题',
}

export class InteractionService {
  static readonly CONFIRMATION_TIMEOUT_MS = 30 * 60 * 1000

  private pendingConfirmation: PendingConfirmation | null = null
  private confirmationTimeout: ReturnType<typeof setTimeout> | null = null
  private verificationWindow: BrowserWindow | null = null

  private cookieManager: CookieManager
  private windowManager: WindowManager
  private auth: TaobaoAuth
  private emitStatus: (status: string) => void

  constructor(
    cookieManager: CookieManager,
    windowManager: WindowManager,
    auth: TaobaoAuth,
    emitStatus: (status: string) => void,
  ) {
    this.cookieManager = cookieManager
    this.windowManager = windowManager
    this.auth = auth
    this.emitStatus = emitStatus
  }

  isDisposableUrl(url: string): boolean {
    return isDisposableUrl(url)
  }

  hasPendingConfirmation(): boolean {
    return this.pendingConfirmation !== null
  }

  async waitForUserConfirmation(
    win: BrowserWindow,
    statusMessage: string,
    windowTitle: string,
    bannerMessage: string,
    scene?: 'verification' | 'add-to-cart' | 'payment',
  ): Promise<boolean> {
    const id = `confirm_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    const windowUrl = win.webContents.getURL()
    const disposable = this.isDisposableUrl(windowUrl)
    return new Promise<boolean>((resolve) => {
      let resolved = false
      const safeResolve = (value: boolean) => {
        if (resolved) return
        resolved = true
        if (this.confirmationTimeout) {
          clearTimeout(this.confirmationTimeout)
          this.confirmationTimeout = null
        }
        if (this.pendingConfirmation?.id === id) {
          this.pendingConfirmation = null
        }
        resolve(value)
      }

      this.pendingConfirmation = {
        id,
        resolve: safeResolve,
        window: win,
        windowUrl,
        windowTitle,
        bannerMessage,
        scene,
      }

      if (!win.isDestroyed()) {
        const onNavigate = () => {
          if (this.pendingConfirmation && this.pendingConfirmation.id === id && !win.isDestroyed()) {
            const newUrl = win.webContents.getURL()
            this.pendingConfirmation.windowUrl = newUrl
            if (isBuyPage(newUrl) || newUrl.includes('alipay.com')) {
              if (this.pendingConfirmation.scene !== 'payment') {
                this.pendingConfirmation.scene = 'payment'
                this.emitStatus(`已进入支付页面，请在窗口中完成支付|SCENE:payment|`)
              }
            }
          }
        }
        const onNavigateInPage = () => {
          if (this.pendingConfirmation && this.pendingConfirmation.id === id && !win.isDestroyed()) {
            const newUrl = win.webContents.getURL()
            this.pendingConfirmation.windowUrl = newUrl
            if (isBuyPage(newUrl) || newUrl.includes('alipay.com')) {
              if (this.pendingConfirmation.scene !== 'payment') {
                this.pendingConfirmation.scene = 'payment'
                this.emitStatus(`已进入支付页面，请在窗口中完成支付|SCENE:payment|`)
              }
            }
          }
        }
        const onClosed = () => {
          if (!resolved) {
            const closedUrl = this.pendingConfirmation?.windowUrl || ''
            const currentScene = this.pendingConfirmation?.scene || scene || 'add-to-cart'
            if (this.isDisposableUrl(closedUrl)) {
              this.emitStatus(`操作窗口已关闭，结算/支付页面无法恢复，任务已自动取消|SCENE:${currentScene}|`)
              safeResolve(false)
            } else {
              this.emitStatus(`操作窗口已关闭|SCENE:${currentScene}|`)
            }
          }
          if (!win.isDestroyed()) {
            win.webContents.removeListener('did-navigate', onNavigate)
            win.webContents.removeListener('did-navigate-in-page', onNavigateInPage)
          }
        }
        win.webContents.on('did-navigate', onNavigate)
        win.webContents.on('did-navigate-in-page', onNavigateInPage)
        win.on('closed', onClosed)
      }

      this.confirmationTimeout = setTimeout(() => {
        if (!resolved) {
          this.emitStatus('操作超时（30分钟），自动取消')
          safeResolve(false)
        }
      }, InteractionService.CONFIRMATION_TIMEOUT_MS)

      if (disposable) {
        this.emitStatus(statusMessage.replace('弹出的窗口', '弹出的窗口（关闭后无法恢复）'))
      } else {
        const reopenTag = `|REOPEN:${id}|弹出的窗口|REOPEN_END|`
        this.emitStatus(`${statusMessage.replace('弹出的窗口', reopenTag)}`)
      }
    })
  }

  async resolveConfirmation(confirmed: boolean): Promise<boolean> {
    if (this.pendingConfirmation) {
      const pending = this.pendingConfirmation
      this.pendingConfirmation = null
      if (this.confirmationTimeout) {
        clearTimeout(this.confirmationTimeout)
        this.confirmationTimeout = null
      }
      if (pending.window && !pending.window.isDestroyed()) {
        try {
          await this.cookieManager.syncCookiesFromElectron(null, this.auth)
        } catch { /* ignore */ }
        if (pending.scene === 'verification' && confirmed) {
          this.verificationWindow = pending.window
        } else {
          pending.window.close()
        }
      }
      pending.resolve(confirmed)
      return true
    }
    return false
  }

  getVerificationWindow(): BrowserWindow | null {
    const win = this.verificationWindow
    this.verificationWindow = null
    return win
  }

  async reopenConfirmationWindow(): Promise<boolean> {
    if (!this.pendingConfirmation) return false
    const { windowUrl, windowTitle, bannerMessage } = this.pendingConfirmation

    this.cookieManager.resetToElectronSyncTimer()
    await this.cookieManager.syncCookiesToElectron(null, this.auth)
    const win = new BrowserWindow({
      width: 1100,
      height: 800,
      title: windowTitle,
      icon: APP_ICON,
      autoHideMenuBar: true,
      webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: false, backgroundThrottling: false },
    })
    setUserAgent(win)
    const mainWindow = this.windowManager.getMainWindow()
    if (mainWindow) win.setParentWindow(mainWindow)
    this.windowManager.trackWindow(win)

    win.webContents.setWindowOpenHandler(({ url: openUrl }) => {
      return { action: 'allow', overrideBrowserWindowOptions: { show: false, webPreferences: { sandbox: false, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } } }
    })

    win.webContents.on('did-create-window', (newWindow) => {
      setUserAgent(newWindow)
      newWindow.setIcon(APP_ICON)
      this.windowManager.trackWindow(newWindow)

      const handlePopupUrl = async (popupUrl: string) => {
        if (isIdentityVerifyPage(popupUrl)) {
          this.emitStatus('需要进行身份验证，请在弹出的窗口中完成验证...')
          newWindow.setSize(500, 600)
          newWindow.setTitle('淘宝身份验证')
          const mw = this.windowManager.getMainWindow()
          if (mw) newWindow.setParentWindow(mw)
          injectOverlayBanner(newWindow, "🔐 自动购物助手：淘宝要求身份验证，请在下方完成验证后继续")
          injectCenterToast(newWindow, "请完成身份验证")
          newWindow.show()
          newWindow.focus()
          return
        }

        if (isLoginPage(popupUrl)) {
          await this.tryAutoLoginThenShow(newWindow)
          return
        }

        if (isBuyPage(popupUrl)) {
          await this.cookieManager.syncCookiesFromElectron(null, this.auth)
          this.emitStatus('已进入结算页面')
          return
        }

        if (popupUrl.includes('cart.taobao.com')) {
          await this.cookieManager.syncCookiesFromElectron(null, this.auth)
          this.emitStatus('已加入购物车')
          return
        }
      }

      newWindow.webContents.on('did-finish-load', async () => {
        await handlePopupUrl(newWindow.webContents.getURL())
      })
      newWindow.webContents.on('did-navigate', async () => {
        await handlePopupUrl(newWindow.webContents.getURL())
      })
    })

    win.loadURL(windowUrl)
    injectOverlayBanner(win, bannerMessage)
    injectCenterToast(win, bannerMessage.replace(/^[🛒🔐💳🔑⚠️📋💰]\s*自动购物助手[：:]\s*/, ''))
    win.show()
    this.pendingConfirmation.window = win

    win.webContents.on('did-finish-load', async () => {
      if (!this.pendingConfirmation) return
      const loadedUrl = win.webContents.getURL()
      if (isLoginPage(loadedUrl)) {
        const failLabel = sceneFailLabels[this.pendingConfirmation.scene || 'add-to-cart']
        this.emitStatus(`重新打开的页面已过期（跳转到了登录页），请点击"${failLabel}"取消当前任务，然后重新下单|SCENE:${this.pendingConfirmation.scene || 'add-to-cart'}|`)
        win.setTitle('页面已过期 - 请关闭此窗口')
        injectOverlayBanner(win, `⚠️ 此页面已过期，请关闭此窗口并点击任务面板中的「${failLabel}」按钮，然后重新下单`)
        return
      }
      try {
        const pageText = await win.webContents.executeJavaScript('document.body?.innerText?.substring(0, 200) || ""')
        if (pageText.includes('系统繁忙') || pageText.includes('系统异常') || pageText.includes('页面已过期') || pageText.includes('session expired')) {
          const failLabel = sceneFailLabels[this.pendingConfirmation.scene || 'add-to-cart']
          this.emitStatus(`重新打开的页面已失效（系统繁忙/页面过期），请点击"${failLabel}"取消当前任务，然后重新下单|SCENE:${this.pendingConfirmation.scene || 'add-to-cart'}|`)
          win.setTitle('页面已失效 - 请关闭此窗口')
          injectOverlayBanner(win, `⚠️ 此页面已失效，请关闭此窗口并点击任务面板中的「${failLabel}」按钮，然后重新下单`)
        }
      } catch { /* ignore */ }
    })

    win.on('closed', () => {
      if (this.pendingConfirmation) {
        this.emitStatus(`操作窗口已关闭|SCENE:${this.pendingConfirmation.scene || 'add-to-cart'}|`)
      }
    })

    if (this.confirmationTimeout) {
      clearTimeout(this.confirmationTimeout)
      this.confirmationTimeout = null
    }
    this.confirmationTimeout = setTimeout(() => {
      if (this.pendingConfirmation) {
        this.emitStatus('操作超时（30分钟），自动取消')
        this.resolveConfirmation(false)
      }
    }, InteractionService.CONFIRMATION_TIMEOUT_MS)

    return true
  }

  private async tryAutoLoginThenShow(win: BrowserWindow): Promise<void> {
    await tryAutoLoginThenShow(win, this.cookieManager, this.windowManager, this.auth, this.emitStatus)
  }
}
