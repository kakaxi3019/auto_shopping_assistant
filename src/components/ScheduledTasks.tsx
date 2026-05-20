import { useState, useEffect } from 'react'
import { api } from '../lib/api'

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
}

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

export default function ScheduledTasks() {
  const [tasks, setTasks] = useState<ScheduledTask[]>([])
  const [showForm, setShowForm] = useState(false)
  const [editingId, setEditingId] = useState<number | null>(null)

  const [name, setName] = useState('')
  const [instruction, setInstruction] = useState('')
  const [repeatType, setRepeatType] = useState<RepeatType>('once')
  const [scheduledTime, setScheduledTime] = useState('')
  const [dayOfWeek, setDayOfWeek] = useState(1)
  const [dayOfMonth, setDayOfMonth] = useState(1)
  const [paymentMode, setPaymentMode] = useState<PaymentMode>('')

  useEffect(() => {
    loadTasks()
  }, [])

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
      })
    } else {
      await api.createScheduledTask({
        name, instruction, repeatType, scheduledTime: scheduledTimeStr,
        dayOfWeek: repeatType === 'weekly' ? dayOfWeek : undefined,
        dayOfMonth: repeatType === 'monthly' ? dayOfMonth : undefined,
        paymentMode,
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
            <input
              type="datetime-local"
              value={scheduledTime}
              onChange={(e) => setScheduledTime(e.target.value)}
              className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
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
        <div className="space-y-3">
          {tasks.map((task) => (
            <div
              key={task.id}
              className={`bg-white rounded-xl border shadow-sm p-5 transition-colors ${
                task.enabled ? 'border-gray-100' : 'border-gray-100 opacity-60'
              }`}
            >
              <div className="flex items-start justify-between gap-4">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
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
                  </div>
                  <p className="text-sm text-gray-500 mb-2">{task.instruction}</p>
                  <div className="flex items-center gap-4 text-sm text-gray-400">
                    <span>下次执行: {formatNextRun(task)}</span>
                    {task.lastRunAt && (
                      <span>上次执行: {new Date(task.lastRunAt.replace(' ', 'T')).toLocaleString('zh-CN')}</span>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-2">
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
      )}
    </div>
  )
}
