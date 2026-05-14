export type TaskStatus = 'pending' | 'running' | 'success' | 'failed' | 'cancelled'

export interface ShoppingTask {
  id: number
  status: TaskStatus
  instruction: string
  parsedItems: string // JSON string of ParsedShoppingItem[]
  orderId: number | null
  platform: string
  createdAt: string
  completedAt: string | null
  error: string | null
}

export interface TaskStatusUpdate {
  taskId: number
  status: TaskStatus
  error?: string
  progress?: string
}
