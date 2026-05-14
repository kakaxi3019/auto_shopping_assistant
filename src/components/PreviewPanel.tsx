import { useState } from 'react'
import { api } from '../lib/api'

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
}

interface TaskPreview {
  instruction: string
  items: PreviewItem[]
  platform: string
}

interface PreviewPanelProps {
  preview: TaskPreview
  onConfirm: (instruction: string, items: PreviewItem[], dryRun?: boolean) => Promise<void>
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

export default function PreviewPanel({ preview, onConfirm, onCancel, onUpdateItem, onRemoveItem }: PreviewPanelProps) {
  const [confirming, setConfirming] = useState(false)
  const [editingIndex, setEditingIndex] = useState<number | null>(null)
  const [searching, setSearching] = useState(false)
  const [searchResults, setSearchResults] = useState<OrderOption[]>([])
  const [editQuantity, setEditQuantity] = useState<number>(1)
  const [showSearchModal, setShowSearchModal] = useState(false)
  const [dryRun, setDryRun] = useState(false)

  const matchedCount = preview.items.filter(i => i.matched).length
  const unmatchedCount = preview.items.filter(i => !i.matched).length
  const totalPrice = preview.items
    .filter(i => i.matched && i.lastPrice !== undefined)
    .reduce((sum, i) => sum + (i.lastPrice || 0) * i.quantity, 0)

  const platformsInPreview = [...new Set(preview.items.filter(i => i.matched && i.platform).map(i => i.platform!))]

  const handleConfirm = async () => {
    const matchedItems = preview.items.filter(i => i.matched)
    if (matchedItems.length === 0) return

    setConfirming(true)
    try {
      await onConfirm(preview.instruction, preview.items, dryRun)
    } catch {
      setConfirming(false)
    }
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

  return (
    <div className="bg-white rounded-xl border border-blue-200 shadow-sm overflow-hidden">
      <div className="bg-blue-50 px-5 py-3 border-b border-blue-100">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="text-blue-500 text-lg">🔍</span>
            <h3 className="text-sm font-semibold text-blue-800">解析结果</h3>
          </div>
          <div className="flex items-center gap-2 text-xs">
            {matchedCount > 0 && (
              <span className="px-2 py-0.5 rounded-full bg-green-100 text-green-700 font-medium">
                {matchedCount} 项匹配
              </span>
            )}
            {unmatchedCount > 0 && (
              <span className="px-2 py-0.5 rounded-full bg-red-100 text-red-700 font-medium">
                {unmatchedCount} 项未匹配
              </span>
            )}
          </div>
        </div>
        <div className="flex items-center gap-3 mt-1">
          <p className="text-xs text-blue-600">指令：{preview.instruction}</p>
          {platformsInPreview.length > 0 && (
            <div className="flex items-center gap-1">
              <span className="text-xs text-blue-400">|</span>
              <span className="text-xs text-blue-500">购买平台：</span>
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

      <div className="p-5 space-y-3">
        {preview.items.map((item, index) => {
          const methodInfo = item.matchMethod ? matchMethodLabels[item.matchMethod] : null
          const platformInfo = getPlatformInfo(item.platform)
          const isEditing = editingIndex === index

          return (
            <div
              key={index}
              className={`rounded-lg border p-4 transition-colors ${
                item.matched
                  ? 'border-green-200 bg-green-50/40'
                  : 'border-red-200 bg-red-50/40'
              }`}
            >
              <div className="flex items-start gap-3">
                {item.imageUrl && (
                  <img
                    src={item.imageUrl}
                    alt={item.name}
                    className="w-12 h-12 rounded-md object-cover flex-shrink-0 border border-gray-100"
                    onError={(e) => {
                      (e.target as HTMLImageElement).style.display = 'none'
                    }}
                  />
                )}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className={`text-sm ${item.matched ? 'text-green-600' : 'text-red-500'}`}>
                      {item.matched ? '✓' : '✗'}
                    </span>
                    {isEditing ? (
                      <div className="flex items-center gap-1">
                        <span className="text-xs text-gray-400">数量:</span>
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
                      <span className="text-xs text-gray-400">x{item.quantity}</span>
                    )}
                  </div>

                  {item.matched ? (
                    <div className="mt-1">
                      <p className="text-sm font-medium text-gray-900 truncate">
                        {item.matchedProduct}
                      </p>
                      <div className="flex items-center flex-wrap gap-2 mt-1">
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
                            上次价格: ¥{item.lastPrice.toFixed(2)}
                          </span>
                        )}
                      </div>
                    </div>
                  ) : (
                    <div className="mt-1">
                      <p className="text-sm font-medium text-gray-900">{item.name}</p>
                      <p className="text-xs text-red-500 mt-0.5">未找到匹配的历史订单</p>
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
                      className="px-3 py-1.5 text-xs font-medium text-blue-600 bg-blue-50 rounded-md hover:bg-blue-100 transition-colors disabled:opacity-50"
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
                              <p className="text-xs font-medium text-gray-900 truncate">{order.productName}</p>
                              <div className="flex items-center gap-2">
                                {order.price > 0 && (
                                  <span className="text-xs text-gray-400">¥{order.price.toFixed(2)}</span>
                                )}
                                {orderPlatformInfo && (
                                  <span className={`inline-flex items-center gap-0.5 px-1 py-0.5 rounded text-[10px] font-medium ${orderPlatformInfo.bg} ${orderPlatformInfo.color}`}>
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
        })}

        {preview.items.length === 0 && (
          <div className="text-center py-6 text-gray-400">
            <p className="text-sm">未解析出任何商品</p>
          </div>
        )}
      </div>

      {totalPrice > 0 && (
        <div className="px-5 py-2 bg-gray-50 border-t border-gray-100">
          <div className="flex items-center justify-between">
            <span className="text-xs text-gray-500">已匹配商品预计总金额</span>
            <span className="text-sm font-semibold text-gray-900">¥{totalPrice.toFixed(2)}</span>
          </div>
        </div>
      )}

      <div className="px-5 py-4 bg-gray-50 border-t border-gray-100 flex items-center justify-between">
        <div className="flex items-center gap-4">
          <button
            onClick={onCancel}
            disabled={confirming}
            className="px-4 py-2 text-sm font-medium text-gray-600 bg-white border border-gray-200 rounded-lg hover:bg-gray-50 transition-colors disabled:opacity-50"
          >
            取消
          </button>
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={dryRun}
              onChange={(e) => setDryRun(e.target.checked)}
              className="w-4 h-4 text-blue-600 border-gray-300 rounded focus:ring-blue-500"
            />
            <span className="text-sm text-gray-600">测试模式（跳过支付）</span>
          </label>
        </div>
        <button
          onClick={handleConfirm}
          disabled={confirming || matchedCount === 0}
          className={`px-6 py-2 text-sm font-medium rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
            dryRun
              ? 'text-amber-700 bg-amber-100 hover:bg-amber-200'
              : 'text-white bg-blue-600 hover:bg-blue-700'
          }`}
        >
          {confirming ? '执行中...' : dryRun ? `模拟购买${unmatchedCount > 0 ? `（${matchedCount}项）` : ''}` : `确认购买${unmatchedCount > 0 ? `（${matchedCount}项）` : ''}`}
        </button>
      </div>
    </div>
  )
}
