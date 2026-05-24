import type { Order, ParsedShoppingItem, PreviewItem, CandidateOrder, AmbiguityLevel, AddToCartResult } from '../../shared/types/platform.types'
import type { PlatformAdapter } from '../../shared/types/platform.types'
import type { ItemResult } from '../../shared/types/task.types'
import type { Database } from '../db/database'
import { appendFileSync } from 'fs'
import { join } from 'path'
import { app } from 'electron'

const PREVIEW_LOG_FILE = join(app.getPath('userData'), 'preview-debug.log')

function previewLog(msg: string) {
  const ts = new Date().toISOString()
  const line = `[${ts}] ${msg}\n`
  console.log(msg)
  try { appendFileSync(PREVIEW_LOG_FILE, line, 'utf-8') } catch {}
}

export type ErrorCategory = 'out_of_stock' | 'login_expired' | 'not_supported' | 'network_error' | 'no_history' | 'other'

export function categorizeError(error?: string): ErrorCategory {
  if (!error) return 'other'
  if (error.includes('已下架') || error.includes('商品已下架') || error.includes('已售罄') || error.includes('商品不存在')) return 'out_of_stock'
  if (error.includes('登录已过期') || error.includes('未登录') || error.includes('登录验证') || error.includes('身份验证')) return 'login_expired'
  if (error.includes('不支持再买一单') || error.includes('未找到再买一单') || error.includes('不支持再买')) return 'not_supported'
  if (error.includes('Timeout') || error.includes('timeout') || error.includes('网络') || error.includes('ERR_') || error.includes('net::')) return 'network_error'
  if (error.includes('未找到历史订单') || error.includes('没有历史')) return 'no_history'
  return 'other'
}

export const ERROR_CATEGORY_INFO: Record<ErrorCategory, { label: string; icon: string; color: string; description?: string }> = {
  out_of_stock: { label: '商品不可购买', icon: '📦', color: 'text-orange-500', description: '该商品已下架或库存不足' },
  login_expired: { label: '登录已过期', icon: '🔐', color: 'text-amber-500', description: '请重新登录账号' },
  not_supported: { label: '平台不支持', icon: '🚫', color: 'text-gray-500', description: '该商品所在店铺未开通"再买一单"功能，这是平台限制而非程序问题' },
  network_error: { label: '网络异常', icon: '🌐', color: 'text-blue-500', description: '网络连接不稳定，请检查网络设置' },
  no_history: { label: '未找到历史订单', icon: '🔍', color: 'text-purple-500', description: '未在历史订单中找到匹配的商品' },
  other: { label: '购买失败', icon: '❌', color: 'text-red-500', description: '购买过程中发生未知错误' },
}

export class TaskExecutor {
  private db: Database

  constructor(db: Database) {
    this.db = db
  }

  async execute(
    taskId: number,
    parsedItems: ParsedShoppingItem[],
    platform: PlatformAdapter,
    onProgress: (msg: string) => void,
    instruction?: string,
    dryRun?: boolean,
    paymentMode?: string,
  ): Promise<{ success: boolean; itemResults: ItemResult[]; error?: string }> {
    const itemResults: ItemResult[] = []

    for (const item of parsedItems) {
      const result: ItemResult = { name: item.name, quantity: item.quantity, status: 'failed' }
      const candidateOrders = this.findCandidateOrders(item, platform.name, result, onProgress, instruction)

      if (candidateOrders.length === 0) {
        result.error = '未找到历史订单'
        itemResults.push(result)
        continue
      }

      const order = candidateOrders[0]
      await this.processPurchase(taskId, item, order, platform, result, onProgress, dryRun, paymentMode)
      itemResults.push(result)

      if (platform.cleanup) {
        await platform.cleanup()
      }
    }

    const successCount = itemResults.filter(r => r.status === 'success').length
    const pendingCount = itemResults.filter(r => r.status === 'pending').length
    if (pendingCount > 0 && successCount === 0) {
      return { success: false, itemResults, error: `已找到替代商品，请选择：${itemResults.filter(r => r.status === 'pending').map(r => r.name).join('、')}` }
    }
    if (successCount === 0) {
      const failedDetails = itemResults.filter(r => r.status === 'failed').map(r => {
        if (r.error === '未找到历史订单') return `${r.name}（未找到历史订单）`
        if (r.error?.includes('不支持再买一单') || r.error?.includes('未找到再买一单')) return `${r.name}（平台未开通"再买一单"功能）`
        if (r.error?.includes('已下架')) return `${r.name}（${r.error}）`
        if (r.error?.includes('登录已过期')) return `${r.name}（登录已过期）`
        return `${r.name}（${r.error || '购买失败'}）`
      }).join('、')
      return { success: false, itemResults, error: `购买失败：${failedDetails}` }
    }

    const isCartOnly = paymentMode === 'cart_only'
    onProgress(isCartOnly ? '加购完成!' : '购买完成!')
    return { success: true, itemResults }
  }

  private async processPurchase(
    taskId: number,
    item: ParsedShoppingItem,
    order: Order,
    platform: PlatformAdapter,
    result: ItemResult,
    onProgress: (msg: string) => void,
    dryRun?: boolean,
    paymentMode?: string,
  ): Promise<void> {
    const isCartOnly = paymentMode === 'cart_only'
    const url = platform.getProductUrl(order)
    console.log(`[TaskExecutor] addToCart: name=${item.name}, orderId=${order.orderId}, url=${url}`)

    onProgress(`正在为 "${item.name}" 执行再买一单（订单 ${order.orderId}）...`)
    try {
      const cartResult: AddToCartResult = await platform.addToCart(url, item.sku, order.orderId, isCartOnly)
      if (!cartResult.success) {
        await this.handleSearchFallback(taskId, item, order, platform, cartResult, result, onProgress, dryRun, paymentMode)
      } else if (isCartOnly) {
        onProgress(`已将 "${item.name}" 加入购物车`)
        result.matchedProduct = order.productName
        result.status = 'success'
      } else {
        await this.handleCheckoutAndPay(taskId, item, order, platform, cartResult.directToPay, url, result, onProgress, dryRun, paymentMode)
      }
    } catch (e) {
      console.log(`[TaskExecutor] purchase failed for order ${order.orderId}: ${e}`)
      const errMsg = String(e)
      if (errMsg.includes('Object has been destroyed') || errMsg.includes('destroyed')) {
        result.error = '操作窗口已关闭'
      } else if (errMsg.includes('timeout') || errMsg.includes('Timeout') || errMsg.includes('超时')) {
        result.error = '操作超时'
      } else {
        result.error = errMsg
      }
    }
  }

  private async handleSearchFallback(
    taskId: number,
    item: ParsedShoppingItem,
    order: Order,
    platform: PlatformAdapter,
    cartResult: AddToCartResult,
    result: ItemResult,
    onProgress: (msg: string) => void,
    dryRun?: boolean,
    paymentMode?: string,
  ): Promise<void> {
    const isCartOnly = paymentMode === 'cart_only'
    const searchParts = [order.productName]
    if (order.shopName) searchParts.push(order.shopName)
    if (item.sku) searchParts.push(item.sku)
    const searchKeyword = searchParts.join(' ')
    onProgress(`再买一单失败（${cartResult.error}），正在打开搜索页面，请在搜索结果中找到对应商品并点击进入...`)
    try {
      const searchUrl = await platform.openSearchPage(searchKeyword)
      if (searchUrl) {
        const purchaseResult = await platform.purchaseFromUrl(searchUrl)
        if (purchaseResult.success) {
          if (isCartOnly) {
            onProgress(`已将商品加入购物车`)
            result.matchedProduct = order.productName
            result.status = 'success'
          } else {
            await this.handleCheckoutAndPay(taskId, item, order, platform, purchaseResult.directToPay, searchUrl, result, onProgress, dryRun, paymentMode)
          }
        } else {
          result.error = '商品页面无法购买'
        }
      } else {
        result.error = cartResult.error || '未找到商品'
      }
    } catch (e: any) {
      result.error = e.message || '打开搜索页面失败'
    }
  }

  private async handleCheckoutAndPay(
    taskId: number,
    item: ParsedShoppingItem,
    order: Order,
    platform: PlatformAdapter,
    directToPay: boolean,
    productUrl: string,
    result: ItemResult,
    onProgress: (msg: string) => void,
    dryRun?: boolean,
    paymentMode?: string,
  ): Promise<void> {
    onProgress(`正在结算 "${item.name}"${item.quantity > 1 ? `（x${item.quantity}）` : ''}...`)
    const checkoutResult = await platform.checkout(directToPay, item.quantity)
    if (!checkoutResult.success) {
      result.error = checkoutResult.error || '结算失败'
      return
    }

    const lastPrice = order.price
    const currentPrice = checkoutResult.currentPrice
    if (currentPrice && currentPrice > 0 && lastPrice > 0 && paymentMode !== 'checkout_only' && paymentMode !== 'cart_only') {
      const priceIncreaseRate = (currentPrice - lastPrice * item.quantity) / (lastPrice * item.quantity)
      const protectionThreshold = parseFloat(this.db.getSetting('price_protection_threshold') || '0.15')
      if (priceIncreaseRate >= protectionThreshold) {
        onProgress(`❌ 资金拦截："${item.name}" 当前价 (¥${currentPrice.toFixed(2)}) 较上次 (¥${(lastPrice * item.quantity).toFixed(2)}) 暴涨了 ${(priceIncreaseRate * 100).toFixed(0)}%，已紧急熔断拦截！`)
        const confirmationId = this.db.createPendingConfirmation({
          taskId,
          productName: item.name,
          originalPrice: lastPrice,
          failureReason: 'price_anomaly',
          searchKeyword: item.name,
          candidates: JSON.stringify([{
            platform: platform.name,
            productName: order.productName,
            price: currentPrice,
            imageUrl: order.imageUrl,
            productUrl,
            shopName: order.shopName,
          }]),
          orderId: order.id,
        })
        result.status = 'pending'
        result.pendingConfirmationId = confirmationId
        result.currentPrice = currentPrice
        result.lastPrice = lastPrice
        if (platform.cleanup) await platform.cleanup()
        return
      }
    }

    const totalAmount = order.price * item.quantity
    if (paymentMode === 'checkout_only') {
      onProgress(`已到达结算页面，请在弹出的窗口中确认金额并完成支付`)
      const payWindowResult = await platform.showPaymentWindow()
      if (payWindowResult.paid) {
        result.matchedProduct = order.productName
        result.status = 'success'
      } else {
        result.error = '支付未完成'
      }
    } else {
      onProgress(totalAmount > 0
        ? `正在支付 "${item.name}"（¥${totalAmount.toFixed(2)}）...`
        : `正在支付 "${item.name}"...`
      )
      const payResult = await platform.pay(totalAmount, dryRun, paymentMode)
      if (!payResult.success) {
        result.error = payResult.error || '支付失败'
      } else {
        result.matchedProduct = order.productName
        result.status = 'success'
      }
    }
  }

  private findCandidateOrders(item: ParsedShoppingItem, platformName: string, result: ItemResult, onProgress: (msg: string) => void, instruction?: string): Order[] {
    console.log(`[TaskExecutor] findCandidateOrders: name="${item.name}", orderRef=${item.orderRef}, platform=${platformName}, itemPlatform=${item.platform}, instruction="${instruction}"`)

    const searchPlatform = item.platform || platformName

    if (item.orderRef) {
      onProgress(`正在通过 LLM 匹配结果查找订单 #${item.orderRef}...`)
      const order = this.db.getOrderById(item.orderRef)
      if (order) {
        if ((order as any).unavailable) {
          onProgress(`LLM 匹配的订单 #${item.orderRef} 已被排除匹配，尝试其他方式...`)
        } else if (!item.platform || order.platform === searchPlatform) {
          result.matchedProduct = order.productName
          result.matchMethod = 'llm_direct'
          result.orderId = order.id
          onProgress(`LLM 精确匹配: ${order.productName}`)
          return [order]
        }
      }
      onProgress(`LLM 匹配的订单 #${item.orderRef} 不存在或平台不匹配，尝试其他方式...`)
    }

    onProgress(`正在查找 "${item.name}" 的历史订单...`)
    const exactOrders = this.db.searchOrders(item.name, searchPlatform)
    console.log(`[TaskExecutor] searchOrders("${item.name}", "${searchPlatform}"): ${exactOrders.length} results`)
    if (exactOrders.length > 0) {
      result.matchMethod = 'exact'
      result.matchedProduct = exactOrders[0].productName
      result.orderId = exactOrders[0].id
      onProgress(`精确匹配: ${exactOrders.length} 条订单`)
      return exactOrders
    }

    const { orders, usedKeyword } = this.db.searchOrdersFuzzy(item.name, searchPlatform)
    console.log(`[TaskExecutor] searchOrdersFuzzy("${item.name}", "${searchPlatform}"): ${orders.length} results, usedKeyword="${usedKeyword}"`)
    if (orders.length > 0) {
      result.matchMethod = 'fuzzy'
      result.matchedProduct = orders[0].productName
      result.orderId = orders[0].id
      onProgress(`模糊匹配(关键词"${usedKeyword}"): ${orders.length} 条订单`)
      return orders
    }

    console.log(`[TaskExecutor] No matching orders found for "${item.name}" on platform "${searchPlatform}"`)
    return []
  }

  private searchBestMatchOrder(item: ParsedShoppingItem, platformName: string, _instruction?: string): { order: Order | null; matchMethod: 'llm_direct' | 'exact' | 'fuzzy' | null } {
    const searchPlatform = item.platform || platformName
    previewLog(`[Preview] searchBestMatchOrder: name="${item.name}", orderRef=${item.orderRef}, searchPlatform="${searchPlatform}"`)

    if (item.orderRef) {
      const order = this.db.getOrderById(item.orderRef)
      previewLog(`[Preview]   llm_direct: orderRef=${item.orderRef}, found=${!!order}, platformMatch=${order ? order.platform === searchPlatform : 'N/A'}`)
      if (order && (order as any).unavailable) {
        previewLog(`[Preview]   llm_direct: orderRef=${item.orderRef} is excluded, skipping`)
      } else if (order && (!item.platform || order.platform === searchPlatform)) {
        return { order, matchMethod: 'llm_direct' }
      }
    }

    let exactOrders = this.db.searchOrders(item.name, searchPlatform)
    previewLog(`[Preview]   exact search: searchOrders("${item.name}", "${searchPlatform}") = ${exactOrders.length} results`)
    if (exactOrders.length === 0 && searchPlatform) {
      exactOrders = this.db.searchOrders(item.name)
      previewLog(`[Preview]   exact search (no platform): searchOrders("${item.name}") = ${exactOrders.length} results`)
    }
    if (exactOrders.length > 0) {
      previewLog(`[Preview]   exact match: id=${exactOrders[0].id}, name="${exactOrders[0].productName}"`)
      return { order: exactOrders[0], matchMethod: 'exact' }
    }

    if (item.name.length >= 2) {
      let fuzzyResult = this.db.searchOrdersFuzzy(item.name, searchPlatform)
      previewLog(`[Preview]   fuzzy search: searchOrdersFuzzy("${item.name}", "${searchPlatform}") = ${fuzzyResult.orders.length} results, usedKeyword="${fuzzyResult.usedKeyword}"`)
      if (fuzzyResult.orders.length === 0 && searchPlatform) {
        fuzzyResult = this.db.searchOrdersFuzzy(item.name)
        previewLog(`[Preview]   fuzzy search (no platform): searchOrdersFuzzy("${item.name}") = ${fuzzyResult.orders.length} results, usedKeyword="${fuzzyResult.usedKeyword}"`)
      }
      if (fuzzyResult.orders.length > 0) {
        previewLog(`[Preview]   fuzzy match: id=${fuzzyResult.orders[0].id}, name="${fuzzyResult.orders[0].productName}"`)
        return { order: fuzzyResult.orders[0], matchMethod: 'fuzzy' }
      }
    }

    previewLog(`[Preview]   no match found`)
    return { order: null, matchMethod: null }
  }

  private computeMatchScore(order: Order, keyword: string): number {
    const name = order.productName.toLowerCase()
    const kw = keyword.toLowerCase()
    if (name === kw) return 100
    if (name.includes(kw)) return 80 + (kw.length / name.length) * 20
    const spaceWords = kw.split(/\s+/).filter(w => w.length > 0)
    const matchedSpaceWords = spaceWords.filter(w => name.includes(w))
    if (matchedSpaceWords.length > 0 && spaceWords.length > 1) {
      return 50 + (matchedSpaceWords.length / spaceWords.length) * 30
    }
    let bestSubLen = 0
    for (let len = kw.length - 1; len >= 2; len--) {
      for (let start = 0; start <= kw.length - len; start++) {
        const sub = kw.substring(start, start + len)
        if (name.includes(sub)) {
          if (len > bestSubLen) bestSubLen = len
        }
      }
      if (bestSubLen > 0 && bestSubLen >= len) break
    }
    if (bestSubLen > 0) {
      const ratio = bestSubLen / kw.length
      if (ratio < 0.5) return 30 + ratio * 10
      if (ratio < 0.75) return 40 + (ratio - 0.5) * 80
      return 60 + ratio * 30
    }
    return 30
  }

  private computeAmbiguityLevel(candidates: CandidateOrder[]): AmbiguityLevel {
    if (candidates.length <= 1) return 'none'
    const prices = candidates.map(c => c.price).filter(p => p > 0)
    if (prices.length >= 2) {
      const minPrice = Math.min(...prices)
      const maxPrice = Math.max(...prices)
      if (minPrice > 0 && (maxPrice - minPrice) / minPrice > 0.3) return 'high'
    }
    const names = candidates.slice(0, 3).map(c => c.productName)
    const uniqueNames = new Set(names)
    if (uniqueNames.size > 1) return 'high'
    return 'low'
  }

  previewCandidateOrders(item: ParsedShoppingItem, platformName: string, instruction?: string): PreviewItem {
    const MAX_CANDIDATES = 10

    previewLog(`[Preview] === previewCandidateOrders START ===`)
    previewLog(`[Preview] item: name="${item.name}", orderRef=${item.orderRef}, platform=${item.platform}, sku=${item.sku}`)
    previewLog(`[Preview] matchedOrders: ${item.matchedOrders ? JSON.stringify(item.matchedOrders) : 'none'}`)

    const preview: PreviewItem = {
      name: item.name,
      quantity: item.quantity,
      sku: item.sku,
      orderRef: item.orderRef,
      matched: false,
    }

    if (item.matchedOrders && item.matchedOrders.length > 0) {
      const candidates: CandidateOrder[] = []
      for (const match of item.matchedOrders.slice(0, MAX_CANDIDATES)) {
        const order = this.db.getOrderById(match.orderRef)
        if (!order) {
          previewLog(`[Preview]   orderRef=${match.orderRef} not found in DB`)
          continue
        }
        previewLog(`[Preview]   [${candidates.length}] id=${order.id}, name="${order.productName}", price=${order.price}, confidence=${match.confidence}, purchasedAt="${order.purchasedAt}"`)
        candidates.push({
          id: order.id,
          productName: order.productName,
          price: order.price,
          imageUrl: order.imageUrl,
          platform: order.platform,
          purchasedAt: order.purchasedAt,
          shopName: order.shopName,
          matchScore: match.confidence,
        })
      }

      if (candidates.length > 0) {
        const best = candidates[0]
        preview.matched = true
        preview.matchedProduct = best.productName
        preview.matchMethod = 'llm_direct'
        preview.lastPrice = best.price
        preview.imageUrl = best.imageUrl
        preview.orderRef = best.id
        preview.platform = best.platform

        preview.candidates = candidates
        preview.totalMatchCount = item.matchedOrders.length
        preview.ambiguityLevel = this.computeAmbiguityLevel(candidates)
        previewLog(`[Preview] candidates count=${candidates.length}, totalMatchCount=${item.matchedOrders.length}, ambiguityLevel=${preview.ambiguityLevel}`)
      }
    } else {
      previewLog(`[Preview] No matchedOrders from LLM, falling back to SQL search`)
      const { order, matchMethod } = this.searchBestMatchOrder(item, platformName, instruction)
      previewLog(`[Preview] searchBestMatchOrder result: matchMethod=${matchMethod}, order=${order ? `id=${order.id}, name="${order.productName}"` : 'null'}`)
      if (order && matchMethod) {
        preview.matched = true
        preview.matchedProduct = order.productName
        preview.matchMethod = matchMethod
        preview.lastPrice = order.price
        preview.imageUrl = order.imageUrl
        preview.orderRef = order.id
        preview.platform = order.platform
      }

      const candidateOrders = this.findCandidateOrdersForPreview(item, platformName)
      previewLog(`[Preview] findCandidateOrdersForPreview returned ${candidateOrders.length} orders`)
      if (candidateOrders.length > 0) {
        const candidates: CandidateOrder[] = candidateOrders.slice(0, MAX_CANDIDATES).map(o => ({
          id: o.id,
          productName: o.productName,
          price: o.price,
          imageUrl: o.imageUrl,
          platform: o.platform,
          purchasedAt: o.purchasedAt,
          shopName: o.shopName,
          matchScore: undefined,
        }))
        preview.candidates = candidates
        preview.totalMatchCount = candidateOrders.length
        if (!preview.matched && candidates.length > 0) {
          const best = candidates[0]
          preview.matched = true
          preview.matchedProduct = best.productName
          preview.matchMethod = 'exact'
          preview.lastPrice = best.price
          preview.imageUrl = best.imageUrl
          preview.orderRef = best.id
          preview.platform = best.platform
        }
        preview.ambiguityLevel = this.computeAmbiguityLevel(candidates)
        previewLog(`[Preview] fallback candidates count=${candidates.length}, ambiguityLevel=${preview.ambiguityLevel}`)
      }
    }

    previewLog(`[Preview] === previewCandidateOrders END ===`)
    return preview
  }

  private findCandidateOrdersForPreview(item: ParsedShoppingItem, platformName: string): Order[] {
    const searchPlatform = item.platform || platformName
    const seen = new Set<string>()
    const allOrders: Order[] = []
    const MAX_PREVIEW_ORDERS = 20
    const MIN_CANDIDATE_SCORE = 40

    const addOrders = (orders: Order[], label: string, minScore?: number) => {
      const filtered = minScore
        ? orders.filter(o => this.computeMatchScore(o, item.name) >= minScore)
        : orders
      previewLog(`[Preview]   addOrders("${label}"): got ${orders.length} orders, ${filtered.length} passed score filter (min=${minScore || 0}), current total=${allOrders.length}`)
      for (const o of filtered) {
        const key = `${o.platform}:${o.orderId}`
        if (!seen.has(key)) {
          seen.add(key)
          allOrders.push(o)
        }
      }
    }

    const doSearch = (keyword: string, platform?: string): Order[] => {
      let results = this.db.searchOrders(keyword, platform)
      if (results.length === 0 && platform) {
        results = this.db.searchOrders(keyword)
      }
      return results
    }

    previewLog(`[Preview] findCandidateOrdersForPreview: name="${item.name}", searchPlatform="${searchPlatform}"`)

    let exactOrders = doSearch(item.name, searchPlatform)
    previewLog(`[Preview]   exact search "${item.name}": ${exactOrders.length} results`)
    addOrders(exactOrders, 'exact')

    if (item.name.length >= 2) {
      let fuzzyResult = this.db.searchOrdersFuzzy(item.name, searchPlatform)
      previewLog(`[Preview]   searchOrdersFuzzy("${item.name}", "${searchPlatform}"): ${fuzzyResult.orders.length} results, usedKeyword="${fuzzyResult.usedKeyword}"`)
      if (fuzzyResult.orders.length === 0 && searchPlatform) {
        fuzzyResult = this.db.searchOrdersFuzzy(item.name)
        previewLog(`[Preview]   searchOrdersFuzzy("${item.name}", no platform): ${fuzzyResult.orders.length} results, usedKeyword="${fuzzyResult.usedKeyword}"`)
      }
      addOrders(fuzzyResult.orders, `fuzzy:${fuzzyResult.usedKeyword}`, MIN_CANDIDATE_SCORE)
    }

    previewLog(`[Preview] findCandidateOrdersForPreview total: ${allOrders.length} unique orders`)
    return allOrders
  }

  async executeSingle(
    taskId: number,
    item: ParsedShoppingItem,
    platform: PlatformAdapter,
    onProgress: (msg: string) => void,
    instruction?: string,
    dryRun?: boolean,
    paymentMode?: string,
  ): Promise<ItemResult> {
    const result: ItemResult = { name: item.name, quantity: item.quantity, status: 'failed' }

    const candidateOrders = this.findCandidateOrders(item, platform.name, result, onProgress, instruction)

    if (candidateOrders.length === 0) {
      result.error = '未找到历史订单'
      return result
    }

    const order = candidateOrders[0]
    await this.processPurchase(taskId, item, order, platform, result, onProgress, dryRun, paymentMode)

    if (platform.cleanup) {
      await platform.cleanup()
    }

    return result
  }
}
