import { useState, useEffect, useCallback } from 'react'
import { api } from '../lib/api'

interface Order {
  id: number
  platform: string
  orderId: string
  productName: string
  productUrl: string
  price: number
  imageUrl: string
  purchasedAt: string
  rawData: string
  unavailable: number
}

interface PlatformInfo {
  key: string
  name: string
  icon: string
  color: string
  bgColor: string
  borderColor: string
}

const PLATFORMS: PlatformInfo[] = [
  { key: 'taobao', name: '淘宝', icon: '🛒', color: 'text-orange-600', bgColor: 'bg-orange-50', borderColor: 'border-orange-100' },
]

const PAGE_SIZE = 20

function formatDate(dateStr: string): string {
  if (!dateStr) return ''
  try {
    const d = new Date(dateStr)
    if (isNaN(d.getTime())) return dateStr
    return d.toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' })
  } catch {
    return dateStr
  }
}

function formatPrice(price: number): string {
  if (!price || price === 0) return ''
  return `¥${price.toFixed(2)}`
}

export default function OrderList({ onNavigateToTasks }: { onNavigateToTasks?: (filter?: string | number) => void }) {
  const [selectedPlatform, setSelectedPlatform] = useState<string | null>(null)
  const [orders, setOrders] = useState<Order[]>([])
  const [orderCounts, setOrderCounts] = useState<Record<string, number>>({})
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [searchKeyword, setSearchKeyword] = useState('')
  const [activeSearch, setActiveSearch] = useState('')
  const [loading, setLoading] = useState(false)
  const [clearing, setClearing] = useState<string | null>(null)
  const [rebuying, setRebuying] = useState<number | null>(null)

  const [manageMode, setManageMode] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set())
  const [deleting, setDeleting] = useState(false)
  const [togglingId, setTogglingId] = useState<number | null>(null)

  const handleRebuy = useCallback(async (order: Order) => {
    setRebuying(order.id)
    try {
      const paymentMode = await api.getSetting('payment_mode') as string || 'auto_pay'
      const result = await api.confirmTask(
        order.productName,
        [{ name: order.productName, quantity: 1, orderRef: order.id }],
        order.platform,
        false,
        paymentMode,
      ) as { taskId?: number; error?: string }
      if (result && result.error) {
        console.error('再买一单失败:', result.error)
      } else if (result && result.taskId) {
        onNavigateToTasks?.(result.taskId)
      } else {
        onNavigateToTasks?.('running')
      }
    } catch (e) {
      console.error('再买一单失败:', e)
    } finally {
      setRebuying(null)
    }
  }, [onNavigateToTasks])

  const loadCounts = useCallback(async () => {
    const counts: Record<string, number> = {}
    for (const p of PLATFORMS) {
      try {
        counts[p.key] = await api.getOrderCount(p.key)
      } catch {
        counts[p.key] = 0
      }
    }
    setOrderCounts(counts)
  }, [])

  useEffect(() => {
    loadCounts()
  }, [loadCounts])

  const loadOrders = useCallback(async () => {
    if (!selectedPlatform) return
    setLoading(true)
    try {
      if (activeSearch) {
        const results = await api.searchOrders(activeSearch)
        setOrders((results as Order[]).filter(o => o.platform === selectedPlatform))
        setTotal((results as Order[]).filter(o => o.platform === selectedPlatform).length)
        setPage(1)
      } else {
        const offset = (page - 1) * PAGE_SIZE
        const results = await api.getOrders(selectedPlatform, PAGE_SIZE, offset)
        const count = await api.getOrderCount(selectedPlatform)
        setOrders(results as Order[])
        setTotal(count)
      }
    } catch {
      setOrders([])
    } finally {
      setLoading(false)
    }
  }, [selectedPlatform, page, activeSearch])

  useEffect(() => {
    if (selectedPlatform) loadOrders()
  }, [selectedPlatform, loadOrders])

  useEffect(() => {
    if (!manageMode) {
      setSelectedIds(new Set())
    }
  }, [manageMode])

  const handlePlatformClick = (platformKey: string) => {
    setSelectedPlatform(platformKey)
    setPage(1)
    setSearchKeyword('')
    setActiveSearch('')
    setManageMode(false)
    setSelectedIds(new Set())
  }

  const handleBack = () => {
    setSelectedPlatform(null)
    setOrders([])
    setSearchKeyword('')
    setActiveSearch('')
    setManageMode(false)
    setSelectedIds(new Set())
    loadCounts()
  }

  const handleSearch = () => {
    setActiveSearch(searchKeyword.trim())
    setPage(1)
  }

  const handleClearSearch = () => {
    setSearchKeyword('')
    setActiveSearch('')
    setPage(1)
  }

  const handleClearPlatform = async (e: React.MouseEvent, platformKey: string) => {
    e.stopPropagation()
    const p = PLATFORMS.find(p => p.key === platformKey)
    if (!confirm(`确定要清除${p?.name}的所有历史订单吗？此操作不可恢复。`)) return
    setClearing(platformKey)
    try {
      await api.clearOrders(platformKey)
      loadCounts()
    } catch {
      alert('清除失败')
    } finally {
      setClearing(null)
    }
  }

  const toggleSelect = (id: number) => {
    setSelectedIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) {
        next.delete(id)
      } else {
        next.add(id)
      }
      return next
    })
  }

  const toggleSelectAll = () => {
    if (selectedIds.size === orders.length) {
      setSelectedIds(new Set())
    } else {
      setSelectedIds(new Set(orders.map(o => o.id)))
    }
  }

  const handleDeleteSelected = async () => {
    if (selectedIds.size === 0) return
    if (!confirm(`确定要删除选中的 ${selectedIds.size} 条订单吗？此操作不可恢复。`)) return
    setDeleting(true)
    try {
      await api.deleteOrders(Array.from(selectedIds))
      setSelectedIds(new Set())
      loadOrders()
      loadCounts()
    } catch {
      alert('删除失败')
    } finally {
      setDeleting(false)
    }
  }

  const handleDeleteSingle = async (id: number) => {
    if (!confirm('确定要删除这条订单吗？此操作不可恢复。')) return
    try {
      await api.deleteOrder(id)
      setSelectedIds(prev => {
        const next = new Set(prev)
        next.delete(id)
        return next
      })
      loadOrders()
      loadCounts()
    } catch {
      alert('删除失败')
    }
  }

  const handleToggleUnavailable = async (id: number) => {
    setTogglingId(id)
    try {
      await api.toggleOrderUnavailable(id)
      loadOrders()
    } catch {
      alert('操作失败')
    } finally {
      setTogglingId(null)
    }
  }

  const platform = PLATFORMS.find(p => p.key === selectedPlatform)
  const totalPages = Math.ceil(total / PAGE_SIZE)

  if (!selectedPlatform) {
    return (
      <div>
        <h2 className="text-lg font-semibold text-gray-800 mb-6">历史订单</h2>
        <div className="grid grid-cols-2 gap-4 max-w-lg">
          {PLATFORMS.map((p) => (
            <button
              key={p.key}
              onClick={() => handlePlatformClick(p.key)}
              className={`bg-white rounded-xl border ${p.borderColor} shadow-sm p-6 hover:shadow-md transition-all text-left group`}
            >
              <div className="flex items-center gap-4">
                <div className={`w-12 h-12 ${p.bgColor} rounded-xl flex items-center justify-center text-2xl`}>
                  {p.icon}
                </div>
                <div>
                  <h3 className={`font-medium ${p.color}`}>{p.name}</h3>
                  <p className="text-sm text-gray-400 mt-0.5">
                    {orderCounts[p.key] ?? 0} 条订单
                  </p>
                </div>
              </div>
              <div className="mt-4 flex items-center justify-between">
                <div className="flex items-center text-sm text-gray-400 group-hover:text-gray-600 transition-colors">
                  查看订单
                  <svg className="w-3.5 h-3.5 ml-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                  </svg>
                </div>
                {(orderCounts[p.key] ?? 0) > 0 && (
                  <button
                    onClick={(e) => handleClearPlatform(e, p.key)}
                    disabled={clearing === p.key}
                    className="text-sm text-gray-400 hover:text-red-500 transition-colors disabled:opacity-50"
                  >
                    {clearing === p.key ? '清除中...' : '清除记录'}
                  </button>
                )}
              </div>
            </button>
          ))}
        </div>
      </div>
    )
  }

  return (
    <div>
      <div className="flex items-center gap-3 mb-6">
        <button
          onClick={handleBack}
          aria-label="返回平台选择"
          className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-500 hover:text-gray-700 transition-colors"
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
        </button>
        <div className="flex items-center gap-3">
          <span className="text-xl">{platform?.icon}</span>
          <h2 className="text-lg font-semibold text-gray-800">{platform?.name} 历史订单</h2>
        </div>
        <span className="text-sm text-gray-400 ml-1">{total} 条</span>

        <div className="ml-auto flex items-center gap-2">
          {orders.length > 0 && (
            <button
              onClick={() => setManageMode(!manageMode)}
              className={`px-3 py-1.5 text-sm rounded-lg border transition-colors ${
                manageMode
                  ? 'bg-blue-600 text-white border-blue-600'
                  : 'bg-white text-gray-600 border-gray-200 hover:bg-gray-50'
              }`}
            >
              {manageMode ? '退出管理' : '管理订单'}
            </button>
          )}
        </div>
      </div>

      {manageMode && (
        <div className="mb-4 flex items-center gap-3 p-3 bg-blue-50 rounded-xl border border-blue-100">
          <label className="flex items-center gap-2 cursor-pointer text-sm text-gray-700">
            <input
              type="checkbox"
              checked={selectedIds.size === orders.length && orders.length > 0}
              onChange={toggleSelectAll}
              className="w-4 h-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
            />
            <span>全选</span>
          </label>
          <span className="text-sm text-gray-500">
            已选 {selectedIds.size} 项
          </span>
          {selectedIds.size > 0 && (
            <button
              onClick={handleDeleteSelected}
              disabled={deleting}
              className="ml-auto px-3 py-1.5 text-sm bg-red-500 text-white rounded-lg hover:bg-red-600 transition-colors disabled:opacity-50"
            >
              {deleting ? '删除中...' : `删除选中 (${selectedIds.size})`}
            </button>
          )}
        </div>
      )}

      <div className="flex items-center gap-2 mb-4">
        <div className="relative">
          <input
            type="text"
            value={searchKeyword}
            onChange={(e) => setSearchKeyword(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
            placeholder="搜索商品名称..."
            aria-label="搜索历史订单"
            className="w-56 pl-3 pr-8 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent bg-white"
          />
          {searchKeyword && (
            <button
              onClick={handleClearSearch}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
            >
              ✕
            </button>
          )}
        </div>
        <button
          onClick={handleSearch}
          className="px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 transition-colors"
        >
          搜索
        </button>
      </div>

      {activeSearch && (
        <div className="mb-4 flex items-center gap-2 text-sm text-gray-500">
          <span>搜索 "{activeSearch}" 的结果，共 {total} 条</span>
          <button
            onClick={handleClearSearch}
            className="text-blue-600 hover:text-blue-700"
          >
            清除搜索
          </button>
        </div>
      )}

      {loading ? (
        <div className="flex items-center justify-center py-20">
          <div className="text-center">
            <div className="inline-block w-6 h-6 border-2 border-blue-500 border-t-transparent rounded-full animate-spin mb-3" />
            <p className="text-sm text-gray-500">加载中...</p>
          </div>
        </div>
      ) : orders.length === 0 ? (
        <div className="flex items-center justify-center py-20">
          <div className="text-center">
            <div className="text-4xl mb-3">📦</div>
            <p className="text-sm text-gray-500">
              {activeSearch ? '没有找到匹配的订单' : '暂无订单数据，请先同步历史订单'}
            </p>
          </div>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-1 gap-3">
            {orders.map((order) => (
              <div
                key={order.id}
                className={`bg-white rounded-xl border shadow-sm p-4 hover:shadow-md transition-shadow ${
                  order.unavailable ? 'border-gray-200 opacity-60' : 'border-gray-100'
                } ${selectedIds.has(order.id) ? 'ring-2 ring-blue-500 border-blue-300' : ''}`}
              >
                <div className="flex gap-4">
                  {manageMode && (
                    <div className="flex items-center flex-shrink-0">
                      <input
                        type="checkbox"
                        checked={selectedIds.has(order.id)}
                        onChange={() => toggleSelect(order.id)}
                        className="w-4 h-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                      />
                    </div>
                  )}
                  <div className="w-20 h-20 flex-shrink-0 rounded-lg overflow-hidden bg-gray-100">
                    {order.imageUrl ? (
                      <img
                        src={order.imageUrl.startsWith('//') ? 'https:' + order.imageUrl : order.imageUrl}
                        alt={order.productName}
                        className="w-full h-full object-cover"
                        onError={(e) => {
                          (e.target as HTMLImageElement).style.display = 'none'
                          ;((e.target as HTMLImageElement).nextElementSibling as HTMLElement)!.style.display = 'flex'
                        }}
                      />
                    ) : null}
                    <div
                      className="w-full h-full items-center justify-center text-2xl"
                      role="img"
                      aria-label="商品图片"
                      style={{ display: order.imageUrl ? 'none' : 'flex' }}
                    >
                      🛍️
                    </div>
                  </div>

                  <div className="flex-1 min-w-0">
                    <div className="flex items-start justify-between gap-3">
                      <h3 className="text-sm font-medium text-gray-900 line-clamp-2 leading-5">
                        {order.productUrl ? (
                          <a
                            href={order.productUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="hover:text-blue-600 transition-colors"
                          >
                            {order.productName}
                          </a>
                        ) : (
                          order.productName
                        )}
                      </h3>
                      <div className="flex items-center gap-2 flex-shrink-0">
                        {order.price > 0 && (
                          <span className="text-sm font-semibold text-orange-500">
                            {formatPrice(order.price)}
                          </span>
                        )}
                      </div>
                    </div>

                    <div className="flex items-center gap-3 mt-2">
                      <span className="inline-flex items-center px-2 py-0.5 rounded-md text-sm bg-orange-50 text-orange-600 font-medium">
                        {platform?.name}
                      </span>
                      {order.unavailable ? (
                        <span className="inline-flex items-center px-2 py-0.5 rounded-md text-sm bg-gray-100 text-gray-500 font-medium">
                          已下架
                        </span>
                      ) : null}
                      {order.purchasedAt && (
                        <span className="text-sm text-gray-400">
                          {formatDate(order.purchasedAt)}
                        </span>
                      )}
                      <span className="text-sm text-gray-300">
                        #{order.orderId}
                      </span>
                    </div>

                    <div className="flex items-center gap-2 mt-2">
                      {!manageMode && (
                        <button
                          onClick={(e) => {
                            e.stopPropagation()
                            handleRebuy(order)
                          }}
                          disabled={rebuying === order.id}
                          className="text-sm text-blue-500 hover:text-blue-700 transition-colors disabled:opacity-50"
                          title="使用当前支付模式重新购买此商品"
                        >
                          {rebuying === order.id ? '执行中...' : '再买一单'}
                        </button>
                      )}
                      {!manageMode && (
                        <button
                          onClick={(e) => {
                            e.stopPropagation()
                            handleToggleUnavailable(order.id)
                          }}
                          disabled={togglingId === order.id}
                          className={`text-sm transition-colors disabled:opacity-50 ${
                            order.unavailable
                              ? 'text-green-500 hover:text-green-700'
                              : 'text-gray-400 hover:text-orange-500'
                          }`}
                          title={order.unavailable ? '恢复上架，使其重新参与搜索匹配' : '标记下架，搜索商品时不再匹配此订单'}
                        >
                          {togglingId === order.id
                            ? '处理中...'
                            : order.unavailable
                              ? '恢复上架'
                              : '标记下架'}
                        </button>
                      )}
                      {!manageMode && (
                        <button
                          onClick={(e) => {
                            e.stopPropagation()
                            handleDeleteSingle(order.id)
                          }}
                          className="text-sm text-gray-400 hover:text-red-500 transition-colors"
                          title="删除此订单"
                        >
                          删除
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>

          {!activeSearch && totalPages > 1 && (
            <div className="flex items-center justify-center gap-2 mt-6">
              <button
                onClick={() => setPage(Math.max(1, page - 1))}
                disabled={page <= 1}
                className="px-3 py-1.5 text-sm rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                上一页
              </button>
              <span className="text-sm text-gray-500 px-2">
                {page} / {totalPages}
              </span>
              <button
                onClick={() => setPage(Math.min(totalPages, page + 1))}
                disabled={page >= totalPages}
                className="px-3 py-1.5 text-sm rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                下一页
              </button>
            </div>
          )}
        </>
      )}
    </div>
  )
}
