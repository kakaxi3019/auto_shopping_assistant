import { useState, useEffect, useCallback } from 'react'
import { api } from '../lib/api'

interface Task {
  id: number
  status: string
  instruction: string
  parsedItems: string
  platform: string
  createdAt: string
  completedAt: string | null
  error: string | null
  itemResults?: string | null
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

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const result = await api.listTasks()
      setTasks(result as Task[])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    refresh()

    const unsubscribe = api.onTaskStatusUpdate((data: unknown) => {
      const update = data as { taskId: number; status: string; error?: string }
      setTasks((prev) =>
        prev.map((t) =>
          t.id === update.taskId
            ? { ...t, status: update.status, error: update.error || t.error }
            : t
        )
      )
      refresh()
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
    } finally {
      setPreviewLoading(false)
    }
  }, [])

  const confirmTask = useCallback(async (instruction: string, items: PreviewItem[], dryRun?: boolean) => {
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
    const result = await api.confirmTask(instruction, confirmItems, undefined, dryRun) as { error?: string }
    if (result && result.error) {
      throw new Error(result.error)
    }
    setPreview(null)
    await refresh()
  }, [refresh])

  const cancelPreview = useCallback(() => {
    setPreview(null)
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

  return {
    tasks, loading, refresh,
    createTask, cancelTask, retryTaskItem,
    preview, previewLoading, previewTask, confirmTask, cancelPreview,
    updatePreviewItem, removePreviewItem,
  }
}
