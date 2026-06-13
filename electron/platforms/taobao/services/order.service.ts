import { BrowserWindow } from 'electron'
import type { Database } from '../../../db/database'
import type { Order } from '../../../../shared/types/platform.types'
import { CookieManager } from '../infrastructure/cookie-manager'
import { WindowManager } from '../infrastructure/window-manager'
import { TaobaoAuth } from '../taobao.auth'
import { setUserAgent, debugLog, getOrderApiJs } from '../utils/page-helper'
import { APP_ICON, TAOBAO_PRELOAD } from '../utils/constants'
import { TAOBAO_SELECTORS } from '../taobao.selectors'

export class OrderService {
  private windowManager: WindowManager
  private cookieManager: CookieManager
  private auth: TaobaoAuth
  private db: Database
  private emitStatus: (status: string) => void
  private syncCancelled = false

  cancelSync() {
    this.syncCancelled = true
  }

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
    this.syncCancelled = false
    this.emitStatus('正在同步历史订单...')

    await this.cookieManager.syncCookiesToElectron(null, this.auth)

    const hiddenWindow = new BrowserWindow({
      width: 1280,
      height: 800,
      show: false,
      icon: APP_ICON,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: false,
        preload: TAOBAO_PRELOAD,
      },
    })
    setUserAgent(hiddenWindow)

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
        if (this.syncCancelled) {
          this.emitStatus('同步已取消')
          break
        }
        this.emitStatus(`正在获取第 ${pageNum} 页订单${totalOrders > 0 ? `（共 ${totalOrders} 条）` : ''}...`)

        const result = await hiddenWindow.webContents.executeJavaScript(
          `(${getOrderApiJs()})(${pageNum}, "${beginTime}", "${endTime}")`
        ) as any

        if (result && result.rgv587_flag === 'sm' && result.url) {
          this.windowManager.createInteractionWindow(result.url)
          throw new Error('淘宝需要人机安全验证，已为您弹出验证窗口，请在此窗口内完成滑动验证后重新同步。')
        }

        const ordersList = result?.orders || []
        if (ordersList.length === 0) break

        if (result.totalOrders > 0) totalOrders = result.totalOrders

        for (let i = 0; i < ordersList.length; i++) {
          const item = ordersList[i]
          
          // 强化数据完整性校验：必须完整包含所有核心字段以供下次正常复购与匹配
          const hasValidOrderId = !!(item.orderId && item.orderId.trim() !== '')
          const hasValidProductName = !!(item.productName && item.productName.trim() !== '')
          const hasValidProductUrl = !!(item.productUrl && (item.productUrl.startsWith('http') || item.productUrl.startsWith('//') || item.productUrl.startsWith('https')))
          const hasValidPrice = typeof item.price === 'number' && item.price > 0
          // 允许 sku 存在但为空字符串（单规格商品无 sku 信息）
          const hasValidSku = typeof (item as any).sku === 'string'

          if (!hasValidOrderId || !hasValidProductName || !hasValidProductUrl || !hasValidPrice || !hasValidSku) {
            debugLog(`[OrderService] 跳过不完整的新订单: ${JSON.stringify(item)}`)
            continue
          }

          const totalSoFar = allOrders.length + 1
          this.emitStatus(`正在保存订单... (${totalSoFar})`)

          const orderId = this.db.upsertOrder({
            platform: 'taobao',
            orderId: item.orderId,
            productName: item.productName,
            productUrl: item.productUrl,
            price: item.price,
            imageUrl: item.imageUrl || '',
            purchasedAt: item.purchasedAt || new Date().toISOString(),
            shopName: (item as Record<string, unknown>).shopName as string || '',
            sku: (item as Record<string, unknown>).sku as string || '',
            skuId: (item as Record<string, unknown>).skuId as string || '',
            rawData: JSON.stringify(item),
          })
          allOrders.push({ id: orderId, platform: 'taobao', productName: item.productName, productUrl: item.productUrl, price: item.price, imageUrl: item.imageUrl, orderId: item.orderId, purchasedAt: item.purchasedAt, shopName: (item as Record<string, unknown>).shopName as string || '', sku: (item as Record<string, unknown>).sku as string || '', skuId: (item as Record<string, unknown>).skuId as string || '', rawData: JSON.stringify(item) } as Order)
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
