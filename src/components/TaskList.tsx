import TaskCard from './TaskCard'

interface Task {
  id: number
  status: string
  instruction: string
  parsedItems: string
  createdAt: string
  completedAt: string | null
  error: string | null
  itemResults?: string | null
}

interface TaskListProps {
  tasks: Task[]
  loading: boolean
  onCancel: (id: number) => void
  onRetryItem: (taskId: number, itemName: string) => Promise<void>
}

export default function TaskList({ tasks, loading, onCancel, onRetryItem }: TaskListProps) {
  if (loading && tasks.length === 0) {
    return (
      <div className="text-center py-12 text-gray-400">
        <p className="text-sm">加载中...</p>
      </div>
    )
  }

  if (tasks.length === 0) {
    return (
      <div className="text-center py-12 text-gray-400" role="status">
        <p className="text-4xl mb-3" aria-hidden="true">🛒</p>
        <p className="text-sm">暂无购物任务</p>
        <p className="text-xs mt-1">在上方输入购物需求开始使用</p>
      </div>
    )
  }

  return (
    <div>
      <h3 className="text-sm font-medium text-gray-700 mb-3">任务列表</h3>
      <div className="space-y-3">
        {tasks.map((task) => (
          <TaskCard key={task.id} task={task} onCancel={onCancel} onRetryItem={onRetryItem} />
        ))}
      </div>
    </div>
  )
}
