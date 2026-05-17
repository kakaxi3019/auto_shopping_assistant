interface Task {
  id: number
  status: string
  instruction: string
  createdAt: string
}

interface DashboardProps {
  tasks: Task[]
  onScrollToTasks?: (filter?: string) => void
}

export default function Dashboard({ tasks, onScrollToTasks }: DashboardProps) {
  const stats = {
    total: tasks.length,
    success: tasks.filter((t) => t.status === 'success').length,
    running: tasks.filter((t) => ['running', 'pending', 'partial'].includes(t.status)).length,
    failed: tasks.filter((t) => t.status === 'failed').length,
    cancelled: tasks.filter((t) => t.status === 'cancelled').length,
  }

  const cards = [
    { label: '总任务', value: stats.total, color: 'bg-blue-500', action: onScrollToTasks ? () => onScrollToTasks() : undefined },
    { label: '已完成', value: stats.success, color: 'bg-green-500', action: onScrollToTasks ? () => onScrollToTasks('success') : undefined },
    { label: '执行中', value: stats.running, color: 'bg-amber-500', action: onScrollToTasks ? () => onScrollToTasks('running') : undefined },
    { label: '失败', value: stats.failed, color: 'bg-red-500', action: onScrollToTasks ? () => onScrollToTasks('failed') : undefined },
    { label: '已取消', value: stats.cancelled, color: 'bg-gray-400', action: onScrollToTasks ? () => onScrollToTasks('cancelled') : undefined },
  ]

  return (
    <div>
      <h2 className="text-lg font-semibold text-gray-800 mb-4">总览</h2>
      <div className="grid grid-cols-3 gap-4">
        {cards.map((card) => (
          <div
            key={card.label}
            onClick={card.action}
            className={`bg-white rounded-xl p-5 border border-gray-100 shadow-sm ${
              card.action ? 'cursor-pointer hover:shadow-md hover:border-gray-200 transition-all active:scale-[0.98]' : ''
            }`}
          >
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-gray-500">{card.label}</p>
                <p className="text-2xl font-bold text-gray-900 mt-1">{card.value}</p>
              </div>
              <div className={`w-10 h-10 ${card.color} rounded-lg opacity-80`} />
            </div>
            {card.action && card.value > 0 && (
              <p className="text-sm text-gray-400 mt-2">点击查看 →</p>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
