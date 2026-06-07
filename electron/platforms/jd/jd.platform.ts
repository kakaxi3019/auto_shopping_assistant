import { BrowserWindow, session } from 'electron'
import type { PlatformAdapter, Order, CheckoutResult, PayResult, AddToCartResult, SearchResult, PaymentMode } from '../../../shared/types/platform.types'
import { JdAuth } from './jd.auth'
import type { Database } from '../../db/database'
import { chromium, type Browser, type BrowserContext, type Page as PlaywrightPage } from 'playwright'
import {
  injectHumanSim,
  debugLog,
  execJS,
  humanClickAt,
  humanClickElement,
  humanDelay,
  rand,
  injectOverlayBanner,
  injectCenterToast,
  cleanupForCaptcha,
  resetCaptchaMode,
  gaussRand
} from '../taobao/utils/page-helper'
import { join } from 'path'
import { app } from 'electron'
import * as fs from 'fs'
import { CHROME_UA } from '../taobao/utils/constants'

const APP_ICON = app.isPackaged
  ? join(process.resourcesPath, 'app-icon', 'auto_shopping_app_icon.png')
  : join(app.getAppPath(), 'build', 'auto_shopping_app_icon.png')

const WINDOW_SIZES = {
  LOGIN: { width: 1000, height: 750 },
  VERIFICATION: { width: 500, height: 400 },
  CONFIRMATION: { width: 1050, height: 800 },
  SHOP: { width: 1200, height: 850 }
}

function setUserAgent(win: BrowserWindow) {
  if (!win || win.isDestroyed()) return
  win.webContents.setMaxListeners(20)
  win.webContents.setUserAgent(CHROME_UA)
  injectHumanSim(win)
}

export class JdPlatform implements PlatformAdapter {
  name = 'jd'

  private auth: JdAuth
  private db: Database
  private destroyed = false
  private _statusCallbacks = new Map<number, (status: string) => void>()
  private _nextCallbackId = 0
  private _lastEmittedStatus = ''
  private _lastEmitTime = 0

  private loginWindow: BrowserWindow | null = null
  private shopWindow: BrowserWindow | null = null
  private mainWindow: BrowserWindow | null = null

  // Playwright 后台驱动（部分操作）
  private browser: Browser | null = null
  private playwrightContext: BrowserContext | null = null

  private debug(msg: string) {
    const formatted = `[JD-Platform] ${msg}`
    debugLog(formatted)
  }

  constructor(db: Database) {
    this.db = db
    this.auth = new JdAuth()
    this.log('JdPlatform initialized')
  }

  private log(msg: string) {
    const formatted = `[JD-Platform] ${msg}`
    debugLog(formatted)
    this.emitStatus(msg)
  }

  private emitStatus(status: string) {
    const now = Date.now()
    if (status === this._lastEmittedStatus && now - this._lastEmitTime < 2000) return
    this._lastEmittedStatus = status
    this._lastEmitTime = now
    for (const callback of this._statusCallbacks.values()) {
      try { callback(status) } catch { /* ignore */ }
    }
  }

  onStatusChange(callback: (status: string) => void): () => void {
    const id = this._nextCallbackId++
    this._statusCallbacks.set(id, callback)
    return () => this._statusCallbacks.delete(id)
  }

  setMainWindow(win: BrowserWindow) {
    this.mainWindow = win
  }

  destroy() {
    this.destroyed = true
    this.cleanupWindows()
    this.closeBrowser().catch(() => {})
  }

  private cleanupWindows() {
    if (this.loginWindow && !this.loginWindow.isDestroyed()) {
      try { this.loginWindow.close() } catch {}
      this.loginWindow = null
    }
    if (this.shopWindow && !this.shopWindow.isDestroyed()) {
      try { this.shopWindow.close() } catch {}
      this.shopWindow = null
    }
  }

  private async closeBrowser() {
    try {
      await this.playwrightContext?.close()
      await this.browser?.close()
    } catch {}
    this.playwrightContext = null
    this.browser = null
  }

  // 同步 Cookie：将本地 JdAuth 的 Cookie 同步到 Electron 默认的 Session 中
  private async syncCookiesToElectron() {
    this.debug('Syncing saved cookies to Electron Session...')
    const cookies = this.auth.loadCookiesRaw()
    const ses = session.defaultSession
    for (const c of cookies) {
      try {
        const domain = c.domain.startsWith('.') ? c.domain : `.${c.domain}`
        const url = `https://${domain.replace(/^\./, '')}${c.path || '/'}`
        await ses.cookies.set({
          url,
          name: c.name,
          value: c.value,
          domain,
          path: c.path || '/',
          secure: c.secure,
          httpOnly: c.httpOnly ?? false,
          ...(c.expires ? { expirationDate: c.expires } : {})
        })
      } catch (e) {
        debugLog(`[JD-Cookie] Failed to sync cookie ${c.name} to Electron: ${e}`)
      }
    }
  }

  // 同步 Cookie：将 Electron 中的 Cookie 捞出保存到本地
  private async syncCookiesFromElectron() {
    this.debug('Saving session cookies from Electron to JdAuth...')
    const allCookies = await session.defaultSession.cookies.get({})
    const jdCookies = allCookies.filter(
      (c) => c.domain.includes('jd.com') || c.domain.includes('jd.hk') || c.domain.includes('jdpay.com')
    )
    this.auth.saveElectronCookies(jdCookies)
  }

  // 同步 Cookie：把本地的 Cookie 同步到 Playwright 上下文中
  private async syncCookiesToPlaywright(context: BrowserContext) {
    this.log('Syncing saved cookies to Playwright Context...')
    await this.auth.loadCookies(context)
  }

  async login(): Promise<boolean> {
    this.log('正在打开京东登录页面...')
    this.cleanupWindows()

    // 强行清理默认 session 中残留的旧京东 Cookie，防止被风控的垃圾会话直接让新二维码失效
    try {
      const ses = session.defaultSession
      const jdCookies = await ses.cookies.get({ domain: 'jd.com' })
      for (const c of jdCookies) {
        const url = `https://${c.domain.replace(/^\./, '')}${c.path}`
        await ses.cookies.remove(url, c.name).catch(() => {})
      }
      const jdHkCookies = await ses.cookies.get({ domain: 'jd.hk' })
      for (const c of jdHkCookies) {
        const url = `https://${c.domain.replace(/^\./, '')}${c.path}`
        await ses.cookies.remove(url, c.name).catch(() => {})
      }
      this.debug('[JD-Login] Cleared existing cookies to avoid session pollution')
    } catch (cleanErr) {
      this.debug(`[JD-Login] Cookies clear failed: ${cleanErr}`)
    }

    return new Promise<boolean>((resolve) => {
      this.loginWindow = new BrowserWindow({
        width: WINDOW_SIZES.LOGIN.width,
        height: WINDOW_SIZES.LOGIN.height,
        title: '京东登录 - 请扫码或输入账号登录',
        icon: APP_ICON,
        webPreferences: {
          nodeIntegration: false,
          contextIsolation: true,
          sandbox: false
        }
      })

      setUserAgent(this.loginWindow)
      if (this.mainWindow) {
        this.loginWindow.setParentWindow(this.mainWindow)
      }

      this.loginWindow.loadURL('https://passport.jd.com/new/login.aspx')

      let resolved = false
      const timeout = setTimeout(() => {
        if (!resolved) {
          resolved = true
          this.cleanupWindows()
          this.log('⚠️ 登录操作超时，请重试')
          resolve(false)
        }
      }, 300000) // 5 分钟

      const handleLoginSuccess = async () => {
        if (resolved) return
        resolved = true
        clearTimeout(timeout)
        this.log('🎉 登录成功，正在同步登录状态...')
        await humanDelay(2000)
        await this.syncCookiesFromElectron()
        this.cleanupWindows()
        this.log('京东登录状态已成功保存')
        resolve(true)
      }

      const checkUrl = async (url: string) => {
        this.log(`Navigated to: ${url}`)
        
        // 明确的验证页或安全验证流程中，绝对不关闭窗口
        const isSafeOrVerify = url.includes('safe.jd.com') || url.includes('verification') || url.includes('validate') || url.includes('security')
        if (isSafeOrVerify) {
          this.log('[JD-Login] Security verification page detected, keeping login window open...')
          return
        }

        const isJdHome = url.includes('www.jd.com') || url.includes('order.jd.com') || url.includes('home.jd.com') || (url.includes('jd.com') && !url.includes('passport') && !url.includes('login'))
        if (isJdHome) {
          // 进一步检查核心登录 Cookie（如 pin, unick, pt_pin 等）是否已经写入，确保确实登录成功且度过了验证阶段
          const cookies = await session.defaultSession.cookies.get({ domain: 'jd.com' })
          const hasLoginCookie = cookies.some(c => ['pin', 'unick', 'pt_pin'].includes(c.name) && c.value && c.value.trim() !== '')
          
          if (hasLoginCookie) {
            this.log('[JD-Login] Found core login cookie (pin/unick), login finalized.')
            await handleLoginSuccess()
          } else {
            this.log('[JD-Login] Jumped to jd.com but key login cookies (pin/unick) not found yet, keeping window open for safety...')
          }
        }
      }

      this.loginWindow.webContents.on('did-navigate', (_evt, url) => { checkUrl(url).catch(() => {}) })
      this.loginWindow.webContents.on('did-finish-load', () => {
        if (!this.loginWindow || resolved) return
        checkUrl(this.loginWindow.webContents.getURL()).catch(() => {})
      })

      this.loginWindow.on('closed', () => {
        this.loginWindow = null
        if (!resolved) {
          resolved = true
          clearTimeout(timeout)
          this.log('❌ 登录已被取消')
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
    const ses = session.defaultSession
    const jdCookies = await ses.cookies.get({ domain: 'jd.com' })
    for (const c of jdCookies) {
      const url = `https://${c.domain.replace(/^\./, '')}${c.path}`
      try { await ses.cookies.remove(url, c.name) } catch {}
    }
    const jdHkCookies = await ses.cookies.get({ domain: 'jd.hk' })
    for (const c of jdHkCookies) {
      const url = `https://${c.domain.replace(/^\./, '')}${c.path}`
      try { await ses.cookies.remove(url, c.name) } catch {}
    }
    this.cleanupWindows()
    this.log('已退出登录并清除 Cookie')
  }

  async fetchOrderHistory(page = 1, timeRange?: { beginTime?: string; endTime?: string }): Promise<Order[]> {
    this.log('开始同步京东历史订单记录...')
    await this.syncCookiesToElectron()

    const orderWindow = new BrowserWindow({
      width: 1280,
      height: 800,
      show: false, // 订单同步隐藏在后台运行，遭遇滑块人机风控时会自动弹出
      icon: APP_ICON,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        backgroundThrottling: false
      }
    })

    setUserAgent(orderWindow)

    let orders: any[] = []
    let loginExpired = false
    try {
      const currentYear = new Date().getFullYear()
      let yearsToSync = ['2']
      if (timeRange?.beginTime) {
        try {
          const beginYear = new Date(timeRange.beginTime).getFullYear()
          for (let y = currentYear - 1; y >= beginYear && y >= currentYear - 15; y--) {
            yearsToSync.push(String(y))
          }
          if (beginYear <= 2014) {
            yearsToSync.push('3')
          }
        } catch {
          yearsToSync = ['2', String(currentYear - 1), String(currentYear - 2)]
        }
      } else {
        // 默认拉取全部：从去年开始一直往回推到京东支持的最早年份 2014，最后加上 2014 以前的全部订单 ('3')
        for (let y = currentYear - 1; y >= 2014; y--) {
          yearsToSync.push(String(y))
        }
        yearsToSync.push('3')
      }

      this.log(`[JD-Sync] 准备同步以下年份的订单: ${yearsToSync.join(', ')}`)

      const allParsed: any[] = []

      // 使用 BrowserWindow 真实 loadURL 遍历每一个目标年份，防止前端 AJAX fetch 遇到 Sec-Fetch 策略被京东默默降级拦截
      for (const yr of yearsToSync) {
        const yearDesc = yr === '2' ? '今年内' : `${yr}年`
        this.log(`正在载入京东 ${yearDesc} 的订单页面...`)

        await new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error(`加载${yearDesc}订单超时`)), 45000)
          
          const onFinish = () => {
            clearTimeout(timeout)
            resolve()
          }
          const onFail = (_event: any, code: number, desc: string) => {
            clearTimeout(timeout)
            reject(new Error(`加载${yearDesc}订单失败: ${desc} (${code})`))
          }

          orderWindow.webContents.once('did-finish-load', onFinish)
          orderWindow.webContents.once('did-fail-load', onFail)

          orderWindow.loadURL(`https://order.jd.com/center/list.action?d=${yr}&s=4096`)
        })

        const currentUrl = orderWindow.webContents.getURL()
        if (currentUrl.includes('passport') || currentUrl.includes('login')) {
          this.log('⚠️ 京东登录态已失效，同步中断')
          loginExpired = true
          break
        }

        // 拟人化渲染延迟，等待页面数据与表格生成完毕
        await humanDelay(1500)

        // 京东防爬风控滑块拦截检测
        const hasCaptcha = await execJS(orderWindow, `
          (function() {
            var bodyText = document.body ? document.body.innerText : '';
            var isCaptcha = bodyText.includes('验证码') || bodyText.includes('安全验证') || !!document.querySelector('#captcha, [id*="captcha"], [class*="captcha"], .slider');
            return isCaptcha;
          })()
        `)

        if (hasCaptcha) {
          this.log(`⚠️ 京东 ${yearDesc} 遭遇人机拦截，请求人工处理...`)
          cleanupForCaptcha(orderWindow)
          orderWindow.setSize(WINDOW_SIZES.VERIFICATION.width, WINDOW_SIZES.VERIFICATION.height)
          orderWindow.setTitle('京东安全验证 - 请拖动滑块完成人机验证')
          orderWindow.setAlwaysOnTop(true)
          if (this.mainWindow) {
            orderWindow.setParentWindow(this.mainWindow)
          }
          injectOverlayBanner(orderWindow, '🔐 京东风控验证：检测到人机安全拦截，请在下方拖动滑块验证')
          injectCenterToast(orderWindow, '请完成滑块验证')
          orderWindow.center()
          orderWindow.show()

          // 挂起，直到用户在窗口中手动通过滑块
          await new Promise<void>((resolveVerify) => {
            let checkInterval = setInterval(async () => {
              if (orderWindow.isDestroyed()) {
                clearInterval(checkInterval)
                resolveVerify()
                return
              }
              const url = orderWindow.webContents.getURL()
              const stillCaptcha = await execJS(orderWindow, `
                (function() {
                  var bodyText = document.body ? document.body.innerText : '';
                  return bodyText.includes('验证') && (bodyText.includes('滑动') || !!document.querySelector('.slider'));
                })()
              `)
              if (url.includes('list.action') && !stillCaptcha) {
                clearInterval(checkInterval)
                resetCaptchaMode(orderWindow)
                if (!isDev) {
                  orderWindow.hide()
                }
                this.log('🎉 滑块验证通过，继续解析订单')
                resolveVerify()
              }
            }, 1500)
          })
        }

        if (orderWindow.isDestroyed()) {
          throw new Error('同步窗口被用户关闭')
        }

        // 此时页面已完全渲染，开始针对当前年的 DOM 进行精确定位提取
        const result = await execJS(orderWindow, `
          (function() {
            var parsed = [];
            
            // 收集诊断信息
            var tbodyList = document.querySelectorAll('tbody');
            var tbodyIds = [];
            for (var idx = 0; idx < Math.min(tbodyList.length, 10); idx++) {
              tbodyIds.push(tbodyList[idx].id || '');
            }
            
            var tableList = document.querySelectorAll('table');
            var tableClasses = [];
            for (var idx = 0; idx < Math.min(tableList.length, 5); idx++) {
              tableClasses.push(tableList[idx].className || '');
            }

            var debugInfo = {
              tbodyCount: tbodyList.length,
              tbodyIds: tbodyIds,
              tableCount: tableList.length,
              tableClasses: tableClasses,
              orderBoxCount: document.querySelectorAll('[class*="order-box"]').length,
              tbOrderCount: document.querySelectorAll('tbody[id^="tb-"]').length,
              hasEmptyBox: !!document.querySelector('.empty-box'),
              bodyTextSnippet: document.body ? document.body.innerText.substring(0, 150).replace(/\\s+/g, ' ') : ''
            };

            // 1. 优先尝试寻找每一个具体的订单行容器（京东常规订单和拆分后的子订单均以 tb- 开头）
            var containers = document.querySelectorAll('tbody[id^="tb-"]');
            
            // 如果实在没有找到任何 tbody 订单行，再以大表格做退级解析
            if (containers.length === 0) {
              containers = document.querySelectorAll('table.order-tb, .order-tb, table');
            }
            
            var seenOrderIds = new Set();
            
            for (var i = 0; i < containers.length; i++) {
              var container = containers[i];
              
              // 过滤已取消的订单
              var statusEl = container.querySelector('.order-status, [class*="status"]');
              var statusText = statusEl ? statusEl.textContent.trim() : '';
              if (statusText.indexOf('已取消') !== -1 || statusText.indexOf('取消') !== -1) {
                continue;
              }
              
              // 提取订单号
              var orderId = '';
              if (container.id && container.id.indexOf('tb-') === 0) {
                orderId = container.id.replace('tb-', '').trim();
              }
              
              // 校验订单号只由数字组成，防止误匹配其他布局 id
              if (orderId && !/^\\d+$/.test(orderId)) {
                orderId = '';
              }
              
              // 兜底提取订单号
              if (!orderId) {
                var text = container.innerText || '';
                var match = text.match(/(?:订单号|订单编号)[:：]\\s*(\\d+)/);
                if (match) {
                  orderId = match[1].trim();
                }
              }
              
              if (!orderId || seenOrderIds.has(orderId)) continue;
              seenOrderIds.add(orderId);
              
              // 提取订单时间
              var purchasedAt = '';
              var dealtimeEl = container.querySelector('.dealtime, [class*="time"]');
              if (dealtimeEl) {
                purchasedAt = dealtimeEl.getAttribute('title') || dealtimeEl.textContent || '';
              }
              if (!purchasedAt) {
                var containerText = container.innerText || '';
                var timeMatch = containerText.match(/(\\d{4}-\\d{2}-\\d{2}\\s+\\d{2}:\\d{2}(:\\d{2})?)/);
                if (timeMatch) {
                  purchasedAt = timeMatch[1];
                }
              }
              if (!purchasedAt) {
                purchasedAt = new Date().toISOString();
              }
              
              // 提取店铺名
              var shopName = '';
              var shopEl = container.querySelector('.shop-txt, .shop-name, [class*="shop"]');
              if (shopEl) {
                shopName = shopEl.textContent.trim();
              }
              if (!shopName) {
                shopName = '京东自营';
              }
              
              // 提取该订单内的所有商品链接 a 标签
              var links = container.querySelectorAll('a[href*="item.jd.com"], a[href*="item.jd.hk"], a[href*="item.jkcs.jd.com"]');
              
              // 价格提取
              var orderPrice = 0;
              var priceEl = container.querySelector('.amount, .p-price, .price, [class*="amount"]');
              if (priceEl) {
                var pText = priceEl.textContent.replace(/[¥￥\\s]/g, '');
                orderPrice = parseFloat(pText) || 0;
              } else {
                var containerTextForPrice = container.innerText || '';
                var pMatch = containerTextForPrice.match(/[¥￥]\\s*(\\d+(\\.\\d+)?)/);
                if (pMatch) {
                  orderPrice = parseFloat(pMatch[1]) || 0;
                }
              }
              
              var orderItems = [];
              var itemsMap = {};
              
              for (var j = 0; j < links.length; j++) {
                var link = links[j];
                var href = link.getAttribute('href') || '';
                if (href.startsWith('//')) href = 'https:' + href;
                
                var cleanUrl = href.split('?')[0];
                if (!itemsMap[cleanUrl]) {
                  itemsMap[cleanUrl] = { productName: '', imageUrl: '', href: href };
                }
                
                var productName = link.textContent.trim();
                if (!productName) {
                  var siblingText = link.parentElement ? link.parentElement.textContent.trim() : '';
                  if (siblingText) {
                    productName = siblingText;
                  }
                }
                
                if (productName && productName.length > itemsMap[cleanUrl].productName.length) {
                  itemsMap[cleanUrl].productName = productName;
                }
                
                var imgEl = link.querySelector('img') || (link.parentElement ? link.parentElement.querySelector('img') : null);
                if (imgEl) {
                  var imgUrl = imgEl.getAttribute('src') || imgEl.getAttribute('data-lazy-img') || imgEl.getAttribute('lazy-src') || '';
                  if (imgUrl.startsWith('//')) imgUrl = 'https:' + imgUrl;
                  if (imgUrl) {
                    itemsMap[cleanUrl].imageUrl = imgUrl;
                  }
                }
              }
              
              for (var urlKey in itemsMap) {
                var itemObj = itemsMap[urlKey];
                if (itemObj.productName && itemObj.productName.length > 5) {
                  if (!itemObj.imageUrl) {
                    var fallbackImg = container.querySelector('img');
                    if (fallbackImg) {
                      var imgUrl = fallbackImg.getAttribute('src') || fallbackImg.getAttribute('data-lazy-img') || fallbackImg.getAttribute('lazy-src') || '';
                      if (imgUrl.startsWith('//')) imgUrl = 'https:' + imgUrl;
                      itemObj.imageUrl = imgUrl;
                    }
                  }
                  
                  orderItems.push({
                    productName: itemObj.productName,
                    productUrl: itemObj.href,
                    imageUrl: itemObj.imageUrl
                  });
                }
              }
              
              var passKey = '';
              var detailLinkEl = container.querySelector('a[href*="details.jd.com"], a[href*="PassKey="]');
              if (detailLinkEl) {
                var detailHref = detailLinkEl.getAttribute('href') || '';
                var pkMatch = detailHref.match(/[?&]PassKey=([^&]+)/i);
                if (pkMatch) {
                  passKey = pkMatch[1];
                }
              }
              if (!passKey) {
                var allLinks = container.querySelectorAll('a');
                for (var lIdx = 0; lIdx < allLinks.length; lIdx++) {
                  var aHref = allLinks[lIdx].getAttribute('href') || '';
                  var m = aHref.match(/[?&]PassKey=([^&]+)/i);
                  if (m) {
                    passKey = m[1];
                    break;
                  }
                }
              }

              for (var k = 0; k < orderItems.length; k++) {
                var item = orderItems[k];
                parsed.push({
                  orderId: orderId + '_' + k,
                  productName: item.productName,
                  productUrl: item.productUrl,
                  price: orderPrice > 0 ? orderPrice : 0,
                  imageUrl: item.imageUrl,
                  purchasedAt: purchasedAt,
                  shopName: shopName,
                  sku: '',
                  passKey: passKey
                });
              }
            }
            return { orders: parsed, debug: debugInfo };
          })()
        `) as { orders: any[], debug: any }

        const pageOrders = result.orders
        const debugInfo = result.debug

        this.log(`[JD-Sync] 年份 ${yearDesc} 页面诊断: URL=${currentUrl}, tbodyCount=${debugInfo.tbodyCount}, tbOrderCount=${debugInfo.tbOrderCount}, tableCount=${debugInfo.tableCount}, tableClasses=${JSON.stringify(debugInfo.tableClasses)}, hasEmptyBox=${debugInfo.hasEmptyBox}`)

        // 无论有无订单，将该年份的 innerHTML 写入本地文件以做调试
        try {
          const htmlContent = (await execJS(orderWindow, `document.documentElement.innerHTML`)) as string
          const diagDir = app.isPackaged ? app.getPath('userData') : process.cwd()
          const diagnosePath = join(diagDir, `jd_order_diagnose_${yr}.html`)
          fs.writeFileSync(diagnosePath, htmlContent, 'utf-8')
          this.log(`[JD-Diagnostic] 已将 ${yearDesc} 的 HTML 写入到本地文件以供排查: ${diagnosePath}`)
        } catch (diagErr) {
          this.log(`[JD-Diagnostic] 保存 ${yearDesc} HTML 发生异常: ${diagErr}`)
        }

        if (Array.isArray(pageOrders) && pageOrders.length > 0) {
          this.log(`[JD-Sync] 京东 ${yearDesc} 同步成功，提取并解析到 ${pageOrders.length} 条订单`)
          allParsed.push(...pageOrders)
        } else {
          this.log(`[JD-Sync] 京东 ${yearDesc} 同步结束，该年份页面没有提取到订单`)
        }
      }

      orders = allParsed
      this.log(`京东历史订单同步汇总，共提取到 ${orders.length} 个历史商品项`)

      if (!orders || orders.length === 0) {
        try {
          const diag = await execJS(orderWindow, `
            (function() {
              var htmlLen = document.documentElement.innerHTML.length;
              var bodyText = document.body ? document.body.innerText.substring(0, 1000) : '';
              var tables = document.querySelectorAll('table').length;
              var tbodies = document.querySelectorAll('tbody').length;
              var divs = document.querySelectorAll('div').length;
              var iframes = document.querySelectorAll('iframe').length;
              var title = document.title;
              var url = window.location.href;
              return {
                htmlLen: htmlLen,
                bodyText: bodyText,
                tables: tables,
                tbodies: tbodies,
                divs: divs,
                iframes: iframes,
                title: title,
                url: url
              };
            })()
          `) as any
          this.log(`⚠️ [JD-Diagnostic] 未能从页面上解析到订单信息。诊断信息如下：
- 当前实际 URL: ${diag.url}
- 页面 Title: ${diag.title}
- HTML 字符长度: ${diag.htmlLen}
- 节点统计 -> Div: ${diag.divs}, Table: ${diag.tables}, Tbody: ${diag.tbodies}, Iframe: ${diag.iframes}
- 页面主要文本片段(前500字): ${diag.bodyText.substring(0, 500).replace(/\s+/g, ' ')}`)

          const htmlContent = (await execJS(orderWindow, `document.documentElement.innerHTML`)) as string
          const diagDir = app.isPackaged ? app.getPath('userData') : process.cwd()
          const diagnosePath = join(diagDir, 'jd_order_diagnose.html')
          fs.writeFileSync(diagnosePath, htmlContent, 'utf-8')
          this.log(`[JD-Diagnostic] 已自动将当时页面的 HTML 结构写入到本地文件以供排查: ${diagnosePath}`)
        } catch (diagErr) {
          this.log(`[JD-Diagnostic] 诊断过程发生异常: ${diagErr}`)
        }
      }

      const savedOrders: Order[] = []
      if (Array.isArray(orders)) {
        for (const item of orders) {
          if (!item.orderId || !item.productName || !item.productUrl) continue
          
          let isWithinRange = true
          if (timeRange?.beginTime) {
            try {
              const purchasedDate = new Date(item.purchasedAt)
              const beginDate = new Date(timeRange.beginTime)
              if (purchasedDate < beginDate) {
                isWithinRange = false
              }
            } catch {}
          }

          if (isWithinRange) {
            this.log(`正在保存订单 [${item.orderId}] -> ${item.productName.substring(0, 15)}...`)
            const id = this.db.upsertOrder({
              platform: 'jd',
              orderId: item.orderId,
              productName: item.productName,
              productUrl: item.productUrl,
              price: item.price || 0,
              imageUrl: item.imageUrl || '',
              purchasedAt: item.purchasedAt,
              shopName: item.shopName,
              sku: item.sku || '',
              rawData: JSON.stringify(item)
            })
            
            savedOrders.push({
              id,
              platform: 'jd',
              orderId: item.orderId,
              productName: item.productName,
              productUrl: item.productUrl,
              price: item.price || 0,
              imageUrl: item.imageUrl || '',
              purchasedAt: item.purchasedAt,
              shopName: item.shopName,
              sku: item.sku || '',
              rawData: JSON.stringify(item),
              unavailable: 0
            })
          } else {
            // 超出筛选范围的我们依旧静默 upsert 写入本地数据库，但不放入返回给前端的 savedOrders 列表中以遵守前端过滤
            this.db.upsertOrder({
              platform: 'jd',
              orderId: item.orderId,
              productName: item.productName,
              productUrl: item.productUrl,
              price: item.price || 0,
              imageUrl: item.imageUrl || '',
              purchasedAt: item.purchasedAt,
              shopName: item.shopName,
              sku: item.sku || '',
              rawData: JSON.stringify(item)
            })
          }
        }
      }

      if (loginExpired) {
        if (savedOrders.length > 0) {
          throw new Error(`同步部分完成，但京东登录已失效，请重新登录（已保存 ${savedOrders.length} 条）`)
        } else {
          throw new Error('京东登录已失效，请重新登录')
        }
      }

      this.log(`京东历史订单同步结束，共新增/更新本地订单：${savedOrders.length} 条`)
      return savedOrders
    } finally {
      if (!orderWindow.isDestroyed()) {
        orderWindow.close()
      }
    }
  }

  async searchOrders(keyword: string): Promise<Order[]> {
    return this.db.searchOrders(keyword, 'jd')
  }

  // 搜索商品接口
  async searchProduct(keyword: string): Promise<SearchResult[]> {
    this.log(`正在京东上搜索商品: "${keyword}"...`)
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
        backgroundThrottling: false
      }
    })
    setUserAgent(searchWindow)

    try {
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('搜索超时')), 30000)
        searchWindow.webContents.on('did-finish-load', () => { clearTimeout(t); resolve() })
        searchWindow.loadURL(`https://search.jd.com/Search?keyword=${encodeURIComponent(keyword)}`)
      })

      const results = await execJS(searchWindow, `
        (function() {
          var items = [];
          var lis = document.querySelectorAll('#J_goodsList ul.gl-warp li.gl-item');
          for (var i = 0; i < lis.length && items.length < 10; i++) {
            var li = lis[i];
            var pImg = li.querySelector('.p-img img');
            var pName = li.querySelector('.p-name a');
            var pPrice = li.querySelector('.p-price i');
            var pShop = li.querySelector('.p-shop');
            
            if (!pName) continue;
            
            var title = pName.textContent.trim();
            var url = pName.getAttribute('href') || '';
            if (url.startsWith('//')) url = 'https:' + url;
            
            var price = 0;
            if (pPrice) {
              price = parseFloat(pPrice.textContent.trim()) || 0;
            }
            
            var imageUrl = '';
            if (pImg) {
              imageUrl = pImg.getAttribute('src') || pImg.getAttribute('data-lazy-img') || '';
              if (imageUrl.startsWith('//')) imageUrl = 'https:' + imageUrl;
            }
            
            var shopName = pShop ? pShop.textContent.trim() : '';
            
            items.push({
              title: title,
              url: url,
              price: price,
              imageUrl: imageUrl,
              shopName: shopName
            });
          }
          return items;
        })()
      `) as SearchResult[]

      this.log(`搜索完毕，在京东搜索页定位到 ${results?.length || 0} 个结果`)
      return results || []
    } finally {
      if (!searchWindow.isDestroyed()) searchWindow.close()
    }
  }

  async openSearchPage(keyword: string): Promise<string | null> {
    // 再次过滤关键词，确保去除特殊标点并限制长度，规避极盾超长安全频次拦截
    let cleanKeyword = keyword || ''
    cleanKeyword = cleanKeyword.replace(/【[^】]*】/g, ' ')
    cleanKeyword = cleanKeyword.replace(/\[[^\]]*\]/g, ' ')
    cleanKeyword = cleanKeyword.replace(/（[^）]*）/g, ' ')
    cleanKeyword = cleanKeyword.replace(/\([^)]*\)/g, ' ')
    cleanKeyword = cleanKeyword.replace(/\{[^}]*\}/g, ' ')
    cleanKeyword = cleanKeyword.replace(/[\/\\|.+\-*&^%$#@!~`?:;\"'<>,\u3002\uff0c\uff1a\uff1b\uff1f\uff01\u3001\u201c\u201d\u2018\u2019]/g, ' ')
    cleanKeyword = cleanKeyword.trim().replace(/\s+/g, ' ')
    if (cleanKeyword.length > 28) {
      cleanKeyword = cleanKeyword.substring(0, 28).trim()
    }

    this.log(`由于直接“再买一单”无法自动加载，已为您打开京东搜索界面匹配商品: "${cleanKeyword}"...`)
    await this.syncCookiesToElectron()

    if (this.shopWindow && !this.shopWindow.isDestroyed()) {
      this.shopWindow.close()
    }

    this.shopWindow = new BrowserWindow({
      width: WINDOW_SIZES.SHOP.width,
      height: WINDOW_SIZES.SHOP.height,
      autoHideMenuBar: true,
      title: '自动购买助手 - 请在搜索页面中点击对应商品进入',
      icon: APP_ICON,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: false,
        backgroundThrottling: false
      }
    })

    setUserAgent(this.shopWindow)
    if (this.mainWindow) {
      this.shopWindow.setParentWindow(this.mainWindow)
    }

    return new Promise<string | null>((resolve) => {
      let resolved = false
      const safeResolve = (result: string | null) => {
        if (resolved) return
        resolved = true
        clearTimeout(searchTimeout)
        resolve(result)
      }

      const timeout = setTimeout(() => {
        safeResolve(null)
        if (this.shopWindow && !this.shopWindow.isDestroyed()) this.shopWindow.close()
      }, 600000) // 最长等待 10 分钟

      const isProductDetailUrl = (urlStr: string): boolean => {
        if (!urlStr) return false
        const lowerUrl = urlStr.toLowerCase()
        return lowerUrl.includes('item.jd.com') || lowerUrl.includes('item.jd.hk') || lowerUrl.includes('item.jkcs.jd.com')
      }

      const handleUrl = (url: string) => {
        if (resolved) return
        if (isProductDetailUrl(url)) {
          clearTimeout(timeout)
          safeResolve(url)
          if (this.shopWindow && !this.shopWindow.isDestroyed()) {
            this.shopWindow.close()
          }
        }
      }

      this.shopWindow!.webContents.on('did-navigate', (_event: any, url: string) => handleUrl(url))
      this.shopWindow!.webContents.on('did-navigate-in-page', (_event: any, url: string) => handleUrl(url))

      this.shopWindow!.webContents.setWindowOpenHandler(({ url: openUrl }) => {
        if (isProductDetailUrl(openUrl)) {
          handleUrl(openUrl)
        }
        return { action: 'allow' }
      })

      this.shopWindow!.webContents.on('did-create-window', (newWin) => {
        this.debug('检测到新打开的商品详情页窗口，接管 URL')
        setUserAgent(newWin)
        newWin.setIcon(APP_ICON)
        newWin.focus()
        newWin.webContents.on('did-finish-load', () => {
          handleUrl(newWin.webContents.getURL())
        })
      })

      this.shopWindow!.on('closed', () => {
        safeResolve(null)
      })

      this.shopWindow!.webContents.on('did-finish-load', async () => {
        if (resolved || !this.shopWindow || this.shopWindow.isDestroyed()) return
        const currentUrl = this.shopWindow.webContents.getURL()
        if (currentUrl.includes('passport') || currentUrl.includes('login')) {
          injectOverlayBanner(this.shopWindow, '⚠️ 自动购物助手：搜索页面需要登录，请完成登录后继续')
          injectCenterToast(this.shopWindow, '请先完成登录')
        } else if (currentUrl.includes('search.jd.com')) {
          // 深度嗅探页面内容，判断是否触发了京东的安全拦截（访问频繁）
          const isBlocked = await execJS(this.shopWindow, `
            (function() {
              var text = document.body ? document.body.innerText : '';
              return text.includes('访问频繁') || text.includes('无法搜索');
            })()
          `).catch(() => false)

          if (isBlocked) {
            injectOverlayBanner(this.shopWindow, '⚠️ 京东安全风控：检测到搜索频繁拦截。请在下方页面中手动拖动滑块验证，或在网页搜索栏重新输入商品名称搜索。一旦点击进入商品详情页，系统将自动重新接管！')
            injectCenterToast(this.shopWindow, '风控拦截：请手动验证或重新搜索')
          } else {
            injectOverlayBanner(this.shopWindow, '🛒 自动购物助手：由于该商品直接“再买一单”失败，已为您打开搜索页。请在下方结果中点击正确的商品进入详情页，系统会自动检测并重新接管后续流程。')
            injectCenterToast(this.shopWindow, '请点击对应商品进入，系统将自动接管')
          }
        }
      })

      // 拟人化搜索流：首先加载京东首页以在当前会话中热身/初始化 Cookie/安全上下文
      this.shopWindow!.loadURL('https://www.jd.com')
      this.shopWindow!.show()

      // 延迟 2.5 秒（等待主页面基础框架与安全指纹初始化完毕），使用完整的 Referer 和 fetch headers 伪装安全跳转到搜索结果页，彻底解决极盾风控对直接加载搜索链接的频控拦截
      const searchTimeout = setTimeout(() => {
        if (resolved || !this.shopWindow || this.shopWindow.isDestroyed()) return
        const searchUrl = `https://search.jd.com/Search?keyword=${encodeURIComponent(cleanKeyword)}`
        this.log(`正在使用来源伪装（www.jd.com）安全跳转到京东搜索页...`)
        this.shopWindow.loadURL(searchUrl, {
          httpReferrer: 'https://www.jd.com/',
          extraHeaders: 'accept-language: zh-CN,zh;q=0.9,en;q=0.8\nupgrade-insecure-requests: 1\nsec-fetch-dest: document\nsec-fetch-mode: navigate\nsec-fetch-site: same-site\nsec-fetch-user: ?1'
        }).catch(err => {
          this.debug(`[JD-Search] 跳转搜索页失败: ${err}`)
        })
      }, 2500)
    })
  }

  getProductUrl(order: Order): string {
    return order.productUrl
  }

  // 直购/加购：优先使用 orderId 进入订单详情页执行再次购买，如失败再降级为商品 URL 直购
  async addToCart(productUrl: string, sku?: string, orderId?: string, cartOnly?: boolean): Promise<AddToCartResult> {
    this.debug(`[JD-Rebuy] addToCart: productUrl=${productUrl}, sku=${sku}, orderId=${orderId}, cartOnly=${cartOnly}`)
    if (orderId) {
      const bizOrderId = orderId.replace(/_\d+$/, '') // 兼容 "289767237472_0" 类型的ID
      
      let passKey = ''
      try {
        let localOrder = this.db.getOrderByPlatformAndOrderId('jd', orderId)
        if (!localOrder && bizOrderId !== orderId) {
          localOrder = this.db.getOrderByPlatformAndOrderId('jd', bizOrderId)
        }
        if (localOrder && localOrder.rawData) {
          const parsed = JSON.parse(localOrder.rawData)
          if (parsed && parsed.passKey) {
            passKey = parsed.passKey
          }
        }
      } catch (err) {
        this.debug(`[JD-Rebuy] Failed to query local order to extract passKey: ${err}`)
      }

      const orderDetailUrl = passKey
        ? `https://details.jd.com/normal/item.action?orderid=${bizOrderId}&PassKey=${passKey}`
        : `https://details.jd.com/normal/item.action?orderid=${bizOrderId}`

      return this.purchaseFromOrderDetail(orderDetailUrl, productUrl, sku, cartOnly)
    }
    return this.purchaseFromUrl(productUrl, sku, cartOnly)
  }

  // 通过订单详情页执行再次购买
  async purchaseFromOrderDetail(orderDetailUrl: string, productUrl: string, sku?: string, cartOnly = false): Promise<AddToCartResult> {
    this.log(cartOnly
      ? `正在通过订单详情页执行加入购物车: ${orderDetailUrl}`
      : `正在通过订单详情页执行再次购买: ${orderDetailUrl}`
    )
    await this.syncCookiesToElectron()

    if (this.shopWindow && !this.shopWindow.isDestroyed()) {
      this.shopWindow.close()
    }

    this.shopWindow = new BrowserWindow({
      width: WINDOW_SIZES.SHOP.width,
      height: WINDOW_SIZES.SHOP.height,
      show: false,
      autoHideMenuBar: true,
      icon: APP_ICON,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: false,
        backgroundThrottling: false
      }
    })

    this.shopWindow.setOpacity(0.02)
    this.shopWindow.center()
    this.shopWindow.showInactive()

    setUserAgent(this.shopWindow)
    if (this.mainWindow) {
      this.shopWindow.setParentWindow(this.mainWindow)
    }

    this.shopWindow.webContents.setWindowOpenHandler(({ url }) => {
      this.debug(`[JD-Window] Intercepted window open: ${url}`)
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          show: true,
          webPreferences: { backgroundThrottling: false }
        }
      }
    })

    this.shopWindow.webContents.on('did-create-window', (newWin) => {
      setUserAgent(newWin)
      newWin.setIcon(APP_ICON)
      newWin.focus()
    })

    return new Promise<AddToCartResult>((resolve) => {
      let resolved = false
      const doResolve = (res: AddToCartResult) => {
        if (resolved) return
        resolved = true
        clearInterval(checkInterval)
        clearTimeout(timeout)
        resolve(res)
      }

      const idMatch = orderDetailUrl.match(/[?&]orderid=([^&]+)/i)
      const bizOrderId = idMatch ? idMatch[1] : ''

      const timeout = setTimeout(() => {
        if (!resolved) {
          this.log('❌ 自动再次购买超时，请手动操作')
          if (this.shopWindow && !this.shopWindow.isDestroyed()) {
            this.shopWindow.setOpacity(1.0)
            this.shopWindow.center()
            this.shopWindow.restore()
            this.shopWindow.show()
          }
          doResolve({ success: false, error: '再次购买超时' })
        }
      }, 60000)

      let rebuyClicked = false
      let noButtonCount = 0
      let checking = false

      const checkInterval = setInterval(async () => {
        if (resolved) return
        if (checking) return
        checking = true
        if (!this.shopWindow || this.shopWindow.isDestroyed()) {
          doResolve({ success: false, error: '操作窗口已关闭' })
          return
        }

        try {
          const url = this.shopWindow.webContents.getURL()
          if (!url) return

          if (url.includes('passport') || url.includes('login')) {
            this.log('⚠️ 登录已过期')
            doResolve({ success: false, error: '登录已过期' })
            return
          }

          // 验证码检测
          const hasCaptcha = await execJS(this.shopWindow, `
            (function() {
              var bodyText = document.body ? document.body.innerText : '';
              return bodyText.includes('验证码') || bodyText.includes('安全验证') || !!document.querySelector('#captcha, [id*="captcha"], [class*="captcha"], .slider');
            })()
          `)

          if (hasCaptcha) {
            this.log('⚠️ 京东订单详情页遭遇风控拦截，请手动通过验证码...')
            this.shopWindow.setOpacity(1.0)
            this.shopWindow.setSize(WINDOW_SIZES.VERIFICATION.width, WINDOW_SIZES.VERIFICATION.height)
            this.shopWindow.setTitle('京东安全验证 - 请完成滑块验证')
            this.shopWindow.setAlwaysOnTop(true)
            injectOverlayBanner(this.shopWindow, '🔐 京东安全验证：检测到风控拦截，请手动滑块验证')
            injectCenterToast(this.shopWindow, '请完成滑块验证')
            this.shopWindow.center()
            this.shopWindow.restore()
            this.shopWindow.show()
            this.shopWindow.focus()
            return
          }

          const isDetailOrList = url.includes('details.jd.com') || url.includes('orderid=') || url.includes('order.jd.com') || url.includes('list.action')
          if (isDetailOrList) {
            if (rebuyClicked) return

            const rebuyBtn = await execJS(this.shopWindow, `
              (function(bizOrderId) {
                var isDetail = window.location.href.includes('details.jd.com') || window.location.href.includes('orderid=');
                if (isDetail) {
                  var targets = ['还要买', '再次购买', '再买一单', '立即购买', '重新购买'];
                  var els = document.querySelectorAll('button, a, [class*="btn"], span, div');
                  for (var i = 0; i < els.length; i++) {
                    var el = els[i];
                    var text = (el.textContent || '').trim().replace(/\\s+/g, '');
                    for (var j = 0; j < targets.length; j++) {
                      if (text === targets[j] || text.includes(targets[j])) {
                        var rect = el.getBoundingClientRect();
                        if (rect.width > 0 && rect.height > 0) {
                          el.scrollIntoView({ block: 'center', inline: 'center' });
                          var r2 = el.getBoundingClientRect();
                          return { found: true, text: text, type: 'detail', x: Math.round(r2.left + r2.width/2), y: Math.round(r2.top + r2.height/2) };
                        }
                      }
                    }
                  }
                  var againBtn = document.querySelector('.btn-again, [class*="again"]');
                  if (againBtn) {
                    var r = againBtn.getBoundingClientRect();
                    if (r.width > 0 && r.height > 0) {
                      againBtn.scrollIntoView({ block: 'center', inline: 'center' });
                      var r2 = againBtn.getBoundingClientRect();
                      return { found: true, text: againBtn.textContent.trim(), type: 'detail', x: Math.round(r2.left + r2.width/2), y: Math.round(r2.top + r2.height/2) };
                    }
                  }
                } else if (bizOrderId) {
                  // 2. 如果是订单列表页，查找特定的订单行并找到“还要买”按钮
                  var orderContainer = document.querySelector('#tb-' + bizOrderId + ', [id*="' + bizOrderId + '"], [data-orderid*="' + bizOrderId + '"]');
                  if (!orderContainer) {
                    var allTables = document.querySelectorAll('table, div[class*="order"], div[class*="box"]');
                    for (var tIdx = 0; tIdx < allTables.length; tIdx++) {
                      var table = allTables[tIdx];
                      if (table.textContent && table.textContent.includes(bizOrderId)) {
                        if (table.textContent.includes('还要买') || table.textContent.includes('再次购买') || table.textContent.includes('订单详情')) {
                          orderContainer = table;
                          break;
                        }
                      }
                    }
                  }
                  
                  if (orderContainer) {
                    var targetsList = ['还要买', '再次购买', '再买一单'];
                    var subEls = orderContainer.querySelectorAll('button, a, [class*="btn"], span');
                    for (var sIdx = 0; sIdx < subEls.length; sIdx++) {
                      var subEl = subEls[sIdx];
                      var subText = (subEl.textContent || '').trim().replace(/\\s+/g, '');
                      for (var tIdx = 0; tIdx < targetsList.length; tIdx++) {
                        if (subText === targetsList[tIdx] || subText.includes(targetsList[tIdx])) {
                          var rect = subEl.getBoundingClientRect();
                          if (rect.width > 0 && rect.height > 0) {
                            subEl.scrollIntoView({ block: 'center', inline: 'center' });
                            var r2 = subEl.getBoundingClientRect();
                            return { found: true, text: subText, type: 'list', x: Math.round(r2.left + r2.width/2), y: Math.round(r2.top + r2.height/2) };
                          }
                        }
                      }
                    }
                    var classAgain = orderContainer.querySelector('[class*="again"], [class*="buy"]');
                    if (classAgain) {
                      var rect = classAgain.getBoundingClientRect();
                      if (rect.width > 0 && rect.height > 0) {
                        classAgain.scrollIntoView({ block: 'center', inline: 'center' });
                        var r2 = classAgain.getBoundingClientRect();
                        return { found: true, text: classAgain.textContent.trim(), type: 'list', x: Math.round(r2.left + r2.width/2), y: Math.round(r2.top + r2.height/2) };
                      }
                    }
                  }
                }
                return { found: false };
              })(${JSON.stringify(bizOrderId)})
            `) as any

            if (rebuyBtn && rebuyBtn.found) {
              rebuyClicked = true
              this.log(`在订单${rebuyBtn.type === 'list' ? '列表' : '详情'}页中找到“再次购买”按钮: "${rebuyBtn.text}"，正在点击...`)
              await humanClickAt(this.shopWindow, rebuyBtn.x, rebuyBtn.y)
              
              let redirectSuccess = false
              for (let attempt = 0; attempt < 15; attempt++) {
                await humanDelay(1000)
                if (resolved) return
                const currentUrl = this.shopWindow.webContents.getURL()
                
                if (currentUrl.includes('cart.jd.com') || currentUrl.includes('cart.action')) {
                  this.log('🎉 再次购买成功，已自动加入购物车/跳转购物车页')
                  redirectSuccess = true
                  
                  if (cartOnly) {
                    doResolve({ success: true, directToPay: false })
                  } else {
                    this.log('正在转往购物车结算...')
                    await humanDelay(1500)
                    const goCheckout = await execJS(this.shopWindow, `
                      (function() {
                        var btn = document.querySelector('.common-submit-btn, [class*="submit-btn"], .btn-area a');
                        if (btn) {
                          btn.scrollIntoView({ block: 'center', inline: 'center' });
                          var r = btn.getBoundingClientRect();
                          return { clicked: true, x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2) };
                        }
                        return { clicked: false };
                      })()
                    `)

                    if (goCheckout && goCheckout.clicked) {
                      await humanClickAt(this.shopWindow, goCheckout.x, goCheckout.y)
                      await humanDelay(5000)
                      const finalUrl = this.shopWindow.webContents.getURL()
                      if (finalUrl.includes('trade') || finalUrl.includes('getOrderInfo')) {
                        this.log('🎉 经过购物车跳转，成功到达京东结算页')
                        doResolve({ success: true, directToPay: true })
                      } else {
                        doResolve({ success: false, error: '购物车结算后无法跳转至结算页' })
                      }
                    } else {
                      doResolve({ success: false, error: '未定位到购物车中的去结算按钮' })
                    }
                  }
                  break
                } else if (currentUrl.includes('trade.jd.com') || currentUrl.includes('getOrderInfo')) {
                  this.log('🎉 再次购买成功，直接跳转至结算页面')
                  redirectSuccess = true
                  doResolve({ success: true, directToPay: true })
                  break
                } else if (currentUrl.includes('item.jd.com') || currentUrl.includes('item.jd.hk')) {
                  this.log('再次购买跳转到了商品详情页，转入商品详情页购买流程...')
                  redirectSuccess = true
                  const detailRes = await this.purchaseFromUrl(currentUrl, sku, cartOnly)
                  doResolve(detailRes)
                  break
                }
              }

              if (!redirectSuccess) {
                this.log('⚠️ 点击再次购买后未检测到跳转，尝试在当前窗口继续操作，请关注窗口变化')
                if (this.shopWindow && !this.shopWindow.isDestroyed()) {
                  this.shopWindow.setOpacity(1.0)
                  this.shopWindow.restore()
                  this.shopWindow.show()
                }
                doResolve({ success: false, error: '点击再次购买后页面未跳转' })
              }
            } else {
              noButtonCount++
              if (noButtonCount >= 6) {
                this.log('❌ 在订单列表/详情页中多次尝试未定位到该订单的“还要买”按钮，降级通过商品链接直接购买...')
                const fallbackRes = await this.purchaseFromUrl(productUrl, sku, cartOnly)
                doResolve(fallbackRes)
              }
            }
          } else {
            noButtonCount++
            if (noButtonCount >= 6) {
              this.log('❌ 页面已偏离订单列表/详情页，降级通过商品链接直接购买...')
              const fallbackRes = await this.purchaseFromUrl(productUrl, sku, cartOnly)
              doResolve(fallbackRes)
            }
          }
        } catch (err) {
          this.debug(`[JD-Rebuy-OrderDetail-Poll] Poll loop error: ${err}`)
        } finally {
          checking = false
        }
      }, 2000)

      this.shopWindow!.loadURL(orderDetailUrl)
    })
  }

  async openProductPage(productUrl: string): Promise<void> {
    this.log('正在拉起京东商品页...')
    await this.syncCookiesToElectron()

    if (this.shopWindow && !this.shopWindow.isDestroyed()) {
      this.shopWindow.close()
    }

    this.shopWindow = new BrowserWindow({
      width: WINDOW_SIZES.SHOP.width,
      height: WINDOW_SIZES.SHOP.height,
      autoHideMenuBar: true,
      title: '商品页面 - 请确认商品规格并购买',
      icon: APP_ICON,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: false,
        backgroundThrottling: false
      }
    })

    setUserAgent(this.shopWindow)
    if (this.mainWindow) {
      this.shopWindow.setParentWindow(this.mainWindow)
    }

    // 追踪京东收银台窗口的弹出并自动推至前台
    this.shopWindow.webContents.setWindowOpenHandler(({ url }) => {
      this.log(`[JD-Window] Detected popout window: ${url}`)
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          show: true,
          webPreferences: { backgroundThrottling: false }
        }
      }
    })

    this.shopWindow.webContents.on('did-create-window', (newWin) => {
      this.log('[JD-Window] Intercepted new window created, setting custom UA and focus')
      setUserAgent(newWin)
      newWin.setIcon(APP_ICON)
      newWin.focus()
    })

    this.shopWindow.loadURL(productUrl)

    this.shopWindow.on('closed', async () => {
      this.shopWindow = null
      await this.syncCookiesFromElectron()
    })
  }

  // 京东商品详情页模拟规格匹配与物理点击的主体流程
  async purchaseFromUrl(productUrl: string, sku?: string, cartOnly = false): Promise<AddToCartResult> {
    this.log(`正在直购/加购京东商品: ${productUrl} (规格: "${sku || '无'}")`)
    await this.syncCookiesToElectron()

    if (this.shopWindow && !this.shopWindow.isDestroyed()) {
      this.shopWindow.close()
    }

    // 创建可视的直购主窗口
    this.shopWindow = new BrowserWindow({
      width: WINDOW_SIZES.SHOP.width,
      height: WINDOW_SIZES.SHOP.height,
      show: false,
      autoHideMenuBar: true,
      icon: APP_ICON,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: false,
        backgroundThrottling: false
      }
    })

    this.shopWindow.setOpacity(0.02)
    this.shopWindow.center()
    this.shopWindow.showInactive()

    setUserAgent(this.shopWindow)
    if (this.mainWindow) {
      this.shopWindow.setParentWindow(this.mainWindow)
    }

    this.shopWindow.webContents.setWindowOpenHandler(({ url }) => {
      this.debug(`[JD-Window] Intercepted window open: ${url}`)
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          show: true,
          webPreferences: { backgroundThrottling: false }
        }
      }
    })

    this.shopWindow.webContents.on('did-create-window', (newWin) => {
      setUserAgent(newWin)
      newWin.setIcon(APP_ICON)
      newWin.focus()
    })

    return new Promise<AddToCartResult>((resolve) => {
      let resolved = false
      const doResolve = (res: AddToCartResult) => {
        if (resolved) return
        resolved = true
        clearTimeout(timeout)
        resolve(res)
      }

      const timeout = setTimeout(() => {
        if (!resolved) {
          this.log('❌ 自动直购/加购超时，请手动操作')
          if (this.shopWindow && !this.shopWindow.isDestroyed()) {
            this.shopWindow.setOpacity(1.0)
            this.shopWindow.center()
            this.shopWindow.restore()
            this.shopWindow.show()
          }
          doResolve({ success: false, error: '直购超时' })
        }
      }, 50000)

      this.shopWindow!.webContents.on('did-finish-load', async () => {
        if (resolved) return
        const url = this.shopWindow!.webContents.getURL()
        let pageTitle = ''
        try {
          pageTitle = await execJS(this.shopWindow, 'document.title') as string
        } catch {}
        this.log(`[JD-Navigation] 商品详情页已加载完成，当前URL: ${url}，页面标题: "${pageTitle}"`)
        this.debug(`[JD-Navigation] Detail page loaded URL: ${url}`)

        if (url.includes('passport') || url.includes('login')) {
          this.log('⚠️ 登录已过期')
          doResolve({ success: false, error: '登录已过期' })
          return
        }

        // 1. 等待防风控拟人化高斯分布延迟
        await humanDelay(3000)

        // 2. 选择商品规格 SKU
        const isNoSku = !sku || ['无', '无规格', 'none', 'default', 'null', 'undefined'].includes(sku.trim().toLowerCase())
        if (sku && !isNoSku) {
          this.log(`正在选择商品规格: "${sku}"...`)
          this.debug(`[JD-SKU] Attempting to match and click SKU: "${sku}"...`)
          // 精准及模糊匹配京东详情页规格 SKU
          const clickRes = await execJS(this.shopWindow, `
            (function() {
              var target = ${JSON.stringify(sku)};
              var parts = target.split(/[;；]/);
              var clicked = 0;
              
              for (var p = 0; p < parts.length; p++) {
                var pVal = parts[p].trim();
                if (!pVal) continue;
                
                // 去除属性名如 颜色:红 中的属性名
                var val = pVal;
                var colon = pVal.indexOf(':');
                if (colon === -1) colon = pVal.indexOf('：');
                if (colon !== -1) {
                  val = pVal.substring(colon + 1).trim();
                }
                
                // 查找所有可能的规格节点
                var items = document.querySelectorAll('#choose-attrs .item a, #choose-attrs .item, [data-sku], [class*="sku"]');
                var bestEl = null;
                for (var i = 0; i < items.length; i++) {
                  var item = items[i];
                  var text = (item.textContent || item.innerText || '').trim().replace(/\\s+/g, '');
                  var cleanVal = val.replace(/\\s+/g, '');
                  if (text === cleanVal || text.includes(cleanVal) || cleanVal.includes(text)) {
                    bestEl = item;
                    if (text === cleanVal) break;
                  }
                }
                if (bestEl) {
                  var rect = bestEl.getBoundingClientRect();
                  if (rect.width > 0 && rect.height > 0) {
                    var x = rect.left + rect.width * (0.3 + Math.random() * 0.4);
                    var y = rect.top + rect.height * (0.3 + Math.random() * 0.4);
                    // 点击
                    if (window._hs && typeof window._hs.click === 'function') {
                      window._hs.click(bestEl);
                    } else {
                      bestEl.click();
                    }
                    clicked++;
                  }
                }
              }
              return clicked;
            })()
          `)
          this.debug(`[JD-SKU] Clicked ${clickRes} specifications`)
          await humanDelay(1500)
        }

        // 3. 点击“加入购物车”或“立即购买”
        if (cartOnly) {
          this.log('正在将商品加入京东购物车...')
          this.debug('[JD-Action] Click "Add to Cart"...')
          // 京东详情页的“加入购物车”通常是 #InitCartUrl
          const cartClicked = await execJS(this.shopWindow, `
            (function() {
              var btn = document.querySelector('#InitCartUrl, #add-to-cart, [class*="add-cart"], [class*="InitCartUrl"], [id*="add-cart"]');
              if (!btn) {
                var els = document.querySelectorAll('a, button, div, span');
                for (var i = 0; i < els.length; i++) {
                  var el = els[i];
                  var text = (el.textContent || el.innerText || '').trim();
                  if (text === '加入购物车' || text === '加购' || text === '加入购物车立即购买') {
                    var rect = el.getBoundingClientRect();
                    if (rect.width > 0 && rect.height > 0) {
                      btn = el;
                      if (text === '加入购物车') break;
                    }
                  }
                }
              }
              if (btn) {
                btn.scrollIntoView({ block: 'center', inline: 'center' });
                var r = btn.getBoundingClientRect();
                return { clicked: true, x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2) };
              }
              return { clicked: false };
            })()
          `)

          if (cartClicked && cartClicked.clicked) {
            this.debug(`[JD-Mouse] Clicking Add to Cart at (${cartClicked.x}, ${cartClicked.y})`)
            await humanClickAt(this.shopWindow!, cartClicked.x, cartClicked.y)
            await humanDelay(5000)

            // 检查加购结果
            const afterUrl = this.shopWindow!.webContents.getURL()
            const successText = await execJS(this.shopWindow, `
              (function() {
                var bodyText = document.body ? document.body.innerText : '';
                return bodyText.includes('商品已成功加入购物车') || bodyText.includes('成功加入') || !!document.querySelector('.addcart-success');
              })()
            `)

            if (afterUrl.includes('addcart') || successText) {
              this.log('🎉 商品已成功加入京东购物车')
              doResolve({ success: true, directToPay: false })
            } else {
              this.log('加购结果未明确，跳转失败')
              doResolve({ success: false, error: '加购可能失败（未匹配到加购成功页）' })
            }
          } else {
            try {
              const diag = await execJS(this.shopWindow, `
                (function() {
                  return {
                    url: window.location.href,
                    title: document.title,
                    htmlLen: document.documentElement.innerHTML.length,
                    bodyText: document.body ? document.body.innerText.substring(0, 300) : '',
                    hasCaptcha: !!(document.querySelector('#J_captcha') || document.querySelector('[class*="captcha"]') || document.querySelector('#popup-captcha') || document.querySelector('.yidun'))
                  };
                })()
              `) as any
              this.log(`⚠️ [JD-Rebuy-Diagnostic] 未定位到加购按钮，当前页面状态：URL="${diag.url}", Title="${diag.title}", HTML长度=${diag.htmlLen}, 疑似验证码=${diag.hasCaptcha}, 文本="${diag.bodyText.replace(/\\s+/g, ' ')}"`)
            } catch (diagErr) {
              this.log(`[JD-Rebuy-Diagnostic] 收集加购诊断信息失败: ${diagErr}`)
            }
            this.log('❌ 未在京东详情页定位到“加入购物车”按钮')
            doResolve({ success: false, error: '加购按钮未找到' })
          }
        } else {
          // 立即复购结算模式：京东为“立即购买”或进入结算页
          this.log('正在执行立即购买...')
          this.debug('[JD-Action] Click "Buy Now"...')
          // 京东“立即购买”按钮一般是 #btn-onkeybuy 或者是立即抢购
          const buyClicked = await execJS(this.shopWindow, `
            (function() {
              var btn = document.querySelector('#btn-onkeybuy, .btn-onkeybuy, [class*="buy-now"], #InitCartUrl');
              if (!btn) {
                var els = document.querySelectorAll('a, button, div, span');
                for (var i = 0; i < els.length; i++) {
                  var el = els[i];
                  var text = (el.textContent || el.innerText || '').trim();
                  if ((text === '立即购买' || text === '立即抢购' || text === '一键购买') && !el.querySelector('a, button, div')) {
                    var rect = el.getBoundingClientRect();
                    if (rect.width > 0 && rect.height > 0) {
                      btn = el;
                      break;
                    }
                  }
                }
                if (!btn) {
                  for (var i = 0; i < els.length; i++) {
                    var el = els[i];
                    var text = (el.textContent || el.innerText || '').trim();
                    if ((text.includes('立即购买') || text.includes('立即抢购')) && text.length < 15) {
                      var rect = el.getBoundingClientRect();
                      if (rect.width > 0 && rect.height > 0) {
                        btn = el;
                        break;
                      }
                    }
                  }
                }
              }
              if (btn) {
                btn.scrollIntoView({ block: 'center', inline: 'center' });
                var r = btn.getBoundingClientRect();
                return { clicked: true, name: btn.id || btn.className || 'text-match', x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2) };
              }
              return { clicked: false };
            })()
          `)

          if (buyClicked && buyClicked.clicked) {
            this.debug(`[JD-Mouse] Clicking Buy Now at (${buyClicked.x}, ${buyClicked.y}) [Selector: ${buyClicked.name}]`)
            await humanClickAt(this.shopWindow!, buyClicked.x, buyClicked.y)
            await humanDelay(5000)

            // 点击“立即购买”后如果进入结算页（即 trade.jd.com）
            const nextUrl = this.shopWindow!.webContents.getURL()
            this.debug(`[JD-Navigation] URL after Buy Now click: ${nextUrl}`)

            if (nextUrl.includes('trade.jd.com') || nextUrl.includes('getOrderInfo')) {
              this.log('🎉 成功跳转至京东结算页面')
              doResolve({ success: true, directToPay: true })
            } else {
              // 京东有些商品不适合立即购买，可能进入了加购流程，在此自动前往购物车
              this.log('立即购买未直接跳转结算，正在转往购物车结算...')
              this.debug('[JD-Action] Buy Now did not navigate to checkout, heading to cart page instead...')
              this.shopWindow!.loadURL('https://cart.jd.com/cart.action')
              
              await new Promise<void>(r => {
                this.shopWindow!.webContents.once('did-finish-load', () => r())
              })
              await humanDelay(2000)
              
              // 点击去结算
              const goCheckout = await execJS(this.shopWindow, `
                (function() {
                  var btn = document.querySelector('.common-submit-btn, [class*="submit-btn"], .btn-area a');
                  if (btn) {
                    btn.scrollIntoView({ block: 'center', inline: 'center' });
                    var r = btn.getBoundingClientRect();
                    return { clicked: true, x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2) };
                  }
                  return { clicked: false };
                })()
              `)

              if (goCheckout && goCheckout.clicked) {
                this.debug(`[JD-Mouse] Clicking "Go Checkout" in cart at (${goCheckout.x}, ${goCheckout.y})`)
                await humanClickAt(this.shopWindow!, goCheckout.x, goCheckout.y)
                await humanDelay(5000)
                const finalUrl = this.shopWindow!.webContents.getURL()
                if (finalUrl.includes('trade') || finalUrl.includes('getOrderInfo')) {
                  this.log('🎉 经过购物车跳转，成功到达京东结算页')
                  doResolve({ success: true, directToPay: true })
                } else {
                  doResolve({ success: false, error: '无法跳转至结算页' })
                }
              } else {
                doResolve({ success: false, error: '未定位到去结算按钮' })
              }
            }
          } else {
            try {
              const diag = await execJS(this.shopWindow, `
                (function() {
                  return {
                    url: window.location.href,
                    title: document.title,
                    htmlLen: document.documentElement.innerHTML.length,
                    bodyText: document.body ? document.body.innerText.substring(0, 300) : '',
                    hasCaptcha: !!(document.querySelector('#J_captcha') || document.querySelector('[class*="captcha"]') || document.querySelector('#popup-captcha') || document.querySelector('.yidun'))
                  };
                })()
              `) as any
              this.log(`⚠️ [JD-Rebuy-Diagnostic] 未定位到购买按钮，当前页面状态：URL="${diag.url}", Title="${diag.title}", HTML长度=${diag.htmlLen}, 疑似验证码=${diag.hasCaptcha}, 文本="${diag.bodyText.replace(/\\s+/g, ' ')}"`)
            } catch (diagErr) {
              this.log(`[JD-Rebuy-Diagnostic] 收集购买诊断信息失败: ${diagErr}`)
            }
            this.log('❌ 未在京东详情页定位到“立即购买”或“加购”按钮')
            doResolve({ success: false, error: '购买按钮未找到' })
          }
        }
      })

      this.shopWindow!.loadURL(productUrl)
    })
  }

  // 结算
  async checkout(directToPay?: boolean, quantity?: number): Promise<CheckoutResult> {
    this.debug('[JD-Action] Performing Checkout validation...')
    if (!this.shopWindow || this.shopWindow.isDestroyed()) {
      return { success: false, error: '交互窗口未就绪' }
    }

    await humanDelay(3000)
    
    // 解析实付金额
    const currentPrice = await execJS(this.shopWindow, `
      (function() {
        var el = document.querySelector('#sumPayPriceId, .sumPayPriceId, [class*="pay-price"], [class*="total-val"]');
        if (el) {
          var t = el.textContent.replace(/[¥￥\\s]/g, '');
          return parseFloat(t) || 0;
        }
        // 正则提取包含 ¥/￥ 的金额元素
        var all = document.querySelectorAll('*');
        for (var i = all.length - 1; i >= 0; i--) {
          var txt = all[i].textContent || '';
          if (all[i].children.length === 0 && txt.includes('¥')) {
            var m = txt.match(/¥\\s*(\\d+(\\.\\d+)?)/);
            if (m) return parseFloat(m[1]);
          }
        }
        return 0;
      })()
    `)

    this.log(`已获取订单结算金额：¥${currentPrice || '未知'}`)
    this.debug(`[JD-Price] Parsed order total amount: ¥${currentPrice || '未知'}`)

    return {
      success: true,
      currentPrice: currentPrice || undefined
    }
  }

  // 支付
  async pay(totalAmount?: number, dryRun?: boolean, paymentMode?: string): Promise<PayResult> {
    this.debug(`[JD-Action] Initiating Pay: totalAmount=${totalAmount}, dryRun=${dryRun}, mode=${paymentMode}`)
    if (!this.shopWindow || this.shopWindow.isDestroyed()) {
      return { success: false, error: '交互窗口已关闭' }
    }

    if (dryRun) {
      this.log('测试环境模式下，跳过实际订单提交和付款')
      return { success: true }
    }

    // 京东结算页面提交订单按钮
    const submitBtn = await execJS(this.shopWindow, `
      (function() {
        var btn = document.querySelector('#order-submit, .checkout-submit, [class*="submit-btn"]');
        if (btn) {
          btn.scrollIntoView({ block: 'center', inline: 'center' });
          var r = btn.getBoundingClientRect();
          return { found: true, x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2) };
        }
        return { found: false };
      })()
    `)

    if (submitBtn && submitBtn.found) {
      this.log(`[JD-Mouse] Clicking "Submit Order" at (${submitBtn.x}, ${submitBtn.y})`)
      await humanClickAt(this.shopWindow, submitBtn.x, submitBtn.y)
      await humanDelay(5000)

      const afterSubmitUrl = this.shopWindow.webContents.getURL()
      this.log(`[JD-Navigation] URL after Submit Order: ${afterSubmitUrl}`)

      // 订单提交成功，进入收银台
      if (afterSubmitUrl.includes('cashier') || afterSubmitUrl.includes('payment') || afterSubmitUrl.includes('pay')) {
        this.log('🎉 订单提交完成，成功进入京东收银台页面')
        
        // 自动拉前台居中展示，供扫码支付
        this.shopWindow.setOpacity(1.0)
        this.shopWindow.setSize(WINDOW_SIZES.CONFIRMATION.width, WINDOW_SIZES.CONFIRMATION.height)
        this.shopWindow.setTitle('京东收银台 - 请扫码付款')
        this.shopWindow.center()
        this.shopWindow.show()
        this.shopWindow.focus()
        
        injectOverlayBanner(this.shopWindow, '💳 自动购物助手：订单已提交！请在下方收银台完成扫码支付，付款后系统会自动完成记录')
        injectCenterToast(this.shopWindow, '请扫描二维码付款')

        return {
          success: true
        }
      } else {
        return {
          success: false,
          error: '订单提交失败，未跳转到收银台页面'
        }
      }
    } else {
      return {
        success: false,
        error: '未找到“提交订单”按钮'
      }
    }
  }

  // 展示付款小窗口，等待付款
  async showPaymentWindow(title?: string): Promise<{ paid: boolean }> {
    this.log('Showing cashier payment window...')
    if (!this.shopWindow || this.shopWindow.isDestroyed()) {
      return { paid: false }
    }

    this.shopWindow.setSize(WINDOW_SIZES.CONFIRMATION.width, WINDOW_SIZES.CONFIRMATION.height)
    this.shopWindow.setTitle(title || '收银台付款')
    this.shopWindow.center()
    this.shopWindow.show()
    this.shopWindow.focus()

    injectOverlayBanner(this.shopWindow, `💳 京东支付引导：请在弹窗内完成支付`)
    injectCenterToast(this.shopWindow, '请完成支付')

    // 挂起，直到用户完成支付（通常跳转到 success 页面，或者用户手动关闭窗口）
    return new Promise<{ paid: boolean }>((resolve) => {
      let resolved = false
      const checkPaid = setInterval(() => {
        if (!this.shopWindow || this.shopWindow.isDestroyed()) {
          clearInterval(checkPaid)
          if (!resolved) {
            resolved = true
            resolve({ paid: false })
          }
          return
        }
        const url = this.shopWindow.webContents.getURL()
        if (url.includes('success') || url.includes('complete') || url.includes('paysuccess')) {
          clearInterval(checkPaid)
          if (!resolved) {
            resolved = true
            this.log('🎉 监测到京东支付成功页，支付完成')
            resolve({ paid: true })
          }
        }
      }, 2000)

      this.shopWindow.on('closed', () => {
        clearInterval(checkPaid)
        if (!resolved) {
          resolved = true
          resolve({ paid: false })
        }
      })
    })
  }

  async cleanup(): Promise<void> {
    this.cleanupWindows()
  }
}
