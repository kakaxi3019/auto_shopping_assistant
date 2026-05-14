import { useState, useEffect, lazy, Suspense } from 'react'
import Layout from './components/Layout'
import Dashboard from './components/Dashboard'
import ShoppingInput from './components/ShoppingInput'
import TaskList from './components/TaskList'
import PreviewPanel from './components/PreviewPanel'
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
  const { tasks, loading, refresh, createTask, cancelTask, retryTaskItem,
    preview, previewLoading, previewTask, confirmTask, cancelPreview,
    updatePreviewItem, removePreviewItem } = useTasks()

  useEffect(() => {
    const check = () => {
      api.isBackendReady?.().then(ready => {
        if (ready) {
          setBackendReady(true)
          refresh()
        }
      }).catch(() => {})
    }

    check()

    const unsubBackend = api.onAppReady?.(() => {
      setBackendReady(true)
      refresh()
    }) ?? (() => {})

    const timer = setInterval(() => {
      if (!backendReady) check()
    }, 1000)

    return () => {
      unsubBackend()
      clearInterval(timer)
    }
  }, [refresh])

  const renderPage = () => {
    switch (page) {
      case 'shopping':
        return (
          <div className="space-y-6">
            <Dashboard tasks={tasks} />
            <ShoppingInput onSubmit={previewTask} disabled={!backendReady || previewLoading} />
            {preview && (
              <PreviewPanel
                preview={preview}
                onConfirm={confirmTask}
                onCancel={cancelPreview}
                onUpdateItem={updatePreviewItem}
                onRemoveItem={removePreviewItem}
              />
            )}
            <TaskList tasks={tasks} loading={loading} onCancel={cancelTask} onRetryItem={retryTaskItem} />
          </div>
        )
      case 'orders':
        return (
          <Suspense fallback={<div className="p-4 text-sm text-gray-500">加载中...</div>}>
            <OrderList />
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
    <Layout currentPage={page} onNavigate={setPage}>
      {!backendReady && (
        <div className="mb-4 p-3 bg-blue-50 border border-blue-200 rounded-lg text-sm text-blue-700 flex items-center gap-2" role="status" aria-live="polite">
          <div className="w-4 h-4 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" aria-hidden="true" />
          正在初始化服务，请稍候...
        </div>
      )}
      {renderPage()}
    </Layout>
  )
}
