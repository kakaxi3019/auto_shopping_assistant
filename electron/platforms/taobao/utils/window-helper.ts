import { BrowserWindow } from 'electron'
import { isLoginPage } from './url-helper'
import { injectOverlayBanner, injectCenterToast } from './page-helper'
import type { HintContext } from './page-helper'
import type { CookieManager } from '../infrastructure/cookie-manager'
import type { WindowManager } from '../infrastructure/window-manager'
import type { TaobaoAuth } from '../taobao.auth'

export type { HintContext }

export async function tryAutoLoginThenShow(
  win: BrowserWindow,
  cookieManager: CookieManager,
  windowManager: WindowManager,
  auth: TaobaoAuth,
  emitStatus: (status: string) => void,
  syncContext?: any,
): Promise<void> {
  cookieManager.resetToElectronSyncTimer()
  await cookieManager.syncCookiesToElectron(syncContext, auth)

  const currentUrl = win.webContents.getURL()
  if (!isLoginPage(currentUrl)) {
    emitStatus('Cookie 已同步，页面已自动跳转')
    win.show()
    return
  }

  try {
    const referrer = win.webContents.getURL()
    await win.loadURL(referrer)
    await new Promise(r => setTimeout(r, 3000))

    if (!isLoginPage(win.webContents.getURL())) {
      emitStatus('Cookie 已同步，页面已自动跳转')
      win.show()
      return
    }
  } catch { /* ignore */ }

  emitStatus('登录已过期，请在弹出的窗口中重新登录...')
  win.setSize(900, 700)
  win.setTitle('淘宝登录 - 请重新登录')
  const mw = windowManager.getMainWindow()
  if (mw) win.setParentWindow(mw)
  injectOverlayBanner(win, "🔑 自动购物助手：登录已过期，请在下方重新登录后继续")
  injectCenterToast(win, "请重新登录")
  win.show()
}

export interface ShowConfirmationOptions {
  win: BrowserWindow
  title: string
  bannerMessage: string
  toastMessage?: string
  context?: HintContext
  size?: { width: number; height: number }
}

export function showConfirmationWindow(
  opts: ShowConfirmationOptions,
  windowManager: WindowManager,
): void {
  const { win, title, bannerMessage, toastMessage, context, size } = opts
  const w = size?.width ?? 1100
  const h = size?.height ?? 800
  win.setSize(w, h)
  win.setTitle(title)
  const mw = windowManager.getMainWindow()
  if (mw) win.setParentWindow(mw)
  injectOverlayBanner(win, bannerMessage, context)
  injectCenterToast(win, toastMessage || bannerMessage.replace(/^[🛒🔐💳🔑⚠️📋💰]\s*自动购物助手[：:]\s*/, ''), context)
  win.show()
}
