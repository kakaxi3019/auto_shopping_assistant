import { useState, useEffect, lazy, Suspense, useCallback } from 'react'
import Layout from './components/Layout'
import Dashboard from './components/Dashboard'
import ShoppingInput from './components/ShoppingInput'
import TaskList from './components/TaskList'
import PreviewPanel from './components/PreviewPanel'
import ToastProvider from './components/ToastProvider'
import { useTasks } from './hooks/useTasks'
import { api } from './lib/api'

const AccountManager = lazy(() => import('./components/AccountManager'))
const OrderList = lazy(() => import('./components/OrderList'))
const Settings = lazy(() => import('./components/Settings'))
const ScheduledTasks = lazy(() => import('./components/ScheduledTasks'))

type Page = 'shopping' | 'scheduled' | 'orders' | 'account' | 'settings'

export default function App() {
  const [page, setPage] = useState<Page>('shopping')
  const [backendReady, setBackendReady] = useState(false)
  const [scrollToFilter, setScrollToFilter] = useState<string | number | null>(null)
  const { tasks, loading, refresh, createTask, cancelTask, retryTaskItem,
    deleteTask, deleteTasks, clearHistory,
    preview, previewLoading, previewTask, confirmTask, cancelPreview,
    updatePreviewItem, removePreviewItem } = useTasks()

  const handleReExecute = useCallback(async (task: { instruction: string; parsedItems: string; paymentMode?: string }) => {
    try {
      const items = JSON.parse(task.parsedItems) as { name: string; quantity: number; sku?: string; orderRef?: number }[]
      const confirmItems = items.map(item => ({
        name: item.name,
        quantity: item.quantity,
        sku: item.sku,
        orderRef: item.orderRef,
      }))
      await confirmTask(task.instruction, confirmItems.map(item => ({ ...item, matched: true, matchedProduct: item.name })), false, task.paymentMode)
    } catch (e) {
      console.error('再执行失败:', e)
    }
  }, [confirmTask])

  useEffect(() => {
    let ready = false

    const check = () => {
      if (ready) return
      api.isBackendReady?.().then(r => {
        if (r && !ready) {
          ready = true
          setBackendReady(true)
          refresh()
        }
      }).catch(() => {})
    }

    check()

    const unsubBackend = api.onAppReady?.(() => {
      if (!ready) {
        ready = true
        setBackendReady(true)
        refresh()
      }
    }) ?? (() => {})

    const timer = setInterval(check, 1000)

    return () => {
      unsubBackend()
      clearInterval(timer)
    }
  }, [refresh])

  useEffect(() => {
    const unsubNotification = api.onTaskNotificationClick?.((_data: { taskId: number }) => {
      setPage('shopping')
    }) ?? (() => {})

    return unsubNotification
  }, [])

  const renderPage = () => {
    switch (page) {
      case 'shopping':
        return (
          <div className="space-y-6">
            <Dashboard tasks={tasks} onScrollToTasks={(filter) => { setScrollToFilter(filter !== undefined ? filter : ''); setPage('shopping') }} />
            <ShoppingInput onSubmit={previewTask} disabled={!backendReady || previewLoading} recentTasks={tasks.filter(t => t.status === 'success').filter((t, i, arr) => arr.findIndex(x => x.instruction === t.instruction) === i).slice(0, 5)} />
            {preview && (
              <PreviewPanel
                preview={preview}
                onConfirm={confirmTask}
                onCancel={cancelPreview}
                onUpdateItem={updatePreviewItem}
                onRemoveItem={removePreviewItem}
              />
            )}
            <TaskList tasks={tasks} loading={loading} onCancel={cancelTask} onRetryItem={retryTaskItem} onReExecute={handleReExecute} onDelete={deleteTask} onDeleteBatch={deleteTasks} onClearHistory={clearHistory} scrollToFilter={scrollToFilter} onScrollHandled={() => setScrollToFilter(null)} />
          </div>
        )
      case 'orders':
        return (
          <Suspense fallback={<div className="p-4 text-sm text-gray-500">加载中...</div>}>
            <OrderList onNavigateToTasks={(filter) => { if (filter !== undefined) setScrollToFilter(filter); setPage('shopping') }} />
          </Suspense>
        )
      case 'scheduled':
        return (
          <Suspense fallback={<div className="p-4 text-sm text-gray-500">加载中...</div>}>
            <ScheduledTasks />
          </Suspense>
        )
      case 'account':
        return (
          <Suspense fallback={<div className="p-4 text-sm text-gray-500">加载中...</div>}>
            <AccountManager />
          </Suspense>
        )
      case 'settings':
        return (
          <Suspense fallback={<div className="p-4 text-sm text-gray-500">加载中...</div>}>
            <Settings />
          </Suspense>
        )
    }
  }

  return (
    <ToastProvider>
      <Layout currentPage={page} onNavigate={setPage}>
        {!backendReady && (
          <div className="mb-4 p-3 bg-blue-50 border border-blue-200 rounded-lg text-sm text-blue-700 flex items-center gap-2" role="status" aria-live="polite">
            <div className="w-4 h-4 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" aria-hidden="true" />
            正在初始化服务，请稍候...
          </div>
        )}
        {renderPage()}
      </Layout>
    </ToastProvider>
  )
}
