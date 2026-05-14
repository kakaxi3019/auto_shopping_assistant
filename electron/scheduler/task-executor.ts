import type { Order, ParsedShoppingItem, PreviewItem, AddToCartResult } from '../../shared/types/platform.types'
import type { PlatformAdapter } from '../../shared/types/platform.types'
import type { Database } from '../db/database'

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
  status: 'success' | 'failed'
  error?: string
  matchedProduct?: string
  matchMethod?: 'llm_direct' | 'exact' | 'fuzzy'
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
      const url = platform.getProductUrl(order)
      console.log(`[TaskExecutor] addToCart: name=${item.name}, orderId=${order.orderId}, url=${url}`)

      onProgress(`正在为 "${item.name}" 执行再买一单（订单 ${order.orderId}）...`)
      try {
        const cartResult: AddToCartResult = await platform.addToCart(url, item.sku, order.orderId)
        if (!cartResult.success) {
          result.error = cartResult.error || '再来一单失败'
        } else {
          onProgress(`正在结算 "${item.name}"${item.quantity > 1 ? `（x${item.quantity}）` : ''}...`)
          const checkoutResult = await platform.checkout(cartResult.directToPay, item.quantity)
          if (!checkoutResult.success) {
            result.error = checkoutResult.error || '结算失败'
          } else {
            const totalAmount = order.price * item.quantity
            onProgress(totalAmount > 0
              ? `正在支付 "${item.name}"（¥${totalAmount.toFixed(2)}）...`
              : `正在支付 "${item.name}"...`
            )
            const payResult = await platform.pay(totalAmount, dryRun)
            if (!payResult.success) {
              result.error = payResult.error || '支付失败'
            } else {
              result.matchedProduct = order.productName
              result.status = 'success'
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

    onProgress('购买完成!')
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

    if (item.orderRef) {
      const order = this.db.getOrderById(item.orderRef)
      if (order && (!item.platform || order.platform === searchPlatform)) {
        return { order, matchMethod: 'llm_direct' }
      }
    }

    const exactOrders = this.db.searchOrders(item.name, searchPlatform)
    if (exactOrders.length > 0) {
      return { order: exactOrders[0], matchMethod: 'exact' }
    }

    if (item.name.length >= 2) {
      const { orders: fuzzyOrders } = this.db.searchOrdersFuzzy(item.name, searchPlatform)
      if (fuzzyOrders.length > 0) {
        return { order: fuzzyOrders[0], matchMethod: 'fuzzy' }
      }
    }

    return { order: null, matchMethod: null }
  }

  previewCandidateOrders(item: ParsedShoppingItem, platformName: string, instruction?: string): PreviewItem {
    const preview: PreviewItem = {
      name: item.name,
      quantity: item.quantity,
      sku: item.sku,
      orderRef: item.orderRef,
      matched: false,
    }

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

    return preview
  }

  async executeSingle(
    item: ParsedShoppingItem,
    platform: PlatformAdapter,
    onProgress: (msg: string) => void,
    instruction?: string,
    dryRun?: boolean,
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

    onProgress(`正在为 "${item.name}" 执行再买一单（订单 ${order.orderId}）...`)
    try {
      const cartResult: AddToCartResult = await platform.addToCart(url, item.sku, order.orderId)
      if (!cartResult.success) {
        result.error = cartResult.error || '再来一单失败'
      } else {
        onProgress(`正在结算 "${item.name}"${item.quantity > 1 ? `（x${item.quantity}）` : ''}...`)
        const checkoutResult = await platform.checkout(cartResult.directToPay, item.quantity)
        if (!checkoutResult.success) {
          result.error = checkoutResult.error || '结算失败'
        } else {
          const totalAmount = order.price * item.quantity
          onProgress(totalAmount > 0
            ? `正在支付 "${item.name}"（¥${totalAmount.toFixed(2)}）...`
            : `正在支付 "${item.name}"...`
          )
          const payResult = await platform.pay(totalAmount, dryRun)
          if (!payResult.success) {
            result.error = payResult.error || '支付失败'
          } else {
            result.matchedProduct = order.productName
            result.status = 'success'
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
