import { BrowserWindow } from 'electron'
import type { Database } from '../../../db/database'
import type { Order } from '../../../../shared/types/platform.types'
import { CookieManager } from '../infrastructure/cookie-manager'
import { WindowManager } from '../infrastructure/window-manager'
import { TaobaoAuth } from '../taobao.auth'
import { setUserAgent, debugLog, getOrderApiJs } from '../utils/page-helper'
import { ORDER_API_URL, APP_ICON } from '../utils/constants'
import { TAOBAO_SELECTORS } from '../taobao.selectors'

export class OrderService {
  private windowManager: WindowManager
  private cookieManager: CookieManager
  private auth: TaobaoAuth
  private db: Database
  private emitStatus: (status: string) => void

  constructor(
    windowManager: WindowManager,
    cookieManager: CookieManager,
    auth: TaobaoAuth,
    db: Database,
    emitStatus: (status: string) => void
  ) {
    this.windowManager = windowManager
    this.cookieManager = cookieManager
    this.auth = auth
    this.db = db
    this.emitStatus = emitStatus
  }

  async fetchOrderHistory(_page = 1, timeRange?: { beginTime?: string; endTime?: string }): Promise<Order[]> {
    this.emitStatus('正在同步历史订单...')

    await this.cookieManager.syncCookiesToElectron(null, this.auth)

    const hiddenWindow = new BrowserWindow({
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
    setUserAgent(hiddenWindow)
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

        setUserAgent(hiddenWindow)
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
          `(${getOrderApiJs()})(${pageNum}, "${beginTime}", "${endTime}")`
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
            platform: 'taobao',
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
          allOrders.push({ id: orderId, platform: 'taobao', ...item, rawData: JSON.stringify(item) })
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
}
