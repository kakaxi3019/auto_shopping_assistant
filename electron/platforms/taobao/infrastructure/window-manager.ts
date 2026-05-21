import { BrowserWindow } from 'electron'
import { APP_ICON, CHROME_UA } from '../utils/constants'
import { setUserAgent } from '../utils/page-helper'

export class WindowManager {
  private mainWindow: BrowserWindow | null = null
  private loginWindow: BrowserWindow | null = null
  private shopWindow: BrowserWindow | null = null

  setMainWindow(win: BrowserWindow) {
    this.mainWindow = win
  }

  getMainWindow(): BrowserWindow | null {
    return this.mainWindow
  }

  getShopWindow(): BrowserWindow | null {
    return this.shopWindow
  }

  setShopWindow(win: BrowserWindow | null) {
    this.shopWindow = win
  }

  getLoginWindow(): BrowserWindow | null {
    return this.loginWindow
  }

  setLoginWindow(win: BrowserWindow | null) {
    this.loginWindow = win
  }

  createLoginWindow(): BrowserWindow {
    this.loginWindow = new BrowserWindow({
      width: 900,
      height: 700,
      minWidth: 700,
      minHeight: 550,
      title: '淘宝登录',
      icon: APP_ICON,
      parent: this.mainWindow!,
      modal: true,
      autoHideMenuBar: true,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        backgroundThrottling: false,
      },
    })
    setUserAgent(this.loginWindow)
    return this.loginWindow
  }

  createShopWindow(options?: { show?: boolean; width?: number; height?: number }): BrowserWindow {
    this.shopWindow = new BrowserWindow({
      width: options?.width ?? 1280,
      height: options?.height ?? 800,
      show: options?.show ?? false,
      autoHideMenuBar: true,
      icon: APP_ICON,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        backgroundThrottling: false,
      },
    })
    setUserAgent(this.shopWindow)
    if (this.mainWindow) {
      this.shopWindow.setParentWindow(this.mainWindow)
    }
    return this.shopWindow
  }

  createInteractionWindow(url: string): BrowserWindow {
    const win = new BrowserWindow({
      width: 1100,
      height: 800,
      show: false,
      autoHideMenuBar: true,
      icon: APP_ICON,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        backgroundThrottling: false,
      },
    })
    setUserAgent(win)
    win.loadURL(url)
    win.setTitle('请手动选择商品规格')
    if (this.mainWindow) {
      win.setParentWindow(this.mainWindow)
    }
    win.show()
    return win
  }

  createHiddenWindow(url: string): BrowserWindow {
    const win = new BrowserWindow({
      width: 1280,
      height: 800,
      show: true,
      icon: APP_ICON,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        backgroundThrottling: false,
      },
    })
    setUserAgent(win)
    if (this.mainWindow) {
      win.setParentWindow(this.mainWindow)
    }
    win.minimize()
    win.loadURL(url)
    return win
  }

  createSearchWindow(): BrowserWindow {
    const win = new BrowserWindow({
      width: 1280,
      height: 800,
      show: false,
      icon: APP_ICON,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        backgroundThrottling: false,
      },
    })
    return win
  }

  createOrderWindow(): BrowserWindow {
    const win = new BrowserWindow({
      width: 1280,
      height: 800,
      show: true,
      icon: APP_ICON,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        backgroundThrottling: false,
      },
    })
    setUserAgent(win)
    win.minimize()
    return win
  }

  async closeShopWindow(cookieSyncFn?: () => Promise<void>): Promise<void> {
    if (this.shopWindow && !this.shopWindow.isDestroyed()) {
      try {
        if (cookieSyncFn) await cookieSyncFn()
      } catch { /* ignore */ }
      this.shopWindow.close()
    }
    this.shopWindow = null
  }

  closeLoginWindow() {
    if (this.loginWindow && !this.loginWindow.isDestroyed()) {
      try { this.loginWindow.close() } catch { /* ignore */ }
    }
    this.loginWindow = null
  }

  cleanup() {
    if (this.shopWindow && !this.shopWindow.isDestroyed()) {
      try { this.shopWindow.close() } catch { /* ignore */ }
    }
    this.shopWindow = null
    if (this.loginWindow && !this.loginWindow.isDestroyed()) {
      try { this.loginWindow.close() } catch { /* ignore */ }
    }
    this.loginWindow = null
  }
}
