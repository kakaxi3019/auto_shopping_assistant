import { useState, useEffect, useRef, lazy, Suspense, useCallback } from 'react'
import Layout from './components/Layout'
import Dashboard from './components/Dashboard'
import ShoppingInput from './components/ShoppingInput'
import TaskList from './components/TaskList'
import ShoppingAssistantPanel from './components/ShoppingAssistantPanel'
import ErrorBoundary from './components/ErrorBoundary'
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
  const mainRef = useRef<HTMLDivElement>(null)
  const [scrolledDown, setScrolledDown] = useState(false)
  const { tasks, loading, refresh, createTask, cancelTask, retryTaskItem,
    deleteTask, deleteTasks, clearHistory,
    preview, previewLoading, previewTask, confirmTask, cancelPreview,
    updatePreviewItem, removePreviewItem,
    activeTaskId, panelOpen, closePanel, openPreviewPanel, openTaskPanel, recentSuggestions } = useTasks()

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
            <ShoppingInput onSubmit={previewTask} disabled={!backendReady || previewLoading} recentTasks={recentSuggestions} previewOpen={panelOpen} />
            <Dashboard tasks={tasks} onScrollToTasks={(filter) => { setScrollToFilter(filter !== undefined ? filter : ''); setPage('shopping') }} />
            <TaskList tasks={tasks} loading={loading} onCancel={cancelTask} onRetryItem={retryTaskItem} onReExecute={handleReExecute} onDelete={deleteTask} onDeleteBatch={deleteTasks} onClearHistory={clearHistory} scrollToFilter={scrollToFilter} onScrollHandled={() => setScrollToFilter(null)} onOpenTaskPanel={openTaskPanel} />
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
    <ErrorBoundary>
      <>
        <Layout currentPage={page} onNavigate={setPage} mainRef={mainRef} onScrollStateChange={(scrolled) => setScrolledDown(scrolled && page === 'shopping')}>
          {!backendReady && (
            <div className="mb-4 p-3 bg-blue-50 border border-blue-200 rounded-lg text-sm text-blue-700 flex items-center gap-2" role="status" aria-live="polite">
              <div className="w-4 h-4 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" aria-hidden="true" />
              正在初始化服务，请稍候...
            </div>
          )}
          {renderPage()}
        </Layout>
        {panelOpen && (
          <ShoppingAssistantPanel
            preview={preview}
            previewLoading={previewLoading}
            activeTaskId={activeTaskId}
            tasks={tasks}
            onConfirm={confirmTask}
            onCancelPreview={cancelPreview}
            onUpdateItem={updatePreviewItem}
            onRemoveItem={removePreviewItem}
            onClose={closePanel}
            onConfirmAction={async () => { const r = await api.confirmAction() as boolean; return r }}
            onRejectAction={async () => { const r = await api.rejectAction() as boolean; return r }}
            onReopenWindow={async () => { const r = await api.reopenConfirmationWindow() as boolean; return r }}
            onRetryItem={retryTaskItem}
            onCancelTask={cancelTask}
          />
        )}
        {(() => {
          const isTaskRunning = !panelOpen && activeTaskId && tasks.some(t => t.id === activeTaskId && (t.status === 'running' || t.status === 'partial'))
          const showAssistantButton = !panelOpen && (isTaskRunning || previewLoading || preview !== null)

          const buttonConfig = (() => {
            if (previewLoading) {
              return {
                text: 'AI 正在解析指令...',
                dotClass: 'bg-indigo-400 animate-pulse',
                onClick: openPreviewPanel
              }
            }
            if (preview !== null) {
              return {
                text: '解析就绪，请确认',
                dotClass: 'bg-green-400 animate-bounce',
                onClick: openPreviewPanel
              }
            }
            return {
              text: '购物助手',
              dotClass: 'bg-green-400 animate-pulse',
              onClick: () => openTaskPanel(activeTaskId!)
            }
          })()

          return (
            <>
              {scrolledDown && (
                <button
                  onClick={() => mainRef.current?.scrollTo({ top: 0, behavior: 'smooth' })}
                  className={`fixed bottom-6 z-40 flex items-center justify-center w-11 h-11 bg-white text-gray-600 rounded-full shadow-lg border border-gray-200 hover:bg-gray-50 hover:text-gray-900 transition-all hover:scale-105 active:scale-95 ${showAssistantButton ? 'left-64' : 'right-6'}`}
                  aria-label="回到输入框"
                >
                  <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M5 15l7-7 7 7" />
                  </svg>
                </button>
              )}
              {showAssistantButton && (
                <button
                  onClick={buttonConfig.onClick}
                  className="fixed bottom-6 right-6 z-40 flex items-center gap-1.5 px-4 py-3 bg-blue-600 text-white rounded-full shadow-lg hover:bg-blue-700 transition-all hover:scale-105 active:scale-95 group"
                >
                  <span className={`w-2 h-2 rounded-full ${buttonConfig.dotClass}`} />
                  <span className="text-sm font-medium">{buttonConfig.text}</span>
                  <svg className="w-4 h-4 transition-transform group-hover:translate-x-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                  </svg>
                </button>
              )}
            </>
          )
        })()}
      </>
    </ErrorBoundary>
  )
}
