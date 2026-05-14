import { chromium, type Browser, type BrowserContext, type Page } from 'playwright'
import { BrowserWindow, session, dialog, app } from 'electron'
import * as path from 'path'
import * as fs from 'fs'
import type { PlatformAdapter, Order, CheckoutResult, PayResult, AddToCartResult } from '../../../shared/types/platform.types'
import { TAOBAO_SELECTORS } from './taobao.selectors'
import { TaobaoAuth } from './taobao.auth'
import type { Database } from '../../db/database'

const ORDER_API_URL = 'https://buyertrade.taobao.com/trade/itemlist/asyncBought.htm'

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

        if (productName) {
          orders.push({ productName, productUrl, price, imageUrl, orderId, purchasedAt });
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
  private statusCallback: ((status: string) => void) | null = null
  private mainWindow: BrowserWindow | null = null
  private loginWindow: BrowserWindow | null = null

  constructor(db: Database) {
    this.db = db
    this.auth = new TaobaoAuth()
  }

  setMainWindow(win: BrowserWindow) {
    this.mainWindow = win
  }

  onStatusChange(callback: (status: string) => void) {
    this.statusCallback = callback
  }

  private emitStatus(status: string) {
    this.statusCallback?.(status)
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
        ],
      })

      this.browser.on('disconnected', () => {
        this.page = null
        this.context = null
        this.browser = null
      })

      this.context = await this.browser.newContext({
        userAgent:
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        viewport: { width: 1280, height: 800 },
      })

      await this.auth.loadCookies(this.context)

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
      }, 120000)

      const saveCookiesAndClose = async () => {
        if (resolved) return
        resolved = true
        clearTimeout(timeout)

        const allCookies = await session.defaultSession.cookies.get({})
        const taobaoCookies = allCookies.filter(
          (c) => c.domain.includes('taobao') || c.domain.includes('tmall') || c.domain.includes('alipay')
        )

        this.auth.saveElectronCookies(taobaoCookies)
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
      show: false,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
      },
    })

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

  getProductUrl(order: Order): string {
    return order.productUrl
  }

  private shopWindow: BrowserWindow | null = null

  private readonly CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

  private setUserAgent(win: BrowserWindow) {
    win.webContents.setUserAgent(this.CHROME_UA)
  }

  async addToCart(productUrl: string, sku?: string, orderId?: string): Promise<AddToCartResult> {
    this.emitStatus('正在再来一单...')

    console.log(`[Taobao] addToCart called with orderId: "${orderId}"`)

    if (!orderId) {
      this.emitStatus('没有订单号，无法再来一单')
      return { success: false, error: '没有订单号' }
    }

    try {
      const result = await this.runInHiddenWindow(orderId)
      if (result) return result

      return { success: false, error: '再来一单操作超时' }
    } catch (e) {
      console.log(`[Taobao] addToCart error: ${e}`)
      this.emitStatus(`再来一单失败: ${e}`)
      return { success: false, error: String(e) }
    }
  }

  private async runInHiddenWindow(orderId: string): Promise<AddToCartResult | null> {
    if (!this.mainWindow) return null

    const bizOrderId = orderId.replace(/_\d+$/, '')
    const detailUrl = `https://buyertrade.taobao.com/trade/detail/trade_item_detail.htm?bizOrderId=${bizOrderId}`
    console.log(`[Taobao] runInHiddenWindow: ${detailUrl}`)
    this.emitStatus('正在打开订单详情页...')

    await this.syncCookiesToElectron()

    if (this.shopWindow && !this.shopWindow.isDestroyed()) {
      this.shopWindow.close()
      this.shopWindow = null
    }

    return new Promise<AddToCartResult | null>((resolve) => {
      this.shopWindow = new BrowserWindow({
        width: 1280,
        height: 800,
        show: false,
        autoHideMenuBar: true,
        webPreferences: {
          nodeIntegration: false,
          contextIsolation: true,
        },
      })
      this.setUserAgent(this.shopWindow)
      this.shopWindow.loadURL(detailUrl)

      this.shopWindow.webContents.setWindowOpenHandler(({ url: openUrl }) => {
        console.log(`[Taobao] Window open requested: ${openUrl}`)
        return { action: 'allow', overrideBrowserWindowOptions: { show: false } }
      })

      this.shopWindow.webContents.on('did-create-window', (newWindow) => {
        console.log(`[Taobao] Popup window created: ${newWindow.webContents.getURL()}`)
        this.setUserAgent(newWindow)

        const handlePopupUrl = async (popupUrl: string) => {
          if (resolved) return
          console.log(`[Taobao] Popup URL: ${popupUrl}`)

          if (this.isCheckoutOrPayPage(popupUrl) || popupUrl.includes('buy.tmall.com') || popupUrl.includes('buy.taobao.com')) {
            resolved = true
            clearTimeout(timeout)
            clearInterval(checkInterval)
            if (!this.shopWindow?.isDestroyed()) this.shopWindow?.hide()
            this.shopWindow = newWindow
            await this.syncCookiesFromElectron()
            this.emitStatus('已进入结算页面')
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
            newWindow.show()
            return
          }

          if (this.isLoginPage(popupUrl)) {
            console.log(`[Taobao] Login page in popup, showing to user`)
            this.emitStatus('登录已过期，请在弹出的窗口中重新登录...')
            newWindow.setSize(900, 700)
            newWindow.setTitle('淘宝登录 - 请重新登录')
            if (this.mainWindow) {
              newWindow.setParentWindow(this.mainWindow)
            }
            newWindow.show()
            return
          }

          if (popupUrl.includes('taobao.com') && !popupUrl.includes('login') && !popupUrl.includes('item.taobao.com') && !popupUrl.includes('detail.tmall.com')) {
            await this.syncCookiesFromElectron()
            console.log(`[Taobao] Popup navigated to taobao page after login/verify: ${popupUrl}`)
          }

          if (popupUrl.includes('item.taobao.com') || popupUrl.includes('detail.tmall.com')) {
            await new Promise(r => setTimeout(r, 1500))
            try {
              const pageStatus = await newWindow.webContents.executeJavaScript(`
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
                  var hasBuyButton = false;
                  var targets = ['领券购买', '立即购买', '加入购物车', '马上抢', '立刻购买', '加购', '去购买'];
                  var allElements = document.querySelectorAll('*');
                  for (var j = 0; j < allElements.length; j++) {
                    var el = allElements[j];
                    var text = (el.textContent || '').trim();
                    if (!text || text.length > 100) continue;
                    var normalized = text.replace(/\\s+/g, '');
                    if (targets.some(function(t) { return normalized.includes(t); })) {
                      var rect = el.getBoundingClientRect();
                      if (rect.width > 0 && rect.height > 0) {
                        hasBuyButton = true;
                        break;
                      }
                    }
                  }
                  return { offShelf: matchedKeyword !== '', keyword: matchedKeyword, hasBuyButton: hasBuyButton };
                })()
              `)
              console.log(`[Taobao] Popup product page status:`, JSON.stringify(pageStatus))

              if (pageStatus.offShelf && !pageStatus.hasBuyButton) {
                resolved = true
                clearTimeout(timeout)
                clearInterval(checkInterval)
                this.closeShopWindow()
                this.emitStatus(`商品已下架（${pageStatus.keyword}）`)
                resolve({ success: false, error: `商品已下架（${pageStatus.keyword}）` })
                return
              }

              if (pageStatus.hasBuyButton) {
                this.emitStatus('正在点击领券购买...')
                await newWindow.webContents.executeJavaScript(`
                  (function() {
                    var targets = ['领券购买', '立即购买', '加入购物车', '马上抢', '立刻购买', '加购', '去购买'];
                    var allElements = document.querySelectorAll('*');
                    var bestMatch = null;
                    for (var i = 0; i < allElements.length; i++) {
                      var el = allElements[i];
                      var text = (el.textContent || '').trim();
                      if (!text || text.length > 100) continue;
                      var normalized = text.replace(/\\s+/g, '');
                      var isMatch = targets.some(function(t) { return normalized.includes(t); });
                      if (!isMatch) continue;
                      var rect = el.getBoundingClientRect();
                      if (rect.width <= 0 || rect.height <= 0) continue;
                      var area = rect.width * rect.height;
                      if (!bestMatch || area < bestMatch.area) {
                        bestMatch = { el: el, area: area, text: text.substring(0, 30) };
                      }
                    }
                    if (bestMatch) {
                      bestMatch.el.click();
                      return { clicked: true, text: bestMatch.text };
                    }
                    return { clicked: false };
                  })()
                `)
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

        const popupCheck = setInterval(async () => {
          if (resolved || newWindow.isDestroyed()) {
            clearInterval(popupCheck)
            return
          }
          try {
            const popupUrl = newWindow.webContents.getURL()
            await handlePopupUrl(popupUrl)
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
      }, 60000)

      const tryClickRebuy = async () => {
        if (resolved || !this.shopWindow || this.shopWindow.isDestroyed()) return
        try {
          const mainResult = await this.shopWindow.webContents.executeJavaScript(`
            (function() {
              var targets = ['再买一单', '再次购买', '再来一单', '重新购买', '去购买', '立即购买', '再次下单', '追加购买'];
              var allElements = document.querySelectorAll('*');
              var bestMatch = null;
              for (var i = 0; i < allElements.length; i++) {
                var el = allElements[i];
                var text = (el.textContent || '').trim();
                if (!text || text.length > 100) continue;
                var normalized = text.replace(/\\s+/g, '');
                var isMatch = targets.some(function(t) { return normalized.includes(t); });
                if (!isMatch) continue;
                var rect = el.getBoundingClientRect();
                if (rect.width <= 0 || rect.height <= 0) continue;
                var area = rect.width * rect.height;
                if (!bestMatch || area < bestMatch.area) {
                  bestMatch = { el: el, area: area, text: text.substring(0, 30) };
                }
              }
              if (bestMatch) {
                bestMatch.el.click();
                return { clicked: true, text: bestMatch.text };
              }
              return { clicked: false };
            })()
          `)
          console.log(`[Taobao] Main frame rebuy result:`, JSON.stringify(mainResult))

          if (mainResult && mainResult.clicked) {
            this.emitStatus('已点击再买一单，等待页面跳转...')
            return
          }

          const frames = this.shopWindow.webContents.mainFrame.framesInSubtree
          console.log(`[Taobao] Main frame not found, searching ${frames.length} frames...`)
          for (const frame of frames) {
            if (frame === this.shopWindow!.webContents.mainFrame) continue
            try {
              const frameUrl = frame.url
              if (!frameUrl.includes('tmall.com') && !frameUrl.includes('taobao.com')) continue
              const frameResult = await frame.executeJavaScript(`
                (function() {
                  var targets = ['再买一单', '再次购买', '再来一单', '重新购买', '去购买', '立即购买', '再次下单', '追加购买'];
                  var allElements = document.querySelectorAll('*');
                  var bestMatch = null;
                  for (var i = 0; i < allElements.length; i++) {
                    var el = allElements[i];
                    var text = (el.textContent || '').trim();
                    if (!text || text.length > 100) continue;
                    var normalized = text.replace(/\\s+/g, '');
                    var isMatch = targets.some(function(t) { return normalized.includes(t); });
                    if (!isMatch) continue;
                    var rect = el.getBoundingClientRect();
                    if (rect.width <= 0 || rect.height <= 0) continue;
                    var area = rect.width * rect.height;
                    if (!bestMatch || area < bestMatch.area) {
                      bestMatch = { el: el, area: area, text: text.substring(0, 30) };
                    }
                  }
                  if (bestMatch) {
                    bestMatch.el.click();
                    return { clicked: true, text: bestMatch.text };
                  }
                  return { clicked: false };
                })()
              `)
              console.log(`[Taobao] Frame ${frameUrl.substring(0, 80)} result:`, JSON.stringify(frameResult))
              if (frameResult && frameResult.clicked) {
                this.emitStatus('已点击再买一单，等待页面跳转...')
                return
              }
            } catch (e) {
              console.log(`[Taobao] Frame search error: ${e}`)
            }
          }

          resolved = true
          clearTimeout(timeout)
          clearInterval(checkInterval)
          this.closeShopWindow()
          this.emitStatus('该商品所在店铺未开通"再买一单"功能')
          resolve({ success: false, error: '该商品所在店铺未开通"再买一单"功能，这是平台限制而非程序问题' })
        } catch (e) {
          console.log(`[Taobao] Hidden window rebuy click error: ${e}`)
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
        console.log(`[Taobao] Hidden window loaded: ${url}`)

        if (this.isLoginPage(url)) {
          if (loginRetryCount < 1) {
            loginRetryCount++
            console.log(`[Taobao] Login page detected, re-syncing cookies and retrying...`)
            this.emitStatus('检测到登录页面，正在重新同步登录状态...')
            await this.syncCookiesToElectron()
            await new Promise(r => setTimeout(r, 500))
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
          this.emitStatus('已进入结算页面')
          resolve({ success: true, directToPay: true })
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

        let rebuyBtnFound = false
        for (let retry = 0; retry < 10; retry++) {
          try {
            const mainHasBtn = await this.shopWindow?.webContents.executeJavaScript(`
              (function() {
                var targets = ['再买一单', '再次购买', '再来一单', '重新购买', '去购买', '立即购买', '再次下单', '追加购买'];
                var allElements = document.querySelectorAll('*');
                for (var i = 0; i < allElements.length; i++) {
                  var text = (allElements[i].textContent || '').trim();
                  if (!text || text.length > 100) continue;
                  var normalized = text.replace(/\\s+/g, '');
                  for (var j = 0; j < targets.length; j++) {
                    if (normalized.includes(targets[j])) {
                      var rect = allElements[i].getBoundingClientRect();
                      if (rect.width > 0 && rect.height > 0) return true;
                    }
                  }
                }
                return false;
              })()
            `)
            if (mainHasBtn) { rebuyBtnFound = true; break }
            const frames = this.shopWindow!.webContents.mainFrame.framesInSubtree
            for (const frame of frames) {
              if (frame === this.shopWindow!.webContents.mainFrame) continue
              const fUrl = frame.url
              if (!fUrl.includes('tmall.com') && !fUrl.includes('taobao.com')) continue
              try {
                const fHasBtn = await frame.executeJavaScript(`
                  (function() {
                    var targets = ['再买一单', '再次购买', '再来一单', '重新购买', '去购买', '立即购买', '再次下单', '追加购买'];
                    var allElements = document.querySelectorAll('*');
                    for (var i = 0; i < allElements.length; i++) {
                      var text = (allElements[i].textContent || '').trim();
                      if (!text || text.length > 100) continue;
                      var normalized = text.replace(/\\s+/g, '');
                      for (var j = 0; j < targets.length; j++) {
                        if (normalized.includes(targets[j])) {
                          var rect = allElements[i].getBoundingClientRect();
                          if (rect.width > 0 && rect.height > 0) return true;
                        }
                      }
                    }
                    return false;
                  })()
                `)
                if (fHasBtn) { rebuyBtnFound = true; break }
              } catch { /* ignore */ }
            }
          } catch { /* ignore */ }
          if (rebuyBtnFound) break
          await new Promise(r => setTimeout(r, 1000))
        }

        if (!rebuyBtnFound) {
          resolved = true
          clearTimeout(timeout)
          clearInterval(checkInterval)
          this.closeShopWindow()
          this.emitStatus('该商品所在店铺未开通"再买一单"功能')
          resolve({ success: false, error: '该商品所在店铺未开通"再买一单"功能，这是平台限制而非程序问题' })
          return
        }

        let offShelfResult: { offShelf: boolean; keyword: string } | null = null
        try {
          const mainOffShelf = await this.shopWindow?.webContents.executeJavaScript(`
            (function() {
              var bodyText = (document.body?.innerText || '');
              var offShelfKeywords = ['已下架', '商品已下架', '宝贝不存在', '商品不存在', '已失效', '商品已失效', '已卖完', '暂时缺货', '该商品已下架', '商品已售罄', '此商品已下架', '页面不存在', '无法购买'];
              for (var i = 0; i < offShelfKeywords.length; i++) {
                if (bodyText.includes(offShelfKeywords[i])) {
                  return { offShelf: true, keyword: offShelfKeywords[i] };
                }
              }
              return { offShelf: false, keyword: '' };
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
                const fOffShelf = await frame.executeJavaScript(`
                  (function() {
                    var bodyText = (document.body?.innerText || '');
                    var offShelfKeywords = ['已下架', '商品已下架', '宝贝不存在', '商品不存在', '已失效', '商品已失效', '已卖完', '暂时缺货', '该商品已下架', '商品已售罄', '此商品已下架', '页面不存在', '无法购买'];
                    for (var i = 0; i < offShelfKeywords.length; i++) {
                      if (bodyText.includes(offShelfKeywords[i])) {
                        return { offShelf: true, keyword: offShelfKeywords[i] };
                      }
                    }
                    return { offShelf: false, keyword: '' };
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
          this.emitStatus(`商品已下架（${offShelfResult.keyword}）`)
          resolve({ success: false, error: `商品已下架（${offShelfResult.keyword}）` })
          return
        }

        await tryClickRebuy()
      })

      const checkInterval = setInterval(async () => {
        if (resolved) return
        try {
          const url = this.shopWindow?.webContents.getURL()
          if (!url) return
          if (this.isCheckoutOrPayPage(url) || url.includes('buy.tmall.com') || url.includes('buy.taobao.com')) {
            resolved = true
            clearTimeout(timeout)
            clearInterval(checkInterval)
            await this.syncCookiesFromElectron()
            this.emitStatus('已进入结算页面')
            resolve({ success: true, directToPay: true })
          } else if (url.includes('cart.taobao.com')) {
            resolved = true
            clearTimeout(timeout)
            clearInterval(checkInterval)
            await this.syncCookiesFromElectron()
            this.emitStatus('已加入购物车')
            resolve({ success: true, directToPay: false })
          } else if (url.includes('item.taobao.com') || url.includes('detail.tmall.com')) {
            const offShelfCheck = await this.shopWindow?.webContents.executeJavaScript(`
              (function() {
                var bodyText = (document.body?.innerText || '');
                var keywords = ['已下架', '商品已下架', '宝贝不存在', '商品不存在', '已失效', '商品已失效', '已卖完', '暂时缺货', '该商品已下架', '商品已售罄', '此商品已下架', '页面不存在', '无法购买'];
                for (var i = 0; i < keywords.length; i++) {
                  if (bodyText.includes(keywords[i])) return keywords[i];
                }
                return '';
              })()
            `).catch(() => '')
            if (offShelfCheck) {
              resolved = true
              clearTimeout(timeout)
              clearInterval(checkInterval)
              this.closeShopWindow()
              this.emitStatus(`商品已下架（${offShelfCheck}）`)
              resolve({ success: false, error: `商品已下架（${offShelfCheck}）` })
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

  private closeShopWindow() {
    if (this.shopWindow && !this.shopWindow.isDestroyed()) {
      this.shopWindow.close()
    }
    this.shopWindow = null
    try {
      const allWindows = BrowserWindow.getAllWindows()
      for (const win of allWindows) {
        if (win !== this.mainWindow && win !== this.loginWindow && !win.isDestroyed()) {
          win.close()
        }
      }
    } catch { /* ignore */ }
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

      await this.page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
      await this.page.waitForTimeout(2000)
      await this.page.evaluate(() => window.scrollTo(0, 0))
      await this.page.waitForTimeout(1000)

      this.emitStatus('正在查找再买一单按钮...')
      const clicked = await this.clickRebuyButton()
      if (clicked) {
        const result = await this.detectPageAfterRebuy()
        if (result) return result
      }

      this.emitStatus('未找到再买一单按钮，滚动页面重试...')
      await this.page.evaluate(() => {
        const scrollHeight = document.body.scrollHeight
        const step = window.innerHeight
        for (let y = 0; y < scrollHeight; y += step) {
          window.scrollTo(0, y)
        }
        window.scrollTo(0, 0)
      })
      await this.page.waitForTimeout(3000)

      const retryClicked = await this.clickRebuyButton()
      if (retryClicked) {
        const result = await this.detectPageAfterRebuy()
        if (result) return result
      }

      this.emitStatus('再次等待页面加载...')
      await this.page.waitForTimeout(5000)

      const retry2Clicked = await this.clickRebuyButton()
      if (retry2Clicked) {
        const result = await this.detectPageAfterRebuy()
        if (result) return result
      }

      return await this.fallbackManualAddToCart(productUrl)
    } catch (e) {
      console.log(`[Taobao] Playwright addToCart error: ${e}`)
      this.emitStatus(`再来一单失败: ${e}`)
      return { success: false, error: String(e) }
    }
  }

  private async detectPageAfterRebuy(): Promise<AddToCartResult | null> {
    if (!this.page || !this.context) return null

    const popupPromise = this.page.waitForEvent('popup', { timeout: 5000 }).catch(() => null)
    await this.page.waitForTimeout(3000)
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
      }, 120000)

      const checkInterval = setInterval(async () => {
        if (resolved) return
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
            await this.page!.waitForTimeout(3000)
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

  private async fallbackManualAddToCart(productUrl?: string): Promise<AddToCartResult> {
    if (!this.page) return { success: false, error: '浏览器未初始化' }

    this.emitStatus('自动再来一单失败，请在弹出的窗口中手动操作...')

    const orderDetailUrl = this.page.url()

    try {
      await this.syncCookiesToElectron()

      if (this.mainWindow) {
        await dialog.showMessageBox(this.mainWindow, {
          type: 'info',
          title: '需要手动操作',
          message: '自动"再来一单"失败',
          detail: '该订单可能因商品下架、SKU变更等原因无法自动再来一单。\n\n即将打开您的购买记录详情页，请您手动操作下单。\n加入购物车后，窗口会自动关闭并继续后续流程。',
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
        }, 120000)

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
          const diag = await frame.evaluate(() => {
            const targets = ['再买一单', '再次购买', '再来一单', '重新购买', '去购买', '立即购买', '再次下单', '追加购买']
            const nearMatches: { tag: string; text: string; cls: string; rect: string }[] = []

            for (const el of document.querySelectorAll('*')) {
              const text = (el.textContent || '').trim()
              if (!text || text.length > 100) continue
              const normalized = text.replace(/\s+/g, '')
              const isNear = targets.some(t => normalized.includes(t))
              if (isNear) {
                const rect = el.getBoundingClientRect()
                if (rect.width > 0 && rect.height > 0) {
                  nearMatches.push({
                    tag: el.tagName,
                    text: text.substring(0, 60),
                    cls: (el as HTMLElement).className?.substring?.(0, 80) || '',
                    rect: `${Math.round(rect.width)}x${Math.round(rect.height)}@${Math.round(rect.x)},${Math.round(rect.y)}`,
                  })
                }
              }
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
              const allElements = document.querySelectorAll('*')
              let bestMatch: { el: Element; area: number; text: string } | null = null

              for (const el of allElements) {
                const fullText = (el.textContent || '').trim()
                if (!fullText || fullText.length > 100) continue

                const normalized = fullText.replace(/\s+/g, '')
                const isMatch = targets.some(t => normalized.includes(t))
                if (!isMatch) continue

                const rect = el.getBoundingClientRect()
                if (rect.width <= 0 || rect.height <= 0) continue

                const area = rect.width * rect.height
                if (!bestMatch || area < bestMatch.area) {
                  bestMatch = { el, area, text: fullText.substring(0, 40) }
                }
              }

              if (bestMatch) {
                ;(bestMatch.el as HTMLElement).click()
                return { clicked: true, tag: bestMatch.el.tagName, text: bestMatch.text, area: bestMatch.area }
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
          const cssResult = await frame.evaluate((selectors: string[]) => {
            for (const sel of selectors) {
              try {
                const el = document.querySelector(sel) as HTMLElement | null
                if (el) {
                  const rect = el.getBoundingClientRect()
                  if (rect.width > 0 && rect.height > 0) {
                    el.click()
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

      await this.page.waitForTimeout(2000)

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
      await this.page.waitForTimeout(3000)

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
      this.emitStatus('正在等待确认订单页面加载...')
      return await this.waitForCheckoutPage(quantity)
    }

    if (!currentUrl.includes('cart.taobao.com')) {
      this.emitStatus('正在跳转购物车...')
      await wc.loadURL(TAOBAO_SELECTORS.CART.URL)
      await new Promise(r => setTimeout(r, 3000))

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
      await new Promise(r => setTimeout(r, delay))

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
      const result = await this.shopWindow.webContents.executeJavaScript(`
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
              plusBtns[0].click();
              currentQty++;
            }
            return { found: true, method: 'plus_click', clicked: quantity - 1 };
          }
          return { found: false };
        })()
      `)
      console.log(`[Taobao] setQuantity result:`, JSON.stringify(result))
      if (result?.found) {
        await new Promise(r => setTimeout(r, 1000))
      }
    } catch (e) {
      console.log(`[Taobao] setQuantity error: ${e}`)
    }
  }

  private async clickInShopWindow(selectors: string[], textTargets: string[]): Promise<{ clicked: boolean; selector?: string; text?: string }> {
    if (!this.shopWindow || this.shopWindow.isDestroyed()) return { clicked: false }

    try {
      const result = await this.shopWindow.webContents.executeJavaScript(`
        (function(args) {
          var loginKeywords = ['登录', '注册', '扫码', '快速进入', '密码登录', '短信登录'];
          for (var i = 0; i < args.selectors.length; i++) {
            try {
              var el = document.querySelector(args.selectors[i]);
              if (el) {
                var elText = (el.textContent || '').trim();
                var isLogin = loginKeywords.some(function(k) { return elText.includes(k); });
                if (isLogin) continue;
                var rect = el.getBoundingClientRect();
                if (rect.width > 0 && rect.height > 0) {
                  el.click();
                  return { clicked: true, selector: args.selectors[i], text: elText.substring(0, 30) };
                }
              }
            } catch(e) {}
          }
          var allEls = document.querySelectorAll('button, a, [role="button"], span, div, input[type="submit"]');
          for (var j = 0; j < allEls.length; j++) {
            var el2 = allEls[j];
            var text = (el2.textContent || el2.value || '').trim();
            if (!text) continue;
            var normalized = text.replace(/\\s+/g, '');
            var isLogin2 = loginKeywords.some(function(k) { return normalized.includes(k); });
            if (isLogin2) continue;
            var isMatch = args.textTargets.some(function(t) { return normalized.includes(t); });
            if (isMatch) {
              var rect2 = el2.getBoundingClientRect();
              if (rect2.width > 0 && rect2.height > 0) {
                el2.click();
                return { clicked: true, selector: 'text:' + text.substring(0, 20), text: text.substring(0, 30) };
              }
            }
          }
          return { clicked: false };
        })(${JSON.stringify({ selectors, textTargets })})
      `)
      return result
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
      await this.page!.waitForTimeout(2000)
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

        const result = await frame.evaluate((args: { selectors: string[]; textTargets: string[] }) => {
          const loginKeywords = ['登录', '注册', '扫码', '快速进入', '密码登录', '短信登录']
          for (const sel of args.selectors) {
            try {
              const el = document.querySelector(sel) as HTMLElement | null
              if (el) {
                const elText = (el.textContent || '').trim()
                if (loginKeywords.some(k => elText.includes(k))) continue
                const rect = el.getBoundingClientRect()
                if (rect.width > 0 && rect.height > 0) {
                  el.click()
                  return { clicked: true, selector: sel, text: elText.substring(0, 30) }
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
                (el as HTMLElement).click()
                return { clicked: true, selector: `text:${text.substring(0, 20)}`, text: text.substring(0, 30) }
              }
            }
          }

          return { clicked: false }
        }, { selectors, textTargets })

        if (result.clicked) return result
      } catch (e) {
        console.log(`[Taobao] clickButtonByTextOrSelector frame error: ${e}`)
      }
    }

    return { clicked: false }
  }

  async pay(totalAmount?: number, dryRun?: boolean): Promise<PayResult> {
    if (dryRun) {
      this.emitStatus(`测试模式：跳过实际支付（预计金额 ¥${totalAmount?.toFixed(2)}）`)
      if (this.shopWindow && !this.shopWindow.isDestroyed()) {
        this.closeShopWindow()
      }
      return { success: true, transactionId: 'TEST_MODE_SKIPPED' }
    }

    const freeEnabled = this.db.getSetting('pay_free_enabled') === 'true'
    const freeLimit = parseFloat(this.db.getSetting('pay_free_limit') || '200')
    const freePlatform = this.db.getSetting('pay_free_platform') || 'taobao'
    const canFreePay = freeEnabled
      && !isNaN(freeLimit) && freeLimit > 0
      && totalAmount !== undefined && totalAmount <= freeLimit
      && freePlatform === this.name

    if (!this.shopWindow || this.shopWindow.isDestroyed()) {
      return { success: false, error: '没有可用的支付窗口' }
    }

    if (canFreePay) {
      this.emitStatus(`订单金额 ¥${totalAmount?.toFixed(2)} ≤ ¥${freeLimit.toFixed(2)}，免密支付中...`)
      try {
        const payResult = await this.clickInShopWindow(
          TAOBAO_SELECTORS.CHECKOUT.SUBMIT_ORDER_SELECTORS as unknown as string[],
          ['免密支付', '立即支付', '确认支付']
        )
        console.log(`[Taobao] Electron free pay result:`, JSON.stringify(payResult))
        if (payResult.clicked) {
          await new Promise(r => setTimeout(r, 2000))
          await this.syncCookiesFromElectron()
          this.closeShopWindow()
          this.emitStatus('免密支付完成')
          return { success: true }
        }

        this.closeShopWindow()
        return { success: false, error: '未找到支付按钮' }
      } catch (e) {
        return { success: false, error: String(e) }
      }
    }

    this.emitStatus(totalAmount !== undefined
      ? `等待支付确认（¥${totalAmount.toFixed(2)}）...`
      : '等待支付确认...'
    )

    try {
      const submitResult = await this.clickInShopWindow(
        TAOBAO_SELECTORS.CHECKOUT.SUBMIT_ORDER_SELECTORS as unknown as string[],
        ['提交订单', '确认订单', '去支付', '立即支付', '立即付款']
      )
      console.log(`[Taobao] Electron submit order result:`, JSON.stringify(submitResult))

      if (submitResult.clicked) {
        await new Promise(r => setTimeout(r, 2000))

        if (this.shopWindow && !this.shopWindow.isDestroyed()) {
          const afterUrl = this.shopWindow.webContents.getURL()
          if (afterUrl.includes('payresult') || afterUrl.includes('cashier_result') ||
              afterUrl.includes('success') || afterUrl.includes('buyertrade.taobao.com')) {
            await this.syncCookiesFromElectron()
            this.closeShopWindow()
            this.emitStatus('支付完成')
            return { success: true }
          }
        }
      }

      if (this.shopWindow && !this.shopWindow.isDestroyed()) {
        this.shopWindow.setSize(900, 750)
        this.shopWindow.setTitle('支付确认 - 请点击支付按钮完成付款')
        this.shopWindow.setResizable(true)
        if (this.mainWindow) {
          this.shopWindow.setParentWindow(this.mainWindow)
        }
        this.shopWindow.show()

        this.emitStatus('请在弹出的窗口中完成支付...')

        const maxWait = 180000
        const startTime = Date.now()

        while (Date.now() - startTime < maxWait) {
          await new Promise(r => setTimeout(r, 1500))
          if (!this.shopWindow || this.shopWindow.isDestroyed()) break

          try {
            const payPageUrl = this.shopWindow.webContents.getURL()
            if (payPageUrl.includes('payresult') ||
                payPageUrl.includes('cashier_result') ||
                payPageUrl.includes('success') ||
                payPageUrl.includes('buyertrade.taobao.com')) {
              await this.syncCookiesFromElectron()
              this.closeShopWindow()
              this.emitStatus('支付完成')
              return { success: true }
            }
          } catch { /* ignore */ }
        }

        this.closeShopWindow()
        await this.syncCookiesFromElectron()
        this.emitStatus('支付超时')
        return { success: false, error: '支付超时' }
      }

      return { success: false, error: '没有可用的支付窗口' }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  }

  private async syncCookiesToElectron(): Promise<void> {
    try {
      const existingCookies = await session.defaultSession.cookies.get({})
      const taobaoExisting = existingCookies.filter(
        (c) => c.domain.includes('taobao') || c.domain.includes('tmall') || c.domain.includes('alipay')
      )
      for (const c of taobaoExisting) {
        try {
          await session.defaultSession.cookies.remove(
            `https://${c.domain.replace(/^\./, '')}${c.path}`,
            c.name
          )
        } catch { /* ignore */ }
      }

      const loaded = this.auth.loadCookiesRaw()
      let cookies: { name: string; value: string; domain: string; path: string; secure: boolean; httpOnly?: boolean; sameSite?: string; expires?: number }[] = loaded.filter(
        (c) => c.domain.includes('taobao') || c.domain.includes('tmall') || c.domain.includes('alipay')
      )

      if (cookies.length === 0 && this.context) {
        const pwCookies = await this.context.cookies()
        cookies = pwCookies.filter(
          (c) => c.domain.includes('taobao') || c.domain.includes('tmall') || c.domain.includes('alipay')
        )
      }

      if (cookies.length > 0) {
        console.log(`[Taobao] Syncing ${cookies.length} cookies to Electron session (cleared ${taobaoExisting.length} old)`)
      }

      let synced = 0
      for (const cookie of cookies) {
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

      if (synced > 0) {
        await new Promise(r => setTimeout(r, 200))
      }
    } catch (e) {
      console.log(`[Taobao] syncCookiesToElectron error: ${e}`)
    }
  }

  private async syncCookiesFromElectron(): Promise<void> {
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

      console.log(`[Taobao] Synced ${taobaoCookies.length} cookies from Electron session`)
    } catch (e) {
      console.log(`[Taobao] syncCookiesFromElectron error: ${e}`)
    }
  }

  async cleanup(): Promise<void> {
    this.closeShopWindow()
    await this.syncCookiesFromElectron()
  }

  async close() {
    if (this.loginWindow) {
      this.loginWindow.close()
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
