interface Task {
  id: number
  status: string
  instruction: string
  createdAt: string
}

interface DashboardProps {
  tasks: Task[]
}

export default function Dashboard({ tasks }: DashboardProps) {
  const stats = {
    total: tasks.length,
    success: tasks.filter((t) => t.status === 'success').length,
    running: tasks.filter((t) => t.status === 'running').length,
    failed: tasks.filter((t) => t.status === 'failed').length,
  }

  const cards = [
    { label: '总任务', value: stats.total, color: 'bg-blue-500' },
    { label: '成功', value: stats.success, color: 'bg-green-500' },
    { label: '执行中', value: stats.running, color: 'bg-amber-500' },
    { label: '失败', value: stats.failed, color: 'bg-red-500' },
  ]

  return (
    <div>
      <h2 className="text-lg font-semibold text-gray-800 mb-4">总览</h2>
      <div className="grid grid-cols-4 gap-4">
        {cards.map((card) => (
          <div
            key={card.label}
            className="bg-white rounded-xl p-5 border border-gray-100 shadow-sm"
          >
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-gray-500">{card.label}</p>
                <p className="text-2xl font-bold text-gray-900 mt-1">{card.value}</p>
              </div>
              <div className={`w-10 h-10 ${card.color} rounded-lg opacity-80`} />
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
