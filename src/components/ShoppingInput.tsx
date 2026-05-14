import { useState } from 'react'

interface ShoppingInputProps {
  onSubmit: (instruction: string) => Promise<void>
  disabled?: boolean
}

export default function ShoppingInput({ onSubmit, disabled = false }: ShoppingInputProps) {
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
    <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-5">
      <h3 className="text-sm font-medium text-gray-700 mb-3">输入购物需求</h3>
      <div className="flex gap-3">
        <textarea
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder='例如：买两箱牛奶和一袋洗衣液'
          aria-label="输入购物需求"
          rows={2}
          className="flex-1 resize-none rounded-lg border border-gray-200 px-4 py-3 text-sm placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-shadow"
          disabled={loading || disabled}
        />
        <button
          onClick={handleSubmit}
          disabled={loading || disabled || !value.trim()}
          className="self-end px-6 py-3 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {loading ? '解析中...' : '解析需求'}
        </button>
      </div>
      {error && (
        <p className="text-sm text-red-500 mt-2">{error}</p>
      )}
    </div>
  )
}
