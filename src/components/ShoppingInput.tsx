import { useState } from 'react'

interface RecentTask {
  instruction: string
}

interface ShoppingInputProps {
  onSubmit: (instruction: string) => Promise<void>
  disabled?: boolean
  recentTasks?: RecentTask[]
  previewOpen?: boolean
}

export default function ShoppingInput({ onSubmit, disabled = false, recentTasks = [], previewOpen = false }: ShoppingInputProps) {
  const [value, setValue] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const handleSubmit = async () => {
    const trimmed = value.trim()
    if (!trimmed) return

    setLoading(true)
    setError('')
    try {
      await onSubmit(trimmed)
      setValue('')
    } catch (e) {
      setError(e instanceof Error ? e.message : '提交失败')
    } finally {
      setLoading(false)
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSubmit()
    }
  }

  return (
    <div className={`bg-white rounded-xl border shadow-sm p-5 transition-all ${previewOpen ? 'border-blue-300 ring-2 ring-blue-100' : 'border-gray-100'}`}>
      <div className="flex gap-3">
        <div className="flex-1">
          <textarea
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder='说一声，帮你买 →  例如：再买一箱牛奶'
            aria-label="输入购物需求"
            rows={2}
            className="w-full resize-none rounded-lg border border-gray-200 px-4 py-3 text-sm placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-shadow"
            disabled={loading || disabled}
          />
        </div>
        <button
          onClick={handleSubmit}
          disabled={loading || disabled || !value.trim()}
          className="self-end px-6 py-3 bg-gradient-to-r from-blue-500 to-blue-600 text-white text-sm font-semibold rounded-lg hover:from-blue-600 hover:to-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-all shadow-sm hover:shadow-md active:scale-[0.98]"
        >
          {loading ? (
            <span className="flex items-center gap-1.5">
              <span className="w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full animate-spin" />
              匹配中...
            </span>
          ) : '帮我买'}
        </button>
      </div>
      {error && (
        <p className="text-sm text-red-500 mt-2">{error}</p>
      )}
      {recentTasks.length > 0 && (
        <div className="mt-3">
          <div className="flex items-center gap-2 mb-1.5">
            <span className="text-xs text-gray-400">💡 猜你想买</span>
          </div>
          <div className="flex gap-2 overflow-x-auto scrollbar-hide pb-1">
            {recentTasks.map((task, i) => (
              <button
                key={i}
                onClick={() => { setValue(task.instruction) }}
                disabled={loading || disabled}
                className="px-3 py-1.5 text-sm text-gray-600 bg-gray-50 border border-gray-200 rounded-full hover:bg-blue-50 hover:text-blue-600 hover:border-blue-200 disabled:opacity-50 transition-colors whitespace-nowrap flex-shrink-0"
                title={task.instruction}
              >
                {task.instruction}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
