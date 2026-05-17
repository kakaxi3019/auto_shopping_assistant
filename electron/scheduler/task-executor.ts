import type { Order, ParsedShoppingItem, PreviewItem, CandidateOrder, AmbiguityLevel, AddToCartResult, SearchResult } from '../../shared/types/platform.types'
import type { PlatformAdapter } from '../../shared/types/platform.types'
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
  out_of_stock: { label: '商品已下架', icon: '📦', color: 'text-orange-500', description: '该商品已下架或库存不足' },
  login_expired: { label: '登录已过期', icon: '🔐', color: 'text-amber-500', description: '请重新登录账号' },
  not_supported: { label: '平台不支持', icon: '🚫', color: 'text-gray-500', description: '该商品所在店铺未开通"再买一单"功能，这是平台限制而非程序问题' },
  network_error: { label: '网络异常', icon: '🌐', color: 'text-blue-500', description: '网络连接不稳定，请检查网络设置' },
  no_history: { label: '未找到历史订单', icon: '🔍', color: 'text-purple-500', description: '未在历史订单中找到匹配的商品' },
  other: { label: '购买失败', icon: '❌', color: 'text-red-500', description: '购买过程中发生未知错误' },
}

export interface ItemResult {
  name: string
  quantity: number
  status: 'success' | 'failed' | 'pending'
  error?: string
  matchedProduct?: string
  matchMethod?: 'llm_direct' | 'exact' | 'fuzzy'
  pendingConfirmationId?: number
  pendingPayment?: boolean
  currentPrice?: number
  lastPrice?: number
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
    const isCartOnly = paymentMode === 'cart_only'

    for (const item of parsedItems) {
      const result: ItemResult = { name: item.name, quantity: item.quantity, status: 'failed' }

      const candidateOrders = this.findCandidateOrders(item, platform.name, result, onProgress, instruction)

      if (candidateOrders.length === 0) {
        result.error = '未找到历史订单'
        itemResults.push(result)
        continue
      }

      const order = candidateOrders[0]
      const url = platform.getProductUrl(order)
      console.log(`[TaskExecutor] addToCart: name=${item.name}, orderId=${order.orderId}, url=${url}`)

      onProgress(`正在为 "${item.name}" 执行再买一单（订单 ${order.orderId}）...`)
      try {
        const cartResult: AddToCartResult = await platform.addToCart(url, item.sku, order.orderId, isCartOnly)
        if (!cartResult.success) {
          const searchParts = [order.productName]
          if (order.shopName) searchParts.push(order.shopName)
          if (item.sku) searchParts.push(item.sku)
          const searchKeyword = searchParts.join(' ')
          onProgress(`再买一单失败（${cartResult.error}），正在搜索商品 "${searchKeyword}"...`)
          const searchResults = await platform.searchProduct(searchKeyword)
          if (searchResults.length > 0) {
            const topResults = this.scoreSearchResults(searchResults, item, order)
            const candidates = topResults.map(t => t.result)
            onProgress(`搜索到 ${searchResults.length} 个结果，已列出前 ${candidates.length} 个供您选择`)
            const confirmationId = this.db.createPendingConfirmation({
              taskId,
              productName: item.name,
              originalPrice: order.price,
              failureReason: cartResult.error || '未找到再买一单入口',
              searchKeyword,
              candidates: JSON.stringify(candidates),
              orderId: order.id,
            })
            result.status = 'pending'
            result.pendingConfirmationId = confirmationId
            result.currentPrice = order.price
            result.lastPrice = order.price
          } else {
            onProgress(`搜索 "${searchKeyword}" 无结果`)
            result.error = cartResult.error || '再来一单失败，且搜索无结果'
          }
        } else if (isCartOnly) {
          onProgress(`已将 "${item.name}" 加入购物车`)
          result.matchedProduct = order.productName
          result.status = 'success'
        } else {
          onProgress(`正在结算 "${item.name}"${item.quantity > 1 ? `（x${item.quantity}）` : ''}...`)
          const checkoutResult = await platform.checkout(cartResult.directToPay, item.quantity)
          if (!checkoutResult.success) {
            result.error = checkoutResult.error || '结算失败'
          } else {
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
        }
      } catch (e) {
        console.log(`[TaskExecutor] purchase failed for order ${order.orderId}: ${e}`)
        result.error = String(e)
      }

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

    onProgress(isCartOnly ? '加购完成!' : '购买完成!')
    return { success: true, itemResults }
  }

  private findCandidateOrders(item: ParsedShoppingItem, platformName: string, result: ItemResult, onProgress: (msg: string) => void, instruction?: string): Order[] {
    console.log(`[TaskExecutor] findCandidateOrders: name="${item.name}", orderRef=${item.orderRef}, platform=${platformName}, itemPlatform=${item.platform}, instruction="${instruction}"`)

    const searchPlatform = item.platform || platformName

    if (item.orderRef) {
      onProgress(`正在通过 LLM 匹配结果查找订单 #${item.orderRef}...`)
      const order = this.db.getOrderById(item.orderRef)
      if (order) {
        if (!item.platform || order.platform === searchPlatform) {
          result.matchedProduct = order.productName
          result.matchMethod = 'llm_direct'
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
      onProgress(`精确匹配: ${exactOrders.length} 条订单`)
      return exactOrders
    }

    const { orders, usedKeyword } = this.db.searchOrdersFuzzy(item.name, searchPlatform)
    console.log(`[TaskExecutor] searchOrdersFuzzy("${item.name}", "${searchPlatform}"): ${orders.length} results, usedKeyword="${usedKeyword}"`)
    if (orders.length > 0) {
      result.matchMethod = 'fuzzy'
      result.matchedProduct = orders[0].productName
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
      if (order && (!item.platform || order.platform === searchPlatform)) {
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

  private scoreSearchResults(results: SearchResult[], item: ParsedShoppingItem, order: Order): Array<{ result: SearchResult; score: number }> {
    const scored = results.map(r => {
      let score = 0
      const title = r.title.toLowerCase()
      const itemName = item.name.toLowerCase()
      const productName = order.productName.toLowerCase()

      if (title === itemName || title === productName) score += 50
      if (title.includes(itemName) || itemName.includes(title)) score += 30
      if (title.includes(productName) || productName.includes(title)) score += 25

      const longerSource = productName.length >= itemName.length ? productName : itemName
      let bestSubstrLen = 0
      for (let len = Math.min(longerSource.length, 20); len >= 3; len--) {
        let found = false
        for (let i = 0; i <= longerSource.length - len; i++) {
          if (title.includes(longerSource.substring(i, i + len))) {
            bestSubstrLen = len
            found = true
            break
          }
        }
        if (found) break
      }
      if (bestSubstrLen >= 6) score += 25
      else if (bestSubstrLen >= 4) score += 15
      else if (bestSubstrLen >= 3) score += 8

      if (r.shopName && order.shopName) {
        if (r.shopName.toLowerCase() === order.shopName.toLowerCase()) score += 30
        else if (r.shopName.toLowerCase().includes(order.shopName.toLowerCase()) || order.shopName.toLowerCase().includes(r.shopName.toLowerCase())) score += 15
      }

      if (r.price > 0 && order.price > 0) {
        const priceDiff = Math.abs(r.price - order.price) / order.price
        if (priceDiff < 0.05) score += 15
        else if (priceDiff < 0.2) score += 8
        else if (priceDiff > 1) score -= 10
      }

      return { result: r, score }
    })

    scored.sort((a, b) => b.score - a.score)
    return scored.slice(0, 5)
  }

  private computeAmbiguityLevel(candidates: CandidateOrder[]): AmbiguityLevel {
    if (candidates.length <= 1) return 'none'
    if (candidates.length === 2) {
      const names = candidates.map(c => c.productName)
      if (names[0] === names[1]) return 'low'
    }
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
    const url = platform.getProductUrl(order)
    console.log(`[TaskExecutor] retry: name=${item.name}, orderId=${order.orderId}, url=${url}`)

    const isCartOnly = paymentMode === 'cart_only'

    onProgress(`正在为 "${item.name}" 执行再买一单（订单 ${order.orderId}）...`)
    try {
      const cartResult: AddToCartResult = await platform.addToCart(url, item.sku, order.orderId, isCartOnly)
      if (!cartResult.success) {
        result.error = cartResult.error || '再来一单失败'
      } else if (isCartOnly) {
        onProgress(`已将 "${item.name}" 加入购物车`)
        result.matchedProduct = order.productName
        result.status = 'success'
      } else {
        onProgress(`正在结算 "${item.name}"${item.quantity > 1 ? `（x${item.quantity}）` : ''}...`)
        const checkoutResult = await platform.checkout(cartResult.directToPay, item.quantity)
        if (!checkoutResult.success) {
          result.error = checkoutResult.error || '结算失败'
        } else {
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
      }
    } catch (e) {
      console.log(`[TaskExecutor] retry failed for order ${order.orderId}: ${e}`)
      result.error = String(e)
    }

    if (platform.cleanup) {
      await platform.cleanup()
    }

    return result
  }
}
