import { useState, useEffect } from 'react'
import { api } from '../lib/api'
import { PLATFORM_CONFIGS } from '@shared/platforms'
import PlatformLogo from './PlatformLogo'

type RepeatType = 'once' | 'daily' | 'weekly' | 'monthly'
type PaymentMode = '' | 'cart_only' | 'checkout_only' | 'auto_pay'

interface ScheduledTask {
  id: number
  name: string
  instruction: string
  repeatType: RepeatType
  scheduledTime: string
  dayOfWeek: number | null
  dayOfMonth: number | null
  enabled: number
  lastRunAt: string | null
  nextRunAt: string | null
  createdAt: string
  paymentMode: string
  platform: string
}

const PLATFORM_OPTIONS: { value: string; label: string; icon: string }[] = [
  { value: '', label: '自动选择', icon: '🤖' },
  ...PLATFORM_CONFIGS.map(p => ({ value: p.key, label: p.name, icon: p.icon }))
]

const REPEAT_LABELS: Record<RepeatType, string> = {
  once: '单次',
  daily: '每天',
  weekly: '每周',
  monthly: '每月',
}

const PAYMENT_MODE_OPTIONS: { value: PaymentMode; label: string; icon: string; desc: string }[] = [
  { value: '', label: '跟随设置', icon: '⚙️', desc: '使用全局设置中的支付模式' },
  { value: 'cart_only', label: '仅加购', icon: '🛒', desc: '只加入购物车，不结算' },
  { value: 'checkout_only', label: '确认后支付', icon: '📋', desc: '自动结算，支付前需确认' },
  { value: 'auto_pay', label: '自动支付', icon: '💳', desc: '全自动完成支付' },
]

const WEEKDAY_LABELS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

export default function ScheduledTasks({
  initialDraft,
  onDraftHandled,
}: {
  initialDraft?: { name: string; instruction: string; platform?: string } | null
  onDraftHandled?: () => void
}) {
  const [tasks, setTasks] = useState<ScheduledTask[]>([])
  const [showForm, setShowForm] = useState(false)
  const [editingId, setEditingId] = useState<number | null>(null)
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set())
  const [showBatchDeleteConfirm, setShowBatchDeleteConfirm] = useState(false)

  const [name, setName] = useState('')
  const [instruction, setInstruction] = useState('')
  const [repeatType, setRepeatType] = useState<RepeatType>('once')
  const [scheduledTime, setScheduledTime] = useState('')
  const [dayOfWeek, setDayOfWeek] = useState(1)
  const [dayOfMonth, setDayOfMonth] = useState(1)
  const [paymentMode, setPaymentMode] = useState<PaymentMode>('')
  const [platform, setPlatform] = useState('')
  useEffect(() => {
    loadTasks()
  }, [])

  useEffect(() => {
    if (initialDraft) {
      setName(initialDraft.name)
      setInstruction(initialDraft.instruction)
      if (initialDraft.platform) {
        setPlatform(initialDraft.platform)
      }
      setShowForm(true)
      onDraftHandled?.()
    }
  }, [initialDraft, onDraftHandled])

  const loadTasks = async () => {
    const list = await api.listScheduledTasks()
    setTasks(list as ScheduledTask[])
  }

  const resetForm = () => {
    setName('')
    setInstruction('')
    setRepeatType('once')
    setScheduledTime('')
    setDayOfWeek(1)
    setDayOfMonth(1)
    setPaymentMode('')
    setPlatform('')
    setEditingId(null)
    setShowForm(false)
  }

  const handleEdit = (task: ScheduledTask) => {
    setEditingId(task.id)
    setName(task.name)
    setInstruction(task.instruction)
    setRepeatType(task.repeatType)
    const timeVal = task.scheduledTime.includes('T')
      ? task.scheduledTime.replace(' ', 'T').substring(0, 16)
      : task.scheduledTime.replace(' ', 'T').substring(0, 16)
    setScheduledTime(timeVal)
    setDayOfWeek(task.dayOfWeek ?? 1)
    setDayOfMonth(task.dayOfMonth ?? 1)
    setPaymentMode((task.paymentMode || '') as PaymentMode)
    setPlatform(task.platform || '')
    setShowForm(true)
  }

  const handleSave = async () => {
    if (!name.trim() || !instruction.trim() || !scheduledTime) return

    const scheduledTimeStr = scheduledTime.replace('T', ' ') + ':00'

    if (editingId) {
      await api.updateScheduledTask(editingId, {
        name, instruction, repeatType, scheduledTime: scheduledTimeStr,
        dayOfWeek: repeatType === 'weekly' ? dayOfWeek : undefined,
        dayOfMonth: repeatType === 'monthly' ? dayOfMonth : undefined,
        nextRunAt: scheduledTimeStr,
        paymentMode,
        platform,
      })
    } else {
      await api.createScheduledTask({
        name, instruction, repeatType, scheduledTime: scheduledTimeStr,
        dayOfWeek: repeatType === 'weekly' ? dayOfWeek : undefined,
        dayOfMonth: repeatType === 'monthly' ? dayOfMonth : undefined,
        paymentMode,
        platform,
      })
    }

    resetForm()
    loadTasks()
  }

  const handleDelete = async (id: number) => {
    await api.deleteScheduledTask(id)
    loadTasks()
  }

  const handleToggle = async (task: ScheduledTask) => {
    await api.updateScheduledTask(task.id, { enabled: !task.enabled })
    loadTasks()
  }

  const toggleSelect = (id: number) => {
    setSelectedIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) {
        next.delete(id)
      } else {
        next.add(id)
      }
      return next
    })
  }

  const toggleSelectAll = () => {
    if (selectedIds.size === tasks.length) {
      setSelectedIds(new Set())
    } else {
      setSelectedIds(new Set(tasks.map(t => t.id)))
    }
  }

  const handleBatchEnable = async () => {
    const ids = Array.from(selectedIds)
    if (ids.length === 0) return
    await api.batchUpdateScheduledTasks(ids, { enabled: true })
    setSelectedIds(new Set())
    loadTasks()
  }

  const handleBatchPause = async () => {
    const ids = Array.from(selectedIds)
    if (ids.length === 0) return
    await api.batchUpdateScheduledTasks(ids, { enabled: false })
    setSelectedIds(new Set())
    loadTasks()
  }

  const handleBatchDelete = async () => {
    const ids = Array.from(selectedIds)
    if (ids.length === 0) return
    await api.batchDeleteScheduledTasks(ids)
    setSelectedIds(new Set())
    setShowBatchDeleteConfirm(false)
    loadTasks()
  }

  const clearSelection = () => {
    setSelectedIds(new Set())
  }

  const formatNextRun = (task: ScheduledTask) => {
    if (!task.enabled) return '已暂停'
    if (!task.nextRunAt) return '-'
    const d = new Date(task.nextRunAt.replace(' ', 'T'))
    return d.toLocaleString('zh-CN')
  }

  const formatRepeatInfo = (task: ScheduledTask) => {
    if (task.repeatType === 'weekly' && task.dayOfWeek != null) {
      return `${REPEAT_LABELS[task.repeatType]}${WEEKDAY_LABELS[task.dayOfWeek]}`
    }
    if (task.repeatType === 'monthly' && task.dayOfMonth != null) {
      return `${REPEAT_LABELS[task.repeatType]}${task.dayOfMonth}号`
    }
    return REPEAT_LABELS[task.repeatType]
  }

  const getPaymentModeLabel = (mode: string) => {
    const opt = PAYMENT_MODE_OPTIONS.find(o => o.value === mode)
    return opt ? `${opt.icon} ${opt.label}` : '⚙️ 跟随设置'
  }

  const allSelected = tasks.length > 0 && selectedIds.size === tasks.length
  const someSelected = selectedIds.size > 0 && !allSelected

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-lg font-semibold text-gray-800">定时任务</h2>
        <button
          onClick={() => { resetForm(); setShowForm(true) }}
          className="px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 transition-colors"
        >
          + 新建定时任务
        </button>
      </div>

      {showForm && (
        <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-6 mb-6 max-w-lg space-y-4">
          <h3 className="text-sm font-medium text-gray-700">
            {editingId ? '编辑定时任务' : '新建定时任务'}
          </h3>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">任务名称</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="如：每周买牛奶"
              className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">购物需求</label>
            <textarea
              value={instruction}
              onChange={(e) => setInstruction(e.target.value)}
              placeholder="如：买两箱牛奶和一袋洗衣液"
              rows={2}
              className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">重复方式</label>
            <div className="flex gap-2">
              {(Object.entries(REPEAT_LABELS) as [RepeatType, string][]).map(([key, label]) => (
                <button
                  key={key}
                  onClick={() => setRepeatType(key)}
                  className={`px-3 py-1.5 text-sm rounded-lg transition-colors ${
                    repeatType === key
                      ? 'bg-blue-600 text-white'
                      : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">执行时间</label>
            {repeatType === 'once' ? (
              <input
                type="datetime-local"
                value={scheduledTime}
                onChange={(e) => setScheduledTime(e.target.value)}
                className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            ) : (
              <input
                type="time"
                value={scheduledTime ? scheduledTime.split('T')[1]?.substring(0, 5) || '09:00' : '09:00'}
                onChange={(e) => {
                  const today = new Date()
                  const dateStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
                  setScheduledTime(`${dateStr}T${e.target.value}`)
                }}
                className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            )}
          </div>

          {repeatType === 'weekly' && (
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">每周几</label>
              <div className="flex gap-1.5">
                {WEEKDAY_LABELS.map((label, i) => (
                  <button
                    key={i}
                    onClick={() => setDayOfWeek(i)}
                    className={`w-10 h-8 text-sm rounded-lg transition-colors ${
                      dayOfWeek === i
                        ? 'bg-blue-600 text-white'
                        : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                    }`}
                  >
                    {label.replace('周', '')}
                  </button>
                ))}
              </div>
            </div>
          )}

          {repeatType === 'monthly' && (
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">每月几号</label>
              <input
                type="number"
                min="1"
                max="31"
                value={dayOfMonth}
                onChange={(e) => setDayOfMonth(Number(e.target.value))}
                className="w-24 px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
          )}

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">购物平台</label>
            <div className="flex gap-2">
              {PLATFORM_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  onClick={() => setPlatform(opt.value)}
                  className={`px-3 py-1.5 text-sm rounded-lg transition-colors flex items-center justify-center gap-1.5 ${
                    platform === opt.value
                      ? 'bg-blue-600 text-white font-medium'
                      : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                  }`}
                >
                  {opt.value ? (
                    <PlatformLogo platformKey={opt.value} size="sm" className="w-5 h-5 !rounded" />
                  ) : (
                    <span className="text-base">🤖</span>
                  )}
                  <span>{opt.label}</span>
                </button>
              ))}
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">支付模式</label>
            <div className="grid grid-cols-2 gap-2">
              {PAYMENT_MODE_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  onClick={() => setPaymentMode(opt.value)}
                  className={`px-3 py-2 text-sm rounded-lg transition-colors text-left ${
                    paymentMode === opt.value
                      ? 'bg-blue-600 text-white'
                      : 'bg-gray-50 text-gray-600 hover:bg-gray-100 border border-gray-200'
                  }`}
                >
                  <span className="font-medium">{opt.icon} {opt.label}</span>
                  <p className={`text-xs mt-0.5 ${paymentMode === opt.value ? 'text-blue-100' : 'text-gray-400'}`}>
                    {opt.desc}
                  </p>
                </button>
              ))}
            </div>
          </div>

          <div className="flex gap-3">
            <button
              onClick={handleSave}
              disabled={!name.trim() || !instruction.trim() || !scheduledTime}
              className="flex-1 px-4 py-2.5 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {editingId ? '保存修改' : '创建任务'}
            </button>
            <button
              onClick={resetForm}
              className="flex-1 px-4 py-2.5 bg-gray-100 text-gray-700 text-sm font-medium rounded-lg hover:bg-gray-200 transition-colors"
            >
              取消
            </button>
          </div>
        </div>
      )}

      {tasks.length === 0 ? (
        <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-12 text-center" role="status">
          <p className="text-3xl mb-3" aria-hidden="true">⏰</p>
          <p className="text-sm text-gray-500">暂无定时任务</p>
          <p className="text-sm text-gray-400 mt-1">点击"新建定时任务"设置自动购买计划</p>
        </div>
      ) : (
        <>
          {selectedIds.size > 0 && (
            <div className="bg-blue-50 border border-blue-200 rounded-xl p-4 mb-4 flex items-center justify-between">
              <div className="flex items-center gap-3">
                <span className="text-sm font-medium text-blue-700">
                  已选择 {selectedIds.size} 项
                </span>
                <button
                  onClick={clearSelection}
                  className="text-xs text-blue-500 hover:text-blue-700 transition-colors"
                >
                  取消选择
                </button>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={handleBatchEnable}
                  className="px-3 py-1.5 text-sm rounded-lg bg-green-50 text-green-600 hover:bg-green-100 transition-colors font-medium"
                >
                  批量启用
                </button>
                <button
                  onClick={handleBatchPause}
                  className="px-3 py-1.5 text-sm rounded-lg bg-amber-50 text-amber-600 hover:bg-amber-100 transition-colors font-medium"
                >
                  批量暂停
                </button>
                <button
                  onClick={() => setShowBatchDeleteConfirm(true)}
                  className="px-3 py-1.5 text-sm rounded-lg bg-red-50 text-red-600 hover:bg-red-100 transition-colors font-medium"
                >
                  批量删除
                </button>
              </div>
            </div>
          )}

          {showBatchDeleteConfirm && (
            <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50" onClick={() => setShowBatchDeleteConfirm(false)}>
              <div className="bg-white rounded-xl p-6 max-w-sm w-full mx-4 shadow-xl" onClick={(e) => e.stopPropagation()}>
                <h3 className="text-base font-semibold text-gray-900 mb-2">确认批量删除</h3>
                <p className="text-sm text-gray-500 mb-5">
                  确定要删除选中的 {selectedIds.size} 个定时任务吗？此操作不可撤销。
                </p>
                <div className="flex gap-3">
                  <button
                    onClick={handleBatchDelete}
                    className="flex-1 px-4 py-2.5 bg-red-600 text-white text-sm font-medium rounded-lg hover:bg-red-700 transition-colors"
                  >
                    确认删除
                  </button>
                  <button
                    onClick={() => setShowBatchDeleteConfirm(false)}
                    className="flex-1 px-4 py-2.5 bg-gray-100 text-gray-700 text-sm font-medium rounded-lg hover:bg-gray-200 transition-colors"
                  >
                    取消
                  </button>
                </div>
              </div>
            </div>
          )}

          <div className="bg-white rounded-xl border border-gray-100 shadow-sm px-5 py-3 mb-3 flex items-center gap-3">
            <input
              type="checkbox"
              checked={allSelected}
              ref={(el) => {
                if (el) el.indeterminate = someSelected
              }}
              onChange={toggleSelectAll}
              className="w-4 h-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500 cursor-pointer"
            />
            <span className="text-sm text-gray-500">
              {allSelected ? '取消全选' : '全选'}
            </span>
          </div>

          <div className="space-y-3">
            {tasks.map((task) => (
              <div
                key={task.id}
                className={`bg-white rounded-xl border shadow-sm p-5 transition-colors ${
                  selectedIds.has(task.id) ? 'border-blue-300 ring-1 ring-blue-200' : 'border-gray-100'
                } ${!selectedIds.has(task.id) && !task.enabled ? 'opacity-60' : ''}`}
              >
                <div className="flex items-start justify-between gap-4">
                  <div className="flex items-start gap-3 flex-1 min-w-0">
                    <input
                      type="checkbox"
                      checked={selectedIds.has(task.id)}
                      onChange={() => toggleSelect(task.id)}
                      className="w-4 h-4 mt-0.5 rounded border-gray-300 text-blue-600 focus:ring-blue-500 cursor-pointer flex-shrink-0"
                    />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1 flex-wrap">
                        <h3 className="text-sm font-medium text-gray-900">{task.name}</h3>
                        <span className={`px-2 py-0.5 text-sm rounded-full font-medium ${
                          task.enabled
                            ? 'bg-green-50 text-green-600'
                            : 'bg-gray-100 text-gray-400'
                        }`}>
                          {task.enabled ? '启用' : '暂停'}
                        </span>
                        <span className="px-2 py-0.5 text-sm rounded-full bg-blue-50 text-blue-600 font-medium">
                          {formatRepeatInfo(task)}
                        </span>
                        <span className="px-2 py-0.5 text-sm rounded-full bg-purple-50 text-purple-600 font-medium">
                          {getPaymentModeLabel(task.paymentMode)}
                        </span>
                        {task.platform ? (
                          <span className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 text-xs rounded-full font-medium ${
                            task.platform === 'taobao' ? 'bg-orange-50 text-orange-600 border border-orange-100' :
                            task.platform === 'jd' ? 'bg-red-50 text-red-600 border border-red-100' :
                            task.platform === 'pdd' ? 'bg-pink-50 text-pink-600 border border-pink-100' :
                            'bg-gray-50 text-gray-600 border border-gray-100'
                          }`}>
                            <PlatformLogo platformKey={task.platform} size="sm" className="w-4 h-4 !rounded" />
                            {PLATFORM_OPTIONS.find(p => p.value === task.platform)?.label || task.platform}
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 px-2.5 py-0.5 text-xs rounded-full bg-blue-50 text-blue-600 border border-blue-100 font-medium">
                            🤖 自动选择
                          </span>
                        )}
                      </div>
                      <p className="text-sm text-gray-500 mb-2">{task.instruction}</p>
                      <div className="flex items-center gap-4 text-sm text-gray-400">
                        <span>下次执行: {formatNextRun(task)}</span>
                        {task.lastRunAt && (
                          <span>上次执行: {new Date(task.lastRunAt.replace(' ', 'T')).toLocaleString('zh-CN')}</span>
                        )}
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 flex-shrink-0">
                    <button
                      onClick={() => handleToggle(task)}
                      className={`px-3 py-1.5 text-sm rounded-lg transition-colors ${
                        task.enabled
                          ? 'bg-amber-50 text-amber-600 hover:bg-amber-100'
                          : 'bg-green-50 text-green-600 hover:bg-green-100'
                      }`}
                    >
                      {task.enabled ? '暂停' : '启用'}
                    </button>
                    <button
                      onClick={() => handleEdit(task)}
                      className="px-3 py-1.5 text-sm rounded-lg bg-gray-50 text-gray-600 hover:bg-gray-100 transition-colors"
                    >
                      编辑
                    </button>
                    <button
                      onClick={() => handleDelete(task.id)}
                      className="px-3 py-1.5 text-sm rounded-lg bg-red-50 text-red-600 hover:bg-red-100 transition-colors"
                    >
                      删除
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  )
}
