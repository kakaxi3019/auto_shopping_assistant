import { useState, useEffect, useRef, useCallback } from 'react'
import { api } from '../lib/api'
import type { ItemResult } from '../../shared/types/task.types'

type ErrorCategory = 'out_of_stock' | 'login_expired' | 'not_supported' | 'network_error' | 'no_history' | 'price_anomaly' | 'other'

interface SearchResult {
  title: string
  url: string
  price: number
  imageUrl: string
  shopName?: string
  originalPrice?: number
}

interface TaskCardProps {
  task: {
    id: number
    status: string
    instruction: string
    parsedItems: string
    platform?: string
    paymentMode?: string
    createdAt: string
    startedAt: string | null
    completedAt: string | null
    error: string | null
    itemResults?: string | null
    progress?: string | null
    progressLog?: string[]
  }
  onCancel: (id: number) => void
  onRetryItem: (taskId: number, itemName: string) => Promise<void>
  onReExecute?: (task: { instruction: string; parsedItems: string; paymentMode?: string }) => void
  onDelete?: (id: number) => void
  recentlyCompleted?: boolean
  fadingOut?: boolean
  selectable?: boolean
  selected?: boolean
  onToggleSelect?: (id: number) => void
  onOpenPanel?: () => void
}

const statusConfig: Record<string, { label: string; color: string; bg: string; icon?: string }> = {
  pending: { label: '排队中', color: 'text-gray-500', bg: 'bg-gray-100', icon: '⏳' },
  running: { label: '执行中', color: 'text-blue-600', bg: 'bg-blue-50', icon: '▶' },
  success: { label: '成功', color: 'text-green-600', bg: 'bg-green-50' },
  failed: { label: '失败', color: 'text-red-600', bg: 'bg-red-50' },
  partial: { label: '待确认', color: 'text-amber-600', bg: 'bg-amber-50' },
  cancelled: { label: '已取消', color: 'text-gray-500', bg: 'bg-gray-50' },
}

const errorCategoryConfig: Record<ErrorCategory, { label: string; icon: string; bg: string; color: string; retryable: boolean; description?: string }> = {
  out_of_stock: { label: '商品不可购买', icon: '📦', bg: 'bg-orange-50', color: 'text-orange-600', retryable: false, description: '商品已下架、缺货或链接失效，将搜索替代商品' },
  login_expired: { label: '登录已过期', icon: '🔐', bg: 'bg-amber-50', color: 'text-amber-600', retryable: true, description: '请重新登录账号' },
  not_supported: { label: '未找到再买一单入口', icon: '🚫', bg: 'bg-gray-50', color: 'text-gray-500', retryable: false, description: '订单详情页未找到"再买一单"按钮，将搜索替代商品' },
  network_error: { label: '操作超时', icon: '🌐', bg: 'bg-blue-50', color: 'text-blue-600', retryable: true, description: '页面加载超时或网络异常，可重试' },
  no_history: { label: '未找到历史订单', icon: '🔍', bg: 'bg-purple-50', color: 'text-purple-600', retryable: true, description: '未在历史订单中找到匹配的商品' },
  price_anomaly: { label: '价格异常上涨', icon: '💰', bg: 'bg-red-50', color: 'text-red-600', retryable: false, description: '已拦截并转交人工处理，请在待确认清单中查看' },
  other: { label: '操作失败', icon: '❌', bg: 'bg-red-50', color: 'text-red-600', retryable: true, description: '页面结构变化或操作异常，可重试' },
}

function categorizeError(error?: string): ErrorCategory {
  if (!error) return 'other'
  if (error.includes('价格异常上涨') || error.includes('价格涨幅超限')) return 'price_anomaly'
  if (error.includes('商品不可购买') || error.includes('已下架') || error.includes('商品已下架') || error.includes('已售罄') || error.includes('商品不存在') || error.includes('宝贝不存在') || error.includes('已卖完') || error.includes('已失效') || error.includes('缺货') || error.includes('无法购买')) return 'out_of_stock'
  if (error.includes('登录已过期') || error.includes('未登录') || error.includes('请重新登录')) return 'login_expired'
  if (error.includes('不支持再买一单') || error.includes('未找到再买一单') || error.includes('不支持再买') || error.includes('未找到再买一单入口') || error.includes('未开通"再买一单"') || error.includes('未开通再买一单') || error.includes('未开通"再买一单"功能')) return 'not_supported'
  if (error.includes('Timeout') || error.includes('timeout') || error.includes('超时') || error.includes('网络') || error.includes('ERR_') || error.includes('net::')) return 'network_error'
  if (error.includes('未找到历史订单') || error.includes('没有历史')) return 'no_history'
  if (error.includes('身份验证')) return 'login_expired'
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

function cleanLogTags(msg: string): string {
  return msg
    .replace(/\|REOPEN:(.+?)\|(.+?)\|REOPEN_END\|/g, '$2')
    .replace(/\|LINK:(.+?)\|(.+?)\|LINK_END\|/g, '$2')
    .replace(/\|SCENE:(verification|add-to-cart|payment)\|/g, '')
}

function renderMsgWithLinks(msg: string | undefined) {
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

  const handleOpenWindow = async (e: React.MouseEvent, url: string) => {
    e.stopPropagation()
    try {
      const result = await api.openInteractionWindow(url) as any
      if (result && !result.success) {
        alert(result.error || '打开窗口失败')
      }
    } catch (e) {
      alert('打开窗口失败: ' + String(e))
    }
  }

  return (
    <>
      {parts.map((part, i) => {
        if (typeof part === 'string') return part
        return (
          <button
            key={i}
            onClick={(e) => handleOpenWindow(e, part.url)}
            className="text-blue-500 hover:text-blue-700 underline underline-offset-2"
          >
            {part.text}
          </button>
        )
      })}
    </>
  )
}

function ConfettiEffect() {
  const colors = ['#FF6B6B', '#4ECDC4', '#45B7D1', '#96CEB4', '#FFEAA7', '#DDA0DD', '#98D8C8', '#F7DC6F']
  const particles = Array.from({ length: 20 }, (_, i) => ({
    id: i,
    left: Math.random() * 100,
    delay: Math.random() * 0.8,
    color: colors[Math.floor(Math.random() * colors.length)],
    size: 4 + Math.random() * 6,
    rotation: Math.random() * 360,
  }))

  return (
    <div className="absolute inset-0 overflow-hidden pointer-events-none z-10">
      {particles.map(p => (
        <div
          key={p.id}
          className="absolute animate-confetti"
          style={{
            left: `${p.left}%`,
            top: '-10px',
            width: `${p.size}px`,
            height: `${p.size}px`,
            backgroundColor: p.color,
            borderRadius: Math.random() > 0.5 ? '50%' : '2px',
            animationDelay: `${p.delay}s`,
            transform: `rotate(${p.rotation}deg)`,
          }}
        />
      ))}
    </div>
  )
}

function deduplicateLogs(logs: string[]): { originalIndex: number }[] {
  const result: { originalIndex: number }[] = []
  for (let i = 0; i < logs.length; i++) {
    result.push({ originalIndex: i })
  }
  return result
}

export default function TaskCard({ task, onCancel, onRetryItem, onReExecute, onDelete, recentlyCompleted, fadingOut, selectable, selected, onToggleSelect, onOpenPanel }: TaskCardProps) {
  const [expanded, setExpanded] = useState(false)
  const [retryingItem, setRetryingItem] = useState<string | null>(null)
  const [candidatesMap, setCandidatesMap] = useState<Record<number, SearchResult[]>>({})
  const [originalPriceMap, setOriginalPriceMap] = useState<Record<number, number>>({})
  const [orderIdMap, setOrderIdMap] = useState<Record<number, number>>({})
  const [confirmingPurchase, setConfirmingPurchase] = useState<number | null>(null)
  const [excludingOrderId, setExcludingOrderId] = useState<number | null>(null)
  const [excludedOrderIds, setExcludedOrderIds] = useState<Set<number>>(new Set())
  const [showConfetti, setShowConfetti] = useState(false)
  const [shaking, setShaking] = useState(false)
  const [confirmingCancel, setConfirmingCancel] = useState(false)
  const logRef = useRef<HTMLDivElement>(null)
  const cardRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!task.itemResults) {
      setExcludedOrderIds(new Set())
      return
    }
    try {
      const results: ItemResult[] = JSON.parse(task.itemResults)
      const orderIds = results.filter(r => r.orderId).map(r => r.orderId!)
      if (orderIds.length === 0) {
        setExcludedOrderIds(new Set())
        return
      }
      api.getUnavailableOrderIds(orderIds).then((ids: unknown) => {
        setExcludedOrderIds(new Set(ids as number[]))
      })
    } catch {
      setExcludedOrderIds(new Set())
    }
  }, [task.itemResults])

  useEffect(() => {
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight
    }
  }, [task.progressLog])

  useEffect(() => {
    if (recentlyCompleted && task.status === 'success') {
      setShowConfetti(true)
      const timer = setTimeout(() => setShowConfetti(false), 2000)
      return () => clearTimeout(timer)
    }
    if (recentlyCompleted && (task.status === 'failed' || task.status === 'partial')) {
      setShaking(true)
      const timer = setTimeout(() => setShaking(false), 600)
      return () => clearTimeout(timer)
    }
  }, [recentlyCompleted, task.status])

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
  const pendingCount = itemResults.filter(r => r.status === 'pending').length
  const hasFailedItems = failedCount > 0

  const outOfStockItems = itemResults.filter(r =>
    r.status === 'failed' && categorizeError(r.error) === 'out_of_stock' && r.pendingConfirmationId
  )

  const excludableFailedItems = itemResults.filter(r =>
    r.status === 'failed' && !errorCategoryConfig[categorizeError(r.error)]?.retryable && r.orderId
  )

  const isRunning = task.status === 'running'
  let displayStatus = task.status
  const isQueued = isRunning && task.progress === '排队中，等待前一个任务完成...'
  if (isQueued) displayStatus = 'pending'

  const config = statusConfig[displayStatus] || statusConfig.pending
  const isTerminal = ['success', 'failed', 'cancelled', 'partial'].includes(displayStatus)
  const hasProgressLog = (task.progressLog?.length ?? 0) > 0
  const canExpand = hasResults || hasProgressLog || (parsedItems.length > 0 && isTerminal)

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

  useEffect(() => {
    for (const item of itemResults) {
      if ((item.status === 'failed' || item.status === 'pending') && item.pendingConfirmationId) {
        loadCandidates(item.pendingConfirmationId)
      }
    }
  }, [itemResults])

  const autoExpandedRef = useRef(false)

  useEffect(() => {
    if (autoExpandedRef.current) return
    const hasCandidates = Object.keys(candidatesMap).some(id => {
      const c = candidatesMap[Number(id)]
      return c && c.length > 0
    })
    if (hasCandidates && (task.status === 'running' || task.status === 'partial')) {
      autoExpandedRef.current = true
      if (!expanded) {
        setExpanded(true)
      }
    }
  }, [candidatesMap, task.status])

  const handleRetry = async (itemName: string) => {
    setRetryingItem(itemName)
    try {
      await onRetryItem(task.id, itemName)
    } finally {
      setRetryingItem(null)
    }
  }

  const [openedUrl, setOpenedUrl] = useState<string | null>(null)
  const [openingUrl, setOpeningUrl] = useState<string | null>(null)

  const handleConfirmPurchase = async (confirmationId: number, candidate: SearchResult) => {
    setConfirmingPurchase(confirmationId)
    try {
      await api.confirmPurchaseFromSearch(confirmationId, {
        platform: task.platform || 'taobao',
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

  const handlePurchaseCandidate = async (confirmationId: number, candidate: SearchResult) => {
    setOpeningUrl(candidate.url)
    try {
      const taskPaymentMode = task.paymentMode || 'auto_pay'
      const result = await api.purchaseCandidate(confirmationId, candidate.url, {
        platform: task.platform || 'taobao',
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

  const handleExcludeOrder = async (confirmationId: number, orderId: number) => {
    if (!orderId) return
    setExcludingOrderId(orderId)
    setExcludedOrderIds(prev => new Set(prev).add(orderId))
    try {
      await api.markOrderUnavailable(orderId)
    } catch {
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
    } catch {
      setExcludedOrderIds(prev => new Set(prev).add(orderId))
    } finally {
      setExcludingOrderId(null)
    }
  }

  const handleBatchExcludeOrders = async () => {
    for (const item of excludableFailedItems) {
      if (item.orderId && !excludedOrderIds.has(item.orderId)) {
        try {
          await api.markOrderUnavailable(item.orderId)
          setExcludedOrderIds(prev => new Set(prev).add(item.orderId!))
        } catch { /* ignore */ }
      }
      if (item.pendingConfirmationId) {
        try {
          await api.dismissPendingConfirmation(item.pendingConfirmationId)
        } catch { /* ignore */ }
      }
    }
    setCandidatesMap(prev => {
      const next = { ...prev }
      excludableFailedItems.forEach(item => {
        if (item.pendingConfirmationId) delete next[item.pendingConfirmationId]
      })
      return next
    })
  }

  const [confirmingPayment, setConfirmingPayment] = useState<string | null>(null)

  const handleConfirmPayment = async (itemName: string) => {
    setConfirmingPayment(itemName)
    try {
      await api.confirmPayment(task.id, itemName)
    } finally {
      setConfirmingPayment(null)
    }
  }

  const hasPendingConfirmation = isRunning && task.progressLog?.some(msg => msg.includes('|REOPEN:')) === true
  const isWindowClosed = hasPendingConfirmation && (task.progressLog?.some(msg => msg.includes('操作窗口已关闭')) === true)
  const [elapsed, setElapsed] = useState(() => {
    if (!isRunning || !task.startedAt) return 0
    return Math.floor((Date.now() - new Date(task.startedAt).getTime()) / 1000)
  })

  useEffect(() => {
    if (!isRunning) return
    const timer = setInterval(() => setElapsed(e => e + 1), 1000)
    return () => clearInterval(timer)
  }, [isRunning])

  const formatElapsed = (seconds: number) => {
    if (seconds < 60) return `${seconds} 秒`
    const m = Math.floor(seconds / 60)
    const s = seconds % 60
    return `${m} 分 ${s} 秒`
  }

  const isCartOnly = task.paymentMode === 'cart_only'

  const progressSteps = isCartOnly
    ? [
        { key: 'find', label: '查找订单', match: (msg: string) => msg.includes('查找') || msg.includes('匹配') || msg.includes('LLM') },
        { key: 'cart', label: '加入购物车', match: (msg: string) => msg.includes('加购') || msg.includes('购物车') || msg.includes('加入') || msg.includes('再买一单') || msg.includes('规格') || msg.includes('SKU') || msg.includes('sku') },
      ]
    : [
        { key: 'find', label: '查找订单', match: (msg: string) => msg.includes('查找') || msg.includes('匹配') || msg.includes('LLM') },
        { key: 'rebuy', label: '再买一单', match: (msg: string) => msg.includes('再买一单') || msg.includes('执行再买') },
        { key: 'sku', label: '选择规格', match: (msg: string) => msg.includes('规格') || msg.includes('SKU') || msg.includes('sku') },
        { key: 'buy', label: '提交订单', match: (msg: string) => msg.includes('结算') || msg.includes('提交') || msg.includes('购买') },
        { key: 'pay', label: '完成支付', match: (msg: string) => msg.includes('支付') || msg.includes('付款') || msg.includes('购买完成') },
      ]

  const currentStepIndex = (() => {
    if (!task.progressLog || task.progressLog.length === 0) return 0
    for (let i = task.progressLog.length - 1; i >= 0; i--) {
      const msg = task.progressLog[i]
      for (let s = progressSteps.length - 1; s >= 0; s--) {
        if (progressSteps[s].match(msg)) return s
      }
    }
    return 0
  })()

  const isPending = task.status === 'pending' || isQueued
  const cardStyle = isQueued
    ? 'bg-white/60 border border-gray-200 border-l-4 border-l-gray-300'
    : isRunning
      ? 'bg-gradient-to-r from-blue-50 to-white border-2 border-blue-400 shadow-blue-100 shadow-md animate-breathing-glow'
    : recentlyCompleted && task.status === 'success'
      ? 'bg-gradient-to-r from-green-50 to-white border-2 border-green-400 shadow-green-100 shadow-md'
      : recentlyCompleted && (task.status === 'failed' || task.status === 'partial')
        ? 'bg-gradient-to-r from-red-50 to-white border-2 border-red-300 shadow-red-100 shadow-md'
        : task.status === 'success'
          ? 'bg-white border border-gray-100 border-l-4 border-l-green-400 hover:shadow-md'
          : task.status === 'failed'
            ? 'bg-white border border-gray-100 border-l-4 border-l-red-400 hover:shadow-md'
            : task.status === 'cancelled'
              ? 'bg-white border border-gray-100 border-l-4 border-l-gray-300 hover:shadow-md'
              : task.status === 'partial'
                ? 'bg-white border border-gray-100 border-l-4 border-l-amber-400 hover:shadow-md'
                : isPending
                  ? 'bg-white/60 border border-gray-200 border-l-4 border-l-gray-300'
                  : 'bg-white border border-gray-100 hover:shadow-md'

  return (
    <div id={`task-card-${task.id}`} ref={cardRef} className={`relative rounded-xl shadow-sm transition-all duration-500 ${fadingOut ? 'opacity-0 -translate-y-2 scale-[0.98] pointer-events-none' : 'opacity-100 translate-y-0 scale-100'} ${cardStyle} ${shaking ? 'animate-shake' : ''}`}>
      {showConfetti && <ConfettiEffect />}
      {selectable && (
        <div className="absolute top-3 left-3 z-10">
          <input
            type="checkbox"
            checked={selected}
            onChange={() => onToggleSelect?.(task.id)}
            className="w-4 h-4 rounded border-gray-300 text-blue-500 focus:ring-blue-400 cursor-pointer"
          />
        </div>
      )}
      {isQueued && (
        <div className="px-4 pt-3 pb-2">
          <div className="flex items-center gap-2">
            <span className="text-sm text-gray-400">⏳</span>
            <span className="text-sm text-gray-400">排队中，等待前一个任务完成...</span>
          </div>
        </div>
      )}
      {isRunning && !isQueued && (
        <div className="px-4 pt-3 pb-2">
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-2">
              <div className="flex items-center gap-1.5">
                <div className="w-2 h-2 bg-blue-500 rounded-full animate-pulse-dot" />
                <div className="w-2 h-2 bg-blue-500 rounded-full animate-pulse-dot" style={{ animationDelay: '0.3s' }} />
                <div className="w-2 h-2 bg-blue-500 rounded-full animate-pulse-dot" style={{ animationDelay: '0.6s' }} />
              </div>
              <span className="text-sm font-semibold text-blue-600">正在执行</span>
            </div>
            <span className="text-xs text-blue-400 font-mono">已执行 {formatElapsed(elapsed)}</span>
          </div>
          <div className="flex items-center gap-1">
            {progressSteps.map((step, i) => (
              <div key={step.key} className="flex items-center gap-1 flex-1 min-w-0">
                <div className={`flex items-center justify-center w-5 h-5 rounded-full text-[10px] font-bold flex-shrink-0 ${
                  i < currentStepIndex
                    ? 'bg-green-500 text-white'
                    : i === currentStepIndex
                      ? 'bg-blue-500 text-white animate-pulse'
                      : 'bg-gray-200 text-gray-400'
                }`}>
                  {i < currentStepIndex ? '✓' : i + 1}
                </div>
                <span className={`text-xs truncate ${
                  i < currentStepIndex
                    ? 'text-green-600'
                    : i === currentStepIndex
                      ? 'text-blue-600 font-medium'
                      : 'text-gray-300'
                }`}>{step.label}</span>
                {i < progressSteps.length - 1 && (
                  <div className={`flex-1 h-px min-w-[4px] ${
                    i < currentStepIndex ? 'bg-green-400' : 'bg-gray-200'
                  }`} />
                )}
              </div>
            ))}
          </div>
        </div>
      )}
      {recentlyCompleted && task.status === 'success' && (
        <div className="px-4 pt-3 pb-1 flex items-center gap-2">
          <span className="text-sm">✅</span>
          <span className="text-sm font-semibold text-green-600">任务完成</span>
        </div>
      )}
      {recentlyCompleted && task.status === 'failed' && (
        <div className="px-4 pt-3 pb-1 flex items-center gap-2">
          <span className="text-sm">❌</span>
          <span className="text-sm font-semibold text-red-600">任务失败</span>
        </div>
      )}
      {recentlyCompleted && task.status === 'partial' && (
        <div className="px-4 pt-3 pb-1 flex items-center gap-2">
          <span className="text-sm">⚠️</span>
          <span className="text-sm font-semibold text-amber-600">部分成功，需处理</span>
        </div>
      )}
      {!recentlyCompleted && !isRunning && ['success', 'failed', 'cancelled', 'partial'].includes(task.status) && (
        <div className="px-4 pt-3 pb-1 flex items-center gap-2">
          {task.status === 'success' && (
            <>
              <span className="text-sm">✓</span>
              <span className="text-sm font-medium text-green-600">任务完成</span>
            </>
          )}
          {task.status === 'failed' && (
            <>
              <span className="text-sm">✗</span>
              <span className="text-sm font-medium text-red-500">任务失败</span>
            </>
          )}
          {task.status === 'cancelled' && (
            <>
              <span className="text-sm">—</span>
              <span className="text-sm font-medium text-gray-400">已取消</span>
            </>
          )}
          {task.status === 'partial' && (
            <>
              <span className="text-sm">⚠</span>
              <span className="text-sm font-medium text-amber-600">待处理</span>
            </>
          )}
        </div>
      )}
      <div
        className={`p-4 ${canExpand ? 'cursor-pointer' : ''} ${isRunning ? 'pt-2' : ''}`}
        onClick={() => canExpand && setExpanded(!expanded)}
      >
        <div className="flex items-start justify-between">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <p className={`text-base font-medium truncate ${isPending ? 'text-gray-500' : 'text-gray-900'}`}>{task.instruction}</p>
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
                    className={`inline-flex items-center px-2 py-0.5 rounded-md text-sm ${
                      item.status === 'success'
                        ? 'bg-green-50 text-green-700'
                        : item.status === 'pending'
                          ? 'bg-amber-50 text-amber-600'
                          : 'bg-red-50 text-red-600'
                    }`}
                  >
                    {item.status === 'success' ? '✓' : item.status === 'pending' ? '⏳' : '✗'} {item.name} x{item.quantity}
                  </span>
                ))}
              </div>
            )}
            {!expanded && !hasResults && parsedItems.length > 0 && (
              <div className="flex flex-wrap gap-1.5 mt-2">
                {parsedItems.map((item, i) => (
                  <span
                    key={i}
                    className="inline-flex items-center px-2 py-0.5 rounded-md text-sm bg-gray-100 text-gray-600"
                  >
                    {item.name} x{item.quantity}
                  </span>
                ))}
              </div>
            )}
            {hasResults && (successCount > 0 || failedCount > 0 || pendingCount > 0) && (
              <p className="text-sm text-gray-400 mt-1.5">
                {successCount > 0 && <span className="text-green-600">{successCount} 项成功</span>}
                {successCount > 0 && (failedCount > 0 || pendingCount > 0) && <span className="mx-1">·</span>}
                {pendingCount > 0 && <span className="text-amber-500">{pendingCount} 项待选择</span>}
                {pendingCount > 0 && failedCount > 0 && <span className="mx-1">·</span>}
                {failedCount > 0 && <span className="text-red-500">{failedCount} 项失败</span>}
              </p>
            )}
          </div>
          <span className={`ml-3 flex-shrink-0 px-2.5 py-1 rounded-full text-sm font-medium ${config.bg} ${config.color}`}>
            {config.icon && <span className="mr-1">{config.icon}</span>}
            {config.label}
          </span>
        </div>
        {task.status === 'running' && task.progressLog && task.progressLog.length > 0 && (
          <div
            ref={logRef}
            className="mt-3 rounded-lg bg-blue-50 border border-blue-100 px-3 py-2"
          >
            <div className="flex items-start gap-2">
              <span className="text-xs text-blue-400 flex-shrink-0 mt-0.5 font-mono">
                {String(task.progressLog.length).padStart(2, '0')}
              </span>
              <span className="text-sm leading-relaxed text-blue-700 font-medium">
                {renderMsgWithLinks(task.progressLog?.[task.progressLog.length - 1])}
              </span>
            </div>
            {task.progressLog.length > 1 && (
              <p className="text-sm text-blue-400 text-center mt-1">共 {task.progressLog.length} 条，点击查看详情</p>
            )}
          </div>
        )}
      </div>

      {hasPendingConfirmation && (
        <div className="mx-4 mb-2 p-3 rounded-lg bg-amber-50 border border-amber-200">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="text-base">{isWindowClosed ? '🪟' : '⏸️'}</span>
              <span className="text-sm font-semibold text-amber-700">
                {isWindowClosed ? '操作窗口已关闭' : '等待操作确认'}
              </span>
            </div>
            <button
              onClick={(e) => {
                e.stopPropagation()
                if (onOpenPanel) {
                  onOpenPanel()
                } else {
                  setExpanded(true)
                }
              }}
              className="px-3 py-1.5 text-sm font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700 transition-colors"
            >
              📋 购物助手
            </button>
          </div>
        </div>
      )}

      {expanded && (
        <div className="px-4 pb-4 border-t border-gray-50">
          {hasProgressLog && (
            <div className="mt-3">
              <p className="text-sm font-medium text-gray-500 mb-2">执行过程</p>
              <div className="max-h-60 overflow-y-auto rounded-lg bg-gray-50 border border-gray-100 px-3 py-2 space-y-1 scroll-smooth">
                {deduplicateLogs(task.progressLog ?? []).map((entry, idx) => (
                  <div key={idx} className="flex items-start gap-2">
                    <span className="text-xs text-gray-300 flex-shrink-0 mt-0.5 font-mono">
                      {String(idx + 1).padStart(2, '0')}
                    </span>
                    <span className="text-sm leading-relaxed text-gray-600">
                      {renderMsgWithLinks(task.progressLog?.[entry.originalIndex])}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
          {hasResults && (
            <div className="space-y-2 mt-3">
              <div className="flex items-center justify-between">
                <p className="text-sm font-medium text-gray-500">商品结果</p>
                {excludableFailedItems.length >= 2 && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      handleBatchExcludeOrders()
                    }}
                    className="px-2.5 py-1 text-xs font-medium text-gray-500 bg-gray-50 border border-gray-200 rounded-md hover:bg-gray-100 hover:text-gray-700 transition-colors"
                  >
                    排除所有失败项的订单
                  </button>
                )}
              </div>
              {itemResults.map((item, i) => {
                const category = item.status === 'failed' ? categorizeError(item.error) : null
                const catConfig = category ? errorCategoryConfig[category] : null
                const candidates = item.pendingConfirmationId ? candidatesMap[item.pendingConfirmationId] : undefined

                return (
                  <div key={i}>
                    <div
                      className={`rounded-lg p-3 ${
                        item.status === 'success'
                          ? (item.pendingPayment ? 'bg-amber-50/60' : 'bg-green-50/60')
                          : item.status === 'pending' ? 'bg-amber-50/60' : (catConfig?.bg || 'bg-red-50/60')
                      }`}
                    >
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2 min-w-0 flex-1">
                          <span className={`text-sm ${item.status === 'success' ? (item.pendingPayment ? 'text-amber-500' : 'text-green-600') : item.status === 'pending' ? 'text-amber-600' : (catConfig?.color || 'text-red-600')}`} aria-hidden="true">
                            {item.status === 'success' ? (item.pendingPayment ? '⏳' : '✓') : item.status === 'pending' ? '⏳' : catConfig?.icon || '✗'}
                          </span>
                          <div className="min-w-0">
                            <div className="flex items-center gap-1.5">
                              <span className="text-sm font-medium text-gray-900 truncate">{item.name}</span>
                              <span className="text-sm text-gray-400">x{item.quantity}</span>
                            </div>
                            {item.status === 'success' && item.matchedProduct && (
                              <div className="text-sm text-gray-500 mt-0.5 flex items-center gap-2">
                                <span>
                                  匹配: {item.matchedProduct}
                                  {item.matchMethod && (
                                    <span className="ml-1 text-gray-400">({matchMethodLabels[item.matchMethod] || item.matchMethod})</span>
                                  )}
                                </span>
                                {item.currentPrice && item.currentPrice > 0 && (
                                  <span className={`font-medium ${item.pendingPayment ? 'text-amber-500' : 'text-green-600'}`}>
                                    ¥{(item.currentPrice * item.quantity).toFixed(2)}
                                    {item.quantity > 1 && <span className="text-gray-400 font-normal ml-0.5">(¥{item.currentPrice.toFixed(2)} x {item.quantity})</span>}
                                  </span>
                                )}
                              </div>
                            )}
                            {item.status === 'pending' && (
                              <div className="flex items-center gap-1.5 mt-0.5">
                                <span className="text-sm font-medium text-amber-600">
                                  已找到替代商品，请选择
                                </span>
                                {item.error && (
                                  <span className="text-sm text-gray-400 truncate" title={item.error}>
                                    {item.error.length > 30 ? item.error.slice(0, 30) + '…' : item.error}
                                  </span>
                                )}
                              </div>
                            )}
                            {item.status === 'failed' && (
                              <div className="flex items-center gap-1.5 mt-0.5">
                                <span className={`text-sm font-medium ${catConfig?.color || 'text-red-600'}`}>
                                  {catConfig?.label || '任务失败'}
                                </span>
                                {item.error && item.error !== catConfig?.label && (
                                  <span className="text-sm text-gray-400 truncate" title={item.error}>
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
                            className="ml-2 flex-shrink-0 px-2.5 py-1 text-sm font-medium text-blue-600 bg-blue-50 rounded-md hover:bg-blue-100 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                          >
                            {retryingItem === item.name ? '重试中...' : '重试'}
                          </button>
                        )}
                        {item.status === 'failed' && !catConfig?.retryable && item.orderId && (
                          excludedOrderIds.has(item.orderId)
                            ? (
                              <span className="ml-2 flex-shrink-0 px-2.5 py-1 text-sm font-medium text-gray-400 bg-gray-50 rounded-md inline-flex items-center gap-1.5">
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
                            )
                            : (
                              <button
                                onClick={(e) => {
                                  e.stopPropagation()
                                  handleExcludeOrder(item.pendingConfirmationId || 0, item.orderId!)
                                }}
                                disabled={excludingOrderId === item.orderId}
                                className="ml-2 flex-shrink-0 px-2.5 py-1 text-sm font-medium text-gray-500 bg-gray-50 rounded-md hover:bg-gray-100 hover:text-gray-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                                title="不再匹配此订单，后续购买同类商品时将跳过"
                              >
                                {excludingOrderId === item.orderId ? '处理中...' : '不再匹配'}
                              </button>
                            )
                        )}
                        {item.status === 'success' && item.pendingPayment && (
                          <div className="ml-2 flex-shrink-0">
                            <button
                              onClick={(e) => {
                                e.stopPropagation()
                                handleConfirmPayment(item.name)
                              }}
                              disabled={confirmingPayment === item.name}
                              className="px-2.5 py-1 text-sm font-medium text-green-600 bg-green-50 rounded-md hover:bg-green-100 transition-colors disabled:opacity-50"
                            >
                              {confirmingPayment === item.name ? '处理中...' : '确认已付款'}
                            </button>
                          </div>
                        )}
                      </div>
                    </div>

                    {(item.status === 'failed' || item.status === 'pending') && candidates && candidates.length > 0 && (
                      <div className="mt-2 ml-4">
                        <div className="flex items-center gap-2 mb-2">
                          <p className="text-sm font-medium text-orange-600">找到 {candidates.length} 个替代商品，请选择：</p>
                          {item.pendingConfirmationId && originalPriceMap[item.pendingConfirmationId] && originalPriceMap[item.pendingConfirmationId] > 0 && (
                            <span className="text-sm text-gray-400">原价 ¥{originalPriceMap[item.pendingConfirmationId].toFixed(2)}</span>
                          )}
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
                                  <img
                                    src={c.imageUrl}
                                    alt={c.title}
                                    className="w-14 h-14 object-cover rounded-md flex-shrink-0"
                                  />
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
                                        onClick={(e) => {
                                          e.stopPropagation()
                                          handlePurchaseCandidate(item.pendingConfirmationId!, c)
                                        }}
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
                                          onClick={(e) => {
                                            e.stopPropagation()
                                            handleConfirmPurchase(item.pendingConfirmationId!, c)
                                          }}
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
                      <div className="mt-2 ml-4 p-2.5 bg-gray-50 rounded-lg">
                        <p className="text-sm text-gray-500">未找到替代商品，请手动搜索购买</p>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </div>
      )}

      {task.error && !expanded && (
        <div className="px-4 pb-2">
          <p className={`text-sm rounded-md px-3 py-2 ${
            displayStatus === 'partial'
              ? 'text-amber-600 bg-amber-50'
              : 'text-red-500 bg-red-50'
          }`}>{task.error}</p>
        </div>
      )}

      <div className="flex items-center justify-between px-4 py-3 border-t border-gray-50">
        <div className="flex items-center gap-3 text-sm text-gray-400">
          <span>{formatDate(task.createdAt)}</span>
          {task.startedAt && task.completedAt && (() => {
            const ms = new Date(task.completedAt).getTime() - new Date(task.startedAt).getTime()
            if (ms < 0) return null
            const sec = Math.floor(ms / 1000)
            if (sec < 60) return <span>耗时 {sec} 秒</span>
            const m = Math.floor(sec / 60)
            const s = sec % 60
            return <span>耗时 {m} 分 {s} 秒</span>
          })()}
        </div>
        <div className="flex items-center gap-3">
          {expanded ? (
            <button
              onClick={(e) => {
                e.stopPropagation()
                setExpanded(false)
              }}
              className="text-sm text-gray-500 hover:text-gray-700 transition-colors"
            >
              收起
            </button>
          ) : canExpand && (
            <button
              onClick={(e) => {
                e.stopPropagation()
                setExpanded(true)
              }}
              className="text-sm text-blue-500 hover:text-blue-700 transition-colors"
            >
              查看详情
            </button>
          )}
          {(task.status === 'pending' || task.status === 'running') && !confirmingCancel && (
            <button
              onClick={(e) => {
                e.stopPropagation()
                setConfirmingCancel(true)
              }}
              className="px-2 py-0.5 text-xs font-medium text-red-400 bg-red-50 rounded hover:text-red-600 hover:bg-red-100 transition-colors"
            >
              停止
            </button>
          )}
          {(task.status === 'pending' || task.status === 'running') && confirmingCancel && (
            <div className="flex items-center gap-1">
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  setConfirmingCancel(false)
                  onCancel(task.id)
                }}
                className="px-2 py-0.5 text-xs font-medium text-white bg-red-500 rounded hover:bg-red-600 transition-colors"
              >
                确认
              </button>
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  setConfirmingCancel(false)
                }}
                className="px-2 py-0.5 text-xs font-medium text-gray-400 bg-gray-50 rounded hover:bg-gray-100 transition-colors"
              >
                取消
              </button>
            </div>
          )}
          {task.status === 'partial' && (
            <button
              onClick={(e) => {
                e.stopPropagation()
                onCancel(task.id)
              }}
              className="text-sm text-gray-500 hover:text-red-600 transition-colors"
            >
              放弃
            </button>
          )}
          {isTerminal && onDelete && (
            <button
              onClick={(e) => {
                e.stopPropagation()
                onDelete(task.id)
              }}
              className="text-sm text-gray-400 hover:text-red-500 transition-colors"
            >
              删除
            </button>
          )}
          {isTerminal && onReExecute && (
            <button
              onClick={(e) => {
                e.stopPropagation()
                onReExecute({ instruction: task.instruction, parsedItems: task.parsedItems, paymentMode: task.paymentMode })
              }}
              className="text-sm text-blue-500 hover:text-blue-700 transition-colors"
              title="使用相同的商品和支付模式重新下单"
            >
              再来一单
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
