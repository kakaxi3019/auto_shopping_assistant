import { BrowserWindow } from 'electron'
import { APP_ICON, CHROME_UA } from '../utils/constants'
import { setUserAgent } from '../utils/page-helper'

export class WindowManager {
  private mainWindow: BrowserWindow | null = null
  private loginWindow: BrowserWindow | null = null
  private shopWindow: BrowserWindow | null = null
  private managedWindows: Set<BrowserWindow> = new Set()
  private _cabinMode: boolean = false
  private _cabinOpen: boolean = false
  private _cabinBounds: { x: number; y: number; width: number; height: number } | null = null
  private _cabinDisplayMode: 'auto' | 'interactive' = 'auto'
  private cabinWindows: Set<BrowserWindow> = new Set()
  private _lastCabinWindow: BrowserWindow | null = null
  private _cabinCapturePaused: boolean = false

  trackWindow(win: BrowserWindow): BrowserWindow {
    this.managedWindows.add(win)
    win.on('closed', () => {
      this.managedWindows.delete(win)
    })
    return win
  }

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

  get cabinMode(): boolean {
    return this._cabinMode
  }

  set cabinMode(value: boolean) {
    this._cabinMode = value
  }

  get cabinOpen(): boolean {
    return this._cabinOpen
  }

  set cabinOpen(value: boolean) {
    this._cabinOpen = value
    this._cabinMode = value
    if (!value) {
      for (const win of this.cabinWindows) {
        if (!win.isDestroyed()) {
          win.hide()
        }
      }
    } else {
      if (this.mainWindow && !this.mainWindow.isDestroyed()) {
        this.mainWindow.webContents.send('cabin:mode-change', this._cabinDisplayMode)
      }
    }
  }

  get cabinDisplayMode(): 'auto' | 'interactive' {
    return this._cabinDisplayMode
  }

  set cabinDisplayMode(mode: 'auto' | 'interactive') {
    this._cabinDisplayMode = mode
    if (mode === 'auto') {
      for (const win of this.cabinWindows) {
        if (!win.isDestroyed()) win.hide()
      }
    } else {
      for (const win of this.cabinWindows) {
        if (!win.isDestroyed()) {
          if (this.mainWindow) win.setParentWindow(this.mainWindow)
          if (this._cabinBounds) win.setBounds(this._cabinBounds)
          win.show()
        }
      }
    }
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send('cabin:mode-change', mode)
    }
  }

  setCabinBounds(bounds: { x: number; y: number; width: number; height: number }) {
    this._cabinBounds = bounds
  }

  get cabinCapturePaused(): boolean {
    return this._cabinCapturePaused
  }

  set cabinCapturePaused(value: boolean) {
    this._cabinCapturePaused = value
  }

  getLastCabinWindow(): BrowserWindow | null {
    if (this._lastCabinWindow && !this._lastCabinWindow.isDestroyed()) {
      return this._lastCabinWindow
    }
    return null
  }

  showInCabin(win: BrowserWindow): boolean {
    if (!this._cabinMode || !this.mainWindow || this.mainWindow.isDestroyed()) return false
    try {
      this.cabinWindows.add(win)
      this._lastCabinWindow = win
      win.on('closed', () => {
        this.cabinWindows.delete(win)
        if (this._lastCabinWindow === win) this._lastCabinWindow = null
      })
      if (this.mainWindow) {
        win.setParentWindow(this.mainWindow)
      }
      if (this._cabinBounds) {
        win.setBounds(this._cabinBounds)
      } else {
        const mainBounds = this.mainWindow.getBounds()
        win.setBounds({ x: 224, y: 0, width: mainBounds.width - 224, height: mainBounds.height })
      }
      this.cabinDisplayMode = 'interactive'
      return true
    } catch {
      return false
    }
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
      show: false,
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
    setUserAgent(this.shopWindow)
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
        sandbox: false,
        backgroundThrottling: false,
      },
    })
    setUserAgent(win)
    win.loadURL(url)
    win.setTitle('请手动选择商品规格')
    if (this._cabinMode) {
      this.showInCabin(win)
    } else {
      if (this.mainWindow) {
        win.setParentWindow(this.mainWindow)
      }
      win.show()
    }
    return this.trackWindow(win)
  }

  createHiddenWindow(url: string): BrowserWindow {
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
    setUserAgent(win)
    win.minimize()
    win.loadURL(url)
    return this.trackWindow(win)
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
    return this.trackWindow(win)
  }

  createOrderWindow(): BrowserWindow {
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
    setUserAgent(win)
    win.minimize()
    return this.trackWindow(win)
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
    for (const win of this.managedWindows) {
      if (!win.isDestroyed()) {
        try { win.close() } catch { /* ignore */ }
      }
    }
    this.managedWindows.clear()
  }
}
