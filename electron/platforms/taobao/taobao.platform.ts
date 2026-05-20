import { chromium, type Browser, type BrowserContext, type Page } from 'playwright'
import { BrowserWindow, session, dialog, app } from 'electron'
import * as path from 'path'
import * as fs from 'fs'
import type { PlatformAdapter, Order, CheckoutResult, PayResult, AddToCartResult, SearchResult } from '../../../shared/types/platform.types'
import { TAOBAO_SELECTORS } from './taobao.selectors'
import { TaobaoAuth } from './taobao.auth'
import type { Database } from '../../db/database'

const ORDER_API_URL = 'https://buyertrade.taobao.com/trade/itemlist/asyncBought.htm'

const APP_ICON = path.join(__dirname, '../build/auto_shopping_app_icon.png')

const DEBUG_LOG_PATH = path.join(app.getAppPath(), 'electron_debug.log')

function debugLog(msg: string) {
  const line = `[${new Date().toISOString()}] ${msg}\n`
  console.log(msg)
  try {
    fs.appendFileSync(DEBUG_LOG_PATH, line)
  } catch { /* ignore */ }
}

function getChromiumPath(): string | undefined {
  if (app.isPackaged) {
    const packagedPath = path.join(
      process.resourcesPath,
      'playwright-browsers',
      'chromium-1217',
      'chrome-win64',
      'chrome.exe'
    )
    if (fs.existsSync(packagedPath)) {
      return packagedPath
    }
  }
  return undefined
}

const ANTI_DETECT_JS = `
  Object.defineProperty(Document.prototype, 'visibilityState', { get: () => 'visible', configurable: true });
  Object.defineProperty(Document.prototype, 'hidden', { get: () => false, configurable: true });
  Object.defineProperty(document, 'visibilityState', { get: () => 'visible', configurable: true });
  Object.defineProperty(document, 'hidden', { get: () => false, configurable: true });
  window.addEventListener('visibilitychange', function(e) { e.stopImmediatePropagation(); }, true);

  delete Object.getPrototypeOf(navigator).__proto__.webdriver;
  Object.defineProperty(navigator, 'webdriver', { get: () => undefined, configurable: true });
  Object.defineProperty(navigator, 'languages', { get: () => ['zh-CN', 'zh', 'en-US', 'en'], configurable: true });
  Object.defineProperty(navigator, 'platform', { get: () => 'Win32', configurable: true });
  Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8, configurable: true });
  Object.defineProperty(navigator, 'maxTouchPoints', { get: () => 0, configurable: true });

  var origQuery = window.navigator.permissions.query.bind(window.navigator.permissions);
  Object.defineProperty(window.navigator.permissions, 'query', {
    value: function(params) { return params.name === 'notifications' ? Promise.resolve({ state: Notification.permission }) : origQuery(params); },
    configurable: true,
  });

  if (!window.chrome) { window.chrome = {}; }
  if (!window.chrome.runtime) { window.chrome.runtime = { connect: function(){}, sendMessage: function(){}, onMessage: { addListener: function(){} } }; }
  if (!window.chrome.app) { window.chrome.app = { isInstalled: false, InstallState: { DISABLED: 'disabled', INSTALLED: 'installed', NOT_INSTALLED: 'not_installed' }, RunningState: { CANNOT_RUN: 'cannot_run', READY_TO_RUN: 'ready_to_run', RUNNING: 'running' }, getDetails: function(){}, getIsInstalled: function(){ return false; } }; }
  if (!window.chrome.csi) { window.chrome.csi = function(){}; }
  if (!window.chrome.loadTimes) { window.chrome.loadTimes = function(){ return { commitLoadTime: Date.now()/1000, connectionInfo: 'h2', finishDocumentLoadTime: 0, finishLoadTime: 0, firstPaintAfterLoadTime: 0, firstPaintTime: 0, navigationType: 'Other', npnNegotiatedProtocol: 'h2', requestTime: Date.now()/1000 - 0.5, startLoadTime: Date.now()/1000 - 0.5, wasAlternateProtocolAvailable: false, wasFetchedViaSpdy: true, wasNpnNegotiated: true }; }; }
`

const CANVAS_NOISE_JS = `
  var origGetContext = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function(type) {
    var result = origGetContext.apply(this, arguments);
    if (type === '2d' && result) {
      var origGetImageData = result.getImageData;
      result.getImageData = function() {
        var imageData = origGetImageData.apply(this, arguments);
        for (var i = 0; i < imageData.data.length; i += 4) {
          imageData.data[i] += Math.random() > 0.5 ? 1 : -1;
        }
        return imageData;
      };
      var origToDataURL = result.canvas.toDataURL;
      result.canvas.toDataURL = function() {
        var ctx2 = origGetContext.call(this, '2d');
        if (ctx2) {
          var imgData = origGetImageData.call(ctx2, 0, 0, this.width, this.height);
          for (var i = 0; i < imgData.data.length; i += 4) {
            imgData.data[i] += Math.random() > 0.5 ? 1 : -1;
          }
          ctx2.putImageData(imgData, 0, 0);
        }
        return origToDataURL.apply(this, arguments);
      };
    }
    return result;
  };
`

const HUMAN_SIM_JS = `
  if (!window._hs) {
  var _hs = {
    rand: function(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; },
    click: function(el) {
      if (!el) return false;
      var rect = el.getBoundingClientRect();
      var x = rect.left + rect.width * (0.3 + Math.random() * 0.4);
      var y = rect.top + rect.height * (0.3 + Math.random() * 0.4);
      var opts = { view: window, bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, buttons: 1 };
      var pointerOpts = Object.assign({}, opts, { pointerId: 1, pointerType: 'mouse', isPrimary: true, pressure: 0.5, width: 1, height: 1, tiltX: 0, tiltY: 0 });
      el.dispatchEvent(new PointerEvent('pointerover', Object.assign({}, pointerOpts, { pressure: 0 })));
      el.dispatchEvent(new MouseEvent('mouseover', opts));
      el.dispatchEvent(new PointerEvent('pointerenter', Object.assign({}, pointerOpts, { pressure: 0 })));
      el.dispatchEvent(new MouseEvent('mouseenter', opts));
      el.dispatchEvent(new PointerEvent('pointermove', Object.assign({}, pointerOpts, { clientX: x + _hs.rand(-2,2), clientY: y + _hs.rand(-2,2) })));
      el.dispatchEvent(new MouseEvent('mousemove', Object.assign({}, opts, { clientX: x + _hs.rand(-2,2), clientY: y + _hs.rand(-2,2) })));
      el.dispatchEvent(new PointerEvent('pointerdown', Object.assign({}, pointerOpts, { pressure: 0.5 })));
      el.dispatchEvent(new MouseEvent('mousedown', opts));
      el.dispatchEvent(new PointerEvent('pointerup', Object.assign({}, pointerOpts, { pressure: 0 })));
      el.dispatchEvent(new MouseEvent('mouseup', opts));
      el.dispatchEvent(new PointerEvent('pointerout', Object.assign({}, pointerOpts, { pressure: 0 })));
      el.dispatchEvent(new MouseEvent('mouseout', opts));
      el.dispatchEvent(new PointerEvent('pointerleave', Object.assign({}, pointerOpts, { pressure: 0 })));
      el.dispatchEvent(new MouseEvent('mouseleave', opts));
      el.dispatchEvent(new MouseEvent('click', opts));
      return true;
    },
    scrollSmooth: function(targetY, duration) {
      duration = duration || _hs.rand(300, 800);
      var startY = window.pageYOffset;
      var diff = targetY - startY;
      var start = null;
      return new Promise(function(resolve) {
        function step(ts) {
          if (!start) start = ts;
          var progress = Math.min((ts - start) / duration, 1);
          var ease = progress < 0.5 ? 2 * progress * progress : -1 + (4 - 2 * progress) * progress;
          window.scrollTo(0, startY + diff * ease);
          if (progress < 1) requestAnimationFrame(step);
          else resolve();
        }
        requestAnimationFrame(step);
      });
    },
    delay: function(min, max) {
      return new Promise(function(r) { setTimeout(r, _hs.rand(min, max)); });
    },
    findVisible: function(selectors, textTargets) {
      var results = [];
      for (var si = 0; si < selectors.length; si++) {
        var els = document.querySelectorAll(selectors[si]);
        for (var i = 0; i < els.length; i++) {
          var el = els[i];
          var rect = el.getBoundingClientRect();
          if (rect.width <= 0 || rect.height <= 0) continue;
          var text = (el.textContent || '').trim();
          if (!text || text.length > 100) continue;
          var normalized = text.replace(/\\s+/g, '');
          var matched = !textTargets || textTargets.some(function(t) { return normalized.includes(t); });
          if (matched) results.push({ el: el, text: text, area: rect.width * rect.height, rect: rect });
        }
      }
      return results;
    },
    findAndClick: function(selectors, textTargets) {
      var results = _hs.findVisible(selectors, textTargets);
      if (results.length === 0) return null;
      results.sort(function(a, b) { return a.area - b.area; });
      return _hs.click(results[0].el) ? results[0] : null;
    }
  };
  window._hs = _hs;
  }
`

const ORDER_API_JS = `
async function(pageNum, beginTime, endTime) {
  const form = new URLSearchParams();
  form.append('action', 'itemlist/BoughtQueryAction');
  form.append('event_submit_do_query', '1');
  form.append('_input_charset', 'utf8');
  form.append('pageNum', String(pageNum));
  form.append('pageSize', '20');
  form.append('prePageNo', String(pageNum - 1));
  if (beginTime) form.append('beginTime', beginTime);
  if (endTime) form.append('endTime', endTime);

  const resp = await fetch('${ORDER_API_URL}?action=itemlist/BoughtQueryAction&event_submit_do_query=1&_input_charset=utf8', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
    credentials: 'include',
  });

  const buffer = await resp.arrayBuffer();
  const utf8Text = new TextDecoder('utf-8').decode(buffer);
  let text;
  if (utf8Text.includes('\\ufffd')) {
    text = new TextDecoder('gbk').decode(buffer);
  } else {
    text = utf8Text;
  }
  const data = JSON.parse(text);
  const orders = [];

  if (data.mainOrders) {
    for (const order of data.mainOrders) {
      const subOrders = order.subOrders || [];
      const seller = order.seller || {};
      const orderInfo = order.orderInfo || {};
      const payInfo = order.payInfo || {};

      for (let si = 0; si < subOrders.length; si++) {
        const sub = subOrders[si];
        const itemInfo = sub.itemInfo || {};
        const priceInfo = sub.priceInfo || {};

        const productName = itemInfo.title || '';
        const productUrl = itemInfo.itemUrl || itemInfo.url || '';
        const imageUrl = itemInfo.pic ? (itemInfo.pic.startsWith('//') ? 'https:' + itemInfo.pic : itemInfo.pic) : '';
        const price = parseFloat(priceInfo.realPrice || payInfo.actualFee || '0');
        const orderId = order.id ? String(order.id) + (subOrders.length > 1 ? '_' + si : '') : '';
        const purchasedAt = orderInfo.createTime || '';
        const rawShopName = seller.shopName || seller.shopTitle || seller.nick || '';
        const shopName = typeof rawShopName === 'string' ? rawShopName : String(rawShopName);
        const rawSkuText = itemInfo.skuText || (sub.skuInfo && sub.skuInfo.skuText) || '';
        let skuText = '';
        if (Array.isArray(rawSkuText)) {
          skuText = rawSkuText.map(function(s) {
            if (s && typeof s === 'object' && s.name && s.value) return s.name + ':' + s.value;
            if (typeof s === 'string') return s;
            return '';
          }).filter(Boolean).join(';');
        } else if (typeof rawSkuText === 'string') {
          skuText = rawSkuText;
        }

        if (productName) {
          orders.push({ productName, productUrl, price, imageUrl, orderId, purchasedAt, shopName, sku: skuText });
        }
      }
    }
  }

  const hasNext = !!(data.mainOrders && data.mainOrders.length > 0);
  const totalOrders = data.totalResults || 0;
  return { orders, hasNext, totalOrders, mainOrderCount: data.mainOrders ? data.mainOrders.length : 0 };
}
`

export class TaobaoPlatform implements PlatformAdapter {
  name = 'taobao'
  private browser: Browser | null = null
  private context: BrowserContext | null = null
  private page: Page | null = null
  private auth: TaobaoAuth
  private db: Database
  private _statusCallbacks = new Map<number, (status: string) => void>()
  private _nextCallbackId = 0
  private pendingConfirmation: {
    id: string
    resolve: (confirmed: boolean) => void
    window: BrowserWindow | null
    windowUrl: string
    windowTitle: string
    bannerMessage: string
  } | null = null
  private mainWindow: BrowserWindow | null = null
  private loginWindow: BrowserWindow | null = null
  private destroyed = false
  private lastCookieSyncTime = 0
  private cookieSyncInProgress = false

  constructor(db: Database) {
    this.db = db
    this.auth = new TaobaoAuth()
  }

  setMainWindow(win: BrowserWindow) {
    this.mainWindow = win
  }

  destroy() {
    this.destroyed = true
    if (this.shopWindow && !this.shopWindow.isDestroyed()) {
      try { this.shopWindow.close() } catch { /* ignore */ }
    }
    this.shopWindow = null
    if (this.loginWindow && !this.loginWindow.isDestroyed()) {
      try { this.loginWindow.close() } catch { /* ignore */ }
    }
    this.page = null
    this.context = null
    this.browser = null
  }

  async openInteractionWindow(url: string): Promise<{ success: boolean; error?: string }> {
    try {
      debugLog(`[Taobao] openInteractionWindow called, url: ${url}`)

      debugLog(`[Taobao] openInteractionWindow: syncing cookies...`)
      await this.syncCookiesToElectron()

      const cookies = await session.defaultSession.cookies.get({})
      const taobaoCookies = cookies.filter(c => c.domain.includes('taobao') || c.domain.includes('tmall'))
      debugLog(`[Taobao] openInteractionWindow: session has ${cookies.length} total cookies, ${taobaoCookies.length} taobao/tmall cookies`)

      const win = new BrowserWindow({
        width: 1100,
        height: 800,
        show: false,
        autoHideMenuBar: true,
        icon: APP_ICON,
        webPreferences: {
          nodeIntegration: false,
          contextIsolation: true,
        },
      })
      this.setUserAgent(win)
      debugLog(`[Taobao] openInteractionWindow: BrowserWindow created, UA set`)

      win.webContents.setWindowOpenHandler(({ url: openUrl }) => {
        console.log('[Taobao] Interaction window open: ' + openUrl)
        return { action: 'allow', overrideBrowserWindowOptions: { show: false } }
      })

      win.webContents.on('did-create-window', (newWindow) => {
        this.setUserAgent(newWindow)
        newWindow.setIcon(APP_ICON)

        newWindow.webContents.on('did-navigate', async () => {
          const popupUrl = newWindow.webContents.getURL()
          if (this.isLoginPage(popupUrl)) {
            await this.tryAutoLoginThenShow(newWindow)
          }
        })
        newWindow.webContents.on('did-finish-load', async () => {
          const popupUrl = newWindow.webContents.getURL()
          if (this.isLoginPage(popupUrl)) {
            await this.tryAutoLoginThenShow(newWindow)
          }
        })
      })

      win.webContents.on('did-start-loading', () => {
        debugLog(`[Taobao] openInteractionWindow: did-start-loading`)
      })

      win.webContents.on('did-finish-load', () => {
        debugLog(`[Taobao] openInteractionWindow: did-finish-load, url: ${win.webContents.getURL()}`)
      })

      win.webContents.on('did-fail-load', (_event, errorCode, errorDesc, validatedURL) => {
        debugLog(`[Taobao] openInteractionWindow: did-fail-load, code: ${errorCode}, desc: ${errorDesc}, url: ${validatedURL}`)
      })

      debugLog(`[Taobao] openInteractionWindow: loading URL: ${url}`)
      win.loadURL(url)
      win.setTitle('请手动选择商品规格')
      if (this.mainWindow) {
        win.setParentWindow(this.mainWindow)
      }
      this.injectOverlayBanner(win, "🛒 自动购物助手：需要选择商品规格，请在下方选择后点击对应按钮")
      win.show()
      debugLog(`[Taobao] openInteractionWindow: window shown`)
      return { success: true }
    } catch (e) {
      debugLog(`[Taobao] openInteractionWindow error: ${e}`)
      return { success: false, error: String(e) }
    }
  }

  onStatusChange(callback: (status: string) => void): () => void {
    const id = this._nextCallbackId++
    this._statusCallbacks.set(id, callback)
    return () => this._statusCallbacks.delete(id)
  }

  private _lastEmittedStatus: string = ''

  private emitStatus(status: string) {
    if (status === this._lastEmittedStatus) return
    this._lastEmittedStatus = status
    for (const callback of this._statusCallbacks.values()) {
      try { callback(status) } catch { /* ignore */ }
    }
  }

  private confirmationTimeout: ReturnType<typeof setTimeout> | null = null
  private static readonly CONFIRMATION_TIMEOUT_MS = 30 * 60 * 1000

  private isDisposableUrl(url: string): boolean {
    if (!url) return false
    if (url.includes('confirm_order')) return true
    if (url.includes('cashier.')) return true
    if (url.includes('alipay.com')) return true
    if (url.includes('payresult')) return true
    if (url.includes('trade_success')) return true
    if (url.includes('tradeDetail')) return true
    if (url.includes('buyerPaySuccess')) return true
    if (url.includes('TmallConfirmOrderError')) return true
    if (url.includes('buy.taobao.com') || url.includes('buy.tmall.com')) return true
    return false
  }

  private async waitForUserConfirmation(
    win: BrowserWindow,
    statusMessage: string,
    windowTitle: string,
    bannerMessage: string,
  ): Promise<boolean> {
    const id = `confirm_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    const windowUrl = win.webContents.getURL()
    const disposable = this.isDisposableUrl(windowUrl)
    console.log(`[Taobao] waitForUserConfirmation created, id: ${id}, URL: ${windowUrl}, disposable: ${disposable}`)
    debugLog(`waitForUserConfirmation created, id: ${id}, URL: ${windowUrl}, disposable: ${disposable}`)

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
      }

      if (!win.isDestroyed()) {
        win.webContents.on('did-navigate', () => {
          if (this.pendingConfirmation && this.pendingConfirmation.id === id && !win.isDestroyed()) {
            const newUrl = win.webContents.getURL()
            console.log(`[Taobao] Confirmation window navigated: ${this.pendingConfirmation.windowUrl} -> ${newUrl}`)
            debugLog(`Confirmation window navigated: ${this.pendingConfirmation.windowUrl} -> ${newUrl}`)
            this.pendingConfirmation.windowUrl = newUrl
          }
        })
        win.webContents.on('did-navigate-in-page', () => {
          if (this.pendingConfirmation && this.pendingConfirmation.id === id && !win.isDestroyed()) {
            this.pendingConfirmation.windowUrl = win.webContents.getURL()
          }
        })
        win.on('closed', () => {
          if (!resolved) {
            debugLog(`Confirmation window closed by user, id: ${id}, lastUrl: ${this.pendingConfirmation?.windowUrl || 'unknown'}`)
            const closedUrl = this.pendingConfirmation?.windowUrl || ''
            if (this.isDisposableUrl(closedUrl)) {
              debugLog(`Disposable page closed, auto-resolving as false, URL: ${closedUrl}`)
              this.emitStatus('操作窗口已关闭，结算/支付页面无法恢复，任务已自动取消')
              safeResolve(false)
            } else {
              this.emitStatus('操作窗口已关闭')
            }
          }
        })
      }

      this.confirmationTimeout = setTimeout(() => {
        if (!resolved) {
          this.emitStatus('操作超时（30分钟），自动取消')
          safeResolve(false)
        }
      }, TaobaoPlatform.CONFIRMATION_TIMEOUT_MS)

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
          await this.syncCookiesFromElectron()
        } catch { /* ignore */ }
        pending.window.close()
      }
      pending.resolve(confirmed)
      return true
    }
    return false
  }

  async reopenConfirmationWindow(): Promise<boolean> {
    if (!this.pendingConfirmation) return false
    const { windowUrl, windowTitle, bannerMessage } = this.pendingConfirmation

    console.log(`[Taobao] Reopening confirmation window, URL: ${windowUrl}`)
    debugLog(`Reopening confirmation window, URL: ${windowUrl}`)

    this.lastCookieToElectronSyncTime = 0
    await this.syncCookiesToElectron()
    const win = new BrowserWindow({
      width: 1100,
      height: 800,
      title: windowTitle,
      icon: APP_ICON,
      autoHideMenuBar: true,
      webPreferences: { nodeIntegration: false, contextIsolation: true },
    })
    this.setUserAgent(win)
    if (this.mainWindow) win.setParentWindow(this.mainWindow)

    win.webContents.setWindowOpenHandler(({ url: openUrl }) => {
      console.log('[Taobao] Reopened confirmation window open: ' + openUrl)
      return { action: 'allow', overrideBrowserWindowOptions: { show: false } }
    })

    win.webContents.on('did-create-window', (newWindow) => {
      this.setUserAgent(newWindow)
      newWindow.setIcon(APP_ICON)

      const handlePopupUrl = async (popupUrl: string) => {
        if (this.isIdentityVerifyPage(popupUrl)) {
          this.emitStatus('需要进行身份验证，请在弹出的窗口中完成验证...')
          newWindow.setSize(500, 600)
          newWindow.setTitle('淘宝身份验证')
          if (this.mainWindow) newWindow.setParentWindow(this.mainWindow)
          this.injectOverlayBanner(newWindow, "🔐 自动购物助手：淘宝要求身份验证，请在下方完成验证后继续")
          newWindow.show()
          return
        }

        if (this.isLoginPage(popupUrl)) {
          await this.tryAutoLoginThenShow(newWindow)
          return
        }

        if (this.isCheckoutOrPayPage(popupUrl) || popupUrl.includes('buy.tmall.com') || popupUrl.includes('buy.taobao.com')) {
          await this.syncCookiesFromElectron()
          this.emitStatus('已进入结算页面')
          return
        }

        if (popupUrl.includes('cart.taobao.com')) {
          await this.syncCookiesFromElectron()
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
    this.injectOverlayBanner(win, bannerMessage)
    win.show()
    this.pendingConfirmation.window = win

    win.webContents.on('did-finish-load', async () => {
      if (!this.pendingConfirmation) return
      const loadedUrl = win.webContents.getURL()
      console.log(`[Taobao] Reopened confirmation window loaded: ${loadedUrl}`)
      debugLog(`Reopened confirmation window loaded: ${loadedUrl}`)
      if (this.isLoginPage(loadedUrl)) {
        this.emitStatus('重新打开的页面已过期（跳转到了登录页），请点击"操作失败"取消当前任务，然后重新下单')
        win.setTitle('页面已过期 - 请关闭此窗口')
        this.injectOverlayBanner(win, '⚠️ 此页面已过期，请关闭此窗口并点击任务面板中的「操作失败」按钮，然后重新下单')
        return
      }
      try {
        const pageText = await win.webContents.executeJavaScript('document.body?.innerText?.substring(0, 200) || ""')
        if (pageText.includes('系统繁忙') || pageText.includes('系统异常') || pageText.includes('页面已过期') || pageText.includes('session expired')) {
          console.log(`[Taobao] Reopened page shows error: ${pageText.substring(0, 100)}`)
          debugLog(`Reopened page shows error, URL: ${loadedUrl}, text: ${pageText.substring(0, 200)}`)
          this.emitStatus('重新打开的页面已失效（系统繁忙/页面过期），请点击"操作失败"取消当前任务，然后重新下单')
          win.setTitle('页面已失效 - 请关闭此窗口')
          this.injectOverlayBanner(win, '⚠️ 此页面已失效，请关闭此窗口并点击任务面板中的「操作失败」按钮，然后重新下单')
        }
      } catch { /* ignore */ }
    })

    win.on('closed', () => {
      if (this.pendingConfirmation) {
        this.emitStatus('操作窗口已关闭')
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
    }, TaobaoPlatform.CONFIRMATION_TIMEOUT_MS)

    return true
  }

  private async ensureBrowser() {
    if (this.browser && !this.browser.isConnected()) {
      this.page = null
      this.context = null
      this.browser = null
    }

    if (!this.browser) {
      this.emitStatus('正在启动自动化引擎...')
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
        this.page = null
        this.context = null
        this.browser = null
      })

      this.context = await this.browser.newContext({
        userAgent: this.CHROME_UA,
        viewport: { width: 1280, height: 800 },
        locale: 'zh-CN',
        timezoneId: 'Asia/Shanghai',
      })

      await this.context.addInitScript(HUMAN_SIM_JS)

      await this.context.addInitScript(ANTI_DETECT_JS)

      await this.auth.loadCookies(this.context)

      const currentCookies = await this.context.cookies()
      const hasLoginCookie = currentCookies.some(c =>
        (c.name === 'cookie2' || c.name === 'sgcookie' || c.name === '_tb_token_') &&
        c.domain.includes('taobao')
      )
      if (!hasLoginCookie) {
        console.log('[Taobao] Warning: No login cookies found in Playwright context after loading, may trigger verification')
      }

      this.lastCookieToElectronSyncTime = 0
      await this.syncCookiesToElectron()

      this.page = await this.context.newPage()
      this.emitStatus('自动化引擎已就绪')
    }
  }

  async login(): Promise<boolean> {
    this.emitStatus('正在打开淘宝登录页...')

    if (this.loginWindow) {
      this.loginWindow.close()
      this.loginWindow = null
    }

    return new Promise<boolean>((resolve) => {
      if (!this.mainWindow) {
        this.emitStatus('主窗口未就绪')
        resolve(false)
        return
      }

      this.loginWindow = new BrowserWindow({
        width: 900,
        height: 700,
        minWidth: 700,
        minHeight: 550,
        title: '淘宝登录',
        icon: APP_ICON,
        parent: this.mainWindow,
        modal: true,
        autoHideMenuBar: true,
        webPreferences: {
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: false,
        },
      })

      this.setUserAgent(this.loginWindow)
      this.loginWindow.loadURL(TAOBAO_SELECTORS.LOGIN.LOGIN_PAGE)
      this.emitStatus('请在弹出的窗口中扫码登录...')

      let resolved = false
      const timeout = setTimeout(() => {
        if (!resolved) {
          resolved = true
          this.loginWindow?.close()
          this.loginWindow = null
          this.emitStatus('登录超时')
          resolve(false)
        }
      }, 1800000)

      const saveCookiesAndClose = async () => {
        if (resolved) return
        resolved = true
        clearTimeout(timeout)

        const allCookies = await session.defaultSession.cookies.get({})
        const taobaoCookies = allCookies.filter(
          (c) => c.domain.includes('taobao') || c.domain.includes('tmall') || c.domain.includes('alipay')
        )

        this.auth.saveElectronCookies(taobaoCookies)

        if (this.context && taobaoCookies.length > 0) {
          try {
            const playwrightCookies = taobaoCookies.map((c) => {
              let sameSite: 'Strict' | 'Lax' | 'None' = 'Lax'
              if (c.sameSite === 'no_restriction' || c.sameSite === 'None') {
                sameSite = c.secure ? 'None' : 'Lax'
              } else if (c.sameSite === 'strict' || c.sameSite === 'Strict') {
                sameSite = 'Strict'
              } else if (c.secure) {
                sameSite = 'None'
              }
              return {
                name: c.name,
                value: c.value,
                domain: c.domain,
                path: c.path,
                secure: c.secure,
                httpOnly: c.httpOnly,
                sameSite,
                ...(c.expirationDate && c.expirationDate > 0 ? { expires: c.expirationDate } : {}),
              }
            })
            await this.context.addCookies(playwrightCookies)
            console.log(`[Taobao] Synced ${playwrightCookies.length} cookies from login to Playwright context`)
          } catch (e) {
            console.log(`[Taobao] Failed to sync cookies to Playwright after login: ${e}`)
          }
        }

        this.loginWindow?.close()
        this.loginWindow = null
        this.emitStatus('登录成功，登录状态已保存')
        resolve(true)
      }

      this.loginWindow.webContents.on('did-navigate', async (_event, url) => {
        if (resolved) return
        if (url.includes('taobao.com') && !url.includes('login')) {
          await saveCookiesAndClose()
        }
      })

      this.loginWindow.webContents.on('did-finish-load', async () => {
        if (resolved) return
        try {
          const url = this.loginWindow?.webContents.getURL()
          if (url && url.includes('taobao.com') && !url.includes('login')) {
            await saveCookiesAndClose()
          }
        } catch { /* ignore */ }
      })

      this.loginWindow.on('closed', () => {
        if (!resolved) {
          resolved = true
          clearTimeout(timeout)
          this.loginWindow = null
          this.emitStatus('登录已取消')
          resolve(false)
        }
      })
    })
  }

  async isLoggedIn(): Promise<boolean> {
    return this.auth.hasSavedCookies()
  }

  getCookieAge(): string | null {
    return this.auth.getCookieAge()
  }

  async logout(): Promise<void> {
    this.auth.clearCookies()
    if (this.loginWindow) {
      this.loginWindow.close()
      this.loginWindow = null
    }
    this.emitStatus('已退出登录')
  }

  async fetchOrderHistory(_page = 1, timeRange?: { beginTime?: string; endTime?: string }): Promise<Order[]> {
    this.emitStatus('正在同步历史订单...')

    await this.syncCookiesToElectron()

    const hiddenWindow = new BrowserWindow({
      width: 1280,
      height: 800,
      show: true,
      icon: APP_ICON,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
      },
    })
    this.setUserAgent(hiddenWindow)
    hiddenWindow.minimize()

    const beginTime = timeRange?.beginTime || ''
    const endTime = timeRange?.endTime || ''

    try {
      this.emitStatus('正在访问订单页面...')

      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error('页面加载超时，请检查网络连接'))
        }, 30000)

        hiddenWindow.webContents.on('did-finish-load', () => {
          clearTimeout(timeout)
          resolve()
        })

        hiddenWindow.webContents.on('did-fail-load', (_event, errorCode, errorDesc) => {
          clearTimeout(timeout)
          reject(new Error(`页面加载失败: ${errorDesc} (${errorCode})`))
        })

        this.setUserAgent(hiddenWindow)
        hiddenWindow.loadURL(TAOBAO_SELECTORS.ORDERS.PAGE)
      })

      const currentUrl = hiddenWindow.webContents.getURL()
      if (currentUrl.includes('login')) {
        this.emitStatus('登录已过期，请重新登录')
        throw new Error('未登录或登录已过期，请重新登录')
      }

      this.emitStatus('正在解析订单数据...')

      const allOrders: Order[] = []
      let pageNum = 1
      const maxPages = 100
      let totalOrders = 0

      while (pageNum <= maxPages) {
        this.emitStatus(`正在获取第 ${pageNum} 页订单${totalOrders > 0 ? `（共 ${totalOrders} 条）` : ''}...`)

        const result = await hiddenWindow.webContents.executeJavaScript(
          `(${ORDER_API_JS})(${pageNum}, "${beginTime}", "${endTime}")`
        ) as { orders: Array<{
          productName: string
          productUrl: string
          price: number
          imageUrl: string
          orderId: string
          purchasedAt: string
        }>, hasNext: boolean, totalOrders: number, mainOrderCount: number }

        if (!result.orders || result.orders.length === 0) break

        if (result.totalOrders > 0) totalOrders = result.totalOrders
        console.log(`[Sync] Page ${pageNum}: got ${result.orders.length} items from ${result.mainOrderCount} orders, hasNext=${result.hasNext}, totalOrders=${result.totalOrders}`)

        for (let i = 0; i < result.orders.length; i++) {
          const item = result.orders[i]
          if (!item.productName) continue

          const totalSoFar = allOrders.length + i + 1
          this.emitStatus(`正在保存订单... (${totalSoFar})`)

          const orderId = this.db.upsertOrder({
            platform: this.name,
            orderId: item.orderId || `tb_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            productName: item.productName,
            productUrl: item.productUrl,
            price: item.price,
            imageUrl: item.imageUrl,
            purchasedAt: item.purchasedAt || new Date().toISOString(),
            shopName: item.shopName || '',
            sku: item.sku || '',
            rawData: JSON.stringify(item),
          })
          allOrders.push({ id: orderId, platform: this.name, ...item, rawData: JSON.stringify(item) })
        }

        if (!result.hasNext) break
        pageNum++
      }

      this.emitStatus(`同步完成，获取到 ${allOrders.length} 条订单`)
      return allOrders
    } catch (e) {
      const errorMsg = e instanceof Error ? e.message : String(e)
      this.emitStatus(`同步失败: ${errorMsg}`)
      throw e
    } finally {
      hiddenWindow.close()
    }
  }

  async searchOrders(keyword: string): Promise<Order[]> {
    return this.db.searchOrders(keyword)
  }

  async searchProduct(keyword: string): Promise<SearchResult[]> {
    await this.syncCookiesToElectron()

    const searchWindow = new BrowserWindow({
      width: 1280,
      height: 800,
      show: false,
      icon: APP_ICON,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
      },
    })

    try {
      const encodedKeyword = encodeURIComponent(keyword)
      const searchUrl = `https://s.taobao.com/search?q=${encodedKeyword}`

      this.setUserAgent(searchWindow)
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('搜索页面加载超时')), 30000)
        searchWindow.webContents.on('did-finish-load', () => {
          clearTimeout(timeout)
          resolve()
        })
        searchWindow.webContents.on('did-fail-load', (_event, errorCode, errorDesc) => {
          clearTimeout(timeout)
          reject(new Error(`搜索页面加载失败: ${errorDesc} (${errorCode})`))
        })
        searchWindow.loadURL(searchUrl)
      })

      const currentUrl = searchWindow.webContents.getURL()
      if (currentUrl.includes('login')) {
        return []
      }

      await this.humanDelay(3000)

      const results = await searchWindow.webContents.executeJavaScript(`
        (function() {
          var items = [];
          var debugInfo = {
            url: window.location.href,
            elementCount: 0,
            linkCount: 0
          };

          var searchResultContainer = document.getElementById('content_items_wrapper');
          if (!searchResultContainer) {
            var bodyText = document.body ? document.body.innerText.substring(0, 500) : '';
            return { items: [], debug: { url: window.location.href, bodyPreview: bodyText, elementCount: 0, linkCount: 0 } };
          }

          var allItemElements = searchResultContainer.querySelectorAll('[id^="item_id_"], [data-nid], [data-spm-act-id]');
          debugInfo.elementCount = allItemElements.length;
          var seenIds = {};
          for (var i = 0; i < allItemElements.length; i++) {
            var el = allItemElements[i];
            var itemId = el.id.replace('item_id_', '') || el.getAttribute('data-nid') || el.getAttribute('data-spm-act-id');
            if (!itemId || seenIds[itemId]) continue;
            seenIds[itemId] = true;

            var container = el;
            if (el.tagName === 'A' && el.parentElement) {
              container = el;
            } else {
              var parentLink = el.closest('a');
              if (parentLink) container = parentLink;
            }

            var title = '';
            var titleEl = container.querySelector('[class*="title"], [class*="Title"]');
            if (titleEl) {
              title = (titleEl.textContent || '').trim();
            }
            if (!title) {
              title = (container.getAttribute('title') || container.textContent || '').trim().substring(0, 200);
            }
            if (!title || title.length < 2) continue;

            var price = 0;
            var priceEl = container.querySelector('[class*="price"], [class*="Price"]');
            if (priceEl) {
              var priceMatch = (priceEl.textContent || '').match(/[0-9]+\\.?[0-9]*/);
              if (priceMatch) price = parseFloat(priceMatch[0]);
            }

            var imageUrl = '';
            var imgEl = container.querySelector('img');
            if (imgEl) {
              imageUrl = imgEl.src || imgEl.getAttribute('data-src') || '';
              if (imageUrl.startsWith('//')) imageUrl = 'https:' + imageUrl;
            }

            var shopName = '';
            var shopEl = container.querySelector('[class*="shop"], [class*="store"], [class*="seller"], [class*="Shop"], [class*="Store"]');
            if (shopEl) {
              var rawShop = (shopEl.textContent || '').trim();
              rawShop = rawShop.replace(/店铺会员/g, '').replace(/旺旺在线/g, '').replace(/旺旺离线/g, '').replace(/旺旺/g, '').replace(/进店/g, '').replace(/收藏店铺/g, '').replace(/\s+/g, ' ').trim();
              shopName = rawShop;
            }

            var url = container.getAttribute('href') || '';
            if (url.startsWith('//')) url = 'https:' + url;
            if (url.includes('click.simba.taobao.com') || url.includes('click.taobao.com') || url.includes('s.click.taobao.com')) {
              url = 'https://detail.tmall.com/item.htm?id=' + itemId;
            }
            if (!url && itemId) {
              url = 'https://detail.tmall.com/item.htm?id=' + itemId;
            }

            if (price > 0) {
              items.push({ title: title.substring(0, 200), url: url, price: price, imageUrl: imageUrl, shopName: shopName.substring(0, 100) });
              debugInfo.linkCount++;
            }

            if (items.length >= 10) break;
          }

          if (items.length === 0) {
            var bodyText = document.body ? document.body.innerText.substring(0, 500) : '';
            return { items: [], debug: { url: window.location.href, bodyPreview: bodyText, elementCount: debugInfo.elementCount, linkCount: debugInfo.linkCount } };
          }

          return { items: items, debug: debugInfo };
        })()
      `) as { items: SearchResult[]; debug: any }

      if (results.debug) {
        debugLog(`[Search] URL: ${results.debug.url}, elementCount: ${results.debug.elementCount}, linkCount: ${results.debug.linkCount}`)
        debugLog(`[Search] items found: ${results.items?.length || 0}`)
        if (results.items && results.items.length > 0) {
          results.items.forEach((item: SearchResult, idx: number) => {
            debugLog(`[Search] item[${idx}]: title="${item.title}", price=${item.price}, shop="${item.shopName}"`)
          })
        }
      }

      return (results.items || []).filter(r => r.title && r.price > 0)
    } catch (e) {
      console.log(`[Taobao] searchProduct error: ${e}`)
      return []
    } finally {
      searchWindow.close()
    }
  }

  getProductUrl(order: Order): string {
    return order.productUrl
  }

  private shopWindow: BrowserWindow | null = null

  private readonly CHROME_UA = (() => {
    const electronVer = process.versions.chrome || '131.0.0.0'
    return `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${electronVer} Safari/537.36`
  })()

  private setUserAgent(win: BrowserWindow) {
    win.webContents.setUserAgent(this.CHROME_UA)
    this.injectHumanSim(win)
  }

  private injectHumanSim(win: BrowserWindow) {
    const inject = () => {
      if (win.isDestroyed()) return
      const url = win.webContents.getURL()
      const isCaptchaPage = url.includes('nocaptcha') || url.includes('captcha') || url.includes('slider') || url.includes('baxia') || url.includes('passport.taobao.com/iv')
      win.webContents.executeJavaScript(ANTI_DETECT_JS).catch(() => {})
      if (!isCaptchaPage) {
        win.webContents.executeJavaScript(CANVAS_NOISE_JS).catch(() => {})
        win.webContents.executeJavaScript(HUMAN_SIM_JS).catch(() => {})
      }
    }
    win.webContents.on('did-start-navigation', () => {
      if (win.isDestroyed()) return
      win.webContents.executeJavaScript(ANTI_DETECT_JS).catch(() => {})
    })
    win.webContents.on('did-finish-load', inject)
    if (!win.webContents.isLoading()) {
      inject()
    }
  }

  private async execJS(win: BrowserWindow | null, js: string): Promise<any> {
    if (!win || win.isDestroyed()) return undefined
    await win.webContents.executeJavaScript(HUMAN_SIM_JS).catch(() => {})
    return win.webContents.executeJavaScript(js)
  }

  private async humanClickAt(win: BrowserWindow, x: number, y: number): Promise<void> {
    if (win.isDestroyed()) return
    const jitterX = x + Math.floor(Math.random() * 6) - 3
    const jitterY = y + Math.floor(Math.random() * 6) - 3
    win.webContents.sendInputEvent({ type: 'mouseEnter', x: jitterX, y: jitterY })
    await new Promise(r => setTimeout(r, this.rand(30, 80)))
    win.webContents.sendInputEvent({ type: 'mouseMove', x: jitterX, y: jitterY })
    await new Promise(r => setTimeout(r, this.rand(50, 150)))
    win.webContents.sendInputEvent({ type: 'mouseDown', x: jitterX, y: jitterY, button: 'left', clickCount: 1 })
    await new Promise(r => setTimeout(r, this.rand(50, 120)))
    win.webContents.sendInputEvent({ type: 'mouseUp', x: jitterX, y: jitterY, button: 'left', clickCount: 1 })
    await new Promise(r => setTimeout(r, this.rand(30, 60)))
  }

  private async humanClickElement(win: BrowserWindow, selectors: string[], textTargets?: string[]): Promise<{ clicked: boolean; text?: string; x?: number; y?: number }> {
    if (win.isDestroyed()) return { clicked: false }
    const result = await this.execJS(win, `
      (function() {
        var found = _hs.findVisible(${JSON.stringify(selectors)}, ${textTargets ? JSON.stringify(textTargets) : 'null'});
        if (found.length === 0) return { clicked: false };
        found.sort(function(a, b) { return a.area - b.area; });
        var best = found[0];
        var rect = best.rect;
        var x = rect.left + rect.width * (0.3 + Math.random() * 0.4);
        var y = rect.top + rect.height * (0.3 + Math.random() * 0.4);
        return { clicked: true, text: best.text, x: Math.round(x), y: Math.round(y) };
      })()
    `)
    if (!result || !result.clicked) return { clicked: false }
    await this.humanClickAt(win, result.x, result.y)
    return result
  }

  private rand(min: number, max: number): number {
    return Math.floor(Math.random() * (max - min + 1)) + min
  }

  private async humanDelay(base: number, jitter?: number): Promise<void> {
    const range = jitter ?? Math.ceil(base * 0.4)
    const u1 = Math.random()
    const u2 = Math.random()
    const normal = Math.sqrt(-2 * Math.log(Math.max(u1, 1e-10))) * Math.cos(2 * Math.PI * u2)
    const ms = base + Math.round(normal * range * 0.5)
    await new Promise(r => setTimeout(r, Math.max(150, ms)))
  }

  private injectOverlayBanner(win: BrowserWindow, message: string) {
    const js = `
      (function() {
        var existing = document.getElementById('site-nav');
        if (existing && existing.querySelector('[data-hint]')) return;
        var nav = document.getElementById('site-nav') || document.body.firstChild;
        var hint = document.createElement('div');
        hint.setAttribute('data-hint', '1');
        hint.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:2147483647;padding:10px 20px;background:rgba(37,99,235,0.9);color:#fff;font-size:14px;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;text-align:center;backdrop-filter:blur(4px);box-shadow:0 2px 8px rgba(0,0,0,0.15);line-height:1.5;';
        hint.textContent = ${JSON.stringify(message)};
        var closeBtn = document.createElement('span');
        closeBtn.textContent = '✕';
        closeBtn.style.cssText = 'position:absolute;right:12px;top:50%;transform:translateY(-50%);cursor:pointer;font-size:16px;opacity:0.7;';
        closeBtn.onmouseover = function() { closeBtn.style.opacity = '1'; };
        closeBtn.onmouseout = function() { closeBtn.style.opacity = '0.7'; };
        closeBtn.onclick = function() { hint.remove(); };
        hint.appendChild(closeBtn);
        document.documentElement.appendChild(hint);
        document.body.style.paddingTop = (hint.offsetHeight + 8) + 'px';
      })();
    `;
    win.webContents.executeJavaScript(js).catch(() => {});
    win.webContents.once('did-navigate', () => {
      win.webContents.once('did-finish-load', () => {
        win.webContents.executeJavaScript(js).catch(() => {});
      });
    });
    win.webContents.on('did-navigate-in-page', () => {
      win.webContents.executeJavaScript(js).catch(() => {});
    });
  }

  async addToCart(productUrl: string, sku?: string, orderId?: string, cartOnly?: boolean): Promise<AddToCartResult> {
    this.emitStatus('正在再买一单...')

    debugLog(`[Taobao] addToCart called with orderId: "${orderId}", productUrl: "${productUrl}", cartOnly: ${cartOnly}`)

    if (!orderId) {
      this.emitStatus('没有订单号，无法再买一单')
      return { success: false, error: '没有订单号' }
    }

    try {
      const result = await this.runInHiddenWindow(orderId, productUrl, cartOnly)
      if (result) return result

      return { success: false, error: '再买一单操作未返回结果' }
    } catch (e) {
      debugLog(`[Taobao] addToCart error: ${e}`)
      this.emitStatus(`再买一单失败: ${e}`)
      return { success: false, error: String(e) }
    }
  }

  private async addToCartDirectly(productUrl: string, sku?: string): Promise<AddToCartResult> {
    this.emitStatus('正在打开商品页面加入购物车...')

    if (!productUrl) {
      return { success: false, error: '没有商品链接' }
    }

    let fullUrl = productUrl
    if (fullUrl.startsWith('//')) fullUrl = 'https:' + fullUrl

    try {
      this.lastCookieToElectronSyncTime = 0
      await this.syncCookiesToElectron()

      if (this.shopWindow && !this.shopWindow.isDestroyed()) {
        this.shopWindow.close()
        this.shopWindow = null
      }

      this.shopWindow = new BrowserWindow({
        width: 1280,
        height: 800,
        show: true,
        autoHideMenuBar: true,
        icon: APP_ICON,
        webPreferences: {
          nodeIntegration: false,
          contextIsolation: true,
        },
      })
      this.setUserAgent(this.shopWindow)
      if (this.mainWindow) {
        this.shopWindow.setParentWindow(this.mainWindow)
      }
      this.shopWindow.minimize()

      return new Promise<AddToCartResult>((resolve) => {
        let resolved = false

        const doResolve = (result: AddToCartResult) => {
          if (resolved) return
          resolved = true
          clearTimeout(timeout)
          resolve(result)
        }

        const timeout = setTimeout(() => {
          if (!resolved) {
            this.closeShopWindow()
            this.emitStatus('加入购物车超时')
            doResolve({ success: false, error: '加入购物车超时' })
          }
        }, 1800000)

        const handleNavigation = async (url: string) => {
          if (resolved) return

          if (url.includes('cart.taobao.com')) {
            if (!this.shopWindow?.isDestroyed()) this.shopWindow?.hide()
            await this.syncCookiesFromElectron()
            this.emitStatus('已加入购物车')
            doResolve({ success: true, directToPay: false })
            return
          }

          if (this.isCheckoutOrPayPage(url) || url.includes('buy.tmall.com') || url.includes('buy.taobao.com')) {
            if (!this.shopWindow?.isDestroyed()) this.shopWindow?.hide()
            await this.syncCookiesFromElectron()
            this.emitStatus('已进入结算页面（商品可能不支持加入购物车）')
            doResolve({ success: true, directToPay: true })
            return
          }
        }

        this.shopWindow!.webContents.setWindowOpenHandler(({ url: openUrl }) => {
          console.log('[Taobao] addToCartDirectly window open: ' + openUrl)
          return { action: 'allow', overrideBrowserWindowOptions: { show: false } }
        })

        this.shopWindow!.webContents.on('did-create-window', (newWindow) => {
          this.setUserAgent(newWindow)
          newWindow.setIcon(APP_ICON)

          const handlePopupUrl = async (popupUrl: string) => {
            if (resolved) return

            if (popupUrl.includes('cart.taobao.com')) {
              if (!this.shopWindow?.isDestroyed()) this.shopWindow?.hide()
              this.shopWindow = newWindow
              await this.syncCookiesFromElectron()
              this.emitStatus('已加入购物车')
              doResolve({ success: true, directToPay: false })
              return
            }

            if (this.isCheckoutOrPayPage(popupUrl) || popupUrl.includes('buy.tmall.com') || popupUrl.includes('buy.taobao.com')) {
              if (!this.shopWindow?.isDestroyed()) this.shopWindow?.hide()
              this.shopWindow = newWindow
              await this.syncCookiesFromElectron()
              this.emitStatus('已进入结算页面')
              doResolve({ success: true, directToPay: true })
              return
            }

            if (this.isIdentityVerifyPage(popupUrl)) {
              this.emitStatus('需要进行身份验证，请在弹出的窗口中完成验证...')
              newWindow.setSize(500, 600)
              newWindow.setTitle('淘宝身份验证')
              if (this.mainWindow) newWindow.setParentWindow(this.mainWindow)
              this.injectOverlayBanner(newWindow, "🔐 自动购物助手：淘宝要求身份验证，请在下方完成验证后继续")
              newWindow.show()
              return
            }

            if (this.isLoginPage(popupUrl)) {
              await this.tryAutoLoginThenShow(newWindow)
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

        this.shopWindow!.webContents.on('did-navigate', async (_event, url) => {
          await handleNavigation(url)
        })

        this.shopWindow!.webContents.on('did-finish-load', async () => {
          if (resolved) return

          const currentUrl = this.shopWindow!.webContents.getURL()
          await handleNavigation(currentUrl)
          if (resolved) return

          await this.humanDelay(2000)

          try {
            const pageStatus = await this.execJS(this.shopWindow!, `
              (function() {
                var bodyText = (document.body?.innerText || '');
                var offShelfKeywords = ['已下架', '商品已下架', '宝贝不存在', '商品不存在', '已失效', '已卖完', '暂时缺货', '无法购买'];
                var matchedKeyword = '';
                for (var i = 0; i < offShelfKeywords.length; i++) {
                  if (bodyText.includes(offShelfKeywords[i])) { matchedKeyword = offShelfKeywords[i]; break; }
                }
                var found = _hs.findVisible(['button', 'a', '[class*="btn"]', '[class*="Button"]', '[role="button"]', '[class*="action"]', '[class*="submit"]'], ['加入购物车', '加购']);
                var hasCartButton = found.length > 0;
                return { offShelf: matchedKeyword !== '', keyword: matchedKeyword, hasCartButton: hasCartButton };
              })()
            `)

            if (pageStatus.offShelf && !pageStatus.hasCartButton) {
              this.closeShopWindow()
              this.emitStatus('商品不可购买（' + pageStatus.keyword + '）')
              doResolve({ success: false, error: '商品不可购买（' + pageStatus.keyword + '）' })
              return
            }

            if (pageStatus.hasCartButton) {
              this.emitStatus('正在选择商品规格...')
              await this.execJS(this.shopWindow!, `
                (function() {
                  var skuItems = document.querySelectorAll('[class*="skuItem"], [class*="sku-item"], [class*="SkuItem"], [data-sku], [class*="skuInfo"] [class*="item"], [class*="valueItem"], [class*="ValueItem"]');
                  var clicked = 0;
                  for (var i = 0; i < skuItems.length; i++) {
                    var item = skuItems[i];
                    var rect = item.getBoundingClientRect();
                    if (rect.width <= 0 || rect.height <= 0) continue;
                    var parent = item.parentElement;
                    var siblings = parent ? parent.querySelectorAll('[class*="skuItem"], [class*="sku-item"], [class*="SkuItem"], [data-sku], [class*="valueItem"], [class*="ValueItem"]') : [];
                    var isAlreadySelected = false;
                    var classList = item.className || '';
                    if (classList.includes('selected') || classList.includes('active') || classList.includes('current')) isAlreadySelected = true;
                    if (!isAlreadySelected && siblings.length > 0) {
                      var isFirst = true;
                      for (var j = 0; j < siblings.length; j++) {
                        var sRect = siblings[j].getBoundingClientRect();
                        if (sRect.width > 0 && sRect.height > 0) {
                          if (siblings[j] !== item) { isFirst = false; break; }
                        }
                      }
                      if (isFirst || siblings.length === 1) {
                        _hs.click(item);
                        clicked++;
                      }
                    }
                  }
                  return clicked;
                })()
              `)

              this.emitStatus('正在点击加入购物车...')
              await this.execJS(this.shopWindow!, `
                (function() {
                  var result = _hs.findAndClick(
                    ['button', 'a', '[class*="btn"]', '[class*="Button"]', '[role="button"]', '[class*="action"]', '[class*="submit"]'],
                    ['加入购物车', '加购']
                  );
                  return result ? { clicked: true, text: result.text } : { clicked: false };
                })()
              `)

              await this.humanDelay(5000)

              if (resolved) return

              const afterUrl = this.shopWindow!.webContents.getURL()
              if (afterUrl.includes('cart.taobao.com')) {
                if (!this.shopWindow?.isDestroyed()) this.shopWindow?.hide()
                await this.syncCookiesFromElectron()
                this.emitStatus('已加入购物车')
                doResolve({ success: true, directToPay: false })
                return
              }

              if (afterUrl.includes('buy.tmall.com') || afterUrl.includes('buy.taobao.com') || this.isCheckoutOrPayPage(afterUrl)) {
                if (!this.shopWindow?.isDestroyed()) this.shopWindow?.hide()
                await this.syncCookiesFromElectron()
                this.emitStatus('已进入结算页面（商品可能不支持加入购物车）')
                doResolve({ success: true, directToPay: true })
                return
              }

              const cartSuccessDetected = await this.shopWindow!.webContents.executeJavaScript(`
                (function() {
                  var bodyText = (document.body?.innerText || '');
                  var successHints = ['已加入购物车', '添加成功', '成功加入', '加入成功', '已添加至购物车'];
                  for (var i = 0; i < successHints.length; i++) {
                    if (bodyText.includes(successHints[i])) return true;
                  }
                  var toastEl = document.querySelector('[class*="toast"], [class*="Toast"], [class*="message"], [class*="Message"], [class*="notice"], [class*="Notice"], [class*="success"], [class*="Success"]');
                  if (toastEl) {
                    var toastText = (toastEl.textContent || '').trim();
                    if (toastText.includes('购物车') || toastText.includes('成功') || toastText.includes('添加')) return true;
                  }
                  return false;
                })()
              `)

              if (cartSuccessDetected) {
                await this.syncCookiesFromElectron()
                this.closeShopWindow()
                this.emitStatus('已加入购物车')
                doResolve({ success: true, directToPay: false })
                return
              }

              const hasSkuDialog = await this.shopWindow!.webContents.executeJavaScript(`
                (function() {
                  var dialogs = document.querySelectorAll('[class*="sku"], [class*="Sku"], [class*="dialog"], [class*="Dialog"], [class*="modal"], [class*="Modal"], [class*="popup"], [class*="Popup"]');
                  for (var i = 0; i < dialogs.length; i++) {
                    var rect = dialogs[i].getBoundingClientRect();
                    if (rect.width > 100 && rect.height > 100) return true;
                  }
                  return false;
                })()
              `)

              if (hasSkuDialog) {
                this.emitStatus('需要选择商品规格，请在弹出的窗口中选择后点击"加入购物车"')
                this.shopWindow!.setSize(900, 700)
                this.shopWindow!.setTitle('请选择商品规格，选好后点击"加入购物车"')
                if (this.mainWindow) this.shopWindow!.setParentWindow(this.mainWindow)
                this.injectOverlayBanner(this.shopWindow!, "🛒 自动购物助手：需要选择商品规格，请在下方选择后点击\"加入购物车\"")
                this.shopWindow!.show()

                this.shopWindow!.webContents.on('did-navigate', async (_evt, url: string) => {
                  await handleNavigation(url)
                })
                this.shopWindow!.webContents.setWindowOpenHandler(({ url: openUrl }) => {
                  console.log('[Taobao] addToCartDirectly sku-select window open: ' + openUrl)
                  return { action: 'allow', overrideBrowserWindowOptions: { show: false } }
                })
                this.shopWindow!.webContents.on('did-create-window', (newWin) => {
                  this.setUserAgent(newWin)
                  newWin.setIcon(APP_ICON)
                  newWin.webContents.on('did-finish-load', async () => {
                    const popupUrl = newWin.webContents.getURL()
                    if (popupUrl.includes('cart.taobao.com')) {
                      if (!this.shopWindow?.isDestroyed()) this.shopWindow?.hide()
                      this.shopWindow = newWin
                      await this.syncCookiesFromElectron()
                      this.emitStatus('已加入购物车')
                      doResolve({ success: true, directToPay: false })
                    }
                  })
                })
                return
              }

              this.emitStatus('已点击加入购物车按钮，等待结果...')
            }
          } catch (e) {
            console.log('[Taobao] addToCartDirectly page check error: ' + e)
          }
        })

        this.shopWindow!.loadURL(fullUrl)
      })
    } catch (e) {
      console.log('[Taobao] addToCartDirectly error: ' + e)
      return { success: false, error: String(e) }
    }
  }

  async openProductPage(productUrl: string): Promise<void> {
    this.emitStatus('正在打开商品页面...')

    if (!productUrl) {
      throw new Error('没有商品链接')
    }

    let fullUrl = productUrl
    if (fullUrl.startsWith('//')) fullUrl = 'https:' + fullUrl

    await this.syncCookiesToElectron()

    if (this.shopWindow && !this.shopWindow.isDestroyed()) {
      this.shopWindow.close()
      this.shopWindow = null
    }

    this.shopWindow = new BrowserWindow({
      width: 1100,
      height: 750,
      autoHideMenuBar: true,
      title: '商品页面 - 请选择规格并购买',
      icon: APP_ICON,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
      },
    })
    this.setUserAgent(this.shopWindow)

    if (this.mainWindow) {
      this.shopWindow.setParentWindow(this.mainWindow)
    }

    this.shopWindow.loadURL(fullUrl)

    this.shopWindow.on('closed', async () => {
      this.shopWindow = null
      await this.syncCookiesFromElectron()
    })

    this.emitStatus('已打开商品页面，请在弹出的窗口中选择规格并购买')
  }

  async purchaseFromUrl(productUrl: string): Promise<AddToCartResult> {
    this.emitStatus('正在打开商品页面...')

    if (!productUrl) {
      return { success: false, error: '没有商品链接' }
    }

    let fullUrl = productUrl
    if (fullUrl.startsWith('//')) fullUrl = 'https:' + fullUrl

    try {
      await this.syncCookiesToElectron()

      if (this.shopWindow && !this.shopWindow.isDestroyed()) {
        this.shopWindow.close()
        this.shopWindow = null
      }

      this.shopWindow = new BrowserWindow({
        width: 1280,
        height: 800,
        show: false,
        autoHideMenuBar: true,
        icon: APP_ICON,
        webPreferences: {
          nodeIntegration: false,
          contextIsolation: true,
        },
      })
      this.setUserAgent(this.shopWindow)

      return new Promise<AddToCartResult>((resolve) => {
        let resolved = false

        const doResolve = (result: AddToCartResult) => {
          if (resolved) return
          resolved = true
          clearTimeout(timeout)
          resolve(result)
        }

        const timeout = setTimeout(() => {
          if (!resolved) {
            this.closeShopWindow()
            this.emitStatus('操作超时')
            doResolve({ success: false, error: '操作超时' })
          }
        }, 1800000)

        const handleNavigation = async (url: string) => {
          if (resolved) return

          if (this.isCheckoutOrPayPage(url) || url.includes('buy.tmall.com') || url.includes('buy.taobao.com')) {
            if (!this.shopWindow?.isDestroyed()) this.shopWindow?.hide()
            await this.syncCookiesFromElectron()
            this.emitStatus('已进入结算页面')
            doResolve({ success: true, directToPay: true })
            return
          }

          if (url.includes('cart.taobao.com')) {
            if (!this.shopWindow?.isDestroyed()) this.shopWindow?.hide()
            await this.syncCookiesFromElectron()
            this.emitStatus('已加入购物车')
            doResolve({ success: true, directToPay: false })
            return
          }
        }

        this.shopWindow!.webContents.setWindowOpenHandler(({ url: openUrl }) => {
          console.log('[Taobao] purchaseFromUrl window open: ' + openUrl)
          return { action: 'allow', overrideBrowserWindowOptions: { show: false } }
        })

        this.shopWindow!.webContents.on('did-create-window', (newWindow) => {
          this.setUserAgent(newWindow)
          newWindow.setIcon(APP_ICON)

          const handlePopupUrl = async (popupUrl: string) => {
            if (resolved) return

            if (this.isCheckoutOrPayPage(popupUrl) || popupUrl.includes('buy.tmall.com') || popupUrl.includes('buy.taobao.com')) {
              if (!this.shopWindow?.isDestroyed()) this.shopWindow?.hide()
              this.shopWindow = newWindow
              await this.syncCookiesFromElectron()
              this.emitStatus('已进入结算页面')
              doResolve({ success: true, directToPay: true })
              return
            }

            if (popupUrl.includes('cart.taobao.com')) {
              if (!this.shopWindow?.isDestroyed()) this.shopWindow?.hide()
              this.shopWindow = newWindow
              await this.syncCookiesFromElectron()
              this.emitStatus('已加入购物车')
              doResolve({ success: true, directToPay: false })
              return
            }

            if (this.isIdentityVerifyPage(popupUrl)) {
              this.emitStatus('需要进行身份验证，请在弹出的窗口中完成验证...')
              newWindow.setSize(500, 600)
              newWindow.setTitle('淘宝身份验证')
              if (this.mainWindow) newWindow.setParentWindow(this.mainWindow)
              this.injectOverlayBanner(newWindow, "🔐 自动购物助手：淘宝要求身份验证，请在下方完成验证后继续")
              newWindow.show()
              return
            }

            if (this.isLoginPage(popupUrl)) {
              await this.tryAutoLoginThenShow(newWindow)
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

        this.shopWindow!.webContents.on('did-navigate', async (_event, url) => {
          await handleNavigation(url)
        })

        this.shopWindow!.webContents.on('did-finish-load', async () => {
          if (resolved) return

          const currentUrl = this.shopWindow!.webContents.getURL()
          await handleNavigation(currentUrl)
          if (resolved) return

          await this.humanDelay(2000)

          try {
            const pageStatus = await this.execJS(this.shopWindow!, `
              (function() {
                var bodyText = (document.body?.innerText || '');
                var offShelfKeywords = ['已下架', '商品已下架', '宝贝不存在', '商品不存在', '已失效', '已卖完', '暂时缺货', '无法购买'];
                var matchedKeyword = '';
                for (var i = 0; i < offShelfKeywords.length; i++) {
                  if (bodyText.includes(offShelfKeywords[i])) { matchedKeyword = offShelfKeywords[i]; break; }
                }
                var found = _hs.findVisible(['button', 'a', '[class*="btn"]', '[class*="Button"]', '[role="button"]', '[class*="action"]', '[class*="submit"]'], ['立即购买', '领券购买', '加入购物车', '马上抢', '立刻购买', '加购', '去购买']);
                var hasBuyButton = found.length > 0;
                return { offShelf: matchedKeyword !== '', keyword: matchedKeyword, hasBuyButton: hasBuyButton };
              })()
            `)

            if (pageStatus.offShelf && !pageStatus.hasBuyButton) {
              this.closeShopWindow()
              this.emitStatus('商品不可购买（' + pageStatus.keyword + '）')
              doResolve({ success: false, error: '商品不可购买（' + pageStatus.keyword + '）' })
              return
            }

            if (pageStatus.hasBuyButton) {
              this.emitStatus('正在选择商品规格...')
              await this.execJS(this.shopWindow!, `
                (function() {
                  var skuItems = document.querySelectorAll('[class*="skuItem"], [class*="sku-item"], [class*="SkuItem"], [data-sku], [class*="skuInfo"] [class*="item"], [class*="valueItem"], [class*="ValueItem"]');
                  var clicked = 0;
                  for (var i = 0; i < skuItems.length; i++) {
                    var item = skuItems[i];
                    var rect = item.getBoundingClientRect();
                    if (rect.width <= 0 || rect.height <= 0) continue;
                    var parent = item.parentElement;
                    var siblings = parent ? parent.querySelectorAll('[class*="skuItem"], [class*="sku-item"], [class*="SkuItem"], [data-sku], [class*="valueItem"], [class*="ValueItem"]') : [];
                    var isAlreadySelected = false;
                    var classList = item.className || '';
                    if (classList.includes('selected') || classList.includes('active') || classList.includes('current')) isAlreadySelected = true;
                    if (!isAlreadySelected && siblings.length > 0) {
                      var isFirst = true;
                      for (var j = 0; j < siblings.length; j++) {
                        var sRect = siblings[j].getBoundingClientRect();
                        if (sRect.width > 0 && sRect.height > 0) {
                          if (siblings[j] !== item) { isFirst = false; break; }
                        }
                      }
                      if (isFirst || siblings.length === 1) {
                        _hs.click(item);
                        clicked++;
                      }
                    }
                  }
                  return clicked;
                })()
              `)

              this.emitStatus('正在点击立即购买...')
              await this.execJS(this.shopWindow!, `
                (function() {
                  var result = _hs.findAndClick(
                    ['button', 'a', '[class*="btn"]', '[class*="Button"]', '[role="button"]', '[class*="action"]', '[class*="submit"]'],
                    ['立即购买', '领券购买', '加入购物车', '马上抢', '立刻购买', '加购', '去购买']
                  );
                  if (result) { return true; }
                  return false;
                })()
              `)

              await this.humanDelay(5000)

              if (resolved) return

              const afterUrl = this.shopWindow!.webContents.getURL()
              if (afterUrl.includes('buy.tmall.com') || afterUrl.includes('buy.taobao.com') || this.isCheckoutOrPayPage(afterUrl)) {
                if (!this.shopWindow?.isDestroyed()) this.shopWindow?.hide()
                await this.syncCookiesFromElectron()
                this.emitStatus('已进入结算页面')
                doResolve({ success: true, directToPay: true })
                return
              }

              if (afterUrl.includes('cart.taobao.com')) {
                if (!this.shopWindow?.isDestroyed()) this.shopWindow?.hide()
                await this.syncCookiesFromElectron()
                this.emitStatus('已加入购物车')
                doResolve({ success: true, directToPay: false })
                return
              }

              const hasSkuDialog = await this.shopWindow!.webContents.executeJavaScript(`
                (function() {
                  var dialogs = document.querySelectorAll('[class*="sku"], [class*="Sku"], [class*="dialog"], [class*="Dialog"], [class*="modal"], [class*="Modal"], [class*="popup"], [class*="Popup"]');
                  for (var i = 0; i < dialogs.length; i++) {
                    var rect = dialogs[i].getBoundingClientRect();
                    if (rect.width > 100 && rect.height > 100) return true;
                  }
                  return false;
                })()
              `)

              if (hasSkuDialog) {
                this.emitStatus('需要选择商品规格，请在弹出的窗口中选择...')
                this.shopWindow!.setSize(900, 700)
                this.shopWindow!.setTitle('请选择商品规格，选好后点击"立即购买"')
                if (this.mainWindow) this.shopWindow!.setParentWindow(this.mainWindow)
                this.injectOverlayBanner(this.shopWindow!, "🛒 自动购物助手：需要选择商品规格，请在下方选择后点击\"立即购买\"")
                this.shopWindow!.show()

                this.shopWindow!.webContents.on('did-navigate', async (_evt, url: string) => {
                  await handleNavigation(url)
                })
                this.shopWindow!.webContents.setWindowOpenHandler(({ url: openUrl }) => {
                  console.log('[Taobao] purchaseFromUrl sku-select window open: ' + openUrl)
                  return { action: 'allow', overrideBrowserWindowOptions: { show: false } }
                })
                this.shopWindow!.webContents.on('did-create-window', (newWindow) => {
                  this.setUserAgent(newWindow)
                  newWindow.setIcon(APP_ICON)
                  newWindow.webContents.on('did-finish-load', async () => {
                    const popupUrl = newWindow.webContents.getURL()
                    if (popupUrl.includes('buy.tmall.com') || popupUrl.includes('buy.taobao.com') || this.isCheckoutOrPayPage(popupUrl)) {
                      if (!this.shopWindow?.isDestroyed()) this.shopWindow?.hide()
                      this.shopWindow = newWindow
                      await this.syncCookiesFromElectron()
                      this.emitStatus('已进入结算页面')
                      doResolve({ success: true, directToPay: true })
                    }
                  })
                })
                return
              }

              this.emitStatus('已点击购买按钮，等待页面跳转...')
            }
          } catch (e) {
            console.log('[Taobao] purchaseFromUrl page check error: ' + e)
          }
        })

        this.shopWindow!.loadURL(fullUrl)
      })
    } catch (e) {
      console.log('[Taobao] purchaseFromUrl error: ' + e)
      return { success: false, error: String(e) }
    }
  }

  private async runInHiddenWindow(orderId: string, productUrl?: string, cartOnly?: boolean): Promise<AddToCartResult | null> {
    if (!this.mainWindow) {
      debugLog(`[Taobao] runInHiddenWindow: mainWindow is null, returning null`)
      return null
    }

    const bizOrderId = orderId.replace(/_\d+$/, '')
    const detailUrl = `https://trade.tmall.com/detail/orderDetail.htm?bizOrderId=${bizOrderId}`
    debugLog(`[Taobao] runInHiddenWindow: ${detailUrl}`)
    this.emitStatus('正在打开订单详情页...')

    this.lastCookieToElectronSyncTime = 0
    await this.syncCookiesToElectron()

    if (this.shopWindow && !this.shopWindow.isDestroyed()) {
      this.shopWindow.close()
      this.shopWindow = null
    }

    return new Promise<AddToCartResult | null>((resolve) => {
      this.shopWindow = new BrowserWindow({
        width: 1280,
        height: 800,
        show: true,
        autoHideMenuBar: true,
        icon: APP_ICON,
        webPreferences: {
          nodeIntegration: false,
          contextIsolation: true,
        },
      })
      this.setUserAgent(this.shopWindow)
      if (this.mainWindow) {
        this.shopWindow.setParentWindow(this.mainWindow)
      }
      this.shopWindow.minimize()
      this.shopWindow.loadURL(detailUrl)

      this.shopWindow.webContents.setWindowOpenHandler(({ url: openUrl }) => {
        console.log(`[Taobao] Window open requested: ${openUrl}`)
        return { action: 'allow', overrideBrowserWindowOptions: { show: false } }
      })

      this.shopWindow.webContents.on('did-create-window', (newWindow) => {
        console.log(`[Taobao] Popup window created: ${newWindow.webContents.getURL()}`)
        this.setUserAgent(newWindow)
        newWindow.setIcon(APP_ICON)

        let skuHandled = false

        const handlePopupUrl = async (popupUrl: string) => {
          if (resolved) return
          debugLog(`[Taobao] Popup URL: ${popupUrl}`)

          if (this.isCheckoutOrPayPage(popupUrl) || popupUrl.includes('buy.tmall.com') || popupUrl.includes('buy.taobao.com')) {
            if (cartOnly) {
              resolved = true
              clearTimeout(timeout)
              clearInterval(checkInterval)
              this.closeShopWindow()
              await this.syncCookiesFromElectron()
              this.emitStatus('该商品不支持加入购物车，点击后直接进入了结算页面')
              resolve({ success: false, error: '该商品不支持加入购物车，点击后直接进入了结算页面' })
              return
            }
            resolved = true
            clearTimeout(timeout)
            clearInterval(checkInterval)
            if (!this.shopWindow?.isDestroyed()) this.shopWindow?.hide()
            this.shopWindow = newWindow
            await this.syncCookiesFromElectron()
            this.emitStatus('已进入结算页面')
            newWindow.setSize(1100, 800)
            newWindow.setTitle('请确认订单信息并提交')
            if (this.mainWindow) {
              newWindow.setParentWindow(this.mainWindow)
            }
            this.injectOverlayBanner(newWindow, "💳 自动购物助手：请确认订单信息并提交")
            newWindow.show()
            resolve({ success: true, directToPay: true })
            return
          }

          if (popupUrl.includes('cart.taobao.com')) {
            resolved = true
            clearTimeout(timeout)
            clearInterval(checkInterval)
            if (!this.shopWindow?.isDestroyed()) this.shopWindow?.hide()
            this.shopWindow = newWindow
            await this.syncCookiesFromElectron()
            this.emitStatus('已加入购物车')
            resolve({ success: true, directToPay: false })
            return
          }

          if (this.isIdentityVerifyPage(popupUrl)) {
            console.log(`[Taobao] Identity verification required in popup, showing to user`)
            this.emitStatus('需要进行身份验证，请在弹出的窗口中完成验证...')
            newWindow.setSize(500, 600)
            newWindow.setTitle('淘宝身份验证')
            if (this.mainWindow) {
              newWindow.setParentWindow(this.mainWindow)
            }
            this.injectOverlayBanner(newWindow, "🔐 自动购物助手：淘宝要求身份验证，请在下方完成验证后继续")
            newWindow.show()
            return
          }

          if (this.isLoginPage(popupUrl)) {
            console.log(`[Taobao] Login page in popup, trying auto login first`)
            await this.tryAutoLoginThenShow(newWindow)
            return
          }

          if (popupUrl.includes('taobao.com') && !popupUrl.includes('login') && !popupUrl.includes('item.taobao.com') && !popupUrl.includes('detail.tmall.com')) {
            await this.syncCookiesFromElectron()
            console.log(`[Taobao] Popup navigated to taobao page after login/verify: ${popupUrl}`)
          }

          if (popupUrl.includes('item.taobao.com') || popupUrl.includes('detail.tmall.com')) {
            if (skuHandled) return
            skuHandled = true
            debugLog(`[Taobao] SKU popup detected, url: ${popupUrl}`)
            await this.humanDelay(1500)
            try {
              if (popupUrl.includes('openSku=true') || popupUrl.includes('sku_properties=') || popupUrl.includes('skuId=')) {
                this.emitStatus('正在选择商品规格...')
                const skuClickCount = await this.execJS(newWindow, `
                  (function() {
                    var urlParams = new URLSearchParams(window.location.search);
                    var skuProps = urlParams.get('sku_properties');
                    var skuId = urlParams.get('skuId');
                    var clicked = 0;
                    if (skuProps) {
                      var pairs = skuProps.split(';');
                      for (var p = 0; p < pairs.length; p++) {
                        var pair = pairs[p].split(':');
                        if (pair.length !== 2) continue;
                        var valueId = pair[1];
                        var skuItems = document.querySelectorAll('[data-value], [data-sku-id], [class*="skuItem"], [class*="sku-item"], [class*="SkuItem"], [class*="valueItem"], [class*="ValueItem"]');
                        for (var i = 0; i < skuItems.length; i++) {
                          var val = skuItems[i].getAttribute('data-value') || skuItems[i].getAttribute('data-sku-id') || '';
                          if (val === valueId || val.endsWith(':' + valueId)) {
                            _hs.click(skuItems[i]);
                            clicked++;
                            break;
                          }
                        }
                      }
                    }
                    if (clicked === 0 && skuId) {
                      var allSkuItems = document.querySelectorAll('[data-value], [data-sku-id], [class*="skuItem"], [class*="sku-item"], [class*="SkuItem"], [class*="valueItem"], [class*="ValueItem"], [class*="sku"], [class*="Sku"]');
                      for (var j = 0; j < allSkuItems.length; j++) {
                        var itemVal = allSkuItems[j].getAttribute('data-value') || allSkuItems[j].getAttribute('data-sku-id') || '';
                        if (itemVal === skuId || itemVal.endsWith(':' + skuId)) {
                          _hs.click(allSkuItems[j]);
                          clicked++;
                          break;
                        }
                      }
                      if (clicked === 0) {
                        var skuBtns = document.querySelectorAll('[class*="sku"], [class*="Sku"]');
                        for (var k = 0; k < skuBtns.length; k++) {
                          var rect = skuBtns[k].getBoundingClientRect();
                          if (rect.width <= 0 || rect.height <= 0) continue;
                          var onclick = skuBtns[k].getAttribute('onclick') || '';
                          var dataAttrs = skuBtns[k].outerHTML.substring(0, 500);
                          if (dataAttrs.includes(skuId)) {
                            _hs.click(skuBtns[k]);
                            clicked++;
                            break;
                          }
                        }
                      }
                    }
                    return { skuProps: skuProps, skuId: skuId, clicked: clicked };
                  })()
                `)
                debugLog(`[Taobao] SKU select result: ${JSON.stringify(skuClickCount)}`)
                await this.humanDelay(1000)

                this.emitStatus(cartOnly ? '正在点击加入购物车...' : '正在点击购买...')
                const clickResult = await this.execJS(newWindow, `
                  (function() {
                    var priorityTargets = ${cartOnly} ? ['加入购物车', '加购'] : ['立即购买', '领券购买', '马上抢', '立刻购买', '去购买'];
                    var secondaryTargets = ${cartOnly} ? [] : ['加入购物车', '加购'];
                    var excludeTexts = ['万人加购', '人加购', '人购买', '万人团', '人收货', '人付款'];
                    var btnSelectors = ['button', 'a', '[class*="btn"]', '[class*="Button"]', '[role="button"]', '[class*="action"]', '[class*="submit"]'];
                    var allFound = _hs.findVisible(btnSelectors, priorityTargets.concat(secondaryTargets));
                    var bestPrimary = null;
                    var bestSecondary = null;
                    var allMatches = [];
                    for (var fi = 0; fi < allFound.length; fi++) {
                      var item = allFound[fi];
                      var normalized = item.text.replace(/\\s+/g, '');
                      var isExcluded = excludeTexts.some(function(e) { return normalized.includes(e); });
                      if (isExcluded) continue;
                      var isPrimary = priorityTargets.some(function(t) { return normalized === t || normalized.startsWith(t); });
                      var isSecondary = secondaryTargets.some(function(t) { return normalized === t || normalized.startsWith(t); });
                      if (isPrimary && (!bestPrimary || item.area < bestPrimary.area)) {
                        bestPrimary = { el: item.el, area: item.area, text: item.text.substring(0, 30) };
                      }
                      if (isSecondary && (!bestSecondary || item.area < bestSecondary.area)) {
                        bestSecondary = { el: item.el, area: item.area, text: item.text.substring(0, 30) };
                      }
                      if ((isPrimary || isSecondary) && allMatches.length < 5) {
                        allMatches.push({ tag: item.el.tagName, text: item.text.substring(0, 30), area: Math.round(item.area), isPrimary: isPrimary });
                      }
                    }
                    var chosen = bestPrimary || bestSecondary;
                    if (chosen) { _hs.click(chosen.el); return { clicked: true, text: chosen.text, matches: allMatches }; }
                    return { clicked: false, matches: allMatches };
                  })()
                `)
                debugLog(`[Taobao] SKU popup click result: ${JSON.stringify(clickResult)}`)

                if (cartOnly && !clickResult?.clicked) {
                  resolved = true
                  clearTimeout(timeout)
                  clearInterval(checkInterval)
                  this.closeShopWindow()
                  this.emitStatus('该商品不支持加入购物车（未找到加购按钮）')
                  resolve({ success: false, error: '该商品不支持加入购物车（未找到加购按钮）' })
                  return
                }
                await this.humanDelay(2000)

                const currentPopupUrl = newWindow.webContents.getURL()
                debugLog(`[Taobao] After buy click, current URL: ${currentPopupUrl}`)
                if (this.isIdentityVerifyPage(currentPopupUrl) || currentPopupUrl.includes('nocaptcha') || currentPopupUrl.includes('slider')) {
                  await newWindow.webContents.executeJavaScript(`
                    (function() {
                      try {
                        Object.defineProperty(Document.prototype, 'visibilityState', { get: function() { return document.hidden ? 'hidden' : 'visible'; }, configurable: true });
                        Object.defineProperty(Document.prototype, 'hidden', { get: function() { return !document.hasFocus(); }, configurable: true });
                        Object.defineProperty(document, 'visibilityState', { get: function() { return document.hidden ? 'hidden' : 'visible'; }, configurable: true });
                        Object.defineProperty(document, 'hidden', { get: function() { return !document.hasFocus(); }, configurable: true });
                      } catch(e) {}
                    })()
                  `).catch(() => {})
                  newWindow.setSize(1100, 800)
                  newWindow.setTitle('淘宝安全验证')
                  if (this.mainWindow) newWindow.setParentWindow(this.mainWindow)
                  const captchaBanner = '🔐 自动购物助手：淘宝要求安全验证，请拖动滑块或完成验证后继续'
                  this.injectOverlayBanner(newWindow, captchaBanner)
                  newWindow.show()
                  const verified = await this.waitForUserConfirmation(
                    newWindow,
                    '淘宝要求安全验证（滑块验证），请在弹出的窗口中完成验证，完成后点击"已完成"',
                    '淘宝安全验证',
                    captchaBanner,
                  )
                  if (verified) {
                    resolved = true
                    clearTimeout(timeout)
                    clearInterval(checkInterval)
                    if (!this.shopWindow?.isDestroyed()) this.shopWindow?.hide()
                    this.shopWindow = newWindow
                    await this.syncCookiesFromElectron()
                    const afterVerifyUrl = newWindow.webContents.getURL()
                    if (afterVerifyUrl.includes('cart.taobao.com')) {
                      this.emitStatus('已加入购物车')
                      resolve({ success: true, directToPay: false })
                    } else if (this.isCheckoutOrPayPage(afterVerifyUrl) || afterVerifyUrl.includes('buy.tmall.com') || afterVerifyUrl.includes('buy.taobao.com')) {
                      this.emitStatus('已进入结算页面')
                      resolve({ success: true, directToPay: true })
                    } else {
                      this.emitStatus('验证完成，请继续操作')
                      resolve({ success: true, directToPay: true })
                    }
                  } else {
                    resolved = true
                    clearTimeout(timeout)
                    clearInterval(checkInterval)
                    resolve({ success: false, error: '安全验证未完成' })
                  }
                  return
                }

                if (this.isCheckoutOrPayPage(currentPopupUrl) || currentPopupUrl.includes('buy.tmall.com') || currentPopupUrl.includes('buy.taobao.com')) {
                  debugLog(`[Taobao] Detected checkout page, handling...`)
                  await handlePopupUrl(currentPopupUrl)
                  return
                }

                const pageDiag = await this.execJS(newWindow, `
                  (function() {
                    var bodyText = (document.body?.innerText || '').substring(0, 500);
                    var selectHints = ['请选择', '选择商品信息', '请选择规格', '请选择商品', '请选择您要的'];
                    var matchedHint = '';
                    for (var i = 0; i < selectHints.length; i++) {
                      if (bodyText.includes(selectHints[i])) { matchedHint = selectHints[i]; break; }
                    }
                    var btnSelectors = ['button', 'a', '[class*="btn"]', '[class*="Button"]', '[role="button"]', '[class*="action"]', '[class*="submit"]'];
                    var foundBtns = _hs.findVisible(btnSelectors, ['领券购买', '立即购买', '加入购物车', '马上抢', '立刻购买', '加购', '去购买', '万人加购', '确定']);
                    var hasBuyBtn = foundBtns.length > 0;
                    var buyBtns = [];
                    for (var bi = 0; bi < foundBtns.length && buyBtns.length < 5; bi++) {
                      buyBtns.push({ tag: foundBtns[bi].el.tagName, text: foundBtns[bi].text.substring(0, 30), w: Math.round(foundBtns[bi].rect.width), h: Math.round(foundBtns[bi].rect.height) });
                    }
                    var dialogs = document.querySelectorAll('[class*="dialog"], [class*="Dialog"], [class*="modal"], [class*="Modal"], [class*="popup"], [class*="Popup"], [class*="toast"], [class*="Toast"]');
                    var visibleDialogs = [];
                    for (var k = 0; k < dialogs.length; k++) {
                      var r = dialogs[k].getBoundingClientRect();
                      if (r.width > 50 && r.height > 50) visibleDialogs.push({ cls: dialogs[k].className.substring(0, 50), w: Math.round(r.width), h: Math.round(r.height) });
                    }
                    var captchaSelectors = ['#nocaptcha', '#nc_1_wrapper', '[class*="nc-container"]', '[class*="nc_wrapper"]', '[class*="slider"]', '[class*="captcha"]', '[class*="Captcha"]', '[id*="captcha"]'];
                    var hasCaptcha = false;
                    var captchaInfo = '';
                    for (var ci = 0; ci < captchaSelectors.length; ci++) {
                      var cel = document.querySelector(captchaSelectors[ci]);
                      if (cel) { var cr = cel.getBoundingClientRect(); if (cr.width > 50 && cr.height > 20) { hasCaptcha = true; captchaInfo = captchaSelectors[ci]; break; } }
                    }
                    if (!hasCaptcha) {
                      var captchaHints = ['请拖动', '滑块', '请完成验证', '安全验证', '拖动滑块'];
                      for (var chi = 0; chi < captchaHints.length; chi++) {
                        if (bodyText.includes(captchaHints[chi])) { hasCaptcha = true; captchaInfo = captchaHints[chi]; break; }
                      }
                    }
                    return { needSelect: matchedHint !== '', hint: matchedHint, hasBuyBtn: hasBuyBtn, buyBtns: buyBtns, visibleDialogs: visibleDialogs, hasCaptcha: hasCaptcha, captchaInfo: captchaInfo, bodyPreview: bodyText.substring(0, 200) };
                  })()
                `)
                debugLog(`[Taobao] After buy click page diag: ${JSON.stringify(pageDiag)}`)

                if (pageDiag.hasCaptcha) {
                  debugLog(`[Taobao] Captcha detected in page diag: ${pageDiag.captchaInfo}`)
                  newWindow.setSize(1100, 800)
                  newWindow.setTitle('淘宝安全验证')
                  if (this.mainWindow) newWindow.setParentWindow(this.mainWindow)
                  const captchaBanner = '🔐 自动购物助手：淘宝要求安全验证，请拖动滑块或完成验证后继续'
                  this.injectOverlayBanner(newWindow, captchaBanner)
                  newWindow.show()
                  const captchaConfirmed = await this.waitForUserConfirmation(
                    newWindow,
                    '淘宝要求安全验证（滑块验证），请在弹出的窗口中完成验证，完成后点击"已完成"',
                    '淘宝安全验证',
                    captchaBanner,
                  )
                  if (captchaConfirmed) {
                    resolved = true
                    clearTimeout(timeout)
                    clearInterval(checkInterval)
                    if (!this.shopWindow?.isDestroyed()) this.shopWindow?.hide()
                    this.shopWindow = newWindow
                    await this.syncCookiesFromElectron()
                    const afterVerifyUrl = newWindow.webContents.getURL()
                    if (afterVerifyUrl.includes('cart.taobao.com')) {
                      this.emitStatus('已加入购物车')
                      resolve({ success: true, directToPay: false })
                    } else {
                      this.emitStatus('验证完成，请继续操作')
                      resolve({ success: true, directToPay: true })
                    }
                  } else {
                    resolved = true
                    clearTimeout(timeout)
                    clearInterval(checkInterval)
                    resolve({ success: false, error: '安全验证未完成' })
                  }
                  return
                }

                const checkResult = { needSelect: pageDiag.needSelect, hint: pageDiag.hint }
                debugLog(`[Taobao] After buy click check: ${JSON.stringify(checkResult)}`)

                if (checkResult.needSelect) {
                  const reopenUrl = newWindow.webContents.getURL()
                  const actionText = cartOnly ? '点击加入购物车' : '点击购买'
                  newWindow.setSize(1100, 800)
                  newWindow.setTitle(`请选择商品规格 - 选择后${actionText}`)
                  if (this.mainWindow) {
                    newWindow.setParentWindow(this.mainWindow)
                  }
                  const bannerMsg = `⚠️ 自动购物助手：原商品规格信息已失效，请重新选择规格后${actionText}`
                  this.injectOverlayBanner(newWindow, bannerMsg)
                  newWindow.show()

                  const confirmed = await this.waitForUserConfirmation(
                    newWindow,
                    `原商品规格信息已失效，请在弹出的窗口中重新选择规格后${actionText}，完成后点击"已完成"`,
                    `请选择商品规格 - 选择后${actionText}`,
                    bannerMsg,
                  )

                  if (confirmed) {
                    resolved = true
                    clearTimeout(timeout)
                    clearInterval(checkInterval)
                    if (!this.shopWindow?.isDestroyed()) this.shopWindow?.hide()
                    this.shopWindow = newWindow
                    await this.syncCookiesFromElectron()
                    const currentUrl = newWindow.webContents.getURL()
                    if (currentUrl.includes('cart.taobao.com')) {
                      this.emitStatus('已加入购物车')
                      resolve({ success: true, directToPay: false })
                    } else {
                      this.emitStatus('已进入结算页面')
                      resolve({ success: true, directToPay: true })
                    }
                  } else {
                    resolved = true
                    clearTimeout(timeout)
                    clearInterval(checkInterval)
                    resolve({ success: false, error: '用户取消操作' })
                  }
                  return
                }

                debugLog(`[Taobao] SKU path: buy clicked but no checkout redirect and no needSelect, showing interaction window`)
                let fallbackReason = '点击购买后页面未跳转到结算页'
                if (pageDiag.visibleDialogs && pageDiag.visibleDialogs.length > 0) {
                  fallbackReason = `点击购买后出现弹窗（${pageDiag.visibleDialogs.map((d: any) => d.cls?.substring(0, 20) || '未知').join(', ')}），页面未跳转到结算页`
                } else if (pageDiag.hint) {
                  fallbackReason = `页面提示"${pageDiag.hint}"，自动购买无法继续`
                } else if (!pageDiag.hasBuyBtn) {
                  fallbackReason = '页面上未找到可点击的购买按钮'
                }
                newWindow.setSize(1100, 800)
                newWindow.setTitle('请手动完成购买操作')
                if (this.mainWindow) {
                  newWindow.setParentWindow(this.mainWindow)
                }
                const fallbackBanner = `⚠️ 自动购物助手：${fallbackReason}，请在下方手动完成购买操作`
                this.injectOverlayBanner(newWindow, fallbackBanner)
                newWindow.show()

                const confirmed = await this.waitForUserConfirmation(
                  newWindow,
                  `${fallbackReason}，请在弹出的窗口中手动完成购买操作，完成后点击"已完成"`,
                  '请手动完成购买操作',
                  fallbackBanner,
                )

                if (confirmed) {
                  resolved = true
                  clearTimeout(timeout)
                  clearInterval(checkInterval)
                  if (!this.shopWindow?.isDestroyed()) this.shopWindow?.hide()
                  this.shopWindow = newWindow
                  await this.syncCookiesFromElectron()
                  const currentUrl = newWindow.webContents.getURL()
                  if (currentUrl.includes('cart.taobao.com')) {
                    this.emitStatus('已加入购物车')
                    resolve({ success: true, directToPay: false })
                  } else {
                    this.emitStatus('已进入结算页面')
                    resolve({ success: true, directToPay: true })
                  }
                } else {
                  resolved = true
                  clearTimeout(timeout)
                  clearInterval(checkInterval)
                  resolve({ success: false, error: '用户取消操作' })
                }

                return
              } else {
                const pageStatus = await this.execJS(newWindow, `
                  (function() {
                    var bodyText = (document.body?.innerText || '');
                    var offShelfKeywords = ['已下架', '商品已下架', '宝贝不存在', '商品不存在', '已失效', '商品已失效', '已卖完', '暂时缺货', '该商品已下架', '商品已售罄', '此商品已下架', '页面不存在', '很抱歉', '无法购买'];
                    var matchedKeyword = '';
                    for (var i = 0; i < offShelfKeywords.length; i++) {
                      if (bodyText.includes(offShelfKeywords[i])) {
                        matchedKeyword = offShelfKeywords[i];
                        break;
                      }
                    }
                    var found = _hs.findVisible(['button', 'a', '[class*="btn"]', '[class*="Button"]', '[role="button"]', '[class*="action"]', '[class*="submit"]'], ${cartOnly} ? ['加入购物车', '加购'] : ['领券购买', '立即购买', '加入购物车', '马上抢', '立刻购买', '加购', '去购买']);
                    var hasBuyButton = found.length > 0;
                    return { offShelf: matchedKeyword !== '', keyword: matchedKeyword, hasBuyButton: hasBuyButton };
                  })()
                `)
                debugLog(`[Taobao] Popup product page status: ${JSON.stringify(pageStatus)}`)

                if (pageStatus.offShelf && !pageStatus.hasBuyButton) {
                  resolved = true
                  clearTimeout(timeout)
                  clearInterval(checkInterval)
                  this.closeShopWindow()
                  this.emitStatus(`商品不可购买（${pageStatus.keyword}）`)
                  resolve({ success: false, error: `商品不可购买（${pageStatus.keyword}）` })
                  return
                }

                if (pageStatus.hasBuyButton) {
                  this.emitStatus(cartOnly ? '正在点击加入购物车...' : '正在点击领券购买...')
                  const noSkuClickResult = await this.execJS(newWindow, `
                    (function() {
                      var result = _hs.findAndClick(
                        ['button', 'a', '[class*="btn"]', '[class*="Button"]', '[role="button"]', '[class*="action"]', '[class*="submit"]'],
                        ${cartOnly} ? ['加入购物车', '加购'] : ['领券购买', '立即购买', '加入购物车', '马上抢', '立刻购买', '加购', '去购买']
                      );
                      if (result) { return { clicked: true, text: result.text.substring(0, 30) }; }
                      return { clicked: false };
                    })()
                  `)
                  debugLog(`[Taobao] No-SKU popup click result: ${JSON.stringify(noSkuClickResult)}`)

                  if (cartOnly && !noSkuClickResult?.clicked) {
                    resolved = true
                    clearTimeout(timeout)
                    clearInterval(checkInterval)
                    this.closeShopWindow()
                    this.emitStatus('该商品不支持加入购物车（未找到加购按钮）')
                    resolve({ success: false, error: '该商品不支持加入购物车（未找到加购按钮）' })
                    return
                  }

                  await this.humanDelay(2000)

                  const afterClickUrl = newWindow.webContents.getURL()
                  debugLog(`[Taobao] No-SKU after click URL: ${afterClickUrl}`)

                  const afterClickDiag = await this.execJS(newWindow, `
                    (function() {
                      var bodyText = (document.body?.innerText || '').substring(0, 500);
                      var selectHints = ['请选择', '选择商品信息', '请选择规格', '请选择商品', '请选择您要的', '选择颜色', '选择尺寸', '选择型号'];
                      var matchedHint = '';
                      for (var i = 0; i < selectHints.length; i++) {
                        if (bodyText.includes(selectHints[i])) { matchedHint = selectHints[i]; break; }
                      }
                      var skuPanels = document.querySelectorAll('[class*="sku"], [class*="Sku"], [class*="SKU"], [class*="selector"], [class*="Selector"], [class*="property"], [class*="Property"]');
                      var visibleSkuPanels = [];
                      for (var j = 0; j < skuPanels.length; j++) {
                        var rect = skuPanels[j].getBoundingClientRect();
                        if (rect.width > 100 && rect.height > 100) visibleSkuPanels.push({ cls: skuPanels[j].className.substring(0, 50), w: Math.round(rect.width), h: Math.round(rect.height) });
                      }
                      var btnSelectors = ['button', 'a', '[class*="btn"]', '[class*="Button"]', '[role="button"]', '[class*="action"]', '[class*="submit"]'];
                      var foundBtns = _hs.findVisible(btnSelectors, ['领券购买', '立即购买', '加入购物车', '马上抢', '立刻购买', '加购', '去购买', '万人加购', '确定']);
                      var hasBuyBtn = foundBtns.length > 0;
                      var buyBtns = [];
                      for (var bi = 0; bi < foundBtns.length && buyBtns.length < 5; bi++) {
                        buyBtns.push({ tag: foundBtns[bi].el.tagName, text: foundBtns[bi].text.substring(0, 30), w: Math.round(foundBtns[bi].rect.width), h: Math.round(foundBtns[bi].rect.height) });
                      }
                      return { needSelect: matchedHint !== '' || visibleSkuPanels.length > 0, hint: matchedHint || (visibleSkuPanels.length > 0 ? 'SKU选择面板' : ''), hasBuyBtn: hasBuyBtn, buyBtns: buyBtns, visibleSkuPanels: visibleSkuPanels, bodyPreview: bodyText.substring(0, 200) };
                    })()
                  `)
                  debugLog(`[Taobao] No-SKU after click diag: ${JSON.stringify(afterClickDiag)}`)

                  const afterClickCheck = { needSelect: afterClickDiag.needSelect, hint: afterClickDiag.hint }
                  debugLog(`[Taobao] After buy click check: ${JSON.stringify(afterClickCheck)}`)

                  if (afterClickCheck.needSelect) {
                    const actionText2 = cartOnly ? '点击加入购物车' : '点击购买'
                    newWindow.setSize(1100, 800)
                    newWindow.setTitle(`请选择商品规格 - 选择后${actionText2}`)
                    if (this.mainWindow) {
                      newWindow.setParentWindow(this.mainWindow)
                    }
                    const bannerMsg2 = `⚠️ 自动购物助手：原商品规格信息已失效，请重新选择规格后${actionText2}`
                    this.injectOverlayBanner(newWindow, bannerMsg2)
                    newWindow.show()

                    const confirmed = await this.waitForUserConfirmation(
                      newWindow,
                      `原商品规格信息已失效，请在弹出的窗口中重新选择规格后${actionText2}，完成后点击"已完成"`,
                      `请选择商品规格 - 选择后${actionText2}`,
                      bannerMsg2,
                    )

                    if (confirmed) {
                      resolved = true
                      clearTimeout(timeout)
                      clearInterval(checkInterval)
                      if (!this.shopWindow?.isDestroyed()) this.shopWindow?.hide()
                      this.shopWindow = newWindow
                      await this.syncCookiesFromElectron()
                      const currentUrl = newWindow.webContents.getURL()
                      if (currentUrl.includes('cart.taobao.com')) {
                        this.emitStatus('已加入购物车')
                        resolve({ success: true, directToPay: false })
                      } else {
                        this.emitStatus('已进入结算页面')
                        resolve({ success: true, directToPay: true })
                      }
                    } else {
                      resolved = true
                      clearTimeout(timeout)
                      clearInterval(checkInterval)
                      resolve({ success: false, error: '用户取消操作' })
                    }
                    return
                  }

                  debugLog(`[Taobao] No-SKU path: checking URL after click: ${afterClickUrl}`)
                  if (this.isCheckoutOrPayPage(afterClickUrl) || afterClickUrl.includes('buy.tmall.com') || afterClickUrl.includes('buy.taobao.com')) {
                    await handlePopupUrl(afterClickUrl)
                    return
                  }

                  debugLog(`[Taobao] No-SKU path: buy clicked but no checkout redirect, showing interaction window`)
                  let fallbackReason2 = '点击购买后页面未跳转到结算页'
                  if (afterClickDiag) {
                    if (afterClickDiag.visibleSkuPanels && afterClickDiag.visibleSkuPanels.length > 0) {
                      fallbackReason2 = `点击购买后出现规格选择面板，可能需要手动选择规格`
                    } else if (afterClickDiag.hint) {
                      fallbackReason2 = `页面提示"${afterClickDiag.hint}"，自动购买无法继续`
                    } else if (!afterClickDiag.hasBuyBtn) {
                      fallbackReason2 = '页面上未找到可点击的购买按钮'
                    }
                  }
                  newWindow.setSize(1100, 800)
                  newWindow.setTitle('请手动完成购买操作')
                  if (this.mainWindow) {
                    newWindow.setParentWindow(this.mainWindow)
                  }
                  const fallbackBanner2 = `⚠️ 自动购物助手：${fallbackReason2}，请在下方手动完成购买操作`
                  this.injectOverlayBanner(newWindow, fallbackBanner2)
                  newWindow.show()

                  const confirmed2 = await this.waitForUserConfirmation(
                    newWindow,
                    `${fallbackReason2}，请在弹出的窗口中手动完成购买操作，完成后点击"已完成"`,
                    '请手动完成购买操作',
                    fallbackBanner2,
                  )

                  if (confirmed2) {
                    resolved = true
                    clearTimeout(timeout)
                    clearInterval(checkInterval)
                    if (!this.shopWindow?.isDestroyed()) this.shopWindow?.hide()
                    this.shopWindow = newWindow
                    await this.syncCookiesFromElectron()
                    const currentUrl = newWindow.webContents.getURL()
                    if (currentUrl.includes('cart.taobao.com')) {
                      this.emitStatus('已加入购物车')
                      resolve({ success: true, directToPay: false })
                    } else {
                      this.emitStatus('已进入结算页面')
                      resolve({ success: true, directToPay: true })
                    }
                  } else {
                    resolved = true
                    clearTimeout(timeout)
                    clearInterval(checkInterval)
                    resolve({ success: false, error: '用户取消操作' })
                  }

                  return
                } else if (cartOnly) {
                  resolved = true
                  clearTimeout(timeout)
                  clearInterval(checkInterval)
                  this.closeShopWindow()
                  this.emitStatus('该商品不支持加入购物车（未找到加购按钮）')
                  resolve({ success: false, error: '该商品不支持加入购物车（未找到加购按钮）' })
                  return
                }
              }
            } catch (e) {
              console.log(`[Taobao] Popup buy click error: ${e}`)
            }
          }
        }

        newWindow.webContents.on('did-finish-load', async () => {
          const popupUrl = newWindow.webContents.getURL()
          await handlePopupUrl(popupUrl)
        })

        newWindow.webContents.on('did-navigate', async () => {
          const popupUrl = newWindow.webContents.getURL()
          await handlePopupUrl(popupUrl)
        })

        newWindow.webContents.setWindowOpenHandler(({ url: openUrl }) => {
          debugLog(`[Taobao] Popup window opening: ${openUrl}`)
          if (openUrl.includes('buy.tmall.com') || openUrl.includes('buy.taobao.com') || openUrl.includes('cart.taobao.com')) {
            return { action: 'allow' }
          }
          return { action: 'allow' }
        })

        newWindow.webContents.on('did-create-window', (childWindow) => {
          debugLog(`[Taobao] Child window created`)
          this.setUserAgent(childWindow)
          childWindow.setIcon(APP_ICON)

          childWindow.webContents.on('did-finish-load', async () => {
            const childUrl = childWindow.webContents.getURL()
            debugLog(`[Taobao] Child window loaded: ${childUrl}`)
            await handlePopupUrl(childUrl)
          })

          childWindow.webContents.on('did-navigate', async () => {
            const childUrl = childWindow.webContents.getURL()
            debugLog(`[Taobao] Child window navigated: ${childUrl}`)
            await handlePopupUrl(childUrl)
          })
        })

        const popupCheck = setInterval(async () => {
          if (resolved || newWindow.isDestroyed()) {
            clearInterval(popupCheck)
            return
          }
          try {
            const popupUrl = newWindow.webContents.getURL()
            await handlePopupUrl(popupUrl)
            if (resolved) return

            const allFrames = newWindow.webContents.mainFrame.framesInSubtree
            for (const frame of allFrames) {
              if (frame === newWindow.webContents.mainFrame) continue
              try {
                const frameUrl = frame.url
                if (this.isCheckoutOrPayPage(frameUrl) || frameUrl.includes('buy.tmall.com') || frameUrl.includes('buy.taobao.com')) {
                  await handlePopupUrl(frameUrl)
                  break
                }
              } catch { /* ignore */ }
            }
          } catch { /* ignore */ }
        }, 2000)

        newWindow.on('closed', async () => {
          clearInterval(popupCheck)
          await this.syncCookiesFromElectron()
        })
      })

      let resolved = false
      const timeout = setTimeout(() => {
        if (!resolved) {
          resolved = true
          this.closeShopWindow()
          this.emitStatus('操作超时')
          resolve(null)
        }
      }, 1800000)

      const tryClickRebuy = async () => {
        if (resolved || this.destroyed || !this.shopWindow || this.shopWindow.isDestroyed()) return
        try {
          const cartTargets = cartOnly ? ['加入购物车', '加购'] : []
          const rebuyTargets = ['再买一单', '再次购买', '再来一单', '重新购买', '去购买', '立即购买', '再次下单', '追加购买']
          const allTargets = [...cartTargets, ...rebuyTargets]

          const mainResult = await this.execJS(this.shopWindow, `
            (function() {
              var allTargets = ${JSON.stringify(allTargets)};
              var cartTargets = ${JSON.stringify(cartTargets)};
              var found = _hs.findVisible(['button', 'a', '[class*="btn"]', '[class*="Button"]', '[role="button"]', '[class*="action"]', '[class*="submit"]'], allTargets);
              var bestMatch = null;
              var bestCartMatch = null;
              var debugMatches = [];
              for (var fi = 0; fi < found.length; fi++) {
                var item = found[fi];
                var normalized = item.text.replace(/\\s+/g, '');
                var isCartTarget = cartTargets.some(function(t) { return normalized.includes(t); });
                if (isCartTarget && (!bestCartMatch || item.area < bestCartMatch.area)) {
                  bestCartMatch = { el: item.el, area: item.area, text: item.text.substring(0, 30) };
                }
                if (!bestMatch || item.area < bestMatch.area) {
                  bestMatch = { el: item.el, area: item.area, text: item.text.substring(0, 30) };
                }
                if (debugMatches.length < 5) {
                  debugMatches.push({ tag: item.el.tagName, text: item.text.substring(0, 40), w: Math.round(item.rect.width), h: Math.round(item.rect.height) });
                }
              }
              var chosen = bestCartMatch || bestMatch;
              if (chosen) {
                _hs.click(chosen.el);
                return { clicked: true, text: chosen.text, isCart: !!bestCartMatch, matches: debugMatches };
              }
              return { clicked: false, matches: debugMatches };
            })()
          `)
          debugLog(`[Taobao] Main frame rebuy result: ${JSON.stringify(mainResult)}`)

          if (mainResult && mainResult.clicked) {
            if (mainResult.isCart) {
              this.emitStatus('已点击加入购物车，等待结果...')
              await this.humanDelay(3000)
              if (resolved) return

              const cartResultDetected = await this.shopWindow.webContents.executeJavaScript(`
                (function() {
                  var successHints = ['已加入购物车', '添加成功', '成功加入', '加入成功', '已添加至购物车'];
                  var errorHints = ['不能购买', '无法购买', '已下架', '已失效', '已售罄', '宝贝不存在', '商品不存在', '已卖完', '缺货', '不能买了', '无法加购', '加购失败', '添加失败', '操作失败'];
                  var toastSelectors = '[class*="toast"], [class*="Toast"], [class*="message"], [class*="Message"], [class*="notice"], [class*="Notice"], [class*="success"], [class*="Success"], [class*="dialog"], [class*="Dialog"], [class*="error"], [class*="Error"], [class*="warning"], [class*="Warning"], [class*="popup"], [class*="Popup"], [class*="layer"], [class*="Layer"]';
                  var toastEls = document.querySelectorAll(toastSelectors);
                  for (var k = 0; k < toastEls.length; k++) {
                    var t = (toastEls[k].textContent || '').trim();
                    for (var i = 0; i < errorHints.length; i++) {
                      if (t.includes(errorHints[i])) return { type: 'error', hint: errorHints[i] };
                    }
                    for (var j = 0; j < successHints.length; j++) {
                      if (t.includes(successHints[j])) return { type: 'success' };
                    }
                    if (t.includes('购物车') && (t.includes('成功') || t.includes('已'))) return { type: 'success' };
                  }
                  var bodyText = (document.body?.innerText || '');
                  for (var m = 0; m < errorHints.length; m++) {
                    if (bodyText.includes(errorHints[m])) return { type: 'error', hint: errorHints[m] };
                  }
                  for (var n = 0; n < successHints.length; n++) {
                    if (bodyText.includes(successHints[n])) return { type: 'success' };
                  }
                  return null;
                })()
              `)
              debugLog(`[Taobao] Cart result detected: ${JSON.stringify(cartResultDetected)}`)

              if (cartResultDetected?.type === 'success') {
                resolved = true
                clearTimeout(timeout)
                clearInterval(checkInterval)
                await this.syncCookiesFromElectron()
                this.closeShopWindow()
                this.emitStatus('已加入购物车')
                resolve({ success: true, directToPay: false })
                return
              }

              if (cartResultDetected?.type === 'error') {
                resolved = true
                clearTimeout(timeout)
                clearInterval(checkInterval)
                this.closeShopWindow()
                const errorMsg = `商品不可购买（${cartResultDetected.hint}）`
                this.emitStatus(errorMsg)
                resolve({ success: false, error: errorMsg })
                return
              }
            } else {
              this.emitStatus('已点击再买一单，等待页面跳转...')
            }
            return
          }

          const frames = this.shopWindow.webContents.mainFrame.framesInSubtree
          console.log(`[Taobao] Main frame not found, searching ${frames.length} frames...`)
          for (const frame of frames) {
            if (frame === this.shopWindow!.webContents.mainFrame) continue
            try {
              const frameUrl = frame.url
              debugLog(`[Taobao] Checking frame: ${frameUrl.substring(0, 100)}`)
              await frame.executeJavaScript(HUMAN_SIM_JS).catch(() => {})
              const frameResult = await frame.executeJavaScript(`
                (function() {
                  var allTargets = ${JSON.stringify(allTargets)};
                  var cartTargets = ${JSON.stringify(cartTargets)};
                  var found = _hs.findVisible(['button', 'a', '[class*="btn"]', '[class*="Button"]', '[role="button"]', '[class*="action"]', '[class*="submit"]'], allTargets);
                  var bestMatch = null;
                  var bestCartMatch = null;
                  var debugMatches = [];
                  for (var fi = 0; fi < found.length; fi++) {
                    var item = found[fi];
                    var normalized = item.text.replace(/\\s+/g, '');
                    var isCartTarget = cartTargets.some(function(t) { return normalized.includes(t); });
                    if (isCartTarget && (!bestCartMatch || item.area < bestCartMatch.area)) {
                      bestCartMatch = { el: item.el, area: item.area, text: item.text.substring(0, 30) };
                    }
                    if (!bestMatch || item.area < bestMatch.area) {
                      bestMatch = { el: item.el, area: item.area, text: item.text.substring(0, 30) };
                    }
                    if (debugMatches.length < 5) {
                      debugMatches.push({ tag: item.el.tagName, text: item.text.substring(0, 40), w: Math.round(item.rect.width), h: Math.round(item.rect.height) });
                    }
                  }
                  var chosen = bestCartMatch || bestMatch;
                  if (chosen) {
                    _hs.click(chosen.el);
                    return { clicked: true, text: chosen.text, isCart: !!bestCartMatch, matches: debugMatches };
                  }
                  return { clicked: false, matches: debugMatches };
                })()
              `)
              debugLog(`[Taobao] Frame ${frameUrl.substring(0, 80)} result: ${JSON.stringify(frameResult)}`)
              if (frameResult && frameResult.clicked) {
                if (frameResult.isCart) {
                  this.emitStatus('已点击加入购物车，等待结果...')
                  await this.humanDelay(3000)
                  if (resolved) return

                  const frameCartResult = await this.shopWindow.webContents.executeJavaScript(`
                    (function() {
                      var successHints = ['已加入购物车', '添加成功', '成功加入', '加入成功', '已添加至购物车'];
                      var errorHints = ['不能购买', '无法购买', '已下架', '已失效', '已售罄', '宝贝不存在', '商品不存在', '已卖完', '缺货', '不能买了', '无法加购', '加购失败', '添加失败', '操作失败'];
                      var toastSelectors = '[class*="toast"], [class*="Toast"], [class*="message"], [class*="Message"], [class*="notice"], [class*="Notice"], [class*="success"], [class*="Success"], [class*="dialog"], [class*="Dialog"], [class*="error"], [class*="Error"], [class*="warning"], [class*="Warning"], [class*="popup"], [class*="Popup"], [class*="layer"], [class*="Layer"]';
                      var toastEls = document.querySelectorAll(toastSelectors);
                      for (var k = 0; k < toastEls.length; k++) {
                        var t = (toastEls[k].textContent || '').trim();
                        for (var i = 0; i < errorHints.length; i++) {
                          if (t.includes(errorHints[i])) return { type: 'error', hint: errorHints[i] };
                        }
                        for (var j = 0; j < successHints.length; j++) {
                          if (t.includes(successHints[j])) return { type: 'success' };
                        }
                        if (t.includes('购物车') && (t.includes('成功') || t.includes('已'))) return { type: 'success' };
                      }
                      var bodyText = (document.body?.innerText || '');
                      for (var m = 0; m < errorHints.length; m++) {
                        if (bodyText.includes(errorHints[m])) return { type: 'error', hint: errorHints[m] };
                      }
                      for (var n = 0; n < successHints.length; n++) {
                        if (bodyText.includes(successHints[n])) return { type: 'success' };
                      }
                      return null;
                    })()
                  `)
                  debugLog(`[Taobao] Frame cart result detected: ${JSON.stringify(frameCartResult)}`)

                  if (frameCartResult?.type === 'success') {
                    resolved = true
                    clearTimeout(timeout)
                    clearInterval(checkInterval)
                    await this.syncCookiesFromElectron()
                    this.closeShopWindow()
                    this.emitStatus('已加入购物车')
                    resolve({ success: true, directToPay: false })
                    return
                  }

                  if (frameCartResult?.type === 'error') {
                    resolved = true
                    clearTimeout(timeout)
                    clearInterval(checkInterval)
                    this.closeShopWindow()
                    const errorMsg = `商品不可购买（${frameCartResult.hint}）`
                    this.emitStatus(errorMsg)
                    resolve({ success: false, error: errorMsg })
                    return
                  }
                } else {
                  this.emitStatus('已点击再买一单，等待页面跳转...')
                }
                return
              }
            } catch (e) {
              debugLog(`[Taobao] Frame search error: ${e}`)
            }
          }

          resolved = true
          clearTimeout(timeout)
          clearInterval(checkInterval)
          this.closeShopWindow()
          this.emitStatus('未找到再买一单入口')
          resolve({ success: false, error: '未找到再买一单入口' })
        } catch (e) {
          debugLog(`[Taobao] Hidden window rebuy click error: ${e}`)
          resolved = true
          clearTimeout(timeout)
          clearInterval(checkInterval)
          this.closeShopWindow()
          resolve({ success: false, error: String(e) })
        }
      }

      let loginRetryCount = 0

      this.shopWindow.webContents.on('did-finish-load', async () => {
        if (resolved) return
        const url = this.shopWindow?.webContents.getURL()
        if (!url) return
        debugLog(`[Taobao] Hidden window loaded: ${url}`)

        const hasCaptcha = await this.detectCaptcha(this.shopWindow!)
        if (hasCaptcha) {
          await this.shopWindow?.webContents.executeJavaScript(`
            (function() {
              try {
                Object.defineProperty(Document.prototype, 'visibilityState', { get: function() { return document.hidden ? 'hidden' : 'visible'; }, configurable: true });
                Object.defineProperty(Document.prototype, 'hidden', { get: function() { return !document.hasFocus(); }, configurable: true });
                Object.defineProperty(document, 'visibilityState', { get: function() { return document.hidden ? 'hidden' : 'visible'; }, configurable: true });
                Object.defineProperty(document, 'hidden', { get: function() { return !document.hasFocus(); }, configurable: true });
              } catch(e) {}
            })()
          `).catch(() => {})
          this.shopWindow?.restore()
          this.shopWindow?.setSize(1100, 800)
          this.shopWindow?.setTitle('淘宝安全验证')
          this.injectOverlayBanner(this.shopWindow!, '🔐 自动购物助手：淘宝要求安全验证，请拖动滑块完成验证')
          this.emitStatus('需要进行滑块验证，请在弹出的窗口中完成验证...')
          const verified = await this.waitForUserConfirmation(
            this.shopWindow!,
            '淘宝要求安全验证（滑块验证），请在弹出的窗口中拖动滑块完成验证，然后点击"已完成"',
            '淘宝安全验证',
            '🔐 请拖动滑块完成验证',
          )
          if (!verified) {
            resolved = true
            clearTimeout(timeout)
            clearInterval(checkInterval)
            this.closeShopWindow()
            resolve({ success: false, error: '安全验证未完成' })
            return
          }
          await this.humanDelay(1000)
          return
        }

        if (this.isLoginPage(url)) {
          if (loginRetryCount < 1) {
            loginRetryCount++
            debugLog(`[Taobao] Login page detected, re-syncing cookies and retrying...`)
            this.emitStatus('检测到登录页面，正在重新同步登录状态...')
            this.lastCookieToElectronSyncTime = 0
            await this.syncCookiesToElectron()
            await this.humanDelay(500)
            this.shopWindow?.loadURL(detailUrl)
            return
          }
          resolved = true
          clearTimeout(timeout)
          this.closeShopWindow()
          this.emitStatus('登录已过期，请重新登录')
          resolve({ success: false, error: '登录已过期' })
          return
        }

        const directToPay = this.isCheckoutOrPayPage(url) || url.includes('buy.tmall.com') || url.includes('buy.taobao.com')
        if (directToPay) {
          resolved = true
          clearTimeout(timeout)
          clearInterval(checkInterval)
          await this.syncCookiesFromElectron()
          if (cartOnly) {
            this.closeShopWindow()
            this.emitStatus('该商品不支持加入购物车，点击后直接进入了结算页面')
            resolve({ success: false, error: '该商品不支持加入购物车，点击后直接进入了结算页面' })
          } else {
            this.emitStatus('已进入结算页面')
            resolve({ success: true, directToPay: true })
          }
          return
        }

        if (url.includes('cart.taobao.com')) {
          resolved = true
          clearTimeout(timeout)
          clearInterval(checkInterval)
          await this.syncCookiesFromElectron()
          this.emitStatus('已加入购物车')
          resolve({ success: true, directToPay: false })
          return
        }

        if (url.includes('tradearchive.taobao.com')) {
          debugLog(`[Taobao] tradearchive page detected, no rebuy button available`)
          resolved = true
          clearTimeout(timeout)
          clearInterval(checkInterval)
          this.closeShopWindow()
          this.emitStatus('未找到再买一单入口')
          resolve({ success: false, error: '未找到再买一单入口' })
          return
        }

        let rebuyBtnFound = false
        const btnSearchTargets = cartOnly ? ['加入购物车', '加购', '再买一单', '再次购买', '再来一单', '重新购买', '去购买', '立即购买', '再次下单', '追加购买'] : ['再买一单', '再次购买', '再来一单', '重新购买', '去购买', '立即购买', '再次下单', '追加购买']
        for (let retry = 0; retry < 10 && !this.destroyed; retry++) {
          try {
            if (retry === 0) {
              const pageDiag = await this.execJS(this.shopWindow, `
                (function() {
                  var bodyText = (document.body?.innerText || '').substring(0, 2000);
                  var allTexts = [];
                  var foundEls = _hs.findVisible(['button', 'a', '[class*="btn"]', '[class*="Button"]', '[role="button"]', '[class*="action"]', '[class*="submit"]', 'span', 'div']);
                  for (var fi = 0; fi < foundEls.length; fi++) {
                    var t = foundEls[fi].text;
                    if (t && t.length <= 20 && t.length >= 2) {
                      allTexts.push(foundEls[fi].el.tagName + ':' + t);
                    }
                  }
                  return { url: location.href, bodyLen: bodyText.length, bodyPreview: bodyText.substring(0, 500), visibleTexts: allTexts.join('|') };
                })()
              `)
              debugLog(`[Taobao] PAGE DIAG: ${JSON.stringify(pageDiag)}`)
            }
            const mainHasBtn = await this.execJS(this.shopWindow, `
              (function() {
                var targets = ${JSON.stringify(btnSearchTargets)};
                var found = _hs.findVisible(['button', 'a', '[class*="btn"]', '[class*="Button"]', '[role="button"]', '[class*="action"]', '[class*="submit"]'], targets);
                var foundItems = [];
                for (var fi = 0; fi < found.length; fi++) {
                  foundItems.push({ tag: found[fi].el.tagName, text: found[fi].text.substring(0, 40), w: Math.round(found[fi].rect.width), h: Math.round(found[fi].rect.height) });
                }
                return { found: found.length > 0, matches: foundItems };
              })()
            `)
            debugLog(`[Taobao] rebuyBtnFound retry ${retry} main: ${JSON.stringify(mainHasBtn)}`)
            if (mainHasBtn?.found) { rebuyBtnFound = true; break }
            const frames = this.shopWindow!.webContents.mainFrame.framesInSubtree
            for (const frame of frames) {
              if (frame === this.shopWindow!.webContents.mainFrame) continue
              const fUrl = frame.url
              debugLog(`[Taobao] rebuyBtnFound retry ${retry} frame: ${fUrl.substring(0, 100)}`)
              try {
                await frame.executeJavaScript(HUMAN_SIM_JS).catch(() => {})
                const fHasBtn = await frame.executeJavaScript(`
                  (function() {
                    var targets = ${JSON.stringify(btnSearchTargets)};
                    var found = _hs.findVisible(['button', 'a', '[class*="btn"]', '[class*="Button"]', '[role="button"]', '[class*="action"]', '[class*="submit"]'], targets);
                    var foundItems = [];
                    for (var fi = 0; fi < found.length; fi++) {
                      foundItems.push({ tag: found[fi].el.tagName, text: found[fi].text.substring(0, 40), w: Math.round(found[fi].rect.width), h: Math.round(found[fi].rect.height) });
                    }
                    return { found: found.length > 0, matches: foundItems };
                  })()
                `)
                debugLog(`[Taobao] rebuyBtnFound frame ${fUrl.substring(0, 60)}: ${JSON.stringify(fHasBtn)}`)
                if (fHasBtn?.found) { rebuyBtnFound = true; break }
              } catch (e) {
                debugLog(`[Taobao] rebuyBtnFound frame error: ${e}`)
              }
            }
          } catch (e) {
            debugLog(`[Taobao] rebuyBtnFound retry ${retry} error: ${e}`)
          }
          if (rebuyBtnFound) break
          await this.humanDelay(1000)
        }

        if (!rebuyBtnFound) {
          resolved = true
          clearTimeout(timeout)
          clearInterval(checkInterval)
          this.closeShopWindow()
          this.emitStatus('未找到再买一单入口')
          resolve({ success: false, error: '未找到再买一单入口' })
          return
        }

        let offShelfResult: { offShelf: boolean; keyword: string } | null = null
        try {
          const mainOffShelf = await this.execJS(this.shopWindow, `
            (function() {
              var bodyText = (document.body?.innerText || '');
              var offShelfKeywords = ['已下架', '商品已下架', '宝贝不存在', '商品不存在', '已失效', '商品已失效', '已卖完', '暂时缺货', '该商品已下架', '商品已售罄', '此商品已下架', '页面不存在', '无法购买'];
              var matchedKeyword = '';
              for (var i = 0; i < offShelfKeywords.length; i++) {
                if (bodyText.includes(offShelfKeywords[i])) {
                  matchedKeyword = offShelfKeywords[i];
                  break;
                }
              }
              if (!matchedKeyword) return { offShelf: false, keyword: '' };
              var buyFound = _hs.findVisible(['button', 'a', '[class*="btn"]', '[class*="Button"]', '[role="button"]', '[class*="action"]', '[class*="submit"]'], ['领券购买', '立即购买', '加入购物车', '马上抢', '立刻购买', '加购', '去购买']);
              if (buyFound.length > 0) return { offShelf: false, keyword: '' };
              return { offShelf: true, keyword: matchedKeyword };
            })()
          `)
          if (mainOffShelf?.offShelf) {
            offShelfResult = mainOffShelf
          } else {
            const frames = this.shopWindow!.webContents.mainFrame.framesInSubtree
            for (const frame of frames) {
              if (frame === this.shopWindow!.webContents.mainFrame) continue
              const fUrl = frame.url
              if (!fUrl.includes('tmall.com') && !fUrl.includes('taobao.com')) continue
              try {
                await frame.executeJavaScript(HUMAN_SIM_JS).catch(() => {})
                const fOffShelf = await frame.executeJavaScript(`
                  (function() {
                    var bodyText = (document.body?.innerText || '');
                    var offShelfKeywords = ['已下架', '商品已下架', '宝贝不存在', '商品不存在', '已失效', '商品已失效', '已卖完', '暂时缺货', '该商品已下架', '商品已售罄', '此商品已下架', '页面不存在', '无法购买'];
                    var matchedKeyword = '';
                    for (var i = 0; i < offShelfKeywords.length; i++) {
                      if (bodyText.includes(offShelfKeywords[i])) {
                        matchedKeyword = offShelfKeywords[i];
                        break;
                      }
                    }
                    if (!matchedKeyword) return { offShelf: false, keyword: '' };
                    var buyFound = _hs.findVisible(['button', 'a', '[class*="btn"]', '[class*="Button"]', '[role="button"]', '[class*="action"]', '[class*="submit"]'], ['领券购买', '立即购买', '加入购物车', '马上抢', '立刻购买', '加购', '去购买']);
                    if (buyFound.length > 0) return { offShelf: false, keyword: '' };
                    return { offShelf: true, keyword: matchedKeyword };
                  })()
                `)
                if (fOffShelf?.offShelf) { offShelfResult = fOffShelf; break }
              } catch { /* ignore */ }
            }
          }
        } catch { /* ignore */ }

        if (offShelfResult?.offShelf) {
          resolved = true
          clearTimeout(timeout)
          clearInterval(checkInterval)
          this.closeShopWindow()
          this.emitStatus(`商品不可购买（${offShelfResult.keyword}）`)
          resolve({ success: false, error: `商品不可购买（${offShelfResult.keyword}）` })
          return
        }

        await tryClickRebuy()
      })

      const checkInterval = setInterval(async () => {
        if (resolved || this.destroyed) { clearInterval(checkInterval); return }
        try {
          const url = this.shopWindow?.webContents.getURL()
          if (!url) return

          if (cartOnly && (url.includes('trade.tmall.com') || url.includes('trade.taobao.com') || url.includes('orderDetail'))) {
            const intervalCartResult = await this.shopWindow?.webContents.executeJavaScript(`
              (function() {
                var successHints = ['已加入购物车', '添加成功', '成功加入', '加入成功', '已添加至购物车'];
                var errorHints = ['不能购买', '无法购买', '已下架', '已失效', '已售罄', '宝贝不存在', '商品不存在', '已卖完', '缺货', '不能买了', '无法加购', '加购失败', '添加失败', '操作失败'];
                var toastSelectors = '[class*="toast"], [class*="Toast"], [class*="message"], [class*="Message"], [class*="notice"], [class*="Notice"], [class*="success"], [class*="Success"], [class*="dialog"], [class*="Dialog"], [class*="error"], [class*="Error"], [class*="warning"], [class*="Warning"], [class*="popup"], [class*="Popup"], [class*="layer"], [class*="Layer"], [class*="modal"], [class*="Modal"]';
                var toastEls = document.querySelectorAll(toastSelectors);
                for (var k = 0; k < toastEls.length; k++) {
                  var t = (toastEls[k].textContent || '').trim();
                  for (var i = 0; i < errorHints.length; i++) {
                    if (t.includes(errorHints[i])) return { type: 'error', hint: errorHints[i] };
                  }
                  for (var j = 0; j < successHints.length; j++) {
                    if (t.includes(successHints[j])) return { type: 'success' };
                  }
                  if (t.includes('购物车') && (t.includes('成功') || t.includes('已'))) return { type: 'success' };
                }
                var bodyText = (document.body?.innerText || '');
                for (var m = 0; m < errorHints.length; m++) {
                  if (bodyText.includes(errorHints[m])) return { type: 'error', hint: errorHints[m] };
                }
                for (var n = 0; n < successHints.length; n++) {
                  if (bodyText.includes(successHints[n])) return { type: 'success' };
                }
                return null;
              })()
            `).catch(() => null)
            if (intervalCartResult?.type === 'success') {
              resolved = true
              clearTimeout(timeout)
              clearInterval(checkInterval)
              await this.syncCookiesFromElectron()
              this.closeShopWindow()
              this.emitStatus('已加入购物车')
              resolve({ success: true, directToPay: false })
              return
            }
            if (intervalCartResult?.type === 'error') {
              resolved = true
              clearTimeout(timeout)
              clearInterval(checkInterval)
              this.closeShopWindow()
              const errorMsg = `商品不可购买（${intervalCartResult.hint}）`
              this.emitStatus(errorMsg)
              resolve({ success: false, error: errorMsg })
              return
            }
          }

          if (this.isCheckoutOrPayPage(url) || url.includes('buy.tmall.com') || url.includes('buy.taobao.com')) {
            resolved = true
            clearTimeout(timeout)
            clearInterval(checkInterval)
            await this.syncCookiesFromElectron()
            if (cartOnly) {
              this.closeShopWindow()
              this.emitStatus('该商品不支持加入购物车，点击后直接进入了结算页面')
              resolve({ success: false, error: '该商品不支持加入购物车，点击后直接进入了结算页面' })
            } else {
              this.emitStatus('已进入结算页面')
              resolve({ success: true, directToPay: true })
            }
          } else if (url.includes('cart.taobao.com')) {
            resolved = true
            clearTimeout(timeout)
            clearInterval(checkInterval)
            await this.syncCookiesFromElectron()
            this.emitStatus('已加入购物车')
            resolve({ success: true, directToPay: false })
          } else if (url.includes('item.taobao.com') || url.includes('detail.tmall.com')) {
            const offShelfCheck = await this.execJS(this.shopWindow, `
              (function() {
                var bodyText = (document.body?.innerText || '');
                var keywords = ['已下架', '商品已下架', '宝贝不存在', '商品不存在', '已失效', '商品已失效', '已卖完', '暂时缺货', '该商品已下架', '商品已售罄', '此商品已下架', '页面不存在', '无法购买'];
                var matchedKeyword = '';
                for (var i = 0; i < keywords.length; i++) {
                  if (bodyText.includes(keywords[i])) {
                    matchedKeyword = keywords[i];
                    break;
                  }
                }
                if (!matchedKeyword) return '';
                var buyFound = _hs.findVisible(['button', 'a', '[class*="btn"]', '[class*="Button"]', '[role="button"]', '[class*="action"]', '[class*="submit"]'], ['领券购买', '立即购买', '加入购物车', '马上抢', '立刻购买', '加购', '去购买']);
                if (buyFound.length > 0) return '';
                return matchedKeyword;
              })()
            `).catch(() => '')
            if (offShelfCheck) {
              resolved = true
              clearTimeout(timeout)
              clearInterval(checkInterval)
              this.closeShopWindow()
              this.emitStatus(`商品不可购买（${offShelfCheck}）`)
              resolve({ success: false, error: `商品不可购买（${offShelfCheck}）` })
            }
          }
        } catch { /* ignore */ }
      }, 2000)

      this.shopWindow.on('closed', async () => {
        if (!resolved) {
          resolved = true
          clearTimeout(timeout)
          clearInterval(checkInterval)
          await this.syncCookiesFromElectron()
          this.shopWindow = null
          resolve(null)
        }
      })
    })
  }

  private async closeShopWindow() {
    if (this.shopWindow && !this.shopWindow.isDestroyed()) {
      try {
        await this.syncCookiesFromElectron()
      } catch { /* ignore */ }
      this.shopWindow.close()
    }
    this.shopWindow = null
  }

  private async addToCartViaPlaywright(productUrl: string, orderId: string): Promise<AddToCartResult> {
    await this.ensureBrowser()
    if (!this.page) return { success: false, error: '浏览器未初始化' }

    try {
      const bizOrderId = orderId.replace(/_\d+$/, '')
      const detailUrl = `https://buyertrade.taobao.com/trade/detail/trade_item_detail.htm?bizOrderId=${bizOrderId}`
      console.log(`[Taobao] Playwright: Opening order detail: ${detailUrl}`)
      this.emitStatus('正在打开订单详情页（Playwright）...')
      await this.page.goto(detailUrl, { waitUntil: 'domcontentloaded', timeout: 30000 })

      const pageUrl = this.page.url()
      console.log(`[Taobao] Page URL after navigation: ${pageUrl}`)
      if (pageUrl.includes('login.taobao.com')) {
        this.emitStatus('登录已过期，请重新登录')
        return { success: false, error: '登录已过期' }
      }

      this.emitStatus('正在等待页面加载...')
      try {
        await this.page.waitForFunction(
          () => {
            const text = document.body?.innerText || ''
            return !text.includes('努力加载中') && text.length > 100
          },
          { timeout: 15000 }
        )
      } catch {
        console.log('[Taobao] waitForFunction timeout, proceeding anyway')
      }

      await this.page.evaluate(() => _hs.scrollSmooth(document.body.scrollHeight))
      await this.humanDelay(2000)
      await this.page.evaluate(() => _hs.scrollSmooth(0))
      await this.humanDelay(1000)

      this.emitStatus('正在查找再买一单按钮...')
      const clicked = await this.clickRebuyButton()
      if (clicked) {
        const result = await this.detectPageAfterRebuy()
        if (result) return result
      }

      this.emitStatus('未找到再买一单按钮，滚动页面重试...')
      await this.page.evaluate(async () => {
        const scrollHeight = document.body.scrollHeight
        const step = window.innerHeight
        for (let y = step; y < scrollHeight; y += step) {
          await _hs.scrollSmooth(y, _hs.rand(200, 500))
          await _hs.delay(50, 200)
        }
        await _hs.scrollSmooth(0, _hs.rand(400, 800))
      })
      await this.humanDelay(3000)

      const retryClicked = await this.clickRebuyButton()
      if (retryClicked) {
        const result = await this.detectPageAfterRebuy()
        if (result) return result
      }

      this.emitStatus('再次等待页面加载...')
      await this.humanDelay(5000)

      const retry2Clicked = await this.clickRebuyButton()
      if (retry2Clicked) {
        const result = await this.detectPageAfterRebuy()
        if (result) return result
      }

      return await this.fallbackManualAddToCart(productUrl)
    } catch (e) {
      console.log(`[Taobao] Playwright addToCart error: ${e}`)
      this.emitStatus(`再买一单失败: ${e}`)
      return { success: false, error: String(e) }
    }
  }

  private async detectPageAfterRebuy(): Promise<AddToCartResult | null> {
    if (!this.page || !this.context) return null

    const popupPromise = this.page.waitForEvent('popup', { timeout: 5000 }).catch(() => null)
    await this.humanDelay(3000)
    const popup = await popupPromise

    if (popup) {
      const popupUrl = popup.url()
      console.log(`[Taobao] New popup opened: ${popupUrl}`)

      if (this.isIdentityVerifyPage(popupUrl)) {
        console.log(`[Taobao] Identity verification required, showing to user`)
        const verifyResult = await this.handleIdentityVerification(popup)
        if (verifyResult) return verifyResult
      }

      try {
        await popup.waitForLoadState('domcontentloaded', { timeout: 10000 })
      } catch { /* ignore */ }
      const loadedUrl = popup.url()
      if (this.isCheckoutOrPayPage(loadedUrl)) {
        this.page = popup
        this.emitStatus('已进入结算页面')
        return { success: true, directToPay: true }
      }
      if (loadedUrl.includes('cart.taobao.com')) {
        this.page = popup
        this.emitStatus('已加入购物车')
        return { success: true, directToPay: false }
      }
    }

    const allPages = this.context.pages()
    for (const p of allPages) {
      if (p === this.page || p === popup) continue
      const pUrl = p.url()
      if (this.isCheckoutOrPayPage(pUrl)) {
        this.page = p
        this.emitStatus('已进入结算页面（新标签页）')
        return { success: true, directToPay: true }
      }
      if (pUrl.includes('cart.taobao.com')) {
        this.page = p
        this.emitStatus('已加入购物车（新标签页）')
        return { success: true, directToPay: false }
      }
    }

    const afterUrl = this.page.url()
    console.log(`[Taobao] After rebuy click, URL: ${afterUrl}`)
    if (this.isCheckoutOrPayPage(afterUrl)) {
      this.emitStatus('已进入结算页面')
      return { success: true, directToPay: true }
    }
    if (afterUrl.includes('cart.taobao.com')) {
      this.emitStatus('已加入购物车')
      return { success: true, directToPay: false }
    }

    const hasCheckoutButton = await this.page.evaluate(() => {
      const targets = ['免密支付', '立即支付', '提交订单', '确认订单', '立即付款', '去支付']
      for (const el of document.querySelectorAll('button, a, [role="button"], span, div')) {
        const text = (el.textContent || '').trim().replace(/\s+/g, '')
        if (targets.some(t => text.includes(t))) {
          const rect = el.getBoundingClientRect()
          if (rect.width > 0 && rect.height > 0) return true
        }
      }
      return false
    })

    if (hasCheckoutButton) {
      console.log(`[Taobao] Checkout button found on current page, treating as directToPay`)
      this.emitStatus('已进入结算页面')
      return { success: true, directToPay: true }
    }

    this.emitStatus('已加入购物车')
    return { success: true, directToPay: false }
  }

  private isIdentityVerifyPage(url: string): boolean {
    return url.includes('passport.taobao.com/iv/') ||
      url.includes('identity_verify') ||
      url.includes('iv/identity')
  }

  private async handleIdentityVerification(verifyPage: Page): Promise<AddToCartResult | null> {
    this.emitStatus('需要进行身份验证，请在弹出的窗口中完成验证...')

    await this.syncCookiesToElectron()

    if (this.mainWindow) {
      await dialog.showMessageBox(this.mainWindow, {
        type: 'info',
        title: '需要身份验证',
        message: '淘宝要求进行身份验证',
        detail: '点击"再买一单"后，淘宝需要进行身份验证才能继续。\n\n即将打开验证页面，请完成验证（扫码或输入验证码）。\n验证完成后将自动继续购买流程。',
        buttons: ['知道了'],
        noLink: true,
      })
    }

    const verifyUrl = verifyPage.url()
    console.log(`[Taobao] Opening identity verification in Electron window: ${verifyUrl}`)

    return new Promise<AddToCartResult | null>((resolve) => {
      if (!this.mainWindow) {
        resolve(null)
        return
      }

      const verifyWindow = new BrowserWindow({
        width: 500,
        height: 600,
        title: '淘宝身份验证',
        icon: APP_ICON,
        parent: this.mainWindow,
        modal: true,
        autoHideMenuBar: true,
        webPreferences: {
          nodeIntegration: false,
          contextIsolation: true,
        },
      })
      this.setUserAgent(verifyWindow)
      verifyWindow.loadURL(verifyUrl)

      let resolved = false
      const timeout = setTimeout(() => {
        if (!resolved) {
          resolved = true
          if (!verifyWindow.isDestroyed()) verifyWindow.close()
          this.emitStatus('身份验证超时')
          resolve({ success: false, error: '身份验证超时' })
        }
      }, 1800000)

      const checkInterval = setInterval(async () => {
        if (resolved || this.destroyed) { clearInterval(checkInterval); return }
        try {
          const winUrl = verifyWindow.webContents.getURL()
          if (this.isCheckoutOrPayPage(winUrl) || winUrl.includes('cart.taobao.com') ||
              winUrl.includes('buy.tmall.com') || winUrl.includes('buy.taobao.com')) {
            resolved = true
            clearTimeout(timeout)
            clearInterval(checkInterval)
            await this.syncCookiesFromElectron()
            if (!verifyWindow.isDestroyed()) verifyWindow.close()

            const directToPay = this.isCheckoutOrPayPage(winUrl)
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
          await this.syncCookiesFromElectron()

          try {
            await this.humanDelay(3000)
            const allPages = this.context!.pages()
            for (const p of allPages) {
              const pUrl = p.url()
              if (this.isCheckoutOrPayPage(pUrl)) {
                this.page = p
                this.emitStatus('验证成功，已进入结算页面')
                resolve({ success: true, directToPay: true })
                return
              }
              if (pUrl.includes('cart.taobao.com')) {
                this.page = p
                this.emitStatus('验证成功，已加入购物车')
                resolve({ success: true, directToPay: false })
                return
              }
            }

            const mainUrl = this.page!.url()
            if (this.isCheckoutOrPayPage(mainUrl)) {
              this.emitStatus('验证成功，已进入结算页面')
              resolve({ success: true, directToPay: true })
              return
            }
          } catch { /* ignore */ }

          this.emitStatus('用户关闭了验证窗口')
          resolve({ success: false, error: '用户取消了身份验证' })
        }
      })
    })
  }

  private isCheckoutOrPayPage(url: string): boolean {
    return url.includes('buy.tmall.com') ||
      url.includes('buy.taobao.com') ||
      url.includes('order.tmall.com') ||
      url.includes('order.taobao.com') ||
      url.includes('cashier') ||
      url.includes('checkout') ||
      url.includes('settlement') ||
      url.includes('submitOrder')
  }

  private isLoginPage(url: string): boolean {
    return url.includes('login.taobao.com') ||
      url.includes('login.tmall.com') ||
      url.includes('havanaone/login')
  }

  private async detectCaptcha(win: BrowserWindow): Promise<boolean> {
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

  private async tryAutoLoginThenShow(win: BrowserWindow): Promise<void> {
    this.lastCookieToElectronSyncTime = 0
    await this.syncCookiesToElectron()

    const currentUrl = win.webContents.getURL()
    if (!this.isLoginPage(currentUrl)) {
      this.emitStatus('Cookie 已同步，页面已自动跳转')
      win.show()
      return
    }

    try {
      const referrer = win.webContents.getURL()
      await win.loadURL(referrer)
      await new Promise(r => setTimeout(r, 3000))

      if (!this.isLoginPage(win.webContents.getURL())) {
        this.emitStatus('Cookie 已同步，页面已自动跳转')
        win.show()
        return
      }
    } catch { /* ignore */ }

    this.emitStatus('登录已过期，请在弹出的窗口中重新登录...')
    win.setSize(900, 700)
    win.setTitle('淘宝登录 - 请重新登录')
    if (this.mainWindow) win.setParentWindow(this.mainWindow)
    this.injectOverlayBanner(win, "🔑 自动购物助手：登录已过期，请在下方重新登录后继续")
    win.show()
  }

  private async fallbackManualAddToCart(productUrl?: string): Promise<AddToCartResult> {
    if (!this.page) return { success: false, error: '浏览器未初始化' }

    this.emitStatus('自动再买一单失败，请在弹出的窗口中手动操作...')

    const orderDetailUrl = this.page.url()

    try {
      await this.syncCookiesToElectron()

      if (this.mainWindow) {
        await dialog.showMessageBox(this.mainWindow, {
          type: 'info',
          title: '需要手动操作',
          message: '自动"再买一单"失败',
          detail: '该订单可能因商品下架、SKU变更等原因无法自动再买一单。\n\n即将打开您的购买记录详情页，请您手动操作下单。\n加入购物车后，窗口会自动关闭并继续后续流程。',
          buttons: ['知道了'],
          noLink: true,
        })
      }

      return new Promise<AddToCartResult>((resolve) => {
        if (!this.mainWindow) {
          resolve({ success: false, error: '主窗口未就绪' })
          return
        }

        const manualWindow = new BrowserWindow({
          width: 900,
          height: 750,
          title: '手动加入购物车',
          icon: APP_ICON,
          parent: this.mainWindow,
          modal: true,
          autoHideMenuBar: true,
          webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
          },
        })
        this.setUserAgent(manualWindow)
        manualWindow.loadURL(orderDetailUrl)

        let resolved = false
        const timeout = setTimeout(() => {
          if (!resolved) {
            resolved = true
            if (!manualWindow.isDestroyed()) manualWindow.close()
            this.emitStatus('手动操作超时')
            resolve({ success: false, error: '手动操作超时' })
          }
        }, 1800000)

        const checkDone = setInterval(async () => {
          if (resolved) return
          try {
            const pageUrl = manualWindow.webContents.getURL()
            if (pageUrl.includes('cart.taobao.com')) {
              resolved = true
              clearTimeout(timeout)
              clearInterval(checkDone)
              await this.syncCookiesFromElectron()
              if (!manualWindow.isDestroyed()) manualWindow.close()
              this.emitStatus('已加入购物车')
              resolve({ success: true, directToPay: false })
            } else if (this.isCheckoutOrPayPage(pageUrl)) {
              resolved = true
              clearTimeout(timeout)
              clearInterval(checkDone)
              await this.syncCookiesFromElectron()
              if (!manualWindow.isDestroyed()) manualWindow.close()
              this.emitStatus('已进入结算页面')
              resolve({ success: true, directToPay: true })
            }
          } catch { /* ignore */ }
        }, 2000)

        manualWindow.on('closed', async () => {
          if (!resolved) {
            resolved = true
            clearTimeout(timeout)
            clearInterval(checkDone)
            await this.syncCookiesFromElectron()
            this.emitStatus('用户关闭了手动操作窗口')
            resolve({ success: false, error: '用户关闭了窗口' })
          }
        })
      })
    } catch (e) {
      this.emitStatus(`手动操作失败: ${e}`)
      return { success: false, error: String(e) }
    }
  }

  private async clickRebuyButton(): Promise<boolean> {
    if (!this.page) return false

    const targets = ['再买一单', '再次购买', '再来一单', '重新购买', '去购买', '立即购买', '再次下单', '追加购买']

    try {
      const frames = this.page.frames()
      console.log(`[Taobao] clickRebuyButton: searching ${frames.length} frames, targets: ${targets.join(',')}`)

      for (const frame of frames) {
        try {
          await frame.evaluate(HUMAN_SIM_JS).catch(() => {})
          const diag = await frame.evaluate(() => {
            const targets = ['再买一单', '再次购买', '再来一单', '重新购买', '去购买', '立即购买', '再次下单', '追加购买']
            const nearMatches: { tag: string; text: string; cls: string; rect: string }[] = []

            const found = _hs.findVisible(['button', 'a', '[class*="btn"]', '[class*="Button"]', '[role="button"]', '[class*="action"]', '[class*="submit"]'], targets)
            for (const item of found) {
              nearMatches.push({
                tag: item.el.tagName,
                text: item.text.substring(0, 60),
                cls: (item.el as HTMLElement).className?.substring?.(0, 80) || '',
                rect: `${Math.round(item.rect.width)}x${Math.round(item.rect.height)}@${Math.round(item.rect.x)},${Math.round(item.rect.y)}`,
              })
            }

            return { nearMatches, bodyLen: document.body?.innerText?.length || 0 }
          })

          console.log(`[Taobao] Frame ${frame.url().substring(0, 80)} nearMatches (${diag.nearMatches.length}):`)
          for (const m of diag.nearMatches) {
            console.log(`  ${m.tag} "${m.text}" cls="${m.cls}" rect=${m.rect}`)
          }

          if (diag.nearMatches.length > 0) {
            const clicked = await frame.evaluate(() => {
              const targets = ['再买一单', '再次购买', '再来一单', '重新购买', '去购买', '立即购买', '再次下单', '追加购买']
              const result = _hs.findAndClick(
                ['button', 'a', '[class*="btn"]', '[class*="Button"]', '[role="button"]', '[class*="action"]', '[class*="submit"]'],
                targets
              )

              if (result) {
                return { clicked: true, tag: result.el.tagName, text: result.text.substring(0, 40), area: result.area }
              }

              return { clicked: false }
            })

            console.log(`[Taobao] clickRebuyButton click result:`, JSON.stringify(clicked))
            if (clicked.clicked) return true
          }
        } catch (e) {
          console.log(`[Taobao] clickRebuyButton frame error: ${e}`)
        }
      }

      console.log(`[Taobao] clickRebuyButton: text search failed, trying CSS selectors...`)

      const cssSelectors = TAOBAO_SELECTORS.ORDER_DETAIL.REBUY_SELECTORS
      for (const frame of frames) {
        try {
          await frame.evaluate(HUMAN_SIM_JS).catch(() => {})
          const cssResult = await frame.evaluate((selectors: string[]) => {
            for (const sel of selectors) {
              try {
                const el = document.querySelector(sel) as HTMLElement | null
                if (el) {
                  const rect = el.getBoundingClientRect()
                  if (rect.width > 0 && rect.height > 0) {
                    _hs.click(el)
                    return { clicked: true, selector: sel, tag: el.tagName, text: (el.textContent || '').trim().substring(0, 40) }
                  }
                }
              } catch { /* ignore */ }
            }
            return { clicked: false }
          }, cssSelectors)

          console.log(`[Taobao] clickRebuyButton CSS result:`, JSON.stringify(cssResult))
          if (cssResult.clicked) return true
        } catch (e) {
          console.log(`[Taobao] clickRebuyButton CSS frame error: ${e}`)
        }
      }

      console.log(`[Taobao] clickRebuyButton: no button found with any method`)
      return false
    } catch (e) {
      console.log(`[Taobao] clickRebuyButton error: ${e}`)
    }

    return false
  }

  async checkout(directToPay = false, quantity = 1): Promise<CheckoutResult> {
    this.emitStatus('正在结算...')

    try {
      if (this.shopWindow && !this.shopWindow.isDestroyed()) {
        console.log(`[Taobao] checkout: using existing shopWindow, quantity=${quantity}`)
        return await this.checkoutViaElectron(directToPay, quantity)
      }

      await this.ensureBrowser()
      if (!this.page) return { success: false, error: '浏览器未初始化' }

      const currentUrl = this.page.url()
      console.log(`[Taobao] checkout: currentUrl=${currentUrl}, directToPay=${directToPay}`)

      if (this.isLoginPage(currentUrl)) {
        return { success: false, error: '登录已过期，请重新登录' }
      }

      if (directToPay || this.isCheckoutOrPayPage(currentUrl)) {
        console.log(`[Taobao] Already on checkout/pay page, submitting order directly`)
        return await this.submitOrder()
      }

      if (!currentUrl.includes('cart.taobao.com')) {
        this.emitStatus('正在跳转购物车...')
        await this.page.goto(TAOBAO_SELECTORS.CART.URL, { waitUntil: 'domcontentloaded', timeout: 30000 })
      }

      await this.humanDelay(2000)

      if (this.isLoginPage(this.page.url())) {
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
      await this.humanDelay(3000)

      const afterUrl = this.page.url()
      if (this.isCheckoutOrPayPage(afterUrl)) {
        return await this.submitOrder()
      }

      return { success: true }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  }

  private async checkoutViaElectron(directToPay: boolean, quantity: number): Promise<CheckoutResult> {
    if (!this.shopWindow || this.shopWindow.isDestroyed()) {
      return { success: false, error: '购物窗口已关闭' }
    }

    const wc = this.shopWindow.webContents
    const currentUrl = wc.getURL()
    console.log(`[Taobao] checkoutViaElectron: currentUrl=${currentUrl}, directToPay=${directToPay}, quantity=${quantity}`)

    if (this.isLoginPage(currentUrl)) {
      this.closeShopWindow()
      return { success: false, error: '登录已过期，请重新登录' }
    }

    if (directToPay || this.isCheckoutOrPayPage(currentUrl)) {
      this.emitStatus('已到达确认订单页面')
      return { success: true }
    }

    if (!currentUrl.includes('cart.taobao.com')) {
      this.emitStatus('正在跳转购物车...')
      await wc.loadURL(TAOBAO_SELECTORS.CART.URL)
      await this.humanDelay(3000)

      if (this.isLoginPage(wc.getURL())) {
        this.closeShopWindow()
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
      this.closeShopWindow()
      return { success: false, error: '未找到结算按钮' }
    }

    this.emitStatus('正在等待确认订单页面加载...')
    return await this.waitForCheckoutPage(quantity)
  }

  private async waitForCheckoutPage(quantity = 1): Promise<CheckoutResult> {
    for (let attempt = 0; attempt < 15; attempt++) {
      const delay = attempt === 0 ? 500 : 1500
      await this.humanDelay(delay)

      if (!this.shopWindow || this.shopWindow.isDestroyed()) {
        return { success: false, error: '购物窗口已关闭' }
      }

      try {
        const diag = await this.shopWindow.webContents.executeJavaScript(`
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
          this.emitStatus('已到达确认订单页面')
          return { success: true }
        }
      } catch (e) {
        console.log(`[Taobao] waitForCheckoutPage error: ${e}`)
      }
    }

    this.closeShopWindow()
    return { success: false, error: '确认订单页面加载超时' }
  }

  private async setQuantity(quantity: number): Promise<void> {
    if (!this.shopWindow || this.shopWindow.isDestroyed()) return

    this.emitStatus(`正在修改数量为 ${quantity}...`)
    try {
      const result = await this.execJS(this.shopWindow, `
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
        await this.humanDelay(1000)
      }
    } catch (e) {
      console.log(`[Taobao] setQuantity error: ${e}`)
    }
  }

  private async clickInShopWindow(selectors: string[], textTargets: string[]): Promise<{ clicked: boolean; selector?: string; text?: string }> {
    if (!this.shopWindow || this.shopWindow.isDestroyed()) return { clicked: false }

    try {
      const result = await this.humanClickElement(this.shopWindow, selectors, textTargets)
      if (result.clicked) {
        return { clicked: true, selector: 'humanClick', text: result.text?.substring(0, 30) }
      }

      const fallbackResult = await this.execJS(this.shopWindow, `
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
        await this.humanClickAt(this.shopWindow, fallbackResult.x, fallbackResult.y)
        return { clicked: true, selector: 'text:' + (fallbackResult.text || '').substring(0, 20), text: fallbackResult.text?.substring(0, 30) }
      }
      return { clicked: false }
    } catch (e) {
      console.log(`[Taobao] clickInShopWindow error: ${e}`)
      return { clicked: false }
    }
  }

  private async submitOrder(): Promise<CheckoutResult> {
    const orderDiag = await this.page!.evaluate(() => {
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
      await this.humanDelay(2000)
      this.emitStatus('订单已提交')
      return { success: true }
    }

    return { success: false, error: '未找到提交订单按钮' }
  }

  private async clickButtonByTextOrSelector(selectors: string[], textTargets: string[]): Promise<{ clicked: boolean; selector?: string; text?: string }> {
    if (!this.page) return { clicked: false }

    if (this.isLoginPage(this.page.url())) {
      console.log(`[Taobao] clickButtonByTextOrSelector: on login page, skipping`)
      return { clicked: false }
    }

    for (const frame of this.page.frames()) {
      try {
        const frameUrl = frame.url()
        if (this.isLoginPage(frameUrl)) continue

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

  async pay(totalAmount?: number, dryRun?: boolean, paymentMode?: string): Promise<PayResult> {
    if (dryRun) {
      this.emitStatus(`测试模式：跳过实际支付（预计金额 ¥${totalAmount?.toFixed(2)}）`)
      if (this.shopWindow && !this.shopWindow.isDestroyed()) {
        this.closeShopWindow()
      }
      return { success: true, transactionId: 'TEST_MODE_SKIPPED' }
    }

    if (!this.shopWindow || this.shopWindow.isDestroyed()) {
      return { success: false, error: '没有可用的支付窗口' }
    }

    const payFreeLimit = parseFloat(this.db.getSetting('pay_free_limit') || '0') || 0
    const exceedsLimit = payFreeLimit > 0 && totalAmount !== undefined && totalAmount > payFreeLimit

    if (exceedsLimit) {
      this.shopWindow.setSize(1100, 800)
      this.shopWindow.setTitle(`金额超过免密支付上限 - 需要手动确认付款`)
      if (this.mainWindow) this.shopWindow.setParentWindow(this.mainWindow)
      const bannerMsg = `⚠️ 自动支付已暂停：订单金额 ¥${totalAmount!.toFixed(2)} 超过免密支付上限 ¥${payFreeLimit.toFixed(2)}，为保障资金安全需要您手动确认。请在下方完成付款后点击"已完成"`
      this.injectOverlayBanner(this.shopWindow, bannerMsg)
      this.shopWindow.show()
      const confirmed = await this.waitForUserConfirmation(
        this.shopWindow,
        `订单金额 ¥${totalAmount!.toFixed(2)} 超过免密支付上限 ¥${payFreeLimit.toFixed(2)}，为保障资金安全需要您手动确认付款。请在弹出的窗口中完成支付，然后点击"已完成"`,
        `金额超过免密支付上限 - 需要手动确认付款`,
        bannerMsg,
      )
      if (confirmed) {
        await this.syncCookiesFromElectron()
        this.closeShopWindow()
        this.emitStatus('支付完成')
        return { success: true }
      }
      return { success: false, error: '支付未完成' }
    }

    this.emitStatus(totalAmount !== undefined
      ? `正在自动支付（¥${totalAmount.toFixed(2)}）...`
      : '正在自动支付...'
    )

    try {
      const payResult = await this.clickInShopWindow(
        TAOBAO_SELECTORS.CHECKOUT.SUBMIT_ORDER_SELECTORS as unknown as string[],
        ['免密支付', '立即支付', '确认支付', '提交订单', '确认订单', '去支付', '立即付款']
      )
      console.log(`[Taobao] Electron auto pay result:`, JSON.stringify(payResult))
      if (payResult.clicked) {
        await this.humanDelay(3000)

        if (this.shopWindow && !this.shopWindow.isDestroyed()) {
          const currentUrl = this.shopWindow.webContents.getURL()
          if (this.isIdentityVerifyPage(currentUrl) || currentUrl.includes('nocaptcha') || currentUrl.includes('slider')) {
            await this.shopWindow.webContents.executeJavaScript(`
              (function() {
                try {
                  Object.defineProperty(Document.prototype, 'visibilityState', { get: function() { return document.hidden ? 'hidden' : 'visible'; }, configurable: true });
                  Object.defineProperty(Document.prototype, 'hidden', { get: function() { return !document.hasFocus(); }, configurable: true });
                  Object.defineProperty(document, 'visibilityState', { get: function() { return document.hidden ? 'hidden' : 'visible'; }, configurable: true });
                  Object.defineProperty(document, 'hidden', { get: function() { return !document.hasFocus(); }, configurable: true });
                } catch(e) {}
              })()
            `).catch(() => {})
            this.shopWindow.setSize(1100, 800)
            this.shopWindow.setTitle('淘宝安全验证 - 需要手动操作')
            if (this.mainWindow) this.shopWindow.setParentWindow(this.mainWindow)
            const verifyBanner = '🔐 自动支付已暂停：淘宝检测到异常操作，要求进行安全验证。请拖动滑块完成验证，然后点击"已完成"'
            this.injectOverlayBanner(this.shopWindow, verifyBanner)
            this.shopWindow.show()

            const verified = await this.waitForUserConfirmation(
              this.shopWindow,
              '淘宝检测到异常操作，要求进行安全验证（滑块验证）。请在弹出的窗口中拖动滑块完成验证，然后点击"已完成"，系统将继续自动完成后续流程',
              '淘宝安全验证 - 需要手动操作',
              verifyBanner,
            )
            if (verified) {
              await this.syncCookiesFromElectron()
              this.closeShopWindow()
              this.emitStatus('验证完成')
              return { success: true }
            }
            return { success: false, error: '安全验证未完成' }
          }

          const hasCaptcha = await this.shopWindow.webContents.executeJavaScript(`
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
              var captchaHints = ['请拖动', '滑块', '验证', '请完成验证', '安全验证', '拖动滑块'];
              for (var k = 0; k < captchaHints.length; k++) {
                if (bodyText.includes(captchaHints[k])) return { found: true, hint: captchaHints[k], w: 0, h: 0 };
              }
              return { found: false };
            })()
          `)

          if (hasCaptcha && hasCaptcha.found) {
            console.log(`[Taobao] Captcha detected after pay click:`, JSON.stringify(hasCaptcha))
            this.shopWindow.setSize(1100, 800)
            this.shopWindow.setTitle('淘宝安全验证 - 需要手动操作')
            if (this.mainWindow) this.shopWindow.setParentWindow(this.mainWindow)
            const captchaBanner = '🔐 自动支付已暂停：淘宝检测到异常操作，要求进行验证码验证。请完成验证后点击"已完成"，系统将继续自动完成后续流程'
            this.injectOverlayBanner(this.shopWindow, captchaBanner)
            this.shopWindow.show()

            const verified = await this.waitForUserConfirmation(
              this.shopWindow,
              '淘宝检测到异常操作，要求进行验证码验证。请在弹出的窗口中完成验证（滑块或验证码），然后点击"已完成"，系统将继续自动完成后续流程',
              '淘宝安全验证 - 需要手动操作',
              captchaBanner,
            )
            if (verified) {
              await this.syncCookiesFromElectron()
              this.closeShopWindow()
              this.emitStatus('验证完成')
              return { success: true }
            }
            return { success: false, error: '安全验证未完成' }
          }

          if (paymentMode === 'auto_pay') {
            this.emitStatus('正在等待支付结果...')
            let paymentWindowShown = false
            for (let i = 0; i < 30; i++) {
              await this.humanDelay(2000)
              if (this.shopWindow.isDestroyed()) break
              const payUrl = this.shopWindow.webContents.getURL()

              if (payUrl.includes('payresult') || payUrl.includes('trade_success') || payUrl.includes('tradeDetail') || payUrl.includes('buyerPaySuccess')) {
                await this.syncCookiesFromElectron()
                this.closeShopWindow()
                this.emitStatus('支付完成')
                return { success: true }
              }

              if (payUrl.includes('cashier') || payUrl.includes('alipay')) {
                if (!paymentWindowShown) {
                  paymentWindowShown = true
                  this.shopWindow.setSize(1100, 800)
                  this.shopWindow.setTitle('需要输入支付密码 - 需要手动操作')
                  if (this.mainWindow) this.shopWindow.setParentWindow(this.mainWindow)
                  this.injectOverlayBanner(this.shopWindow, '💳 自动支付已暂停：订单金额超过免密支付限额，支付宝需要您输入支付密码。请在下方输入密码完成支付，系统将自动检测支付结果')
                  this.shopWindow.show()
                }
                continue
              }

              try {
                const pageText = await this.shopWindow.webContents.executeJavaScript(`document.body?.innerText?.substring(0, 500) || ''`)
                if (pageText.includes('支付成功') || pageText.includes('交易成功') || pageText.includes('订单已支付') || pageText.includes('付款成功') || pageText.includes('已付款') || pageText.includes('支付完成')) {
                  await this.syncCookiesFromElectron()
                  this.closeShopWindow()
                  this.emitStatus('支付完成')
                  return { success: true }
                }
                if (pageText.includes('支付失败') || pageText.includes('余额不足') || pageText.includes('交易关闭')) {
                  this.closeShopWindow()
                  return { success: false, error: '支付失败：' + pageText.substring(0, 50) }
                }
                if (!paymentWindowShown && (pageText.includes('请输入支付密码') || pageText.includes('请确认支付') || pageText.includes('收银台') || pageText.includes('确认付款'))) {
                  paymentWindowShown = true
                  this.shopWindow.setSize(1100, 800)
                  this.shopWindow.setTitle('需要输入支付密码 - 需要手动操作')
                  if (this.mainWindow) this.shopWindow.setParentWindow(this.mainWindow)
                  this.injectOverlayBanner(this.shopWindow, '💳 自动支付已暂停：订单金额超过免密支付限额，支付宝需要您输入支付密码。请在下方输入密码完成支付，系统将自动检测支付结果')
                  this.shopWindow.show()
                }
              } catch { /* ignore */ }
            }
            this.shopWindow.setSize(1100, 800)
            this.shopWindow.setTitle('支付结果确认 - 需要手动确认')
            if (this.mainWindow) this.shopWindow.setParentWindow(this.mainWindow)
            this.injectOverlayBanner(this.shopWindow, '📋 自动支付超时：系统等待支付结果超过60秒未能自动检测到。请在下方确认是否已完成支付，然后点击"已完成"')
            this.shopWindow.show()
            const confirmed = await this.waitForUserConfirmation(
              this.shopWindow,
              '系统等待支付结果超过60秒未能自动检测到。请在弹出的窗口中确认是否已完成支付，然后点击"已完成"',
              '支付结果确认 - 需要手动确认',
              '📋 自动支付超时：系统等待支付结果超过60秒未能自动检测到。请在下方确认是否已完成支付，然后点击"已完成"',
            )
            if (confirmed) {
              await this.syncCookiesFromElectron()
              this.closeShopWindow()
              this.emitStatus('支付完成')
              return { success: true }
            }
            return { success: false, error: '支付未完成' }
          }

          this.shopWindow.setSize(1100, 800)
          this.shopWindow.setTitle('请完成支付 - 需要手动操作')
          if (this.mainWindow) this.shopWindow.setParentWindow(this.mainWindow)
          this.injectOverlayBanner(this.shopWindow, '📋 订单已提交成功，当前支付模式为手动支付，请在下方完成支付后点击"已完成"')
          this.shopWindow.show()

          const confirmed = await this.waitForUserConfirmation(
            this.shopWindow,
            '订单已提交成功，当前支付模式为手动支付，需要您手动完成支付。请在弹出的窗口中完成支付，然后点击"已完成"',
            '请完成支付 - 需要手动操作',
            '📋 订单已提交成功，当前支付模式为手动支付，请在下方完成支付后点击"已完成"',
          )
          if (confirmed) {
            await this.syncCookiesFromElectron()
            this.closeShopWindow()
            this.emitStatus('支付完成')
            return { success: true }
          }
          return { success: false, error: '支付未完成' }
        }

        return { success: false, error: '支付窗口已关闭' }
      }

      this.closeShopWindow()
      return { success: false, error: '未找到支付按钮' }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  }

  async showPaymentWindow(title?: string): Promise<{ paid: boolean }> {
    if (!this.shopWindow || this.shopWindow.isDestroyed()) return { paid: false }
    this.shopWindow.setSize(1100, 800)
    this.shopWindow.setTitle(title || '金额超过免密支付上限 - 需要手动确认付款')
    if (this.mainWindow) {
      this.shopWindow.setParentWindow(this.mainWindow)
    }
    this.injectOverlayBanner(this.shopWindow, title || '💰 自动支付已暂停：金额超过免密支付上限，为保障资金安全需要您手动确认。请在下方完成付款后关闭窗口')
    this.shopWindow.show()

    let paymentDetected = false

    const paymentUrlHandler = () => {
      try {
        const url = this.shopWindow?.webContents?.getURL() || ''
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

    this.shopWindow.webContents.on('did-navigate', didNavigateHandler)
    this.shopWindow.webContents.on('did-navigate-in-page', didNavigateHandler)

    await new Promise<void>((resolve) => {
      const checkClosed = setInterval(() => {
        if (!this.shopWindow || this.shopWindow.isDestroyed()) {
          clearInterval(checkClosed)
          resolve()
        }
      }, 1000)
      this.shopWindow?.on('closed', () => {
        clearInterval(checkClosed)
        resolve()
      })
    })

    try {
      this.shopWindow?.webContents?.removeListener('did-navigate', didNavigateHandler)
      this.shopWindow?.webContents?.removeListener('did-navigate-in-page', didNavigateHandler)
    } catch { /* ignore */ }

    return { paid: paymentDetected }
  }

  private lastCookieToElectronSyncTime = 0

  private async syncCookiesToElectron(): Promise<void> {
    const now = Date.now()
    if (now - this.lastCookieToElectronSyncTime < 500) return

    try {
      let sourceCookies: { name: string; value: string; domain: string; path: string; secure: boolean; httpOnly?: boolean; sameSite?: string; expires?: number }[] = []

      if (this.context) {
        try {
          const pwCookies = await this.context.cookies()
          sourceCookies = pwCookies
            .filter(c => c.domain.includes('taobao') || c.domain.includes('tmall') || c.domain.includes('alipay'))
            .map(c => ({
              name: c.name,
              value: c.value,
              domain: c.domain,
              path: c.path,
              secure: c.secure,
              httpOnly: c.httpOnly,
              sameSite: c.sameSite === 'Strict' ? 'strict' : c.sameSite === 'None' ? 'no_restriction' : 'lax',
              expires: c.expires && c.expires > 0 ? c.expires : undefined,
            }))
        } catch (e) {
          console.log(`[Taobao] syncCookiesToElectron: failed to read Playwright cookies: ${e}`)
        }
      }

      if (sourceCookies.length === 0) {
        const loaded = this.auth.loadCookiesRaw()
        sourceCookies = loaded.filter(
          (c) => c.domain.includes('taobao') || c.domain.includes('tmall') || c.domain.includes('alipay')
        )
      } else {
        const loaded = this.auth.loadCookiesRaw()
        const fileCookies = loaded.filter(
          (c) => c.domain.includes('taobao') || c.domain.includes('tmall') || c.domain.includes('alipay')
        )
        const pwKeySet = new Set(sourceCookies.map(c => `${c.domain}:${c.name}:${c.path}`))
        for (const fc of fileCookies) {
          const key = `${fc.domain}:${fc.name}:${fc.path}`
          if (!pwKeySet.has(key)) {
            sourceCookies.push(fc)
            pwKeySet.add(key)
          }
        }
      }

      const existingCookies = await session.defaultSession.cookies.get({})
      const taobaoExisting = existingCookies.filter(
        (c) => c.domain.includes('taobao') || c.domain.includes('tmall') || c.domain.includes('alipay')
      )

      const normalizeDomain = (d: string) => d.startsWith('.') ? d : '.' + d

      const nowSec = Date.now() / 1000
      const sourceMap = new Map<string, { value: string; expires?: number }>()
      for (const c of sourceCookies) {
        const key = `${normalizeDomain(c.domain)}:${c.name}:${c.path}`
        sourceMap.set(key, { value: c.value, expires: c.expires })
      }

      const sessionOnlyCookies: { name: string; value: string; domain: string; path: string; secure: boolean; httpOnly?: boolean; sameSite?: string; expires?: number }[] = []
      for (const ec of taobaoExisting) {
        const key = `${normalizeDomain(ec.domain)}:${ec.name}:${ec.path}`
        const sourceEntry = sourceMap.get(key)
        if (!sourceEntry) {
          const ecExpired = ec.expirationDate && ec.expirationDate > 0 && ec.expirationDate <= nowSec
          if (!ecExpired) {
            let sameSite: string | undefined
            if (ec.sameSite === 'no_restriction' || ec.sameSite === 'None') {
              sameSite = ec.secure ? 'None' : 'Lax'
            } else if (ec.sameSite === 'strict' || ec.sameSite === 'Strict') {
              sameSite = 'Strict'
            } else if (ec.secure) {
              sameSite = 'None'
            } else {
              sameSite = 'Lax'
            }
            sessionOnlyCookies.push({
              name: ec.name,
              value: ec.value,
              domain: ec.domain,
              path: ec.path,
              secure: ec.secure,
              httpOnly: ec.httpOnly,
              sameSite: sameSite === 'Strict' ? 'strict' : sameSite === 'None' ? 'no_restriction' : 'lax',
              expires: ec.expirationDate && ec.expirationDate > 0 ? ec.expirationDate : undefined,
            })
          }
        } else {
          const sourceExpired = sourceEntry.expires && sourceEntry.expires > 0 && sourceEntry.expires <= nowSec
          const ecExpired = ec.expirationDate && ec.expirationDate > 0 && ec.expirationDate <= nowSec
          if (sourceExpired && !ecExpired) {
            let sameSite: string | undefined
            if (ec.sameSite === 'no_restriction' || ec.sameSite === 'None') {
              sameSite = ec.secure ? 'None' : 'Lax'
            } else if (ec.sameSite === 'strict' || ec.sameSite === 'Strict') {
              sameSite = 'Strict'
            } else if (ec.secure) {
              sameSite = 'None'
            } else {
              sameSite = 'Lax'
            }
            sessionOnlyCookies.push({
              name: ec.name,
              value: ec.value,
              domain: ec.domain,
              path: ec.path,
              secure: ec.secure,
              httpOnly: ec.httpOnly,
              sameSite: sameSite === 'Strict' ? 'strict' : sameSite === 'None' ? 'no_restriction' : 'lax',
              expires: ec.expirationDate && ec.expirationDate > 0 ? ec.expirationDate : undefined,
            })
          }
        }
      }

      if (sessionOnlyCookies.length > 0) {
        if (this.context) {
          const pwCookies = sessionOnlyCookies.map(c => ({
            name: c.name,
            value: c.value,
            domain: c.domain,
            path: c.path,
            secure: c.secure,
            httpOnly: c.httpOnly,
            sameSite: (c.sameSite === 'strict' ? 'Strict' : c.sameSite === 'no_restriction' ? 'None' : 'Lax') as 'Strict' | 'Lax' | 'None',
            ...(c.expires && c.expires > 0 ? { expires: c.expires } : {}),
          }))
          await this.context.addCookies(pwCookies)
        }
        this.auth.saveElectronCookies(taobaoExisting as any)
        sourceCookies = [...sourceCookies, ...sessionOnlyCookies]
        console.log(`[Taobao] syncCookiesToElectron: supplemented ${sessionOnlyCookies.length} cookies from Electron session`)
      }

      if (sourceCookies.length === 0) {
        console.log(`[Taobao] syncCookiesToElectron: no source cookies to sync`)
        return
      }

      const existingMap = new Map<string, { value: string; expirationDate?: number }>()
      for (const c of taobaoExisting) {
        const key = `${normalizeDomain(c.domain)}:${c.name}:${c.path}`
        existingMap.set(key, { value: c.value, expirationDate: c.expirationDate })
      }

      const cookiesToSet: { name: string; value: string; domain: string; path: string; secure: boolean; httpOnly?: boolean; sameSite?: string; expires?: number }[] = []

      for (const cookie of sourceCookies) {
        const key = `${normalizeDomain(cookie.domain)}:${cookie.name}:${cookie.path}`
        const existing = existingMap.get(key)

        if (existing) {
          const sourceExpired = cookie.expires && cookie.expires > 0 && cookie.expires <= nowSec
          const existingExpired = existing.expirationDate && existing.expirationDate > 0 && existing.expirationDate <= nowSec

          if (sourceExpired && !existingExpired) {
            continue
          }

          if (!sourceExpired && existingExpired) {
            cookiesToSet.push(cookie)
            continue
          }

          if (cookie.value !== existing.value) {
            cookiesToSet.push(cookie)
            continue
          }
        } else {
          const sourceExpired = cookie.expires && cookie.expires > 0 && cookie.expires <= nowSec
          if (!sourceExpired) {
            cookiesToSet.push(cookie)
          }
        }
      }

      if (cookiesToSet.length === 0) {
        console.log(`[Taobao] syncCookiesToElectron: all cookies up to date, nothing to sync`)
        return
      }

      console.log(`[Taobao] Syncing ${cookiesToSet.length} cookies to Electron session (out of ${sourceCookies.length} source, ${taobaoExisting.length} existing)`)

      let synced = 0
      for (const cookie of cookiesToSet) {
        try {
          const rawSameSite = (cookie as any).sameSite as string | undefined
          let sameSite: 'unspecified' | 'no_restriction' | 'lax' | 'strict'
          if (rawSameSite && ['unspecified', 'no_restriction', 'lax', 'strict'].includes(rawSameSite)) {
            sameSite = rawSameSite as any
          } else if (cookie.secure) {
            sameSite = 'no_restriction'
          } else {
            sameSite = 'lax'
          }
          if (sameSite === 'no_restriction' && !cookie.secure) {
            sameSite = 'lax'
          }

          await session.defaultSession.cookies.set({
            url: `https://${cookie.domain.replace(/^\./, '')}${cookie.path}`,
            name: cookie.name,
            value: cookie.value,
            domain: cookie.domain,
            path: cookie.path,
            secure: cookie.secure,
            httpOnly: cookie.httpOnly ?? false,
            sameSite,
            expirationDate: cookie.expires && cookie.expires > 0 ? cookie.expires : undefined,
          })
          synced++
        } catch (e) {
          console.log(`[Taobao] Failed to sync cookie ${cookie.name}: ${e}`)
        }
      }
      console.log(`[Taobao] Synced ${synced} cookies to Electron session`)

      this.lastCookieToElectronSyncTime = Date.now()

      if (synced > 0) {
        await this.humanDelay(200)
      }
    } catch (e) {
      console.log(`[Taobao] syncCookiesToElectron error: ${e}`)
    }
  }

  private async syncCookiesFromElectron(): Promise<void> {
    if (this.cookieSyncInProgress) return
    const now = Date.now()
    if (now - this.lastCookieSyncTime < 1000) return

    this.cookieSyncInProgress = true
    try {
      const electronCookies = await session.defaultSession.cookies.get({})
      const taobaoCookies = electronCookies.filter(
        (c) => c.domain.includes('taobao') || c.domain.includes('tmall') || c.domain.includes('alipay')
      )

      if (this.context) {
        const playwrightCookies = taobaoCookies.map((c) => {
          let sameSite: 'Strict' | 'Lax' | 'None' = 'Lax'
          if (c.sameSite === 'no_restriction' || c.sameSite === 'None') {
            sameSite = c.secure ? 'None' : 'Lax'
          } else if (c.sameSite === 'strict' || c.sameSite === 'Strict') {
            sameSite = 'Strict'
          } else if (c.secure) {
            sameSite = 'None'
          }
          return {
            name: c.name,
            value: c.value,
            domain: c.domain,
            path: c.path,
            secure: c.secure,
            httpOnly: c.httpOnly,
            sameSite,
            ...(c.expirationDate && c.expirationDate > 0 ? { expires: c.expirationDate } : {}),
          }
        })
        if (playwrightCookies.length > 0) {
          await this.context.addCookies(playwrightCookies)
        }
      }

      if (taobaoCookies.length > 0) {
        this.auth.saveElectronCookies(taobaoCookies as any)
      }

      this.lastCookieSyncTime = Date.now()
      console.log(`[Taobao] Synced ${taobaoCookies.length} cookies from Electron session`)
    } catch (e) {
      console.log(`[Taobao] syncCookiesFromElectron error: ${e}`)
    } finally {
      this.cookieSyncInProgress = false
    }
  }

  async cleanup(): Promise<void> {
    this.closeShopWindow()
    await this.syncCookiesFromElectron()
  }

  async close() {
    if (this.loginWindow) {
      try { this.loginWindow.close() } catch { /* ignore */ }
      this.loginWindow = null
    }
    this.closeShopWindow()
    try { await this.context?.close() } catch { /* ignore */ }
    try { await this.browser?.close() } catch { /* ignore */ }
    this.browser = null
    this.context = null
    this.page = null
  }
}
