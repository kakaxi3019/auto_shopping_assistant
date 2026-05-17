import { createContext, useContext, useState, useCallback, useRef } from 'react'
import type { ReactNode } from 'react'

interface ToastItem {
  id: number
  message: string
  type: 'success' | 'error' | 'info'
  action?: { label: string; onClick: () => void }
}

interface ToastContextValue {
  showToast: (toast: Omit<ToastItem, 'id'>) => void
}

const ToastContext = createContext<ToastContextValue | null>(null)

export function useToast() {
  const ctx = useContext(ToastContext)
  if (!ctx) throw new Error('useToast must be used within ToastProvider')
  return ctx
}

const TOAST_DURATION_MS = 4000

export default function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([])
  const nextIdRef = useRef(0)

  const showToast = useCallback((toast: Omit<ToastItem, 'id'>) => {
    const id = nextIdRef.current++
    setToasts(prev => [...prev, { ...toast, id }])
    setTimeout(() => {
      setToasts(prev => prev.filter(t => t.id !== id))
    }, TOAST_DURATION_MS)
  }, [])

  const removeToast = useCallback((id: number) => {
    setToasts(prev => prev.filter(t => t.id !== id))
  }, [])

  return (
    <ToastContext.Provider value={{ showToast }}>
      {children}
      <div className="fixed bottom-6 right-6 z-50 flex flex-col gap-2 pointer-events-none">
        {toasts.map(toast => (
          <div
            key={toast.id}
            className="pointer-events-auto flex items-center gap-3 px-4 py-3 rounded-xl shadow-lg border bg-white animate-in slide-in-from-right fade-in duration-300 max-w-sm"
            style={{
              borderLeftWidth: 3,
              borderLeftColor: toast.type === 'success' ? '#22c55e' : toast.type === 'error' ? '#ef4444' : '#3b82f6',
            }}
          >
            <span className="text-sm flex-shrink-0">
              {toast.type === 'success' ? '✅' : toast.type === 'error' ? '❌' : 'ℹ️'}
            </span>
            <span className="text-sm text-gray-700 flex-1">{toast.message}</span>
            {toast.action && (
              <button
                onClick={() => { toast.action!.onClick(); removeToast(toast.id) }}
                className="text-sm font-medium text-blue-500 hover:text-blue-700 flex-shrink-0"
              >
                {toast.action.label}
              </button>
            )}
            <button
              onClick={() => removeToast(toast.id)}
              className="text-gray-300 hover:text-gray-500 flex-shrink-0 ml-1"
            >
              ✕
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  )
}
