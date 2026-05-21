import { useState, useEffect, useRef, useCallback } from 'react'
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

interface Task {
  id: number
  status: string
  instruction: string
  parsedItems: string
  paymentMode?: string
  createdAt: string
  startedAt: string | null
  completedAt: string | null
  error: string | null
  itemResults?: string | null
  progress?: string | null
  progressLog?: string[]
}

interface ShoppingAssistantPanelProps {
  preview: TaskPreview | null
  activeTaskId: number | null
  tasks: Task[]
  onConfirm: (instruction: string, items: PreviewItem[], dryRun?: boolean, paymentMode?: string) => Promise<void>
  onCancelPreview: () => void
  onUpdateItem: (index: number, updates: Partial<PreviewItem>) => void
  onRemoveItem: (index: number) => void
  onClose: () => void
  onConfirmAction: () => Promise<boolean>
  onRejectAction: () => Promise<boolean>
  onReopenWindow: () => Promise<boolean>
  onRetryItem: (taskId: number, itemName: string) => Promise<void>
  onCancelTask: (taskId: number) => void
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

const paymentModeLabels: Record<string, { label: string; icon: string; desc: string }> = {
  auto_pay: { label: '自动支付', icon: '💳', desc: '免密支付，超限时需手动确认' },
  checkout_only: { label: '确认金额后支付', icon: '📋', desc: '每次需手动确认金额并付款' },
  cart_only: { label: '仅加购', icon: '🛒', desc: '只加入购物车，不结算' },
}

type ErrorCategory = 'out_of_stock' | 'login_expired' | 'not_supported' | 'network_error' | 'no_history' | 'other'

function categorizeError(error?: string): ErrorCategory {
  if (!error) return 'other'
  if (error.includes('商品不可购买') || error.includes('已下架') || error.includes('商品已下架') || error.includes('已售罄') || error.includes('商品不存在') || error.includes('宝贝不存在') || error.includes('已卖完') || error.includes('已失效') || error.includes('缺货') || error.includes('无法购买')) return 'out_of_stock'
  if (error.includes('登录已过期') || error.includes('未登录') || error.includes('请重新登录') || error.includes('身份验证')) return 'login_expired'
  if (error.includes('不支持再买一单') || error.includes('未找到再买一单') || error.includes('不支持再买') || error.includes('未找到再买一单入口') || error.includes('未开通"再买一单"') || error.includes('未开通再买一单') || error.includes('未开通"再买一单"功能')) return 'not_supported'
  if (error.includes('Timeout') || error.includes('timeout') || error.includes('超时') || error.includes('网络') || error.includes('ERR_') || error.includes('net::')) return 'network_error'
  if (error.includes('未找到历史订单') || error.includes('没有历史')) return 'no_history'
  return 'other'
}

const errorRetryable: Record<ErrorCategory, boolean> = {
  out_of_stock: false,
  login_expired: true,
  not_supported: false,
  network_error: true,
  no_history: true,
  other: true,
}

interface SearchResult {
  title: string
  price: number
  imageUrl?: string
  url: string
  shopName?: string
}

function cleanLogTags(msg: string): string {
  return msg
    .replace(/\|REOPEN:(.+?)\|(.+?)\|REOPEN_END\|/g, '$2')
    .replace(/\|LINK:(.+?)\|(.+?)\|LINK_END\|/g, '$2')
    .replace(/\|SCENE:(verification|add-to-cart|payment)\|/g, '')
}

function renderLogWithLinks(
  msg: string | undefined,
  _onReopenWindow: () => Promise<boolean>,
  onOpenUrl: (url: string) => Promise<void>,
) {
  if (!msg || typeof msg !== 'string') return ''
  const cleaned = msg.replace(/\|REOPEN:(.+?)\|(.+?)\|REOPEN_END\|/g, '$2').replace(/\|SCENE:(verification|add-to-cart|payment)\|/g, '')

  const parts: (string | { url: string; text: string })[] = []
  const linkRegex = /\|LINK:(.+?)\|(.+?)\|LINK_END\|/g
  let lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = linkRegex.exec(cleaned)) !== null) {
    if (match.index > lastIndex) {
      parts.push(cleaned.substring(lastIndex, match.index))
    }
    parts.push({ url: match[1], text: match[2] })
    lastIndex = match.index + match[0].length
  }
  if (lastIndex < cleaned.length) {
    parts.push(cleaned.substring(lastIndex))
  }

  if (parts.length === 0) return cleaned

  return (
    <>
      {parts.map((part, i) => {
        if (typeof part === 'string') return part
        return (
          <button
            key={i}
            onClick={(e) => { e.stopPropagation(); onOpenUrl(part.url) }}
            className="text-blue-500 hover:text-blue-700 underline underline-offset-2"
          >
            {part.text}
          </button>
        )
      })}
    </>
  )
}

function deduplicateLogs(logs: string[]): { originalIndex: number }[] {
  const result: { originalIndex: number }[] = []
  for (let i = 0; i < logs.length; i++) {
    result.push({ originalIndex: i })
  }
  return result
}

type PanelMode = 'preview' | 'progress'

export default function ShoppingAssistantPanel({
  preview,
  activeTaskId,
  tasks,
  onConfirm,
  onCancelPreview,
  onUpdateItem,
  onRemoveItem,
  onClose,
  onConfirmAction,
  onRejectAction,
  onReopenWindow,
  onRetryItem,
}: ShoppingAssistantPanelProps) {
  const [closing, setClosing] = useState(false)
  const [paymentMode, setPaymentMode] = useState<string>('cart_only')
  const [showPaymentMode, setShowPaymentMode] = useState(false)
  const [dryRun, setDryRun] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [confirmActionStatus, setConfirmActionStatus] = useState<'idle' | 'loading' | 'success' | 'failed'>('idle')
  const [retryingItem, setRetryingItem] = useState<string | null>(null)
  const [tick, setTick] = useState(0)
  const [candidatesMap, setCandidatesMap] = useState<Record<number, SearchResult[]>>({})
  const [originalPriceMap, setOriginalPriceMap] = useState<Record<number, number>>({})
  const [orderIdMap, setOrderIdMap] = useState<Record<number, number>>({})
  const [confirmingPurchase, setConfirmingPurchase] = useState<number | null>(null)
  const [openingUrl, setOpeningUrl] = useState<string | null>(null)
  const [openedUrl, setOpenedUrl] = useState<string | null>(null)
  const [excludingOrderId, setExcludingOrderId] = useState<number | null>(null)
  const [expandedItems, setExpandedItems] = useState<Set<number>>(new Set())
  const [editingIndex, setEditingIndex] = useState<number | null>(null)
  const [editQuantity, setEditQuantity] = useState<number>(1)
  const logRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    api.getSetting('payment_mode').then((mode) => {
      if (mode && typeof mode === 'string') {
        setPaymentMode(mode)
      }
    })
  }, [])

  const activeTask = activeTaskId ? tasks.find(t => t.id === activeTaskId) : null
  const mode: PanelMode = preview ? 'preview' : 'progress'

  const hasPendingConfirmation = activeTask?.status === 'running' &&
    Array.isArray(activeTask?.progressLog) &&
    activeTask.progressLog.some(msg => typeof msg === 'string' && msg.includes('|REOPEN:')) === true

  useEffect(() => {
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight
    }
  }, [activeTask?.progressLog])

  useEffect(() => {
    if (preview && preview.items.length > 0) {
      const highAmbiguityIndices = new Set<number>()
      preview.items.forEach((item, index) => {
        if (item.ambiguityLevel === 'high' && item.candidates && item.candidates.length > 1) {
          highAmbiguityIndices.add(index)
        }
      })
      setExpandedItems(highAmbiguityIndices)
    }
  }, [preview])

  useEffect(() => {
    if (hasPendingConfirmation && confirmActionStatus !== 'idle') {
      setConfirmActionStatus('idle')
    }
  }, [hasPendingConfirmation])

  const handleClose = () => {
    setClosing(true)
    setTimeout(() => {
      setClosing(false)
      onClose()
    }, 250)
  }

  const handleRetry = async (itemName: string) => {
    if (!activeTaskId) return
    setRetryingItem(itemName)
    try {
      await onRetryItem(activeTaskId, itemName)
    } finally {
      setRetryingItem(null)
    }
  }

  const handleRetryAllFailed = async () => {
    if (!activeTaskId || !activeTask) return
    let itemResults: { name: string; status: string; error?: string }[] = []
    try {
      if (activeTask.itemResults) itemResults = JSON.parse(activeTask.itemResults)
    } catch { /* ignore */ }
    const failedItems = itemResults.filter(r => r.status === 'failed' && errorRetryable[categorizeError(r.error)])
    for (const item of failedItems) {
      setRetryingItem(item.name)
      try {
        await onRetryItem(activeTaskId, item.name)
        break
      } finally {
        setRetryingItem(null)
      }
    }
  }

  const loadCandidates = useCallback(async (confirmationId: number) => {
    if (candidatesMap[confirmationId]) return
    try {
      const result = await api.getPendingConfirmationById(confirmationId) as any
      if (result) {
        let candidates: SearchResult[] = []
        try { candidates = JSON.parse(result.candidates) } catch { /* ignore */ }
        setCandidatesMap(prev => ({ ...prev, [confirmationId]: candidates }))
        if (result.originalPrice && result.originalPrice > 0) {
          setOriginalPriceMap(prev => ({ ...prev, [confirmationId]: result.originalPrice }))
        }
        if (result.orderId) {
          setOrderIdMap(prev => ({ ...prev, [confirmationId]: result.orderId }))
        }
      }
    } catch { /* ignore */ }
  }, [candidatesMap])

  const handlePurchaseCandidate = async (confirmationId: number, candidate: SearchResult) => {
    if (!activeTask) return
    setOpeningUrl(candidate.url)
    try {
      const taskPaymentMode = activeTask.paymentMode || 'auto_pay'
      const result = await api.purchaseCandidate(confirmationId, candidate.url, {
        platform: 'taobao',
        productName: candidate.title,
        price: candidate.price,
        imageUrl: candidate.imageUrl,
        productUrl: candidate.url,
        shopName: candidate.shopName,
      }, taskPaymentMode) as { success: boolean; stage?: string; error?: string; autoPurchaseFailed?: string }
      if (result.success) {
        if (result.stage === 'auto_pay' || result.stage === 'cart_only') {
          setCandidatesMap(prev => {
            const next = { ...prev }
            delete next[confirmationId]
            return next
          })
        } else {
          setOpenedUrl(candidate.url)
        }
      }
    } catch (e) {
      console.error('打开商品页面失败:', e)
    } finally {
      setOpeningUrl(null)
    }
  }

  const handleConfirmPurchase = async (confirmationId: number, candidate: SearchResult) => {
    setConfirmingPurchase(confirmationId)
    try {
      await api.confirmPurchaseFromSearch(confirmationId, {
        platform: 'taobao',
        productName: candidate.title,
        price: candidate.price,
        imageUrl: candidate.imageUrl,
        productUrl: candidate.url,
        shopName: candidate.shopName,
      })
      setCandidatesMap(prev => {
        const next = { ...prev }
        delete next[confirmationId]
        return next
      })
    } finally {
      setConfirmingPurchase(null)
    }
  }

  const handleExcludeOrder = async (confirmationId: number, orderId: number) => {
    setExcludingOrderId(orderId)
    try {
      await api.markOrderUnavailable(orderId)
    } finally {
      setExcludingOrderId(null)
    }
  }

  const handleBatchIgnoreOutOfStock = async (items: { pendingConfirmationId?: number }[]) => {
    for (const item of items) {
      if (item.pendingConfirmationId) {
        try {
          await api.dismissPendingConfirmation(item.pendingConfirmationId)
        } catch { /* ignore */ }
      }
    }
    setCandidatesMap(prev => {
      const next = { ...prev }
      items.forEach(item => {
        if (item.pendingConfirmationId) delete next[item.pendingConfirmationId]
      })
      return next
    })
  }

  useEffect(() => {
    if (!activeTask?.itemResults) return
    let results: { status: string; pendingConfirmationId?: number }[] = []
    try { results = JSON.parse(activeTask.itemResults) } catch { return }
    for (const item of results) {
      if ((item.status === 'failed' || item.status === 'pending') && item.pendingConfirmationId) {
        loadCandidates(item.pendingConfirmationId)
      }
    }
  }, [activeTask?.itemResults, loadCandidates])

  useEffect(() => {
    if (mode !== 'progress' || !activeTask || (activeTask.status !== 'running' && activeTask.status !== 'partial')) return
    const timer = setInterval(() => setTick(t => t + 1), 1000)
    return () => clearInterval(timer)
  }, [mode, activeTask?.status])

  const handleConfirm = async () => {
    if (!preview) return
    const matchedItems = preview.items.filter(i => i.matched)
    if (matchedItems.length === 0) return
    setConfirming(true)
    console.log('[ShoppingAssistantPanel] handleConfirm START', { matchedCount: matchedItems.length, paymentMode, dryRun })
    try {
      await onConfirm(preview.instruction, preview.items, dryRun, paymentMode)
      console.log('[ShoppingAssistantPanel] handleConfirm SUCCESS')
    } catch (e) {
      console.error('[ShoppingAssistantPanel] handleConfirm ERROR:', e)
      setConfirming(false)
    }
  }

  const handleConfirmActionClick = async () => {
    setConfirmActionStatus('loading')
    try {
      const result = await onConfirmAction()
      setConfirmActionStatus(result ? 'success' : 'failed')
    } catch {
      setConfirmActionStatus('failed')
    }
  }

  const handleRejectActionClick = async () => {
    setConfirmActionStatus('loading')
    try {
      const result = await onRejectAction()
      setConfirmActionStatus(result ? 'success' : 'failed')
    } catch {
      setConfirmActionStatus('failed')
    }
  }

  const handleReopenWindowClick = async () => {
    try {
      await onReopenWindow()
    } catch { /* ignore */ }
  }

  const handleOpenUrl = async (url: string) => {
    try {
      const { api } = await import('../lib/api')
      await api.openInteractionWindow(url)
    } catch { /* ignore */ }
  }

  const toggleExpand = (index: number) => {
    setExpandedItems(prev => {
      const next = new Set(prev)
      if (next.has(index)) next.delete(index)
      else next.add(index)
      return next
    })
  }

  const renderPreviewContent = () => {
    if (!preview) return null

    const matchedItems = preview.items.filter(i => i.matched)
    const unmatchedItems = preview.items.filter(i => !i.matched)
    const matchedCount = matchedItems.length
    const unmatchedCount = unmatchedItems.length
    const totalPrice = matchedItems
      .filter(i => i.lastPrice !== undefined)
      .reduce((sum, i) => sum + (i.lastPrice || 0) * i.quantity, 0)
    const platformsInPreview = [...new Set(matchedItems.filter(i => i.platform).map(i => i.platform!))]

    const renderItem = (item: PreviewItem, index: number) => {
      const methodInfo = item.matchMethod ? matchMethodLabels[item.matchMethod] : null
      const platformInfo = getPlatformInfo(item.platform)
      const isEditing = editingIndex === index
      const isExpanded = expandedItems.has(index)
      const candidates = item.candidates || []
      const hasCandidates = candidates.length > 1
      const ambiguityLevel = item.ambiguityLevel || 'none'
      const visibleCandidates = isExpanded ? candidates : candidates.slice(0, 5)
      const hasMore = candidates.length > 5
      const totalCount = item.totalMatchCount || candidates.length

      return (
        <div
          key={index}
          className={`rounded-lg border p-3 transition-colors ${
            item.matched
              ? ambiguityLevel === 'high' && hasCandidates
                ? 'border-amber-200 bg-amber-50/30'
                : 'border-green-200 bg-green-50/40'
              : 'border-red-200 bg-red-50/40'
          }`}
        >
          <div className="flex items-start gap-3">
            {item.imageUrl && (
              <img
                src={item.imageUrl}
                alt={item.name}
                className="w-10 h-10 rounded-md object-cover flex-shrink-0 border border-gray-100"
                onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }}
              />
            )}
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <span className={`text-sm ${item.matched ? 'text-green-600' : 'text-red-500'}`}>
                  {item.matched ? '✓' : '✗'}
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
                  <p className="text-sm font-medium text-gray-900 truncate">{item.matchedProduct}</p>
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
                      <span className="text-xs text-gray-500">上次 ¥{item.lastPrice.toFixed(2)}</span>
                    )}
                  </div>
                  {hasCandidates && (
                    <div className="mt-2">
                      {ambiguityLevel === 'high' && (
                        <span className="text-xs text-amber-600 font-medium">⚠️ 存在多个不同匹配，请确认选择</span>
                      )}
                      {ambiguityLevel === 'low' && !isExpanded && (
                        <button onClick={() => toggleExpand(index)} className="text-xs text-blue-500 hover:text-blue-600 mb-1.5">
                          ▼ 还有 {candidates.length - 1} 个可选订单
                        </button>
                      )}
                      <div className="space-y-1 mt-1">
                        <p className="text-xs text-gray-400">共匹配到 {totalCount} 条订单，点击可切换：</p>
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
                                  matched: true, matchedProduct: candidate.productName,
                                  matchMethod: 'exact', lastPrice: candidate.price,
                                  imageUrl: candidate.imageUrl, orderRef: candidate.id,
                                  name: candidate.productName, platform: candidate.platform,
                                })
                              }}
                              className={`w-full text-left px-2 py-1.5 rounded-md transition-colors flex items-center gap-2 ${
                                isSelected ? 'bg-blue-50 border border-blue-200' : 'bg-white border border-gray-100 hover:border-blue-200 hover:bg-blue-50/50'
                              }`}
                            >
                              {candidate.imageUrl && (
                                <img src={candidate.imageUrl} alt="" className="w-6 h-6 rounded object-cover flex-shrink-0"
                                  onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }} />
                              )}
                              <div className="min-w-0 flex-1">
                                <p className={`text-xs font-medium truncate ${isSelected ? 'text-blue-700' : 'text-gray-800'}`}>
                                  {candidate.productName}
                                </p>
                                <div className="flex items-center gap-2 mt-0.5">
                                  {candidate.price > 0 && <span className="text-xs text-gray-400">¥{candidate.price.toFixed(2)}</span>}
                                  {candidatePlatformInfo && (
                                    <span className={`inline-flex items-center gap-0.5 px-1 py-0.5 rounded text-xs font-medium ${candidatePlatformInfo.bg} ${candidatePlatformInfo.color}`}>
                                      {candidatePlatformInfo.icon} {candidatePlatformInfo.label}
                                    </span>
                                  )}
                                  {dateStr && <span className="text-xs text-gray-300">{dateStr}</span>}
                                </div>
                              </div>
                              {isSelected && <span className="text-xs text-blue-500 flex-shrink-0">✓</span>}
                            </button>
                          )
                        })}
                        {hasMore && (
                          <button onClick={() => toggleExpand(index)} className="text-xs text-blue-500 hover:text-blue-600 w-full text-center py-1">
                            {isExpanded ? '收起' : `查看全部 ${candidates.length} 条订单`}
                          </button>
                        )}
                      </div>
                    </div>
                  )}
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
                  <button onClick={() => { onUpdateItem(editingIndex, { quantity: editQuantity }); setEditingIndex(null) }}
                    className="px-2 py-1 text-xs font-medium text-green-600 bg-green-50 rounded-md hover:bg-green-100 transition-colors">保存</button>
                  <button onClick={() => setEditingIndex(null)}
                    className="px-2 py-1 text-xs font-medium text-gray-500 bg-gray-50 rounded-md hover:bg-gray-100 transition-colors">取消</button>
                </>
              ) : (
                <>
                  <button onClick={() => { setEditQuantity(item.quantity); setEditingIndex(index) }}
                    className="px-2 py-1 text-xs font-medium text-blue-600 bg-blue-50 rounded-md hover:bg-blue-100 transition-colors">修改</button>
                  <button onClick={() => onRemoveItem(index)}
                    className="px-2 py-1 text-xs font-medium text-red-500 bg-red-50 rounded-md hover:bg-red-100 transition-colors">删除</button>
                </>
              )}
            </div>
          </div>
        </div>
      )
    }

    return (
      <div className="flex-1 overflow-y-auto p-5 space-y-4">
        <div>
          <button onClick={() => setShowPaymentMode(!showPaymentMode)}
            className="flex items-center gap-2 text-sm font-medium text-gray-600 hover:text-gray-800 transition-colors">
            <span>支付模式：{paymentModeLabels[paymentMode]?.icon} {paymentModeLabels[paymentMode]?.label}</span>
            <svg className={`w-3.5 h-3.5 transition-transform ${showPaymentMode ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
            </svg>
          </button>
          {showPaymentMode && (
            <div className="grid grid-cols-3 gap-2 mt-2">
              {Object.entries(paymentModeLabels).map(([key, info]) => (
                <div key={key} onClick={() => setPaymentMode(key)}
                  className={`px-2 py-2 rounded-lg border-2 cursor-pointer transition-all ${
                    paymentMode === key
                      ? key === 'auto_pay' ? 'border-blue-500 bg-blue-50' : key === 'checkout_only' ? 'border-amber-500 bg-amber-50' : 'border-green-500 bg-green-50'
                      : 'border-gray-200 bg-white hover:border-gray-300'
                  }`}>
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

        <div className="px-5 py-2 bg-gray-50 border-t border-gray-100 flex-shrink-0">
          <div className="flex items-center justify-between">
            <span className="text-sm text-gray-500">已匹配商品预计总金额</span>
            <span className="text-base font-semibold text-gray-900">¥{totalPrice.toFixed(2)}</span>
          </div>
        </div>

        <div className="flex items-center justify-between pt-2">
          <div className="flex items-center gap-3">
            <button onClick={onCancelPreview} disabled={confirming}
              className="px-3 py-1.5 text-sm font-medium text-gray-600 bg-white border border-gray-200 rounded-lg hover:bg-gray-50 transition-colors">
              取消
            </button>
            <label className="flex items-center gap-1.5 cursor-pointer">
              <input type="checkbox" checked={dryRun} onChange={(e) => setDryRun(e.target.checked)}
                className="w-3.5 h-3.5 text-blue-600 border-gray-300 rounded focus:ring-blue-500" />
              <span className="text-xs text-gray-500">测试模式</span>
            </label>
          </div>
          <button onClick={handleConfirm} disabled={confirming || matchedCount === 0}
            className={`px-5 py-2 text-sm font-medium rounded-lg transition-colors ${
              dryRun
                ? 'text-amber-700 bg-amber-100 hover:bg-amber-200'
                : paymentMode === 'cart_only'
                  ? 'text-green-700 bg-green-100 hover:bg-green-200'
                  : 'text-white bg-blue-600 hover:bg-blue-700'
            }`}>
            {confirming ? '执行中...' : dryRun ? `模拟购买${unmatchedCount > 0 ? `（${matchedCount}项）` : ''}` : paymentMode === 'cart_only' ? `加入购物车${unmatchedCount > 0 ? `（${matchedCount}项）` : ''}` : `确认购买${unmatchedCount > 0 ? `（${matchedCount}项）` : ''}`}
          </button>
        </div>
      </div>
    )
  }

  const renderProgressContent = () => {
    if (!activeTask) {
      return (
        <div className="flex-1 flex items-center justify-center text-gray-400">
          <div className="text-center">
            <p className="text-sm">任务数据加载中...</p>
          </div>
        </div>
      )
    }

    const safeProgressLog = Array.isArray(activeTask.progressLog) ? activeTask.progressLog : []
    const safeItemResults = (() => {
      try {
        if (activeTask.itemResults) return JSON.parse(activeTask.itemResults)
      } catch { /* ignore */ }
      return []
    })()

    const isRunning = activeTask.status === 'running'
    const isTerminal = ['success', 'failed', 'cancelled'].includes(activeTask.status)
    const hasProgressLog = safeProgressLog.length > 0
    const isWindowClosed = hasPendingConfirmation && hasProgressLog &&
      safeProgressLog.some(msg => typeof msg === 'string' && msg.includes('操作窗口已关闭'))

    const sceneFromLog = (() => {
      if (!hasProgressLog) return 'add-to-cart' as const
      const reversedLog = [...safeProgressLog].reverse()
      const sceneMsg = reversedLog.find(msg => typeof msg === 'string' && msg.includes('|SCENE:'))
      if (sceneMsg && typeof sceneMsg === 'string') {
        const sceneMatch = sceneMsg.match(/\|SCENE:(verification|add-to-cart|payment)\|/)
        if (sceneMatch) return sceneMatch[1] as 'verification' | 'add-to-cart' | 'payment'
      }
      const closedMsg = reversedLog.find(msg => typeof msg === 'string' && msg.includes('操作窗口已关闭'))
      if (closedMsg && typeof closedMsg === 'string') {
        if (closedMsg.includes('结算/支付')) return 'payment' as const
      }
      return 'add-to-cart' as const
    })()

    const sceneLabels: Record<string, { noun: string; action: string; reopenBtn: string; confirmBtn: string; failBtn: string; closedTitle: string; closedHint: string; openTitle: string; openHint: string }> = {
      'verification': {
        noun: '验证',
        action: '完成验证',
        reopenBtn: '🪟 重新打开验证窗口',
        confirmBtn: '✓ 我已完成验证',
        failBtn: '✗ 无法完成验证',
        closedTitle: '验证窗口已关闭',
        closedHint: '如需继续验证，请点击"重新打开验证窗口"；如无法完成验证，请点击"无法完成验证"取消当前任务',
        openTitle: '请在弹出的窗口中完成验证',
        openHint: '系统已打开验证窗口，请在窗口中拖动滑块完成验证后点击下方按钮继续',
      },
      'add-to-cart': {
        noun: '购买',
        action: '完成购买',
        reopenBtn: '🪟 重新打开商品页面',
        confirmBtn: '✓ 我已完成购买',
        failBtn: '✗ 商品无法购买',
        closedTitle: '商品页面已关闭',
        closedHint: '如需继续购买，请点击"重新打开商品页面"；如商品无法购买，请点击"商品无法购买"取消当前任务',
        openTitle: '请在弹出的窗口中选择规格并购买',
        openHint: '系统已打开商品页面，请在窗口中选择规格并加入购物车后点击下方按钮继续',
      },
      'payment': {
        noun: '支付',
        action: '完成支付',
        reopenBtn: '🪟 重新打开支付页面',
        confirmBtn: '✓ 我已完成支付',
        failBtn: '✗ 支付遇到问题',
        closedTitle: '支付页面已关闭',
        closedHint: '如需继续支付，请点击"重新打开支付页面"；如支付遇到问题，请点击"支付遇到问题"取消当前任务',
        openTitle: '请在弹出的窗口中完成支付',
        openHint: '系统已打开支付页面，请在窗口中确认金额并完成支付后点击下方按钮继续',
      },
    }
    const labels = sceneLabels[sceneFromLog]

    let itemResults: { name: string; quantity: number; status: string; error?: string; pendingConfirmationId?: number; currentPrice?: number; lastPrice?: number }[] = safeItemResults

    const successCount = itemResults.filter(r => r.status === 'success').length
    const failedCount = itemResults.filter(r => r.status === 'failed').length
    const pendingCount = itemResults.filter(r => r.status === 'pending').length

    const outOfStockItems = itemResults.filter(r =>
      (r.status === 'failed' || r.status === 'pending') && r.pendingConfirmationId
    )

    return (
      <div className="flex-1 overflow-y-auto p-5 space-y-4">
        {hasPendingConfirmation && (
          <div className="p-3 rounded-lg bg-amber-50 border border-amber-200">
            {isWindowClosed ? (
              <>
                <div className="flex items-center gap-2 mb-2">
                  <span className="text-base">🪟</span>
                  <span className="text-sm font-semibold text-amber-700">{labels.closedTitle}</span>
                </div>
                <p className="text-sm text-amber-600 mb-2">{labels.closedHint}</p>
              </>
            ) : (
              <>
                <div className="flex items-center gap-2 mb-2">
                  <span className="text-base">⏸️</span>
                  <span className="text-sm font-semibold text-amber-700">{labels.openTitle}</span>
                </div>
                <p className="text-sm text-amber-600 mb-2">{labels.openHint}</p>
              </>
            )}
            {confirmActionStatus === 'success' && (
              <div className="flex items-start gap-2 mb-2 p-2 bg-green-50 rounded-md border border-green-200">
                <span className="text-sm">✅</span>
                <div>
                  <p className="text-sm font-medium text-green-600">操作已确认</p>
                  <p className="text-xs text-green-500 mt-0.5">系统正在继续执行，请稍候...</p>
                </div>
              </div>
            )}
            {confirmActionStatus === 'failed' && (
              <div className="flex items-start gap-2 mb-2 p-2 bg-red-50 rounded-md border border-red-200">
                <span className="text-sm">⚠️</span>
                <div>
                  <p className="text-sm font-medium text-red-600">{labels.action}未生效</p>
                  <p className="text-xs text-red-500 mt-0.5">操作会话可能已过期，请点击"{labels.failBtn.replace(/^[✗✘❌]\s*/, '')}"取消当前任务后重新下单</p>
                </div>
              </div>
            )}
            <div className="flex items-center gap-2">
              {isWindowClosed && (
                <button onClick={handleReopenWindowClick} disabled={confirmActionStatus === 'loading'}
                  className="px-3 py-1.5 text-sm font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700 transition-colors">
                  {labels.reopenBtn}
                </button>
              )}
              <button onClick={handleConfirmActionClick} disabled={confirmActionStatus !== 'idle'}
                className="px-3 py-1.5 text-sm font-medium text-white bg-green-600 rounded-lg hover:bg-green-700 transition-colors">
                {confirmActionStatus === 'loading' ? (
                  <span className="flex items-center gap-1.5">
                    <span className="w-3 h-3 border-2 border-white border-t-transparent rounded-full animate-spin" />
                    处理中...
                  </span>
                ) : confirmActionStatus === 'success' ? '✅ 已确认' : labels.confirmBtn}
              </button>
              <button onClick={handleRejectActionClick} disabled={confirmActionStatus === 'loading' || confirmActionStatus === 'success'}
                className="px-3 py-1.5 text-sm font-medium text-white bg-red-500 rounded-lg hover:bg-red-600 transition-colors">
                {labels.failBtn}
              </button>
            </div>
          </div>
        )}

        <div className="bg-gray-50 rounded-lg p-3">
          <p className="text-sm font-medium text-gray-700 mb-1">📋 {activeTask.instruction}</p>
          <div className="flex items-center gap-2 text-xs text-gray-400">
            <span className={`px-2 py-0.5 rounded-full font-medium ${
              activeTask.status === 'running' ? 'bg-blue-100 text-blue-700' :
              activeTask.status === 'success' ? 'bg-green-100 text-green-700' :
              activeTask.status === 'failed' ? 'bg-red-100 text-red-700' :
              activeTask.status === 'partial' ? 'bg-amber-100 text-amber-700' :
              'bg-gray-100 text-gray-600'
            }`}>
              {activeTask.status === 'running' ? '执行中' :
               activeTask.status === 'success' ? '已完成' :
               activeTask.status === 'failed' ? '失败' :
               activeTask.status === 'partial' ? '待处理' :
               activeTask.status === 'cancelled' ? '已取消' : activeTask.status}
            </span>
            {isRunning && activeTask.startedAt && (
              <span className="text-blue-500 font-mono">
                已执行 {Math.floor((Date.now() - new Date(activeTask.startedAt).getTime()) / 1000)} 秒
              </span>
            )}
          </div>
        </div>

        {isRunning && (
            <button
              onClick={() => {
                if (confirm('确定要停止当前任务吗？')) {
                  onCancelTask(activeTask.id)
                }
              }}
              className="px-3 py-1.5 text-sm font-medium text-white bg-red-600 rounded-lg hover:bg-red-700 transition-colors"
            >
              停止任务
            </button>
        )}
        {activeTask.status === 'partial' && (
          <button
            onClick={() => onCancelTask(activeTask.id)}
            className="px-3 py-1.5 text-sm font-medium text-gray-500 bg-gray-50 rounded-lg hover:bg-gray-100 hover:text-red-600 transition-colors"
          >
            放弃待处理项
          </button>
        )}

        {hasProgressLog && (
          <div>
            <p className="text-sm font-medium text-gray-500 mb-2">执行过程</p>
            <div ref={logRef} className="max-h-64 overflow-y-auto rounded-lg bg-gray-50 border border-gray-100 px-3 py-2 space-y-1 scroll-smooth">
              {deduplicateLogs(safeProgressLog).map((entry, idx) => (
                <div key={idx} className="flex items-start gap-2">
                  <span className="text-xs text-gray-300 flex-shrink-0 mt-0.5 font-mono">
                    {String(idx + 1).padStart(2, '0')}
                  </span>
                  <span className="text-sm leading-relaxed text-gray-600">
                    {renderLogWithLinks(safeProgressLog[entry.originalIndex], onReopenWindow, handleOpenUrl)}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {itemResults.length > 0 && (
          <div>
            <p className="text-sm font-medium text-gray-500 mb-2">商品结果</p>
            {outOfStockItems.length > 0 && (
              <div className="mb-2">
                <button
                  onClick={() => handleBatchIgnoreOutOfStock(outOfStockItems)}
                  className="px-3 py-1.5 text-sm font-medium text-gray-500 bg-gray-50 rounded-lg hover:bg-gray-100 hover:text-gray-700 transition-colors"
                >
                  忽略所有缺货商品，继续购买其余项
                </button>
              </div>
            )}
            <div className="space-y-1.5">
              {itemResults.map((item, i) => {
                const errCat = item.status === 'failed' ? categorizeError(item.error) : null
                const retryable = errCat ? errorRetryable[errCat] : false
                const candidates = item.pendingConfirmationId ? candidatesMap[item.pendingConfirmationId] : undefined
                return (
                  <div key={i}>
                    <div className={`flex items-center gap-2 px-3 py-2 rounded-lg text-sm ${
                      item.status === 'success' ? 'bg-green-50 text-green-700' :
                      item.status === 'pending' ? 'bg-amber-50 text-amber-600' :
                      'bg-red-50 text-red-600'
                    }`}>
                      <span>{item.status === 'success' ? '✓' : item.status === 'pending' ? '⏳' : '✗'}</span>
                      <span className="truncate flex-1">{item.name} x{item.quantity}</span>
                      {item.status === 'pending' && item.currentPrice && item.currentPrice > 0 && item.lastPrice && item.lastPrice > 0 && (
                        <span className="text-xs text-amber-500 flex-shrink-0">
                          ¥{item.currentPrice.toFixed(2)}
                          {(() => {
                            const diff = item.currentPrice! - item.lastPrice!
                            const pct = Math.abs(diff / item.lastPrice! * 100)
                            if (Math.abs(diff) < 0.01) return null
                            return diff > 0
                              ? <span className="text-red-400 ml-1">↑{pct.toFixed(0)}%</span>
                              : <span className="text-green-500 ml-1">↓{pct.toFixed(0)}%</span>
                          })()}
                        </span>
                      )}
                      {item.error && <span className="text-xs text-gray-400 truncate max-w-[120px]" title={item.error}>{item.error}</span>}
                      {item.status === 'failed' && retryable && (
                        <button
                          onClick={() => handleRetry(item.name)}
                          disabled={retryingItem === item.name || activeTask?.status === 'running'}
                          className="flex-shrink-0 px-2 py-0.5 text-xs font-medium text-blue-600 bg-blue-50 rounded hover:bg-blue-100 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                          {retryingItem === item.name ? '重试中...' : '重试'}
                        </button>
                      )}
                      {item.status === 'failed' && errCat === 'out_of_stock' && item.pendingConfirmationId && orderIdMap[item.pendingConfirmationId] && (
                        <button
                          onClick={() => handleExcludeOrder(item.pendingConfirmationId!, orderIdMap[item.pendingConfirmationId!])}
                          disabled={excludingOrderId === orderIdMap[item.pendingConfirmationId!]}
                          className="flex-shrink-0 px-2 py-0.5 text-xs font-medium text-gray-500 bg-gray-50 rounded hover:bg-gray-100 hover:text-gray-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                          title="忽略此商品，后续搜索时不再匹配"
                        >
                          {excludingOrderId === orderIdMap[item.pendingConfirmationId!] ? '处理中...' : '忽略'}
                        </button>
                      )}
                    </div>

                    {(item.status === 'failed' || item.status === 'pending') && candidates && candidates.length > 0 && (
                      <div className="mt-2 ml-4">
                        <div className="flex items-center gap-2 mb-2">
                          <p className="text-sm font-medium text-orange-600">找到 {candidates.length} 个替代商品，请选择：</p>
                          {item.pendingConfirmationId && originalPriceMap[item.pendingConfirmationId] && originalPriceMap[item.pendingConfirmationId] > 0 && (
                            <span className="text-sm text-gray-400">原价 ¥{originalPriceMap[item.pendingConfirmationId].toFixed(2)}</span>
                          )}
                          <button
                            onClick={async () => {
                              if (item.pendingConfirmationId) {
                                try { await api.dismissPendingConfirmation(item.pendingConfirmationId) } catch { /* ignore */ }
                                setCandidatesMap(prev => {
                                  const next = { ...prev }
                                  delete next[item.pendingConfirmationId!]
                                  return next
                                })
                              }
                            }}
                            className="ml-auto px-2.5 py-0.5 text-xs font-medium text-gray-400 bg-gray-50 rounded hover:bg-gray-100 hover:text-gray-600 transition-colors"
                          >
                            不想买了
                          </button>
                        </div>
                        <div className="space-y-2 max-h-72 overflow-y-auto">
                          {candidates.map((c, ci) => {
                            const isOpening = openingUrl === c.url
                            const isOpened = openedUrl === c.url
                            return (
                              <div key={ci} className={`flex gap-3 p-2.5 bg-white rounded-lg border transition-colors ${
                                isOpened ? 'border-blue-300 bg-blue-50/30' :
                                'border-orange-100 hover:border-orange-300'
                              }`}>
                                {c.imageUrl && (
                                  <img src={c.imageUrl} alt={c.title} className="w-14 h-14 object-cover rounded-md flex-shrink-0" />
                                )}
                                <div className="flex-1 min-w-0">
                                  <p className="text-sm font-medium text-gray-800 truncate" title={c.title}>{c.title}</p>
                                  <div className="flex items-center gap-2 mt-0.5">
                                    <span className="text-sm font-bold text-red-500">¥{c.price.toFixed(2)}</span>
                                    {item.pendingConfirmationId && originalPriceMap[item.pendingConfirmationId] && originalPriceMap[item.pendingConfirmationId] > 0 && (() => {
                                      const origPrice = originalPriceMap[item.pendingConfirmationId!]
                                      const diff = c.price - origPrice
                                      const pct = Math.abs(diff / origPrice * 100)
                                      if (Math.abs(diff) < 0.01) return <span className="text-sm text-green-500 font-medium">价格相同</span>
                                      return diff > 0
                                        ? <span className="text-sm text-red-400 font-medium">↑ ¥{diff.toFixed(2)}（贵 {pct.toFixed(0)}%）</span>
                                          : <span className="text-sm text-green-500 font-medium">↓ ¥{Math.abs(diff).toFixed(2)}（省 {pct.toFixed(0)}%）</span>
                                    })()}
                                    {c.shopName && <span className="text-sm text-gray-400 truncate">{c.shopName}</span>}
                                  </div>
                                  {!isOpened && (
                                    <div className="mt-1.5">
                                      <button
                                        onClick={() => handlePurchaseCandidate(item.pendingConfirmationId!, c)}
                                        disabled={isOpening}
                                        className="px-3 py-1 text-sm font-medium text-white bg-orange-500 rounded hover:bg-orange-600 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                                      >
                                        {isOpening ? '正在打开...' : '选择购买'}
                                      </button>
                                    </div>
                                  )}
                                  {isOpened && (
                                    <div className="mt-1.5 space-y-1.5">
                                      <p className="text-sm text-blue-600 font-medium">已打开商品页面，请在弹出的窗口中选择规格并购买</p>
                                      <div className="flex items-center gap-2">
                                        <button
                                          onClick={() => handleConfirmPurchase(item.pendingConfirmationId!, c)}
                                          disabled={confirmingPurchase === item.pendingConfirmationId}
                                          className="px-3 py-1 text-sm font-medium text-white bg-green-500 rounded hover:bg-green-600 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                                        >
                                          {confirmingPurchase === item.pendingConfirmationId ? '处理中...' : '加入历史订单'}
                                        </button>
                                      </div>
                                    </div>
                                  )}
                                </div>
                              </div>
                            )
                          })}
                        </div>
                      </div>
                    )}

                    {(item.status === 'failed' || item.status === 'pending') && item.pendingConfirmationId && candidates && candidates.length === 0 && (
                      <div className="mt-2 ml-4 p-2.5 bg-gray-50 rounded-lg flex items-center justify-between">
                        <p className="text-sm text-gray-500">未找到替代商品，请手动搜索购买</p>
                        <button
                          onClick={async () => {
                            if (item.pendingConfirmationId) {
                              try { await api.dismissPendingConfirmation(item.pendingConfirmationId) } catch { /* ignore */ }
                              setCandidatesMap(prev => {
                                const next = { ...prev }
                                delete next[item.pendingConfirmationId!]
                                return next
                              })
                            }
                          }}
                          className="px-2.5 py-0.5 text-xs font-medium text-gray-400 bg-white rounded hover:bg-gray-100 hover:text-gray-600 transition-colors"
                        >
                          不想买了
                        </button>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
            {(successCount > 0 || failedCount > 0 || pendingCount > 0) && (
              <p className="text-sm text-gray-400 mt-2">
                {successCount > 0 && <span className="text-green-600">{successCount} 项成功</span>}
                {successCount > 0 && (failedCount > 0 || pendingCount > 0) && <span className="mx-1">·</span>}
                {pendingCount > 0 && <span className="text-amber-500">{pendingCount} 项待选择</span>}
                {pendingCount > 0 && failedCount > 0 && <span className="mx-1">·</span>}
                {failedCount > 0 && <span className="text-red-500">{failedCount} 项失败</span>}
              </p>
            )}
          </div>
        )}

        {isTerminal && (
          <div className="pt-2 space-y-2">
            {failedCount > 0 && (() => {
              const retryableFailed = itemResults.filter(r => r.status === 'failed' && errorRetryable[categorizeError(r.error)])
              return retryableFailed.length > 0 ? (
                <button
                  onClick={handleRetryAllFailed}
                  disabled={retryingItem !== null}
                  className="w-full px-4 py-2 text-sm font-medium text-blue-600 bg-blue-50 rounded-lg hover:bg-blue-100 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {retryingItem ? `正在重试 ${retryingItem}...` : `重试失败项（${retryableFailed.length} 项可重试）`}
                </button>
              ) : null
            })()}
            <button onClick={handleClose}
              className="w-full px-4 py-2 text-sm font-medium text-gray-600 bg-gray-100 rounded-lg hover:bg-gray-200 transition-colors">
              关闭面板
            </button>
          </div>
        )}
      </div>
    )
  }

  const headerConfig = mode === 'preview'
    ? { icon: '🔍', title: '解析结果', color: 'blue' }
    : activeTask?.status === 'success'
      ? { icon: '✅', title: '购买结果', color: 'green' }
      : activeTask?.status === 'failed'
        ? { icon: '❌', title: '购买结果', color: 'red' }
        : { icon: '🛒', title: '购买进度', color: 'blue' }

  return (
    <>
      <div className="fixed inset-0 bg-black/20 z-40 animate-fade-in-backdrop" />
      <div
        className={`fixed top-0 right-0 h-full w-[480px] max-w-[90vw] bg-white shadow-2xl z-50 flex flex-col ${
          closing ? 'animate-slide-out-right' : 'animate-slide-in-right'
        }`}
      >
        <div className={`px-5 py-3 border-b flex items-center justify-between flex-shrink-0 ${
          headerConfig.color === 'blue' ? 'bg-blue-50 border-blue-100' :
          headerConfig.color === 'green' ? 'bg-green-50 border-green-100' :
          'bg-red-50 border-red-100'
        }`}>
          <div className="flex items-center gap-2">
            <span className={`${headerConfig.color === 'blue' ? 'text-blue-500' : headerConfig.color === 'green' ? 'text-green-500' : 'text-red-500'} text-lg`}>
              {headerConfig.icon}
            </span>
            <h3 className={`text-base font-semibold ${
              headerConfig.color === 'blue' ? 'text-blue-800' : headerConfig.color === 'green' ? 'text-green-800' : 'text-red-800'
            }`}>
              {headerConfig.title}
            </h3>
            {mode === 'preview' && preview && (
              <div className="flex items-center gap-1.5 text-sm ml-2">
                {preview.items.filter(i => i.matched).length > 0 && (
                  <span className="px-2 py-0.5 rounded-full bg-green-100 text-green-700 font-medium text-xs">
                    {preview.items.filter(i => i.matched).length} 项匹配
                  </span>
                )}
                {preview.items.filter(i => !i.matched).length > 0 && (
                  <span className="px-2 py-0.5 rounded-full bg-red-100 text-red-700 font-medium text-xs">
                    {preview.items.filter(i => !i.matched).length} 项未匹配
                  </span>
                )}
              </div>
            )}
          </div>
          <button onClick={handleClose} className="text-gray-400 hover:text-gray-600 transition-colors p-1">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {mode === 'preview' && preview && (
          <div className="px-5 py-2 border-b border-gray-100 bg-gray-50/50 flex-shrink-0">
            <div className="flex items-center gap-2">
              <p className="text-sm text-blue-600">指令：{preview.instruction}</p>
              {[...new Set(preview.items.filter(i => i.matched && i.platform).map(i => i.platform!))].length > 0 && (
                <div className="flex items-center gap-1">
                  <span className="text-sm text-blue-400">|</span>
                  {[...new Set(preview.items.filter(i => i.matched && i.platform).map(i => i.platform!))].map(p => {
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
        )}

        {mode === 'preview' ? renderPreviewContent() : renderProgressContent()}
      </div>
    </>
  )
}
