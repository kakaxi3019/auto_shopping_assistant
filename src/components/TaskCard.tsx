import { useState } from 'react'

type ErrorCategory = 'out_of_stock' | 'login_expired' | 'not_supported' | 'network_error' | 'no_history' | 'other'

interface ItemResult {
  name: string
  quantity: number
  status: 'success' | 'failed'
  error?: string
  matchedProduct?: string
  matchMethod?: 'llm_direct' | 'exact' | 'fuzzy'
}

interface TaskCardProps {
  task: {
    id: number
    status: string
    instruction: string
    parsedItems: string
    createdAt: string
    completedAt: string | null
    error: string | null
    itemResults?: string | null
  }
  onCancel: (id: number) => void
  onRetryItem: (taskId: number, itemName: string) => Promise<void>
}

const statusConfig: Record<string, { label: string; color: string; bg: string }> = {
  pending: { label: '等待中', color: 'text-gray-600', bg: 'bg-gray-100' },
  running: { label: '执行中', color: 'text-blue-600', bg: 'bg-blue-50' },
  success: { label: '成功', color: 'text-green-600', bg: 'bg-green-50' },
  failed: { label: '失败', color: 'text-red-600', bg: 'bg-red-50' },
  partial: { label: '部分成功', color: 'text-amber-600', bg: 'bg-amber-50' },
  cancelled: { label: '已取消', color: 'text-gray-500', bg: 'bg-gray-50' },
}

const errorCategoryConfig: Record<ErrorCategory, { label: string; icon: string; bg: string; color: string; retryable: boolean; description?: string }> = {
  out_of_stock: { label: '商品已下架', icon: '📦', bg: 'bg-orange-50', color: 'text-orange-600', retryable: false, description: '该商品已下架或库存不足' },
  login_expired: { label: '登录已过期', icon: '🔐', bg: 'bg-amber-50', color: 'text-amber-600', retryable: true, description: '请重新登录账号' },
  not_supported: { label: '平台不支持', icon: '🚫', bg: 'bg-gray-50', color: 'text-gray-500', retryable: false, description: '该商品所在店铺未开通"再买一单"功能，这是平台限制而非程序问题' },
  network_error: { label: '网络异常', icon: '🌐', bg: 'bg-blue-50', color: 'text-blue-600', retryable: true, description: '网络连接不稳定，请检查网络设置' },
  no_history: { label: '未找到历史订单', icon: '🔍', bg: 'bg-purple-50', color: 'text-purple-600', retryable: true, description: '未在历史订单中找到匹配的商品' },
  other: { label: '购买失败', icon: '❌', bg: 'bg-red-50', color: 'text-red-600', retryable: true, description: '购买过程中发生未知错误' },
}

function categorizeError(error?: string): ErrorCategory {
  if (!error) return 'other'
  if (error.includes('已下架') || error.includes('商品已下架') || error.includes('已售罄') || error.includes('商品不存在')) return 'out_of_stock'
  if (error.includes('登录已过期') || error.includes('未登录') || error.includes('登录验证') || error.includes('身份验证')) return 'login_expired'
  if (error.includes('不支持再买一单') || error.includes('未找到再买一单') || error.includes('不支持再买') || error.includes('未开通"再买一单"')) return 'not_supported'
  if (error.includes('Timeout') || error.includes('timeout') || error.includes('网络') || error.includes('ERR_') || error.includes('net::')) return 'network_error'
  if (error.includes('未找到历史订单') || error.includes('没有历史')) return 'no_history'
  return 'other'
}

const matchMethodLabels: Record<string, string> = {
  llm_direct: '智能匹配',
  exact: '精确匹配',
  fuzzy: '模糊匹配',
}

function formatDate(dateStr: string | null | undefined): string {
  if (!dateStr) return ''
  const d = new Date(dateStr.replace(' ', 'T'))
  if (isNaN(d.getTime())) return ''
  return d.toLocaleString('zh-CN')
}

export default function TaskCard({ task, onCancel, onRetryItem }: TaskCardProps) {
  const [expanded, setExpanded] = useState(false)
  const [retryingItem, setRetryingItem] = useState<string | null>(null)

  let parsedItems: { name: string; quantity: number }[] = []
  try {
    parsedItems = JSON.parse(task.parsedItems)
  } catch { /* ignore */ }

  let itemResults: ItemResult[] = []
  try {
    if (task.itemResults) {
      itemResults = JSON.parse(task.itemResults)
    }
  } catch { /* ignore */ }

  const hasResults = itemResults.length > 0
  const successCount = itemResults.filter(r => r.status === 'success').length
  const failedCount = itemResults.filter(r => r.status === 'failed').length
  const hasFailedItems = failedCount > 0

  let displayStatus = task.status
  if (hasResults && task.status === 'failed' && successCount > 0) {
    displayStatus = 'partial'
  }

  const config = statusConfig[displayStatus] || statusConfig.pending
  const isTerminal = ['success', 'failed', 'partial', 'cancelled'].includes(displayStatus)
  const canExpand = hasResults || (parsedItems.length > 0 && isTerminal)

  const handleRetry = async (itemName: string) => {
    setRetryingItem(itemName)
    try {
      await onRetryItem(task.id, itemName)
    } finally {
      setRetryingItem(null)
    }
  }

  return (
    <div className="bg-white rounded-xl border border-gray-100 shadow-sm hover:shadow-md transition-shadow">
      <div
        className={`p-4 ${canExpand ? 'cursor-pointer' : ''}`}
        onClick={() => canExpand && setExpanded(!expanded)}
      >
        <div className="flex items-start justify-between">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <p className="text-sm font-medium text-gray-900 truncate">{task.instruction}</p>
              {canExpand && (
                <svg
                  className={`w-4 h-4 text-gray-400 transition-transform flex-shrink-0 ${expanded ? 'rotate-180' : ''}`}
                  fill="none" stroke="currentColor" viewBox="0 0 24 24"
                  aria-hidden="true"
                >
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                </svg>
              )}
            </div>
            {!expanded && hasResults && (
              <div className="flex flex-wrap gap-1.5 mt-2">
                {itemResults.map((item, i) => (
                  <span
                    key={i}
                    className={`inline-flex items-center px-2 py-0.5 rounded-md text-xs ${
                      item.status === 'success'
                        ? 'bg-green-50 text-green-700'
                        : 'bg-red-50 text-red-600'
                    }`}
                  >
                    {item.status === 'success' ? '✓' : '✗'} {item.name} x{item.quantity}
                  </span>
                ))}
              </div>
            )}
            {!expanded && !hasResults && parsedItems.length > 0 && (
              <div className="flex flex-wrap gap-1.5 mt-2">
                {parsedItems.map((item, i) => (
                  <span
                    key={i}
                    className="inline-flex items-center px-2 py-0.5 rounded-md text-xs bg-gray-100 text-gray-600"
                  >
                    {item.name} x{item.quantity}
                  </span>
                ))}
              </div>
            )}
            {hasResults && (successCount > 0 || failedCount > 0) && (
              <p className="text-xs text-gray-400 mt-1.5">
                {successCount > 0 && <span className="text-green-600">{successCount} 项成功</span>}
                {successCount > 0 && failedCount > 0 && <span className="mx-1">·</span>}
                {failedCount > 0 && <span className="text-red-500">{failedCount} 项失败</span>}
              </p>
            )}
          </div>
          <span className={`ml-3 flex-shrink-0 px-2.5 py-1 rounded-full text-xs font-medium ${config.bg} ${config.color}`}>
            {config.label}
          </span>
        </div>
      </div>

      {expanded && hasResults && (
        <div className="px-4 pb-4 border-t border-gray-50">
          <div className="space-y-2 mt-3">
            {itemResults.map((item, i) => {
              const category = item.status === 'failed' ? categorizeError(item.error) : null
              const catConfig = category ? errorCategoryConfig[category] : null

              return (
                <div
                  key={i}
                  className={`rounded-lg p-3 ${
                    item.status === 'success' ? 'bg-green-50/60' : (catConfig?.bg || 'bg-red-50/60')
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2 min-w-0 flex-1">
                      <span className={`text-sm ${item.status === 'success' ? 'text-green-600' : (catConfig?.color || 'text-red-600')}`} aria-hidden="true">
                        {item.status === 'success' ? '✓' : catConfig?.icon || '✗'}
                      </span>
                      <div className="min-w-0">
                        <div className="flex items-center gap-1.5">
                          <span className="text-sm font-medium text-gray-900 truncate">{item.name}</span>
                          <span className="text-xs text-gray-400">x{item.quantity}</span>
                        </div>
                        {item.status === 'success' && item.matchedProduct && (
                          <div className="text-xs text-gray-500 mt-0.5">
                            匹配: {item.matchedProduct}
                            {item.matchMethod && (
                              <span className="ml-1 text-gray-400">({matchMethodLabels[item.matchMethod] || item.matchMethod})</span>
                            )}
                          </div>
                        )}
                        {item.status === 'failed' && (
                          <div className="flex items-center gap-1.5 mt-0.5">
                            <span className={`text-xs font-medium ${catConfig?.color || 'text-red-600'}`}>
                              {catConfig?.label || '购买失败'}
                            </span>
                            {item.error && item.error !== catConfig?.label && (
                              <span className="text-xs text-gray-400 truncate" title={item.error}>
                                {item.error.length > 30 ? item.error.slice(0, 30) + '…' : item.error}
                              </span>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                    {item.status === 'failed' && catConfig?.retryable && (
                      <button
                        onClick={(e) => {
                          e.stopPropagation()
                          handleRetry(item.name)
                        }}
                        disabled={retryingItem === item.name || task.status === 'running'}
                        className="ml-2 flex-shrink-0 px-2.5 py-1 text-xs font-medium text-blue-600 bg-blue-50 rounded-md hover:bg-blue-100 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        {retryingItem === item.name ? '重试中...' : '重试'}
                      </button>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {task.error && !expanded && (
        <div className="px-4 pb-2">
          <p className="text-xs text-red-500 bg-red-50 rounded-md px-3 py-2">{task.error}</p>
        </div>
      )}

      <div className="flex items-center justify-between px-4 py-3 border-t border-gray-50">
        <span className="text-xs text-gray-400">
          {formatDate(task.createdAt)}
        </span>
        <div className="flex items-center gap-3">
          {expanded ? (
            <button
              onClick={(e) => {
                e.stopPropagation()
                setExpanded(false)
              }}
              className="text-xs text-gray-500 hover:text-gray-700 transition-colors"
            >
              收起
            </button>
          ) : hasFailedItems && (
            <button
              onClick={(e) => {
                e.stopPropagation()
                setExpanded(true)
              }}
              className="text-xs text-blue-500 hover:text-blue-700 transition-colors"
            >
              查看详情
            </button>
          )}
          {(task.status === 'pending' || task.status === 'running') && (
            <button
              onClick={(e) => {
                e.stopPropagation()
                onCancel(task.id)
              }}
              className="text-xs text-red-500 hover:text-red-700 transition-colors"
            >
              取消
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
