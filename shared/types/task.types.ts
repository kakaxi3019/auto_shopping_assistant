import type { PaymentMode } from './platform.types'

export type TaskStatus = 'pending' | 'running' | 'success' | 'failed' | 'partial' | 'cancelled'

export interface ShoppingTask {
  id: number
  status: TaskStatus
  instruction: string
  parsedItems: string
  orderId: number | null
  platform: string
  paymentMode: PaymentMode
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

export interface PendingConfirmation {
  id: number
  taskId: number
  productName: string
  originalPrice: number
  failureReason: string
  searchKeyword: string
  candidates: string
  status: 'pending' | 'resolved' | 'dismissed'
  createdAt: string
  resolvedAt: string | null
  orderId: number | null
}
