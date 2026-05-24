import { useState, useEffect, useRef } from 'react'
import TaskCard from './TaskCard'
import { useToast } from './ToastProvider'

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

interface TaskListProps {
  tasks: Task[]
  loading: boolean
  onCancel: (id: number) => void
  onRetryItem: (taskId: number, itemName: string) => Promise<void>
  onReExecute?: (task: { instruction: string; parsedItems: string; paymentMode?: string }) => void
  onDelete?: (id: number) => void
  onDeleteBatch?: (ids: number[]) => void
  onClearHistory?: () => void
  scrollToFilter?: string | number | null
  onScrollHandled?: () => void
  onOpenTaskPanel?: (taskId: number) => void
}

function isTerminalStatus(status: string): boolean {
  return ['success', 'failed', 'cancelled', 'partial'].includes(status)
}

export default function TaskList({ tasks, loading, onCancel, onRetryItem, onReExecute, onDelete, onDeleteBatch, onClearHistory, scrollToFilter, onScrollHandled, onOpenTaskPanel }: TaskListProps) {
  const [showHistory, setShowHistory] = useState(false)
  const [batchMode, setBatchMode] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set())
  const [confirmClear, setConfirmClear] = useState(false)
  const seenCompletedRef = useRef<Set<number>>(new Set())
  const initializedRef = useRef(false)
  const taskListRef = useRef<HTMLDivElement>(null)
  const { showToast } = useToast()

  const [statusFilter, setStatusFilter] = useState<string | null>(null)

  useEffect(() => {
    if (scrollToFilter === null || scrollToFilter === undefined) return

    if (typeof scrollToFilter === 'number') {
      setStatusFilter(null)
      onScrollHandled?.()
      requestAnimationFrame(() => {
        setTimeout(() => {
          const el = document.getElementById(`task-card-${scrollToFilter}`)
          if (el) {
            el.scrollIntoView({ behavior: 'smooth', block: 'center' })
          } else {
            taskListRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
          }
        }, 300)
      })
      return
    }

    if (scrollToFilter === '') {
      setStatusFilter(null)
      onScrollHandled?.()
      requestAnimationFrame(() => {
        setTimeout(() => {
          taskListRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
        }, 100)
      })
      return
    }

    const isCompletedFilter = ['success', 'failed', 'cancelled'].includes(scrollToFilter)
    if (isCompletedFilter && !showHistory) {
      setShowHistory(true)
    }

    setStatusFilter(scrollToFilter)
    onScrollHandled?.()

    requestAnimationFrame(() => {
      setTimeout(() => {
        taskListRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
      }, 100)
    })
  }, [scrollToFilter])

  const allActiveTasks = tasks.filter(t =>
    t.status === 'pending' || t.status === 'running' || t.status === 'partial'
  )
  const allCompletedTasks = tasks.filter(t =>
    ['success', 'failed', 'cancelled'].includes(t.status)
  ).sort((a, b) => {
    const timeA = a.completedAt || a.createdAt
    const timeB = b.completedAt || b.createdAt
    return timeB.localeCompare(timeA)
  })

  const activeTasks = statusFilter
    ? allActiveTasks.filter(t => t.status === statusFilter || (statusFilter === 'running' && t.status === 'pending'))
    : allActiveTasks
  const completedTasks = statusFilter
    ? allCompletedTasks.filter(t => t.status === statusFilter)
    : allCompletedTasks

  useEffect(() => {
    if (!initializedRef.current) {
      if (tasks.length === 0) return
      tasks.forEach(t => {
        if (['success', 'failed', 'cancelled', 'partial'].includes(t.status)) {
          seenCompletedRef.current.add(t.id)
        }
      })
      initializedRef.current = true
      return
    }

    const newIds: number[] = []
    tasks.forEach(t => {
      if (['success', 'failed', 'cancelled', 'partial'].includes(t.status) && !seenCompletedRef.current.has(t.id)) {
        seenCompletedRef.current.add(t.id)
        newIds.push(t.id)
      }
    })

    if (newIds.length > 0) {
      newIds.forEach(id => {
        const task = tasks.find(t => t.id === id)
        const instruction = task?.instruction || ''
        const truncatedInstruction = instruction.length > 20 ? instruction.slice(0, 20) + '…' : instruction
        const isSuccess = task?.status === 'success'
        const isPartial = task?.status === 'partial'
        showToast({
          type: isSuccess ? 'success' : isPartial ? 'error' : 'error',
          message: isSuccess
            ? `「${truncatedInstruction}」已完成`
            : isPartial
              ? `「${truncatedInstruction}」部分成功，需处理`
              : `「${truncatedInstruction}」任务失败`,
          action: {
            label: '查看',
            onClick: () => {
              const el = document.getElementById(`task-card-${id}`)
              if (el) {
                el.scrollIntoView({ behavior: 'smooth', block: 'center' })
              }
            },
          },
        })
      })
      setShowHistory(true)
    }
  }, [tasks])

  if (loading && tasks.length === 0) {
    return (
      <div className="text-center py-12 text-gray-400">
        <p className="text-sm">加载中...</p>
      </div>
    )
  }

  if (tasks.length === 0) {
    return (
      <div className="text-center py-12 text-gray-400" role="status">
        <p className="text-4xl mb-3" aria-hidden="true">🛒</p>
        <p className="text-sm">暂无购物任务</p>
        <p className="text-sm mt-1">在上方输入购物需求开始使用</p>
      </div>
    )
  }

  const hasActive = activeTasks.length > 0
  const hasCompleted = completedTasks.length > 0

  const filterLabels: Record<string, string> = {
    success: '已完成',
    running: '执行中',
    failed: '失败',
    cancelled: '已取消',
    partial: '部分成功',
  }

  return (
    <div ref={taskListRef}>
      {statusFilter && (
        <div className="flex items-center gap-2 mb-4 px-3 py-2 bg-blue-50 border border-blue-100 rounded-lg">
          <span className="text-sm text-blue-600">
            筛选：{filterLabels[statusFilter] || statusFilter}
          </span>
          <span className="text-sm text-blue-400">
            {activeTasks.length + completedTasks.length} 个任务
          </span>
          <button
            onClick={() => setStatusFilter(null)}
            className="ml-auto text-sm text-blue-500 hover:text-blue-700 font-medium"
          >
            清除筛选
          </button>
        </div>
      )}
      {hasActive && (
        <div>
          <h3 className="text-sm font-medium text-gray-700 mb-3">
            进行中的任务
            <span className="ml-1.5 text-sm text-gray-400">({activeTasks.length})</span>
          </h3>
          <div className="space-y-3">
            {activeTasks.map((task) => (
              <TaskCard key={task.id} task={task} onCancel={onCancel} onRetryItem={onRetryItem} onReExecute={onReExecute} onOpenPanel={onOpenTaskPanel ? () => onOpenTaskPanel(task.id) : undefined} />
            ))}
          </div>
        </div>
      )}

      {hasCompleted && (
        <div className={hasActive ? 'mt-6' : ''}>
          <div className="flex items-center justify-between mb-3">
            <button
              onClick={() => setShowHistory(!showHistory)}
              className="flex items-center gap-1.5 text-sm font-medium text-gray-500 hover:text-gray-700 transition-colors"
            >
              <svg
                className={`w-3.5 h-3.5 transition-transform ${showHistory ? 'rotate-90' : ''}`}
                fill="none" stroke="currentColor" viewBox="0 0 24 24"
              >
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
              </svg>
              历史任务
              <span className="text-sm text-gray-400">({completedTasks.length})</span>
            </button>
            {showHistory && !batchMode && (
              <div className="flex items-center gap-2">
                {onDeleteBatch && completedTasks.length > 0 && (
                  <button
                    onClick={() => {
                      setBatchMode(true)
                      setSelectedIds(new Set())
                    }}
                    className="text-sm text-gray-400 hover:text-blue-500 transition-colors"
                  >
                    批量管理
                  </button>
                )}
                {onClearHistory && completedTasks.length > 0 && (
                  confirmClear ? (
                    <div className="flex items-center gap-1.5">
                      <span className="text-sm text-red-500">确认清空？</span>
                      <button
                        onClick={() => {
                          onClearHistory()
                          setConfirmClear(false)
                        }}
                        className="text-sm text-red-500 hover:text-red-700 font-medium"
                      >
                        确认
                      </button>
                      <button
                        onClick={() => setConfirmClear(false)}
                        className="text-sm text-gray-400 hover:text-gray-600"
                      >
                        取消
                      </button>
                    </div>
                  ) : (
                    <button
                      onClick={() => setConfirmClear(true)}
                      className="text-sm text-gray-400 hover:text-red-500 transition-colors"
                    >
                      清空历史
                    </button>
                  )
                )}
              </div>
            )}
            {showHistory && batchMode && (
              <div className="flex items-center gap-2">
                <span className="text-sm text-gray-500">
                  已选 {selectedIds.size} 项
                </span>
                <button
                  onClick={() => {
                    const allIds = new Set(completedTasks.map(t => t.id))
                    setSelectedIds(selectedIds.size === allIds.size ? new Set() : allIds)
                  }}
                  className="text-sm text-blue-500 hover:text-blue-700"
                >
                  {selectedIds.size === completedTasks.length ? '取消全选' : '全选'}
                </button>
                {selectedIds.size > 0 && (
                  <button
                    onClick={() => {
                      onDeleteBatch?.(Array.from(selectedIds))
                      setSelectedIds(new Set())
                      setBatchMode(false)
                    }}
                    className="text-sm text-red-500 hover:text-red-700 font-medium"
                  >
                    删除所选
                  </button>
                )}
                <button
                  onClick={() => {
                    setBatchMode(false)
                    setSelectedIds(new Set())
                  }}
                  className="text-sm text-gray-400 hover:text-gray-600"
                >
                  取消
                </button>
              </div>
            )}
          </div>
          {showHistory && (
            <div className="space-y-3">
              {completedTasks.map((task) => (
                <TaskCard
                  key={task.id}
                  task={task}
                  onCancel={onCancel}
                  onRetryItem={onRetryItem}
                  onReExecute={onReExecute}
                  onDelete={isTerminalStatus(task.status) ? onDelete : undefined}
                  selectable={batchMode}
                  selected={selectedIds.has(task.id)}
                  onToggleSelect={(id) => {
                    setSelectedIds(prev => {
                      const next = new Set(prev)
                      if (next.has(id)) next.delete(id)
                      else next.add(id)
                      return next
                    })
                  }}
                />
              ))}
            </div>
          )}
        </div>
      )}

      {!hasActive && !hasCompleted && (
        <div className="text-center py-12 text-gray-400" role="status">
          <p className="text-4xl mb-3" aria-hidden="true">🛒</p>
          <p className="text-sm">暂无购物任务</p>
          <p className="text-sm mt-1">在上方输入购物需求开始使用</p>
        </div>
      )}
    </div>
  )
}
