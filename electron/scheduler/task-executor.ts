import type { Order, ParsedShoppingItem, PreviewItem, CandidateOrder, AmbiguityLevel, AddToCartResult } from '../../shared/types/platform.types'
import type { PlatformAdapter } from '../../shared/types/platform.types'
import type { ItemResult } from '../../shared/types/task.types'
import type { Database } from '../db/database'
import { appendFileSync } from 'fs'
import { join } from 'path'
import { app } from 'electron'

const PREVIEW_LOG_FILE = join(app.getPath('userData'), 'preview-debug.log')
const MIN_CONFIDENCE_THRESHOLD = 50
const KEYWORD_MATCH_THRESHOLD = 35

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
    isCancelled?: () => boolean,
  ): Promise<{ success: boolean; itemResults: ItemResult[]; error?: string }> {
    const itemResults: ItemResult[] = []

    for (const item of parsedItems) {
      if (isCancelled?.()) {
        return { success: false, itemResults, error: '任务已取消' }
      }

      const result: ItemResult = { name: item.name, quantity: item.quantity, status: 'failed' }
      const candidateOrders = this.findCandidateOrders(item, platform.name, result, onProgress, instruction)

      if (candidateOrders.length === 0) {
        result.error = '未找到历史订单'
        itemResults.push(result)
        continue
      }

      const order = candidateOrders[0]
      await this.processPurchase(taskId, item, order, platform, result, onProgress, dryRun, paymentMode, isCancelled)
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
    isCancelled?: () => boolean,
  ): Promise<void> {
    if (isCancelled?.()) {
      result.error = '任务已取消'
      return
    }

    const isCartOnly = paymentMode === 'cart_only'
    const url = platform.getProductUrl(order)

    onProgress(`正在为 "${item.name}" 执行再买一单（订单 ${order.orderId}）...`)
    try {
      const cartResult: AddToCartResult = await platform.addToCart(url, item.sku, order.orderId, isCartOnly)
      if (isCancelled?.()) {
        result.error = '任务已取消'
        return
      }

      if (!cartResult.success) {
        await this.handleSearchFallback(taskId, item, order, platform, cartResult, result, onProgress, dryRun, paymentMode, isCancelled)
      } else if (isCartOnly) {
        onProgress(`已将 "${item.name}" 加入购物车`)
        result.matchedProduct = order.productName
        result.status = 'success'
      } else {
        await this.handleCheckoutAndPay(taskId, item, order, platform, cartResult.directToPay ?? false, url, result, onProgress, dryRun, paymentMode, isCancelled)
      }
    } catch (e) {
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
    isCancelled?: () => boolean,
  ): Promise<void> {
    if (isCancelled?.()) {
      result.error = '任务已取消'
      return
    }

    const isCartOnly = paymentMode === 'cart_only'
    const searchParts = [order.productName]
    if (order.shopName) searchParts.push(order.shopName)
    if (item.sku) searchParts.push(item.sku)
    const searchKeyword = searchParts.join(' ')
    onProgress(`再买一单失败（${cartResult.error}），正在打开搜索页面，请在搜索结果中找到对应商品并点击进入...`)
    try {
      const searchUrl = await platform.openSearchPage(searchKeyword)
      if (isCancelled?.()) {
        result.error = '任务已取消'
        return
      }

      if (searchUrl) {
        const purchaseResult = await platform.purchaseFromUrl(searchUrl)
        if (isCancelled?.()) {
          result.error = '任务已取消'
          return
        }

        if (purchaseResult.success) {
          if (isCartOnly) {
            onProgress(`已将商品加入购物车`)
            result.matchedProduct = order.productName
            result.status = 'success'
          } else {
            await this.handleCheckoutAndPay(taskId, item, order, platform, purchaseResult.directToPay ?? false, searchUrl, result, onProgress, dryRun, paymentMode, isCancelled)
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
    isCancelled?: () => boolean,
  ): Promise<void> {
    if (isCancelled?.()) {
      result.error = '任务已取消'
      return
    }

    onProgress(`正在结算 "${item.name}"${item.quantity > 1 ? `（x${item.quantity}）` : ''}...`)
    const checkoutResult = await platform.checkout(directToPay, item.quantity)
    if (isCancelled?.()) {
      result.error = '任务已取消'
      return
    }

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
    const searchPlatform = item.platform || platformName

    if (item.orderRef) {
      onProgress(`正在通过 LLM 匹配结果查找订单 #${item.orderRef}...`)
      const order = this.db.getOrderById(item.orderRef)
      if (order) {
        if ((order as any).unavailable) {
          onProgress(`LLM 匹配的订单 #${item.orderRef} 已被排除匹配，尝试其他方式...`)
        } else if (!item.platform || order.platform === searchPlatform) {
          const topKeywordScore = this.computeMatchScore(order, item.name)
          if (topKeywordScore < KEYWORD_MATCH_THRESHOLD && item.matchedOrders && item.matchedOrders.length > 1) {
            onProgress(`LLM 首选匹配 (${order.productName}) 与"${item.name}"关键词不匹配，尝试其他 LLM 候选...`)
            let bestAltOrder: Order | null = null
            let bestAltScore = 0
            for (const match of item.matchedOrders) {
              if (match.orderRef === item.orderRef) continue
              if (match.confidence < MIN_CONFIDENCE_THRESHOLD) continue
              const altOrder = this.db.getOrderById(match.orderRef)
              if (!altOrder || (altOrder as any).unavailable) continue
              if (item.platform && altOrder.platform !== searchPlatform) continue
              const altScore = this.computeMatchScore(altOrder, item.name)
              if (altScore > bestAltScore) {
                bestAltScore = altScore
                bestAltOrder = altOrder
              }
            }
            if (bestAltOrder && bestAltScore >= KEYWORD_MATCH_THRESHOLD) {
              result.matchedProduct = bestAltOrder.productName
              result.matchMethod = 'llm_direct'
              result.orderId = bestAltOrder.id
              onProgress(`LLM 候选匹配: ${bestAltOrder.productName}（关键词匹配更优）`)
              return [bestAltOrder]
            }
          }
          result.matchedProduct = order.productName
          result.matchMethod = 'llm_direct'
          result.orderId = order.id
          onProgress(`LLM 精确匹配: ${order.productName}`)
          return [order]
        }
      }
      onProgress(`LLM 匹配的订单 #${item.orderRef} 不存在或平台不匹配，尝试其他方式...`)
    }

    const hasExcluded = this.db.hasExcludedOrders(item.name)
    if (hasExcluded) {
      onProgress(`"${item.name}" 有已排除的历史订单，跳过搜索匹配`)
      return []
    }

    onProgress(`正在查找 "${item.name}" 的历史订单...`)
    const exactOrders = this.db.searchOrders(item.name, searchPlatform, true)
    if (exactOrders.length > 0) {
      result.matchMethod = 'exact'
      result.matchedProduct = exactOrders[0].productName
      result.orderId = exactOrders[0].id
      result.unavailable = !!exactOrders[0].unavailable
      onProgress(`精确匹配: ${exactOrders.length} 条订单`)
      return exactOrders
    }

    const { orders, usedKeyword } = this.db.searchOrdersFuzzy(item.name, searchPlatform, true)
    if (orders.length > 0) {
      result.matchMethod = 'fuzzy'
      result.matchedProduct = orders[0].productName
      result.orderId = orders[0].id
      result.unavailable = !!orders[0].unavailable
      onProgress(`模糊匹配(关键词"${usedKeyword}"): ${orders.length} 条订单`)
      return orders
    }

    return []
  }

  private searchBestMatchOrder(item: ParsedShoppingItem, platformName: string, _instruction?: string): { order: Order | null; matchMethod: 'llm_direct' | 'exact' | 'fuzzy' | null } {
    const searchPlatform = item.platform || platformName

    if (item.orderRef) {
      const order = this.db.getOrderById(item.orderRef)
      if (order && (order as any).unavailable) {
      } else if (order && (!item.platform || order.platform === searchPlatform)) {
        return { order, matchMethod: 'llm_direct' }
      }
    }

    let exactOrders = this.db.searchOrders(item.name, searchPlatform, true)
    if (exactOrders.length === 0 && searchPlatform) {
      exactOrders = this.db.searchOrders(item.name, undefined, true)
    }
    if (exactOrders.length > 0) {
      return { order: exactOrders[0], matchMethod: 'exact' }
    }

    if (item.name.length >= 2) {
      let fuzzyResult = this.db.searchOrdersFuzzy(item.name, searchPlatform, true)
      if (fuzzyResult.orders.length === 0 && searchPlatform) {
        fuzzyResult = this.db.searchOrdersFuzzy(item.name, undefined, true)
      }
      if (fuzzyResult.orders.length > 0) {
        return { order: fuzzyResult.orders[0], matchMethod: 'fuzzy' }
      }
    }

    return { order: null, matchMethod: null }
  }

  private computeMatchScore(order: Order, keyword: string): number {
    const name = order.productName.toLowerCase()
    const kw = keyword.toLowerCase()
    if (name === kw) return 100

    if (name.includes(kw)) {
      // Check if the keyword is an independent term or part of a compound word
      // e.g. "篮球" in "篮球鞋" is compound (本体不是篮球), but "篮球" in "安踏静音篮球" is independent
      const idx = name.indexOf(kw)
      const afterKw = name.substring(idx + kw.length)

      // Chinese compound word detection: if there are non-space, non-punctuation chars
      // immediately after the keyword, it's likely a compound word (e.g. 篮球鞋, 篮球裤, 篮球护踝)
      const compoundSuffixMatch = afterKw.match(/^[\u4e00-\u9fff]+/)
      if (compoundSuffixMatch) {
        const suffix = compoundSuffixMatch[0]
        // Common product-type suffixes that indicate a different product category
        const productTypeSuffixes = ['鞋', '裤', '裙', '衫', '帽', '袜', '套', '壳', '膜', '包', '架', '桌', '椅', '柜', '箱', '垫', '罩', '巾', '布', '带', '绳', '夹', '扣', '钉', '灯', '糖', '粉', '酱', '油', '醋']
        const protectionSuffixes = ['护踝', '护膝', '护腕', '护肘', '护具', '护齿', '护指', '头盔', '防护', '扭伤', '损伤', '运动']
        const modifierSuffixes = ['长裤', '短裤', '长袖', '短袖', '休闲']
        const isSuffixProductType = productTypeSuffixes.some(s => suffix.startsWith(s))
        const isSuffixProtection = protectionSuffixes.some(s => suffix.startsWith(s))
        const isSuffixModifier = modifierSuffixes.some(s => suffix.startsWith(s))

        if (isSuffixProductType || isSuffixProtection || isSuffixModifier) {
          // "篮球鞋", "篮球护踝", "篮球扭伤防护" — keyword is a modifier, not the product identity
          return 35
        }
        // Any other Chinese compound word — still likely a different product
        // Only give high score if suffix is a quantity/spec word like "篮球7号"
        const specSuffixes = ['号', '寸', '码', '型', '款', '色', '装', '个', '只', '双', '件', '瓶', '包', '盒', '组', '套装']
        const isSpecSuffix = specSuffixes.some(s => suffix.startsWith(s))
        if (isSpecSuffix) {
          return 80 + (kw.length / name.length) * 20
        }
        // Unknown compound — moderate penalty
        return 50
      }

      return 80 + (kw.length / name.length) * 20
    }

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

    const preview: PreviewItem = {
      name: item.name,
      quantity: item.quantity,
      sku: item.sku,
      orderRef: item.orderRef,
      matched: false,
    }

    if (item.matchedOrders && item.matchedOrders.length > 0) {
      const candidates: CandidateOrder[] = []
      let excludedCount = 0
      let filteredByConfidenceCount = 0
      for (const match of item.matchedOrders.slice(0, MAX_CANDIDATES)) {
        if (match.confidence < MIN_CONFIDENCE_THRESHOLD) {
          filteredByConfidenceCount++
          continue
        }
        const order = this.db.getOrderById(match.orderRef)
        if (!order) {
          continue
        }
        if ((order as any).unavailable) {
          excludedCount++
          continue
        }
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
        const keywordScores = candidates.map(c => {
          const score = this.computeMatchScore({ productName: c.productName } as Order, item.name)
          return score
        })

        const hasHighKeywordMatch = keywordScores.some(s => s >= KEYWORD_MATCH_THRESHOLD)
        const firstLowKeyword = keywordScores[0] < KEYWORD_MATCH_THRESHOLD
        if (hasHighKeywordMatch && firstLowKeyword) {
          const indexed = candidates.map((c, i) => ({ candidate: c, keywordScore: keywordScores[i], llmScore: c.matchScore ?? 0 }))
          indexed.sort((a, b) => {
            const aHigh = a.keywordScore >= KEYWORD_MATCH_THRESHOLD
            const bHigh = b.keywordScore >= KEYWORD_MATCH_THRESHOLD
            if (aHigh && !bHigh) return -1
            if (!aHigh && bHigh) return 1
            return b.llmScore - a.llmScore
          })
          candidates.length = 0
          for (const { candidate } of indexed) {
            candidates.push(candidate)
          }
        }

        const best = candidates[0]
        preview.matched = true
        preview.matchedProduct = best.productName
        preview.matchMethod = 'llm_direct'
        preview.lastPrice = best.price
        preview.imageUrl = best.imageUrl
        preview.orderRef = best.id
        preview.platform = best.platform

        preview.candidates = candidates
        preview.totalMatchCount = candidates.length
        preview.ambiguityLevel = this.computeAmbiguityLevel(candidates)
      } else if (excludedCount > 0) {
      } else if (filteredByConfidenceCount > 0) {
      } else {
        const { order, matchMethod } = this.searchBestMatchOrder(item, platformName, instruction)
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
        if (candidateOrders.length > 0) {
          const fallbackCandidates: CandidateOrder[] = candidateOrders.slice(0, MAX_CANDIDATES).map(o => ({
            id: o.id,
            productName: o.productName,
            price: o.price,
            imageUrl: o.imageUrl,
            platform: o.platform,
            purchasedAt: o.purchasedAt,
            shopName: o.shopName,
            matchScore: undefined,
          }))
          preview.candidates = fallbackCandidates
          preview.totalMatchCount = candidateOrders.length
          preview.ambiguityLevel = this.computeAmbiguityLevel(fallbackCandidates)
        }
      }
    } else {
      const hasExcluded = this.db.hasExcludedOrders(item.name)
      if (hasExcluded) {
      } else {
        const { order, matchMethod } = this.searchBestMatchOrder(item, platformName, instruction)
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
        }
      }
    }

    return preview
  }

  private findCandidateOrdersForPreview(item: ParsedShoppingItem, platformName: string): Order[] {
    const searchPlatform = item.platform || platformName
    const seen = new Set<string>()
    const allOrders: Order[] = []
    const MAX_PREVIEW_ORDERS = 20
    const MIN_CANDIDATE_SCORE = 50

    const addOrders = (orders: Order[], label: string, minScore?: number) => {
      const scoreThreshold = minScore ?? MIN_CANDIDATE_SCORE
      const filtered = orders.filter(o => this.computeMatchScore(o, item.name) >= scoreThreshold)
      for (const o of filtered) {
        const key = `${o.platform}:${o.orderId}`
        if (!seen.has(key)) {
          seen.add(key)
          allOrders.push(o)
        }
      }
    }

    const doSearch = (keyword: string, platform?: string): Order[] => {
      let results = this.db.searchOrders(keyword, platform, true)
      if (results.length === 0 && platform) {
        results = this.db.searchOrders(keyword, undefined, true)
      }
      return results
    }

    let exactOrders = doSearch(item.name, searchPlatform)
    addOrders(exactOrders, 'exact')

    if (item.name.length >= 2) {
      let fuzzyResult = this.db.searchOrdersFuzzy(item.name, searchPlatform, true)
      if (fuzzyResult.orders.length === 0 && searchPlatform) {
        fuzzyResult = this.db.searchOrdersFuzzy(item.name, undefined, true)
      }
      addOrders(fuzzyResult.orders, `fuzzy:${fuzzyResult.usedKeyword}`, MIN_CANDIDATE_SCORE)
    }

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
    isCancelled?: () => boolean,
  ): Promise<ItemResult> {
    const result: ItemResult = { name: item.name, quantity: item.quantity, status: 'failed' }

    if (isCancelled?.()) {
      result.error = '任务已取消'
      return result
    }

    const candidateOrders = this.findCandidateOrders(item, platform.name, result, onProgress, instruction)

    if (candidateOrders.length === 0) {
      result.error = '未找到历史订单'
      return result
    }

    const order = candidateOrders[0]
    await this.processPurchase(taskId, item, order, platform, result, onProgress, dryRun, paymentMode, isCancelled)

    if (platform.cleanup) {
      await platform.cleanup()
    }

    return result
  }
}
