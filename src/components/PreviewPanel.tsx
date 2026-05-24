import { useState, useEffect, useRef } from 'react'
import { api } from '../lib/api'

type AmbiguityLevel = 'none' | 'low' | 'high'

interface CandidateOrder {
  id: number
  productName: string
  price: number
  imageUrl: string
  platform: string
  purchasedAt: string
  shopName: string
  matchScore?: number
}

interface PreviewItem {
  name: string
  quantity: number
  sku?: string
  orderRef?: number
  matched: boolean
  matchedProduct?: string
  matchMethod?: 'llm_direct' | 'exact' | 'fuzzy'
  lastPrice?: number
  imageUrl?: string
  platform?: string
  candidates?: CandidateOrder[]
  ambiguityLevel?: AmbiguityLevel
  totalMatchCount?: number
}

interface TaskPreview {
  instruction: string
  items: PreviewItem[]
  platform: string
}

interface PreviewPanelProps {
  preview: TaskPreview
  onConfirm: (instruction: string, items: PreviewItem[], dryRun?: boolean, paymentMode?: string, platform?: string) => Promise<void>
  onCancel: () => void
  onUpdateItem: (index: number, updates: Partial<PreviewItem>) => void
  onRemoveItem: (index: number) => void
}

const matchMethodLabels: Record<string, { label: string; color: string; bg: string }> = {
  llm_direct: { label: '智能匹配', color: 'text-blue-600', bg: 'bg-blue-50' },
  exact: { label: '精确匹配', color: 'text-green-600', bg: 'bg-green-50' },
  fuzzy: { label: '模糊匹配', color: 'text-amber-600', bg: 'bg-amber-50' },
}

const platformLabels: Record<string, { label: string; icon: string; color: string; bg: string }> = {
  taobao: { label: '淘宝', icon: '🛒', color: 'text-orange-600', bg: 'bg-orange-50' },
  jd: { label: '京东', icon: '📦', color: 'text-red-600', bg: 'bg-red-50' },
  pdd: { label: '拼多多', icon: '🏷️', color: 'text-pink-600', bg: 'bg-pink-50' },
}

function getPlatformInfo(platform?: string) {
  if (!platform) return null
  return platformLabels[platform] || { label: platform, icon: '🏪', color: 'text-gray-600', bg: 'bg-gray-50' }
}

interface OrderOption {
  id: number
  productName: string
  price: number
  imageUrl: string
  platform: string
}

const DEFAULT_VISIBLE_COUNT = 5

export default function PreviewPanel({ preview, onConfirm, onCancel, onUpdateItem, onRemoveItem }: PreviewPanelProps) {
  const [confirming, setConfirming] = useState(false)
  const [editingIndex, setEditingIndex] = useState<number | null>(null)
  const [searching, setSearching] = useState(false)
  const [searchResults, setSearchResults] = useState<OrderOption[]>([])
  const [editQuantity, setEditQuantity] = useState<number>(1)
  const [dryRun, setDryRun] = useState(false)
  const [paymentMode, setPaymentMode] = useState<string>('cart_only')
  const [showOrderSearch, setShowOrderSearch] = useState(false)
  const [expandedItems, setExpandedItems] = useState<Set<number>>(new Set())
  const [showPaymentMode, setShowPaymentMode] = useState(false)
  const [closing, setClosing] = useState(false)

  useEffect(() => {
    api.getSetting('payment_mode').then((mode) => {
      if (mode && typeof mode === 'string') {
        setPaymentMode(mode)
      }
    })
  }, [])

  useEffect(() => {
    if (preview.items.length > 0) {
      const highAmbiguityIndices = new Set<number>()
      preview.items.forEach((item, index) => {
        if (item.ambiguityLevel === 'high' && item.candidates && item.candidates.length > 1) {
          highAmbiguityIndices.add(index)
        }
      })
      setExpandedItems(highAmbiguityIndices)
    }
  }, [preview.items])

  const toggleExpand = (index: number) => {
    setExpandedItems(prev => {
      const next = new Set(prev)
      if (next.has(index)) {
        next.delete(index)
      } else {
        next.add(index)
      }
      return next
    })
  }

  const matchedItems = preview.items.filter(i => i.matched)
  const unmatchedItems = preview.items.filter(i => !i.matched)
  const matchedCount = matchedItems.length
  const unmatchedCount = unmatchedItems.length
  const totalPrice = matchedItems
    .filter(i => i.lastPrice !== undefined)
    .reduce((sum, i) => sum + (i.lastPrice || 0) * i.quantity, 0)

  const platformsInPreview = [...new Set(matchedItems.filter(i => i.platform).map(i => i.platform!))]

  const handleConfirm = async () => {
    if (matchedCount === 0) return
    setConfirming(true)
    try {
      await onConfirm(preview.instruction, preview.items, dryRun, paymentMode, preview.platform)
    } catch {
      setConfirming(false)
    }
  }

  const handleCancel = () => {
    setClosing(true)
    setTimeout(() => {
      setClosing(false)
      onCancel()
    }, 250)
  }

  const handleSearchOrders = async (keyword: string) => {
    setSearching(true)
    try {
      const results = await api.searchOrders(keyword) as OrderOption[]
      setSearchResults(results)
    } catch {
      setSearchResults([])
    } finally {
      setSearching(false)
    }
  }

  const handleSelectOrder = (index: number, order: OrderOption) => {
    onUpdateItem(index, {
      matched: true,
      matchedProduct: order.productName,
      matchMethod: 'exact',
      lastPrice: order.price,
      imageUrl: order.imageUrl,
      orderRef: order.id,
      name: order.productName,
      platform: order.platform,
    })
    setSearchResults([])
    setShowOrderSearch(false)
  }

  const handleStartEdit = (index: number, openSearch = false) => {
    const item = preview.items[index]
    setEditQuantity(item.quantity)
    setEditingIndex(index)
    setSearchResults([])
    setShowOrderSearch(openSearch)
    if (openSearch) {
      handleSearchOrders(item.name)
    }
  }

  const handleSaveEdit = (index: number) => {
    onUpdateItem(index, { quantity: editQuantity })
    setEditingIndex(null)
    setShowOrderSearch(false)
    setSearchResults([])
  }

  const handleCancelEdit = () => {
    setEditingIndex(null)
    setShowOrderSearch(false)
    setSearchResults([])
  }

  const paymentModeLabels: Record<string, { label: string; icon: string; desc: string }> = {
    auto_pay: { label: '自动支付', icon: '💳', desc: '免密支付，超限时需手动确认' },
    checkout_only: { label: '确认金额后支付', icon: '📋', desc: '每次需手动确认金额并付款' },
    cart_only: { label: '仅加购', icon: '🛒', desc: '只加入购物车，不结算' },
  }

  const renderItem = (item: PreviewItem, index: number) => {
    const methodInfo = item.matchMethod ? matchMethodLabels[item.matchMethod] : null
    const platformInfo = getPlatformInfo(item.platform)
    const isEditing = editingIndex === index
    const isExpanded = expandedItems.has(index)
    const candidates = item.candidates || []
    const hasCandidates = candidates.length > 1
    const ambiguityLevel = item.ambiguityLevel || 'none'
    const visibleCandidates = isExpanded ? candidates : candidates.slice(0, DEFAULT_VISIBLE_COUNT)
    const hasMore = candidates.length > DEFAULT_VISIBLE_COUNT
    const totalCount = item.totalMatchCount || candidates.length

    return (
      <div
        key={index}
        className={`rounded-lg border p-3 transition-colors ${
          item.matched
            ? ambiguityLevel === 'high' && hasCandidates
              ? 'border-amber-200 bg-amber-50/30'
              : 'border-green-200 bg-green-50/40'
            : 'border-gray-200 bg-gray-50/40'
        }`}
      >
        <div className="flex items-start gap-3">
          {item.imageUrl && (
            <img
              src={item.imageUrl}
              alt={item.name}
              className="w-10 h-10 rounded-md object-cover flex-shrink-0 border border-gray-100"
              onError={(e) => {
                (e.target as HTMLImageElement).style.display = 'none'
              }}
            />
          )}
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <span className={`text-sm ${item.matched ? 'text-green-600' : 'text-gray-400'}`}>
                {item.matched ? '✓' : '○'}
              </span>
              {isEditing ? (
                <div className="flex items-center gap-1">
                  <span className="text-sm text-gray-400">数量:</span>
                  <input
                    type="number"
                    min={1}
                    max={99}
                    value={editQuantity}
                    onChange={(e) => setEditQuantity(Math.max(1, parseInt(e.target.value) || 1))}
                    className="w-16 px-2 py-1 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-1 focus:ring-blue-500"
                  />
                </div>
              ) : (
                <span className="text-sm text-gray-400">x{item.quantity}</span>
              )}
            </div>

            {item.matched ? (
              <div className="mt-1">
                <p className="text-sm font-medium text-gray-900 truncate">
                  {item.matchedProduct}
                </p>
                <div className="flex items-center flex-wrap gap-1.5 mt-1">
                  {platformInfo && (
                    <span className={`inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-xs font-medium ${platformInfo.bg} ${platformInfo.color}`}>
                      {platformInfo.icon} {platformInfo.label}
                    </span>
                  )}
                  {methodInfo && (
                    <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium ${methodInfo.bg} ${methodInfo.color}`}>
                      {methodInfo.label}
                    </span>
                  )}
                  {item.lastPrice !== undefined && item.lastPrice > 0 && (
                    <span className="text-xs text-gray-500">
                      上次 ¥{item.lastPrice.toFixed(2)}
                    </span>
                  )}
                </div>
                {hasCandidates && (
                  <div className="mt-2">
                    {ambiguityLevel === 'high' && (
                      <div className="flex items-center gap-1.5 mb-1.5">
                        <span className="text-xs text-amber-600 font-medium">⚠️ 存在多个不同匹配，请确认选择</span>
                      </div>
                    )}
                    {ambiguityLevel === 'low' && !isExpanded && (
                      <button
                        onClick={() => toggleExpand(index)}
                        className="text-xs text-blue-500 hover:text-blue-600 transition-colors mb-1.5"
                      >
                        ▼ 还有 {candidates.length - 1} 个可选订单
                      </button>
                    )}
                    {(ambiguityLevel === 'high' || ambiguityLevel === 'low' || isExpanded) && (
                      <div className="space-y-1">
                        <p className="text-xs text-gray-400">
                          共匹配到 {totalCount} 条订单{totalCount > candidates.length ? `，显示前 ${candidates.length} 条` : ''}，点击可切换：
                        </p>
                        {visibleCandidates.map((candidate) => {
                          const isSelected = candidate.id === item.orderRef
                          const candidatePlatformInfo = getPlatformInfo(candidate.platform)
                          const purchaseDate = candidate.purchasedAt ? new Date(candidate.purchasedAt.replace(' ', 'T')) : null
                          const dateStr = purchaseDate && !isNaN(purchaseDate.getTime())
                            ? `${purchaseDate.getFullYear()}/${purchaseDate.getMonth() + 1}/${purchaseDate.getDate()}`
                            : ''
                          return (
                            <button
                              key={candidate.id}
                              onClick={(e) => {
                                e.stopPropagation()
                                onUpdateItem(index, {
                                  matched: true,
                                  matchedProduct: candidate.productName,
                                  matchMethod: 'exact',
                                  lastPrice: candidate.price,
                                  imageUrl: candidate.imageUrl,
                                  orderRef: candidate.id,
                                  name: candidate.productName,
                                  platform: candidate.platform,
                                })
                              }}
                              className={`w-full text-left px-2 py-1.5 rounded-md transition-colors flex items-center gap-2 ${
                                isSelected
                                  ? 'bg-blue-50 border border-blue-200'
                                  : 'bg-white border border-gray-100 hover:border-blue-200 hover:bg-blue-50/50'
                              }`}
                            >
                              {candidate.imageUrl && (
                                <img
                                  src={candidate.imageUrl}
                                  alt=""
                                  className="w-6 h-6 rounded object-cover flex-shrink-0"
                                  onError={(e) => {
                                    (e.target as HTMLImageElement).style.display = 'none'
                                  }}
                                />
                              )}
                              <div className="min-w-0 flex-1">
                                <p className={`text-xs font-medium truncate ${isSelected ? 'text-blue-700' : 'text-gray-800'}`}>
                                  {candidate.productName}
                                </p>
                                <div className="flex items-center gap-2 mt-0.5">
                                  {candidate.price > 0 && (
                                    <span className="text-xs text-gray-400">¥{candidate.price.toFixed(2)}</span>
                                  )}
                                  {candidatePlatformInfo && (
                                    <span className={`inline-flex items-center gap-0.5 px-1 py-0.5 rounded text-xs font-medium ${candidatePlatformInfo.bg} ${candidatePlatformInfo.color}`}>
                                      {candidatePlatformInfo.icon} {candidatePlatformInfo.label}
                                    </span>
                                  )}
                                  {dateStr && (
                                    <span className="text-xs text-gray-300">{dateStr}</span>
                                  )}
                                  {candidate.shopName && (
                                    <span className="text-xs text-gray-300 truncate">{candidate.shopName}</span>
                                  )}
                                </div>
                              </div>
                              {isSelected && (
                                <span className="text-xs text-blue-500 flex-shrink-0">✓</span>
                              )}
                            </button>
                          )
                        })}
                        {hasMore && (
                          <button
                            onClick={() => toggleExpand(index)}
                            className="text-xs text-blue-500 hover:text-blue-600 transition-colors w-full text-center py-1"
                          >
                            {isExpanded ? '收起' : `查看全部 ${candidates.length} 条订单`}
                          </button>
                        )}
                        {ambiguityLevel === 'low' && isExpanded && (
                          <button
                            onClick={() => toggleExpand(index)}
                            className="text-xs text-gray-400 hover:text-gray-500 transition-colors w-full text-center py-1"
                          >
                            收起候选列表
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>
            ) : (
              <div className="mt-1">
                <p className="text-sm font-medium text-gray-900">{item.name}</p>
                <p className="text-xs text-gray-500 mt-0.5">该商品不在历史订单中，无法自动匹配复购</p>
                <button
                  onClick={async () => {
                    try {
                      const { api } = await import('../lib/api')
                      await api.openSearchInBrowser(item.name, preview?.platform)
                    } catch { /* ignore */ }
                  }}
                  className="mt-1.5 px-2.5 py-1 text-xs font-medium text-blue-600 bg-blue-50 rounded-md hover:bg-blue-100 transition-colors inline-flex items-center gap-1"
                >
                  🔍 去平台搜索购买
                </button>
              </div>
            )}
          </div>

          <div className="flex items-center gap-1 flex-shrink-0">
            {isEditing ? (
              <>
                <button
                  onClick={() => handleSaveEdit(index)}
                  className="px-2 py-1 text-xs font-medium text-green-600 bg-green-50 rounded-md hover:bg-green-100 transition-colors"
                >
                  保存
                </button>
                <button
                  onClick={handleCancelEdit}
                  className="px-2 py-1 text-xs font-medium text-gray-500 bg-gray-50 rounded-md hover:bg-gray-100 transition-colors"
                >
                  取消
                </button>
              </>
            ) : (
              <>
                <button
                  onClick={() => handleStartEdit(index)}
                  className="px-2 py-1 text-xs font-medium text-blue-600 bg-blue-50 rounded-md hover:bg-blue-100 transition-colors"
                  title="修改数量"
                >
                  修改
                </button>
                <button
                  onClick={() => handleStartEdit(index, true)}
                  className="px-2 py-1 text-xs font-medium text-purple-600 bg-purple-50 rounded-md hover:bg-purple-100 transition-colors"
                  title={item.matched ? '换一个匹配' : '从历史订单中选择'}
                >
                  {item.matched ? '换匹配' : '选择'}
                </button>
                <button
                  onClick={() => onRemoveItem(index)}
                  className="px-2 py-1 text-xs font-medium text-red-500 bg-red-50 rounded-md hover:bg-red-100 transition-colors"
                  title="删除此项"
                >
                  删除
                </button>
              </>
            )}
          </div>
        </div>

        {isEditing && showOrderSearch && (
          <div className="mt-3 border-t border-gray-200 pt-3">
            <p className="text-xs text-gray-500 mb-2">
              {item.matched ? '选择其他历史订单替换当前匹配：' : '从历史订单中选择：'}
            </p>
            <div className="flex gap-2 mb-2">
              <input
                type="text"
                defaultValue={item.name}
                placeholder="搜索历史订单..."
                className="flex-1 px-3 py-1.5 text-sm border border-gray-200 rounded-md focus:outline-none focus:ring-1 focus:ring-blue-500"
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    handleSearchOrders((e.target as HTMLInputElement).value)
                  }
                }}
              />
              <button
                onClick={(e) => {
                  const input = (e.target as HTMLElement).parentElement?.querySelector('input')
                  if (input) handleSearchOrders(input.value)
                }}
                disabled={searching}
                className="px-3 py-1.5 text-sm font-medium text-blue-600 bg-blue-50 rounded-md hover:bg-blue-100 transition-colors disabled:opacity-50"
              >
                {searching ? '搜索中...' : '搜索'}
              </button>
            </div>
            {searchResults.length > 0 && (
              <div className="max-h-40 overflow-y-auto space-y-1">
                {searchResults.map((order) => {
                  const orderPlatformInfo = getPlatformInfo(order.platform)
                  return (
                    <button
                      key={order.id}
                      onClick={() => handleSelectOrder(index, order)}
                      className="w-full text-left px-3 py-2 rounded-md hover:bg-blue-50 transition-colors flex items-center gap-2"
                    >
                      {order.imageUrl && (
                        <img
                          src={order.imageUrl}
                          alt=""
                          className="w-8 h-8 rounded object-cover flex-shrink-0"
                          onError={(e) => {
                            (e.target as HTMLImageElement).style.display = 'none'
                          }}
                        />
                      )}
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium text-gray-900 truncate">{order.productName}</p>
                        <div className="flex items-center gap-2">
                          {order.price > 0 && (
                            <span className="text-sm text-gray-400">¥{order.price.toFixed(2)}</span>
                          )}
                          {orderPlatformInfo && (
                            <span className={`inline-flex items-center gap-0.5 px-1 py-0.5 rounded text-xs font-medium ${orderPlatformInfo.bg} ${orderPlatformInfo.color}`}>
                              {orderPlatformInfo.icon} {orderPlatformInfo.label}
                            </span>
                          )}
                        </div>
                      </div>
                    </button>
                  )
                })}
              </div>
            )}
            {searchResults.length === 0 && !searching && (
              <p className="text-xs text-gray-400">输入关键词搜索历史订单</p>
            )}
          </div>
        )}
      </div>
    )
  }

  return (
    <>
      <div
        className="fixed inset-0 bg-black/20 z-40 animate-fade-in-backdrop pointer-events-none"
      />
      <div
        className={`fixed top-0 right-0 h-full w-[480px] max-w-[90vw] bg-white shadow-2xl z-50 flex flex-col ${
          closing ? 'animate-slide-out-right' : 'animate-slide-in-right'
        }`}
      >
        <div className="bg-blue-50 px-5 py-3 border-b border-blue-100 flex items-center justify-between flex-shrink-0">
          <div className="flex items-center gap-2">
            <span className="text-blue-500 text-lg">🔍</span>
            <h3 className="text-base font-semibold text-blue-800">解析结果</h3>
            <div className="flex items-center gap-1.5 text-sm ml-2">
              {matchedCount > 0 && (
                <span className="px-2 py-0.5 rounded-full bg-green-100 text-green-700 font-medium text-xs">
                  {matchedCount} 项匹配
                </span>
              )}
              {unmatchedCount > 0 && (
                <span className="px-2 py-0.5 rounded-full bg-red-100 text-red-700 font-medium text-xs">
                  {unmatchedCount} 项未匹配
                </span>
              )}
            </div>
          </div>
          <button
            onClick={handleCancel}
            className="text-gray-400 hover:text-gray-600 transition-colors p-1"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="px-5 py-2 border-b border-gray-100 bg-gray-50/50 flex-shrink-0">
          <div className="flex items-center gap-2">
            <p className="text-sm text-blue-600">指令：{preview.instruction}</p>
            {platformsInPreview.length > 0 && (
              <div className="flex items-center gap-1">
                <span className="text-sm text-blue-400">|</span>
                {platformsInPreview.map(p => {
                  const info = getPlatformInfo(p)
                  return info ? (
                    <span key={p} className={`inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-xs font-medium ${info.bg} ${info.color}`}>
                      {info.icon} {info.label}
                    </span>
                  ) : null
                })}
              </div>
            )}
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          <div>
            <button
              onClick={() => setShowPaymentMode(!showPaymentMode)}
              className="flex items-center gap-2 text-sm font-medium text-gray-600 hover:text-gray-800 transition-colors"
            >
              <span>支付模式：{paymentModeLabels[paymentMode]?.icon} {paymentModeLabels[paymentMode]?.label}</span>
              <svg
                className={`w-3.5 h-3.5 transition-transform ${showPaymentMode ? 'rotate-180' : ''}`}
                fill="none" stroke="currentColor" viewBox="0 0 24 24"
              >
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
              </svg>
            </button>
            {showPaymentMode && (
              <div className="grid grid-cols-3 gap-2 mt-2">
                {Object.entries(paymentModeLabels).map(([key, info]) => (
                  <div
                    key={key}
                    onClick={() => setPaymentMode(key)}
                    className={`px-2 py-2 rounded-lg border-2 cursor-pointer transition-all ${
                      paymentMode === key
                        ? key === 'auto_pay' ? 'border-blue-500 bg-blue-50' : key === 'checkout_only' ? 'border-amber-500 bg-amber-50' : 'border-green-500 bg-green-50'
                        : 'border-gray-200 bg-white hover:border-gray-300'
                    }`}
                  >
                    <div className="flex items-center gap-1.5">
                      <span className="text-xs">{info.icon}</span>
                      <span className={`text-xs font-medium ${paymentMode === key ? (key === 'auto_pay' ? 'text-blue-700' : key === 'checkout_only' ? 'text-amber-700' : 'text-green-700') : 'text-gray-700'}`}>
                        {info.label}
                      </span>
                    </div>
                    <p className={`text-xs mt-0.5 ${paymentMode === key ? (key === 'auto_pay' ? 'text-blue-500' : key === 'checkout_only' ? 'text-amber-500' : 'text-green-500') : 'text-gray-400'}`}>
                      {info.desc}
                    </p>
                  </div>
                ))}
              </div>
            )}
          </div>

          {matchedItems.length > 0 && (
            <div>
              <div className="flex items-center gap-2 mb-2">
                <span className="text-sm font-medium text-green-600">✅ 就绪可买</span>
                <span className="text-xs text-gray-400">({matchedItems.length}项)</span>
              </div>
              <div className="space-y-2">
                {preview.items.map((item, index) => item.matched ? renderItem(item, index) : null)}
              </div>
            </div>
          )}

          {unmatchedItems.length > 0 && (
            <div>
              <div className="flex items-center gap-2 mb-2">
                <span className="text-sm font-medium text-amber-600">⚠️ 需你确认/未匹配</span>
                <span className="text-xs text-gray-400">({unmatchedItems.length}项)</span>
              </div>
              <div className="space-y-2">
                {preview.items.map((item, index) => !item.matched ? renderItem(item, index) : null)}
              </div>
            </div>
          )}

          {preview.items.length === 0 && (
            <div className="text-center py-6 text-gray-400">
              <p className="text-sm">未解析出任何商品</p>
            </div>
          )}
        </div>

        {totalPrice > 0 && (
          <div className="px-5 py-2 bg-gray-50 border-t border-gray-100 flex-shrink-0">
            <div className="flex items-center justify-between">
              <span className="text-sm text-gray-500">已匹配商品预计总金额</span>
              <span className="text-base font-semibold text-gray-900">¥{totalPrice.toFixed(2)}</span>
            </div>
          </div>
        )}

        <div className="px-5 py-3 bg-gray-50 border-t border-gray-100 flex items-center justify-between flex-shrink-0">
          <div className="flex items-center gap-3">
            <button
              onClick={handleCancel}
              disabled={confirming}
              className="px-3 py-1.5 text-sm font-medium text-gray-600 bg-white border border-gray-200 rounded-lg hover:bg-gray-50 transition-colors disabled:opacity-50"
            >
              取消
            </button>
            <label className="flex items-center gap-1.5 cursor-pointer">
              <input
                type="checkbox"
                checked={dryRun}
                onChange={(e) => setDryRun(e.target.checked)}
                className="w-3.5 h-3.5 text-blue-600 border-gray-300 rounded focus:ring-blue-500"
              />
              <span className="text-xs text-gray-500">测试模式</span>
            </label>
          </div>
          <button
            onClick={handleConfirm}
            disabled={confirming || matchedCount === 0}
            className={`px-5 py-2 text-sm font-medium rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
              dryRun
                ? 'text-amber-700 bg-amber-100 hover:bg-amber-200'
                : paymentMode === 'cart_only'
                  ? 'text-green-700 bg-green-100 hover:bg-green-200'
                  : 'text-white bg-blue-600 hover:bg-blue-700'
            }`}
          >
            {confirming ? '执行中...' : dryRun ? `模拟购买${unmatchedCount > 0 ? `（${matchedCount}项）` : ''}` : paymentMode === 'cart_only' ? `加入购物车${unmatchedCount > 0 ? `（${matchedCount}项）` : ''}` : `确认购买${unmatchedCount > 0 ? `（${matchedCount}项）` : ''}`}
          </button>
        </div>
      </div>
    </>
  )
}
