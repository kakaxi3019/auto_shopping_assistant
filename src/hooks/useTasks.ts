import { useState, useEffect, useCallback } from 'react'
import { api } from '../lib/api'

interface Task {
  id: number
  status: string
  instruction: string
  parsedItems: string
  platform: string
  paymentMode?: string
  createdAt: string
  completedAt: string | null
  error: string | null
  itemResults?: string | null
  progress?: string | null
  progressLog?: string[]
}

interface CandidateOrder {
  id: number
  productName: string
  price: number
  imageUrl: string
  platform: string
  purchasedAt: string
  shopName: string
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
}

interface TaskPreview {
  instruction: string
  items: PreviewItem[]
  platform: string
}

export function useTasks() {
  const [tasks, setTasks] = useState<Task[]>([])
  const [loading, setLoading] = useState(false)
  const [preview, setPreview] = useState<TaskPreview | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [activeTaskId, setActiveTaskId] = useState<number | null>(null)
  const [panelOpen, setPanelOpen] = useState(false)

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const result = await api.listTasks() as Task[]
      const parsed = result.map(t => ({
        ...t,
        progressLog: typeof (t as any).progressLog === 'string'
          ? JSON.parse((t as any).progressLog as string)
          : t.progressLog || [],
      }))
      setTasks((prev) => {
        const merged = parsed.map((fresh) => {
          const local = prev.find(t => t.id === fresh.id)
          if (local && local.status === 'running' && local.progressLog && local.progressLog.length > 0) {
            const freshLog = fresh.progressLog || []
            if (local.progressLog.length > freshLog.length) {
              return { ...fresh, progressLog: local.progressLog }
            }
          }
          return fresh
        })
        const freshIds = new Set(parsed.map(t => t.id))
        prev.forEach(t => {
          if (!freshIds.has(t.id) && t.status === 'running') {
            merged.push(t)
          }
        })
        return merged
      })
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    const unsubscribe = api.onTaskStatusUpdate((data: unknown) => {
      const update = data as { taskId: number; status: string; error?: string; progress?: string; itemResults?: string }
      setTasks((prev) => {
        const existing = prev.find(t => t.id === update.taskId)
        if (!existing) {
          setTimeout(() => refresh(), 100)
          const newTask: Task = {
            id: update.taskId,
            status: update.status,
            instruction: '',
            parsedItems: '[]',
            platform: 'taobao',
            createdAt: new Date().toISOString(),
            completedAt: null,
            error: update.error || null,
            progress: update.progress || null,
            progressLog: update.progress ? [update.progress] : [],
            itemResults: update.itemResults || null,
          }
          return [newTask, ...prev]
        }
        if (existing.status === update.status && update.status !== 'running' && !update.progress) {
          return prev
        }
        return prev.map((t) => {
          if (t.id !== update.taskId) return t
          const isRestarting = update.status === 'running' && t.status !== 'running'
          const newLog = isRestarting
            ? (update.progress ? [update.progress] : [])
            : (update.progress ? [...(t.progressLog || []), update.progress] : t.progressLog)
          const updated: any = {
            ...t,
            status: update.status,
            error: update.status === 'running' ? (update.error || null) : (update.error || t.error),
            progress: update.progress !== undefined ? update.progress : t.progress,
            progressLog: update.status === 'running' ? newLog : t.progressLog,
          }
          if (update.itemResults !== undefined) {
            updated.itemResults = update.itemResults
          }
          return updated
        })
      })
      if (update.status !== 'running') {
        setTimeout(() => refresh(), 500)
      }
    })

    return unsubscribe
  }, [refresh])

  const previewTask = useCallback(async (instruction: string) => {
    setPreviewLoading(true)
    try {
      const result = await api.previewTask(instruction) as TaskPreview & { error?: string }
      if (result && result.error) {
        throw new Error(result.error)
      }
      setPreview(result)
      setPanelOpen(true)
    } finally {
      setPreviewLoading(false)
    }
  }, [])

  const confirmTask = useCallback(async (instruction: string, items: PreviewItem[], dryRun?: boolean, paymentMode?: string) => {
    const matchedItems = items.filter(item => item.matched)
    if (matchedItems.length === 0) {
      throw new Error('没有匹配的商品可以购买')
    }
    const confirmItems = matchedItems.map(item => ({
      name: item.matchedProduct || item.name,
      quantity: item.quantity,
      sku: item.sku,
      orderRef: item.orderRef,
    }))
    const result = await api.confirmTask(instruction, confirmItems, undefined, dryRun, paymentMode) as { taskId?: number; error?: string }
    if (result && result.error) {
      throw new Error(result.error)
    }
    if (result && result.taskId) {
      setActiveTaskId(result.taskId)
    }
    setPreview(null)
    setPanelOpen(true)
    await refresh()
  }, [refresh])

  const cancelPreview = useCallback(() => {
    setPreview(null)
    setPanelOpen(false)
  }, [])

  const closePanel = useCallback(() => {
    setPanelOpen(false)
    setPreview(null)
  }, [])

  const openTaskPanel = useCallback((taskId: number) => {
    setActiveTaskId(taskId)
    setPreview(null)
    setPanelOpen(true)
  }, [])

  const updatePreviewItem = useCallback((index: number, updates: Partial<PreviewItem>) => {
    setPreview(prev => {
      if (!prev) return prev
      const newItems = [...prev.items]
      newItems[index] = { ...newItems[index], ...updates }
      return { ...prev, items: newItems }
    })
  }, [])

  const removePreviewItem = useCallback((index: number) => {
    setPreview(prev => {
      if (!prev) return prev
      const newItems = prev.items.filter((_, i) => i !== index)
      if (newItems.length === 0) return null
      return { ...prev, items: newItems }
    })
  }, [])

  const createTask = useCallback(async (instruction: string) => {
    const result = await api.createTask(instruction) as { error?: string }
    if (result && result.error) {
      throw new Error(result.error)
    }
    await refresh()
  }, [refresh])

  const cancelTask = useCallback(async (id: number) => {
    await api.cancelTask(id)
    await refresh()
  }, [refresh])

  const retryTaskItem = useCallback(async (taskId: number, itemName: string) => {
    const result = await api.retryTaskItem(taskId, itemName) as { success: boolean; error?: string }
    if (result && !result.success && result.error) {
      throw new Error(result.error)
    }
    await refresh()
  }, [refresh])

  const deleteTask = useCallback(async (id: number) => {
    await api.deleteTask(id)
    await refresh()
  }, [refresh])

  const deleteTasks = useCallback(async (ids: number[]) => {
    await api.deleteTasks(ids)
    await refresh()
  }, [refresh])

  const clearHistory = useCallback(async () => {
    await api.clearHistory()
    await refresh()
  }, [refresh])

  return {
    tasks, loading, refresh,
    createTask, cancelTask, retryTaskItem,
    deleteTask, deleteTasks, clearHistory,
    preview, previewLoading, previewTask, confirmTask, cancelPreview,
    updatePreviewItem, removePreviewItem,
    activeTaskId, panelOpen, closePanel, openTaskPanel,
  }
}
