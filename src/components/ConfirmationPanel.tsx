import { useState, useEffect, useCallback } from 'react'
import { api } from '../lib/api'

interface SearchResult {
  title: string
  url: string
  price: number
  imageUrl: string
  shopName?: string
}

interface PendingConfirmation {
  id: number
  taskId: number
  productName: string
  originalPrice: number
  failureReason: string
  searchKeyword: string
  candidates: string
  status: 'pending' | 'resolved' | 'dismissed'
  createdAt: string
  resolvedAt: string | null
  orderId: number | null
  platform?: string
}

type FilterStatus = 'pending' | 'resolved' | 'dismissed' | 'all'

function formatDate(dateStr: string | null | undefined): string {
  if (!dateStr) return ''
  const d = new Date(dateStr.replace(' ', 'T'))
  if (isNaN(d.getTime())) return ''
  return d.toLocaleString('zh-CN')
}

function CandidateCard({ result, onBought, disabled }: { result: SearchResult; onBought?: () => void; disabled?: boolean }) {
  return (
    <div className="flex gap-3 p-3 bg-white rounded-lg border border-gray-100 hover:border-blue-200 transition-colors">
      {result.imageUrl && (
        <img
          src={result.imageUrl}
          alt={result.title}
          className="w-16 h-16 object-cover rounded-md flex-shrink-0"
        />
      )}
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-gray-800 truncate" title={result.title}>
          {result.title}
        </p>
        <div className="flex items-center gap-2 mt-1">
          <span className="text-sm font-bold text-red-500">¥{result.price.toFixed(2)}</span>
          {result.shopName && (
            <span className="text-sm text-gray-400 truncate">{result.shopName}</span>
          )}
        </div>
        <div className="flex items-center gap-3 mt-1.5">
          {result.url && (
            <a
              href={result.url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm text-blue-600 hover:text-blue-700"
              onClick={(e) => e.stopPropagation()}
            >
              前往购买 →
            </a>
          )}
          {onBought && (
            <button
              onClick={(e) => {
                e.stopPropagation()
                onBought()
              }}
              disabled={disabled}
              className="text-sm font-medium text-green-600 hover:text-green-700 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              我买了这个
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

export default function ConfirmationPanel() {
  const [items, setItems] = useState<PendingConfirmation[]>([])
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState<FilterStatus>('pending')
  const [expandedId, setExpandedId] = useState<number | null>(null)
  const [pendingCount, setPendingCount] = useState(0)
  const [excludingOrderId, setExcludingOrderId] = useState<number | null>(null)
  const [excludedOrderIds, setExcludedOrderIds] = useState<Set<number>>(new Set())
  const [confirmingPurchase, setConfirmingPurchase] = useState<number | null>(null)

  const loadItems = useCallback(async () => {
    setLoading(true)
    try {
      const status = filter === 'all' ? undefined : filter
      const result = await api.listPendingConfirmations(status) as PendingConfirmation[]
      setItems(result)
    } finally {
      setLoading(false)
    }
  }, [filter])

  const loadCount = useCallback(async () => {
    const count = await api.getPendingConfirmationCount() as number
    setPendingCount(count)
  }, [])

  useEffect(() => {
    loadItems()
    loadCount()
  }, [loadItems, loadCount])

  useEffect(() => {
    const orderIds = items.filter(i => i.orderId).map(i => i.orderId!)
    if (orderIds.length === 0) {
      setExcludedOrderIds(new Set())
      return
    }
    api.getUnavailableOrderIds(orderIds).then((ids: unknown) => {
      setExcludedOrderIds(new Set(ids as number[]))
    })
  }, [items])

  const handleResolve = async (id: number) => {
    await api.resolvePendingConfirmation(id)
    await loadItems()
    await loadCount()
  }

  const handleDismiss = async (id: number) => {
    await api.dismissPendingConfirmation(id)
    await loadItems()
    await loadCount()
  }

  const handleExcludeOrder = async (orderId: number) => {
    if (!orderId) return
    setExcludingOrderId(orderId)
    setExcludedOrderIds(prev => new Set(prev).add(orderId))
    try {
      await api.markOrderUnavailable(orderId)
      await loadItems()
      await loadCount()
    } catch (e) {
      console.error('[ConfirmationPanel] markOrderUnavailable failed:', e)
      setExcludedOrderIds(prev => {
        const next = new Set(prev)
        next.delete(orderId)
        return next
      })
    } finally {
      setExcludingOrderId(null)
    }
  }

  const handleRestoreOrder = async (orderId: number) => {
    if (!orderId) return
    setExcludingOrderId(orderId)
    setExcludedOrderIds(prev => {
      const next = new Set(prev)
      next.delete(orderId)
      return next
    })
    try {
      await api.toggleOrderUnavailable(orderId)
      await loadItems()
      await loadCount()
    } catch {
      setExcludedOrderIds(prev => new Set(prev).add(orderId))
    } finally {
      setExcludingOrderId(null)
    }
  }

  const handleConfirmPurchase = async (confirmationId: number, candidate: SearchResult) => {
    setConfirmingPurchase(confirmationId)
    const item = items.find(i => i.id === confirmationId)
    try {
      await api.confirmPurchaseFromSearch(confirmationId, {
        platform: item?.platform || '',
        productName: candidate.title,
        price: candidate.price,
        imageUrl: candidate.imageUrl,
        productUrl: candidate.url,
        shopName: candidate.shopName,
      })
      await loadItems()
      await loadCount()
    } finally {
      setConfirmingPurchase(null)
    }
  }

  const filterTabs: { key: FilterStatus; label: string }[] = [
    { key: 'pending', label: `待处理${pendingCount > 0 ? ` (${pendingCount})` : ''}` },
    { key: 'resolved', label: '已自行解决' },
    { key: 'dismissed', label: '已放弃购买' },
    { key: 'all', label: '全部' },
  ]

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-lg font-semibold text-gray-800">异常与待确认清单</h2>
        <button
          onClick={() => { loadItems(); loadCount() }}
          className="text-sm text-blue-600 hover:text-blue-700"
        >
          刷新
        </button>
      </div>

      <div className="flex gap-2 mb-4">
        {filterTabs.map(tab => (
          <button
            key={tab.key}
            onClick={() => setFilter(tab.key)}
            className={`px-3 py-1.5 text-sm font-medium rounded-lg transition-colors ${
              filter === tab.key
                ? 'bg-blue-600 text-white'
                : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="text-center py-8 text-sm text-gray-400">加载中...</div>
      ) : items.length === 0 ? (
        <div className="text-center py-12">
          <p className="text-4xl mb-3">📋</p>
          <p className="text-sm text-gray-400">
            {filter === 'pending' ? '暂无待处理项目' : '暂无记录'}
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {items.map(item => {
            let candidates: SearchResult[] = []
            try {
              candidates = JSON.parse(item.candidates)
            } catch { /* ignore */ }

            const isExpanded = expandedId === item.id

            return (
              <div
                key={item.id}
                className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden"
              >
                <div
                  className="p-4 cursor-pointer"
                  onClick={() => setExpandedId(isExpanded ? null : item.id)}
                >
                  <div className="flex items-start justify-between">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium text-gray-900">{item.productName}</span>
                        <span className={`px-2 py-0.5 rounded-full text-sm font-medium ${
                          item.status === 'pending'
                            ? 'bg-amber-50 text-amber-600'
                            : item.status === 'resolved'
                              ? 'bg-green-50 text-green-600'
                              : 'bg-gray-50 text-gray-500'
                        }`}>
                          {item.status === 'pending' ? '待处理' : item.status === 'resolved' ? '已解决' : '已放弃'}
                        </span>
                      </div>
                      <p className="text-sm text-gray-500 mt-1">
                        失败原因: {item.failureReason}
                      </p>
                      {item.originalPrice > 0 && (
                        <p className="text-sm text-gray-400 mt-0.5">
                          历史价格: ¥{item.originalPrice.toFixed(2)}
                          {candidates.length > 0 && ` · ${candidates.length} 个候选商品`}
                        </p>
                      )}
                    </div>
                    <svg
                      className={`w-4 h-4 text-gray-400 transition-transform flex-shrink-0 ${isExpanded ? 'rotate-180' : ''}`}
                      fill="none" stroke="currentColor" viewBox="0 0 24 24"
                    >
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                    </svg>
                  </div>
                </div>

                {isExpanded && (
                  <div className="px-4 pb-4 border-t border-gray-50">
                    {item.orderId && item.status === 'pending' && (
                      <div className="mt-3 p-3 rounded-lg bg-orange-50/60 border border-orange-100">
                        <div className="flex items-start justify-between gap-3">
                          <div className="flex-1">
                            <p className="text-sm font-medium text-orange-700 mb-1">原匹配订单无法再次购买</p>
                            <p className="text-sm text-orange-600 leading-relaxed">
                              该商品匹配到的历史订单已无法购买，排除匹配后，下次购买同类商品时不会再匹配到这个订单。
                            </p>
                          </div>
                          {excludedOrderIds.has(item.orderId!) ? (
                            <span className="flex-shrink-0 px-3 py-1.5 text-sm font-medium text-gray-400 bg-gray-50 rounded-md inline-flex items-center gap-1.5 whitespace-nowrap">
                              ✓ 已排除
                              <button
                                onClick={(e) => {
                                  e.stopPropagation()
                                  handleRestoreOrder(item.orderId!)
                                }}
                                disabled={excludingOrderId === item.orderId}
                                className="text-xs text-blue-500 hover:text-blue-700 underline underline-offset-1 disabled:opacity-50"
                              >
                                撤销
                              </button>
                            </span>
                          ) : (
                            <button
                              onClick={(e) => {
                                e.stopPropagation()
                                handleExcludeOrder(item.orderId!)
                              }}
                              disabled={excludingOrderId === item.orderId}
                              className="flex-shrink-0 px-3 py-1.5 text-sm font-medium text-orange-700 bg-orange-100 rounded-md hover:bg-orange-200 transition-colors disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap"
                            >
                              {excludingOrderId === item.orderId ? '处理中...' : '不再匹配此订单'}
                            </button>
                          )}
                        </div>
                      </div>
                    )}

                    {candidates.length > 0 && (
                      <div className="mt-3">
                        <p className="text-sm font-medium text-gray-600 mb-2">
                          搜索到的候选商品
                        </p>
                        <div className="space-y-2 max-h-80 overflow-y-auto">
                          {candidates.map((c, i) => (
                            <CandidateCard
                              key={i}
                              result={c}
                              onBought={item.status === 'pending' ? () => handleConfirmPurchase(item.id, c) : undefined}
                              disabled={confirmingPurchase === item.id}
                            />
                          ))}
                        </div>
                      </div>
                    )}

                    {candidates.length === 0 && (
                      <p className="text-sm text-gray-400 mt-3">未找到候选商品，请手动搜索购买</p>
                    )}

                    {item.status === 'pending' && (
                      <div className="flex gap-2 mt-4 pt-3 border-t border-gray-100">
                        <button
                          onClick={(e) => {
                            e.stopPropagation()
                            handleResolve(item.id)
                          }}
                          className="px-4 py-2 text-sm font-medium text-green-600 bg-green-50 rounded-lg hover:bg-green-100 transition-colors"
                        >
                          已自行解决
                        </button>
                        <button
                          onClick={(e) => {
                            e.stopPropagation()
                            handleDismiss(item.id)
                          }}
                          className="px-4 py-2 text-sm font-medium text-gray-500 bg-gray-50 rounded-lg hover:bg-gray-100 transition-colors"
                        >
                          不买了
                        </button>
                      </div>
                    )}

                    {item.status === 'resolved' && (
                      <div className="mt-3 flex items-center gap-1.5 text-sm text-green-600">
                        <span>✓</span>
                        <span>已标记为自行解决</span>
                      </div>
                    )}

                    {item.status === 'dismissed' && (
                      <div className="mt-3 flex items-center gap-1.5 text-sm text-gray-400">
                        <span>✗</span>
                        <span>已放弃购买</span>
                      </div>
                    )}

                    <p className="text-sm text-gray-300 mt-3">
                      创建时间: {formatDate(item.createdAt)}
                      {item.resolvedAt && ` · 处理时间: ${formatDate(item.resolvedAt)}`}
                    </p>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
