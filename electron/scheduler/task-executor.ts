import type { Order, ParsedShoppingItem, PreviewItem, CandidateOrder, AmbiguityLevel, AddToCartResult } from '../../shared/types/platform.types'
import type { PlatformAdapter } from '../../shared/types/platform.types'
import type { ItemResult } from '../../shared/types/task.types'
import type { Database } from '../db/database'
import { appendFileSync } from 'fs'
import { join } from 'path'
import { app } from 'electron'
import { debugLog } from '../utils/debug-log'

const PREVIEW_LOG_FILE = join(app.getPath('userData'), 'preview-debug.log')
const MIN_CONFIDENCE_THRESHOLD = 50
const KEYWORD_MATCH_THRESHOLD = 35

const PRODUCT_TYPE_SUFFIXES = [
  '鞋', '裤', '裙', '衫', '帽', '袜', '套', '壳', '膜', '包', 
  '架', '桌', '椅', '柜', '箱', '垫', '罩', '巾', '布', '带', 
  '绳', '夹', '扣', '钉', '灯', '糖', '粉', '酱', '油', '醋',
  '耳机', '键盘', '鼠标', '杯', '玩具', '线', '片', '卡', '贴'
]

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
    debugLog('TaskExecutor', `execute called: taskId=${taskId}, parsedItems=${JSON.stringify(parsedItems)}, paymentMode=${paymentMode}, dryRun=${dryRun}`)
    const itemResults: ItemResult[] = []

    for (const item of parsedItems) {
      const result: ItemResult = { name: item.name, quantity: item.quantity, status: 'failed' }
      const candidateOrders = this.findCandidateOrders(item, platform.name, result, onProgress, instruction)
      debugLog('TaskExecutor', `candidateOrders count for "${item.name}": ${candidateOrders.length}`)

      if (candidateOrders.length === 0) {
        result.error = '未找到历史订单'
        itemResults.push(result)
        debugLog('TaskExecutor', `No candidate orders found for item: "${item.name}"`)
        continue
      }

      const order = candidateOrders[0]
      debugLog('TaskExecutor', `Selected candidate order: id=${order.id}, orderId=${order.orderId}, price=${order.price}, name="${order.productName}"`)
      await this.processPurchase(taskId, item, order, platform, result, onProgress, dryRun, paymentMode)
      itemResults.push(result)
      debugLog('TaskExecutor', `Item result for "${item.name}": status=${result.status}, error=${result.error}`)

      if (platform.cleanup) {
        await platform.cleanup()
      }
    }

    const successCount = itemResults.filter(r => r.status === 'success').length
    const pendingCount = itemResults.filter(r => r.status === 'pending').length
    debugLog('TaskExecutor', `execute completed: successCount=${successCount}, pendingCount=${pendingCount}, results=${JSON.stringify(itemResults)}`)
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
    debugLog('TaskExecutor', `processPurchase started: name="${item.name}", orderId=${order.orderId}, url=${url}, isCartOnly=${isCartOnly}`)

    onProgress(`正在为 "${item.name}" 执行再买一单（订单 ${order.orderId}）...`)
    try {
      const skuToUse = item.sku || order.sku
      const cartResult: AddToCartResult = await platform.addToCart(url, skuToUse, order.orderId, isCartOnly, order.skuId)
      debugLog('TaskExecutor', `addToCart returned: ${JSON.stringify(cartResult)}`)
      if (!cartResult.success) {
        // 窗口被关闭通常是用户点击了停止，不应触发搜索降级打开新窗口
        if (cartResult.error?.includes('操作窗口已关闭')) {
          result.error = '已停止'
          return
        }
        await this.handleSearchFallback(taskId, item, order, platform, cartResult, result, onProgress, dryRun, paymentMode)
      } else if (isCartOnly) {
        onProgress(`已将 "${item.name}" 加入购物车`)
        result.matchedProduct = order.productName
        result.status = 'success'
      } else {
        await this.handleCheckoutAndPay(taskId, item, order, platform, cartResult.directToPay ?? false, url, result, onProgress, dryRun, paymentMode)
      }

      // 成功购买（非仅加购模式）后，将新订单同步/保存至本地历史订单库中
      if (result.status === 'success' && !isCartOnly) {
        if (dryRun) {
          onProgress('测试模式：购买已模拟完成，跳过添加历史订单。')
        } else {
          const autoSave = this.db.getSetting('auto_save_orders') === 'true'
          if (autoSave) {
            onProgress('付款成功！正在后台静默同步平台最新订单以更新本地历史记录...')
            try {
              // fetchOrderHistory(1) 只同步第一页最新订单，既快速又有效
              await platform.fetchOrderHistory(1)
              onProgress('本地历史订单库已成功同步并更新')
            } catch (syncError) {
              debugLog('TaskExecutor', `Silent order sync failed: ${syncError}`)
              onProgress('后台订单同步失败，您可以通过"同步订单"按钮手动更新')
            }
          } else {
            onProgress('付款成功！当前设置为“手动保存订单历史”，已跳过自动同步更新。')
          }
        }
      }
    } catch (e) {
      const errMsg = String(e)
      debugLog('TaskExecutor', `processPurchase catch exception: ${errMsg}`)
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
          (result as any).productUrl = searchUrl
          if (isCartOnly) {
            onProgress(`已将商品加入购物车`)
            result.matchedProduct = order.productName
            result.status = 'success'
          } else {
            await this.handleCheckoutAndPay(taskId, item, order, platform, purchaseResult.directToPay ?? false, searchUrl, result, onProgress, dryRun, paymentMode)
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
    debugLog('TaskExecutor', `handleCheckoutAndPay started: item="${item.name}", directToPay=${directToPay}, dryRun=${dryRun}, paymentMode=${paymentMode}`)

    // 用户已手动跳到支付/结算页（directToPay=true），跳过 checkout 流程，直接处理支付
    if (directToPay) {
      onProgress(`已到达支付页面，等待用户完成支付...|SCENE:payment|`)
      debugLog('TaskExecutor', `directToPay=true, skipping checkout, monitoring payment result`)
      const payWindowResult = await platform.showPaymentWindow(
        `订单已提交 - 请在页面中完成支付`,
        true, // silent: 用户已在支付页，不注入额外 banner
      )
      if (payWindowResult.paid) {
        result.matchedProduct = order.productName
        result.status = 'success'
      } else {
        result.error = '支付未完成'
      }
      return
    }

    onProgress(`正在结算 "${item.name}"${item.quantity > 1 ? `（x${item.quantity}）` : ''}...`)
    const checkoutResult = await platform.checkout(directToPay, item.quantity)
    debugLog('TaskExecutor', `platform.checkout returned: ${JSON.stringify(checkoutResult)}`)
    if (!checkoutResult.success) {
      result.error = checkoutResult.error || '结算失败'
      return
    }

    const lastPrice = order.price
    const currentPrice = checkoutResult.currentPrice
    if (currentPrice && currentPrice > 0 && lastPrice > 0 && paymentMode !== 'checkout_only' && paymentMode !== 'cart_only') {
      const priceIncreaseRate = (currentPrice - lastPrice * item.quantity) / (lastPrice * item.quantity)
      const protectionThreshold = parseFloat(this.db.getSetting('price_protection_threshold') || '0.15')
      debugLog('TaskExecutor', `Price safety check: priceIncreaseRate=${priceIncreaseRate.toFixed(4)}, threshold=${protectionThreshold}`)
      if (priceIncreaseRate >= protectionThreshold) {
        onProgress(`❌ 资金拦截："${item.name}" 当前价 (¥${currentPrice.toFixed(2)}) 较上次 (¥${(lastPrice * item.quantity).toFixed(2)}) 暴涨了 ${(priceIncreaseRate * 100).toFixed(0)}%，已紧急熔断拦截！`)
        debugLog('TaskExecutor', `Price protection triggered, intercepting checkout. Price rose by ${(priceIncreaseRate * 100).toFixed(2)}%`)
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

    const totalAmount = currentPrice || (order.price * item.quantity)

    if (paymentMode === 'checkout_only') {
      onProgress(`已到达确认订单页面，请在弹出的窗口中确认金额并完成支付...`)
      debugLog('TaskExecutor', `paymentMode is checkout_only, showing manual payment window`)
      const payWindowResult = await platform.showPaymentWindow(
        `已到达结算页面 - 请确认金额并完成支付`
      )
      debugLog('TaskExecutor', `showPaymentWindow finished: paid=${payWindowResult.paid}`)
      if (payWindowResult.paid) {
        result.matchedProduct = order.productName
        result.status = 'success'
        result.currentPrice = currentPrice
      } else {
        result.error = '支付未完成'
      }
    } else {
      onProgress(totalAmount > 0
        ? `正在支付 "${item.name}"（¥${totalAmount.toFixed(2)}）...|SCENE:payment|`
        : `正在支付 "${item.name}"...|SCENE:payment|`
      )
      debugLog('TaskExecutor', `paymentMode is auto_pay / other, initiating platform.pay for totalAmount=${totalAmount}`)
      const payResult = await platform.pay(totalAmount, dryRun, paymentMode)
      debugLog('TaskExecutor', `platform.pay finished: ${JSON.stringify(payResult)}`)
      if (!payResult.success) {
        result.error = payResult.error || '支付失败'
      } else {
        result.matchedProduct = order.productName
        result.status = 'success'
        result.currentPrice = currentPrice
      }
    }
  }

  private findCandidateOrders(item: ParsedShoppingItem, platformName: string, result: ItemResult, onProgress: (msg: string) => void, instruction?: string): Order[] {
    const searchPlatform = item.platform || platformName
    const cleanKeyword = instruction ? this.cleanInstructionKeyword(instruction) : ''

    if ((item.matchedOrders && item.matchedOrders.length > 0) || item.orderRef) {
      onProgress(`正在评估 LLM 匹配结果的候选订单...`)
      const candidateOrders: Order[] = []
      const seenIds = new Set<number>()

      if (item.matchedOrders) {
        for (const match of item.matchedOrders) {
          if (match.confidence < MIN_CONFIDENCE_THRESHOLD) continue
          const order = this.db.getOrderById(match.orderRef)
          if (!order || (order as any).unavailable) continue
          if (item.platform && order.platform !== searchPlatform) continue
          
          if (cleanKeyword && this.computeMatchScore(order, cleanKeyword) < KEYWORD_MATCH_THRESHOLD) {
            continue
          }
          if (!seenIds.has(order.id)) {
            seenIds.add(order.id)
            candidateOrders.push(order)
          }
        }
      }

      if (item.orderRef && !seenIds.has(item.orderRef)) {
        const order = this.db.getOrderById(item.orderRef)
        if (order && !(order as any).unavailable && (!item.platform || order.platform === searchPlatform)) {
          if (!cleanKeyword || this.computeMatchScore(order, cleanKeyword) >= KEYWORD_MATCH_THRESHOLD) {
            seenIds.add(order.id)
            candidateOrders.push(order)
          }
        }
      }

      if (candidateOrders.length > 0) {
        const sorted = this.sortCandidatesByUserPreference(candidateOrders)
        const bestOrder = sorted[0]
        if (bestOrder) {
          result.matchedProduct = bestOrder.productName
          result.matchMethod = 'llm_direct'
          result.orderId = bestOrder.id
          onProgress(`LLM 智能匹配优先: ${bestOrder.productName}`)
          return sorted
        }
      }
      onProgress(`LLM 候选匹配订单不存在、已被排除或与意图不符，尝试其他方式...`)
    }

    const hasExcluded = this.db.hasExcludedOrders(item.name)
    if (hasExcluded) {
      onProgress(`"${item.name}" 有已排除的历史订单，跳过搜索匹配`)
      return []
    }

    onProgress(`正在查找 "${item.name}" 的历史订单...`)
    const exactOrders = this.db.searchOrders(item.name, searchPlatform, true)
    if (exactOrders.length > 0) {
      const sorted = this.sortCandidatesByUserPreference(exactOrders)
      if (sorted && sorted.length > 0) {
        const bestOrder = sorted[0]
        result.matchMethod = 'exact'
        result.matchedProduct = bestOrder.productName
        result.orderId = bestOrder.id
        result.unavailable = !!bestOrder.unavailable
        onProgress(`精确匹配: ${sorted.length} 条订单`)
        return sorted
      }
    }

    const { orders, usedKeyword } = this.db.searchOrdersFuzzy(item.name, searchPlatform, true)
    if (orders.length > 0) {
      const sorted = this.sortCandidatesByUserPreference(orders)
      if (sorted && sorted.length > 0) {
        const bestOrder = sorted[0]
        result.matchMethod = 'fuzzy'
        result.matchedProduct = bestOrder.productName
        result.orderId = bestOrder.id
        result.unavailable = !!bestOrder.unavailable
        onProgress(`模糊匹配(关键词"${usedKeyword}"): ${sorted.length} 条订单`)
        return sorted
      }
    }

    return []
  }

  private searchBestMatchOrder(item: ParsedShoppingItem, platformName: string, _instruction?: string): { order: Order | null; matchMethod: 'llm_direct' | 'exact' | 'fuzzy' | null } {
    const searchPlatform = item.platform || platformName

    if (item.orderRef) {
      const order = this.db.getOrderById(item.orderRef)
      if (order && !(order as any).unavailable && (!item.platform || order.platform === searchPlatform)) {
        const cleanKeyword = _instruction ? this.cleanInstructionKeyword(_instruction) : ''
        if (!cleanKeyword || this.computeMatchScore(order, cleanKeyword) >= KEYWORD_MATCH_THRESHOLD) {
          return { order, matchMethod: 'llm_direct' }
        }
      }
    }

    let exactOrders = this.db.searchOrders(item.name, searchPlatform, true)
    if (exactOrders.length === 0 && searchPlatform) {
      exactOrders = this.db.searchOrders(item.name, undefined, true)
    }
    if (exactOrders.length > 0) {
      const cleanKeyword = _instruction ? this.cleanInstructionKeyword(_instruction) : ''
      for (const order of exactOrders) {
        if (!cleanKeyword || this.computeMatchScore(order, cleanKeyword) >= KEYWORD_MATCH_THRESHOLD) {
          return { order, matchMethod: 'exact' }
        }
      }
    }

    if (item.name.length >= 2) {
      let fuzzyResult = this.db.searchOrdersFuzzy(item.name, searchPlatform, true)
      if (fuzzyResult.orders.length === 0 && searchPlatform) {
        fuzzyResult = this.db.searchOrdersFuzzy(item.name, undefined, true)
      }
      if (fuzzyResult.orders.length > 0) {
        const cleanKeyword = _instruction ? this.cleanInstructionKeyword(_instruction) : ''
        for (const order of fuzzyResult.orders) {
          if (!cleanKeyword || this.computeMatchScore(order, cleanKeyword) >= KEYWORD_MATCH_THRESHOLD) {
            return { order, matchMethod: 'fuzzy' }
          }
        }
      }
    }

    return { order: null, matchMethod: null }
  }

  private cleanInstructionKeyword(instruction: string): string {
    if (!instruction) return ''
    return instruction
      .replace(/^(买|我要买|帮我买|想买|再买|购|购买|帮我购买|自动购买|模拟购买)(一双|一个|一只|一件|一箱|两箱|三箱|瓶|包|盒|个|只|双|件|袋|包)?/g, '')
      .trim()
  }

  private computeMatchScore(order: Order, keyword: string): number {
    const name = order.productName.toLowerCase()
    const kw = keyword.toLowerCase()
    if (name === kw) return 100

    const kwType = PRODUCT_TYPE_SUFFIXES.find(s => kw.includes(s))
    if (kwType) {
      const nameHasOtherType = PRODUCT_TYPE_SUFFIXES.some(s => s !== kwType && name.includes(s) && !kw.includes(s))
      if (nameHasOtherType) {
        return 10
      }
    }

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
        const protectionSuffixes = ['护踝', '护膝', '护腕', '护肘', '护具', '护齿', '护指', '头盔', '防护', '扭伤', '损伤', '运动']
        const modifierSuffixes = ['长裤', '短裤', '长袖', '短袖', '休闲']
        const isSuffixProductType = PRODUCT_TYPE_SUFFIXES.some(s => suffix.startsWith(s))
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
    let baseScore = 30
    if (bestSubLen > 0) {
      const ratio = bestSubLen / kw.length
      if (ratio < 0.5) baseScore = 30 + ratio * 10
      else if (ratio < 0.75) baseScore = 40 + (ratio - 0.5) * 80
      else baseScore = 60 + ratio * 30
    }

    if (kwType && name.includes(kwType)) {
      baseScore = Math.min(100, baseScore + 25)
    }
    return baseScore
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
      const cleanKeyword = instruction ? this.cleanInstructionKeyword(instruction) : ''

      const seenOrderIds = new Set<number>()
      for (const match of item.matchedOrders.slice(0, MAX_CANDIDATES)) {
        if (match.confidence < MIN_CONFIDENCE_THRESHOLD) {
          filteredByConfidenceCount++
          continue
        }
        const order = this.db.getOrderById(match.orderRef)
        if (!order) {
          continue
        }
        if (seenOrderIds.has(order.id)) {
          continue
        }
        seenOrderIds.add(order.id)
        if ((order as any).unavailable) {
          excludedCount++
          continue
        }
        
        // 对于大模型给出的高置信度推荐（>= 80分），系统选择信任其决策而豁免关键词硬过滤，
        // 只有在置信度较低（低于 80分）时，才需要通过本地 computeMatchScore 规则校验来防御小模型的幻觉。
        if (match.confidence < 80) {
          if (cleanKeyword && this.computeMatchScore(order, cleanKeyword) < KEYWORD_MATCH_THRESHOLD) {
            continue
          }
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
        const sorted = this.sortCandidatesByUserPreference(candidates)
        candidates.length = 0
        candidates.push(...sorted)

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
          const sorted = this.sortCandidatesByUserPreference(fallbackCandidates)
          preview.candidates = sorted
          preview.totalMatchCount = candidateOrders.length
          preview.ambiguityLevel = this.computeAmbiguityLevel(sorted)
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
          const sorted = this.sortCandidatesByUserPreference(candidates)
          preview.candidates = sorted
          preview.totalMatchCount = candidateOrders.length
          if (!preview.matched && sorted.length > 0) {
            const best = sorted[0]
            preview.matched = true
            preview.matchedProduct = best.productName
            preview.matchMethod = 'exact'
            preview.lastPrice = best.price
            preview.imageUrl = best.imageUrl
            preview.orderRef = best.id
            preview.platform = best.platform
          }
          preview.ambiguityLevel = this.computeAmbiguityLevel(sorted)
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

  private sortCandidatesByUserPreference<T extends { productName: string; price: number; id: number }>(
    candidates: T[],
  ): T[] {
    const validCandidates = (candidates || []).filter(c => c && typeof c.productName === 'string')
    if (validCandidates.length <= 1) return validCandidates

    const productNames = validCandidates.map(c => c.productName)
    const stats = this.db.getProductStats(productNames)

    const getStats = (productName: string) => {
      return stats[productName] || { count: 1, lastPurchasedAt: '' }
    }

    const parseTime = (timeStr: string) => {
      if (!timeStr) return 0
      const ms = Date.parse(timeStr)
      return isNaN(ms) ? 0 : ms
    }

    const TIME_THRESHOLD = 7 * 24 * 60 * 60 * 1000 // 7 days

    return [...validCandidates].sort((a, b) => {
      const statsA = getStats(a.productName)
      const statsB = getStats(b.productName)

      // 0. 核心置信度优先：大模型匹配置信度 (降序)
      const scoreA = (a as any).matchScore ?? 0
      const scoreB = (b as any).matchScore ?? 0
      if (scoreA !== scoreB) {
        return scoreB - scoreA
      }

      // 1. 第一权重：购买次数 (降序)
      if (statsA.count !== statsB.count) {
        return statsB.count - statsA.count
      }

      // 2. 第二权重：购买时间 (越近期购买的权重越大)
      const timeA = parseTime(statsA.lastPurchasedAt)
      const timeB = parseTime(statsB.lastPurchasedAt)
      const timeDiff = Math.abs(timeA - timeB)

      if (timeDiff > TIME_THRESHOLD) {
        return timeB - timeA // 降序
      }

      // 3. 第三权重：价格 (低价格优先，升序)
      if (a.price !== b.price) {
        return a.price - b.price // 升序
      }

      // 兜底：如果都一样，按ID降序
      return b.id - a.id
    })
  }
}

