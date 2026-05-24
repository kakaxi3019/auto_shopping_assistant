import { contextBridge, ipcRenderer } from 'electron'

const api = {
  // App
  isBackendReady: () => ipcRenderer.invoke('app:is-ready'),

  // Tasks
  previewTask: (instruction: string) => ipcRenderer.invoke('task:preview', instruction),
  confirmTask: (instruction: string, items: { name: string; quantity: number; sku?: string; orderRef?: number }[], platform?: string, dryRun?: boolean, paymentMode?: string) => ipcRenderer.invoke('task:confirm', instruction, items, platform, dryRun, paymentMode),
  createTask: (instruction: string) => ipcRenderer.invoke('task:create', instruction),
  listTasks: (status?: string) => ipcRenderer.invoke('task:list', status),
  cancelTask: (id: number) => ipcRenderer.invoke('task:cancel', id),
  retryTaskItem: (taskId: number, itemName: string) => ipcRenderer.invoke('task:retry-item', taskId, itemName),
  confirmPayment: (taskId: number, itemName: string) => ipcRenderer.invoke('task:confirm-payment', taskId, itemName),
  markUnpaid: (taskId: number, itemName: string) => ipcRenderer.invoke('task:mark-unpaid', taskId, itemName),
  deleteTask: (id: number) => ipcRenderer.invoke('task:delete', id),
  deleteTasks: (ids: number[]) => ipcRenderer.invoke('task:delete-batch', ids),
  clearHistory: () => ipcRenderer.invoke('task:clear-history'),
  confirmAction: (platform?: string) => ipcRenderer.invoke('task:confirm-action', platform),
  rejectAction: (platform?: string) => ipcRenderer.invoke('task:reject-action', platform),
  reopenConfirmationWindow: (platform?: string) => ipcRenderer.invoke('task:reopen-confirmation-window', platform),

  // Account
  login: (platform: string) => ipcRenderer.invoke('account:login', platform),
  getAccountStatus: (platform: string) => ipcRenderer.invoke('account:status', platform),
  logout: (platform: string) => ipcRenderer.invoke('account:logout', platform),

  // Orders
  syncOrders: (platform: string, timeRange?: { beginTime?: string; endTime?: string }) => ipcRenderer.invoke('orders:sync', platform, timeRange),
  getOrders: (platform: string, limit?: number, offset?: number) => ipcRenderer.invoke('orders:list', platform, limit, offset),
  getAllOrders: (limit?: number, offset?: number) => ipcRenderer.invoke('orders:list-all', limit, offset),
  searchOrders: (keyword: string) => ipcRenderer.invoke('orders:search', keyword),
  getOrderCount: (platform: string) => ipcRenderer.invoke('orders:count', platform),
  clearOrders: (platform: string) => ipcRenderer.invoke('orders:clear', platform),
  deleteOrder: (id: number) => ipcRenderer.invoke('orders:delete', id),
  deleteOrders: (ids: number[]) => ipcRenderer.invoke('orders:delete-batch', ids),
  toggleOrderUnavailable: (id: number) => ipcRenderer.invoke('orders:toggle-unavailable', id),

  // Settings
  getSetting: (key: string) => ipcRenderer.invoke('settings:get', key),
  setSetting: (key: string, value: string) => ipcRenderer.invoke('settings:set', key, value),
  verifyLlm: () => ipcRenderer.invoke('settings:verify-llm'),
  fetchModels: () => ipcRenderer.invoke('settings:fetch-models'),

  // Scheduled Tasks
  createScheduledTask: (task: { name: string; instruction: string; repeatType: string; scheduledTime: string; dayOfWeek?: number; dayOfMonth?: number; paymentMode?: string; platform?: string }) => ipcRenderer.invoke('scheduled:create', task),
  listScheduledTasks: () => ipcRenderer.invoke('scheduled:list'),
  updateScheduledTask: (id: number, updates: Record<string, unknown>) => ipcRenderer.invoke('scheduled:update', id, updates),
  deleteScheduledTask: (id: number) => ipcRenderer.invoke('scheduled:delete', id),
  batchUpdateScheduledTasks: (ids: number[], updates: Record<string, unknown>) => ipcRenderer.invoke('scheduled:batch-update', ids, updates),
  batchDeleteScheduledTasks: (ids: number[]) => ipcRenderer.invoke('scheduled:batch-delete', ids),

  // Pending Confirmations
  listPendingConfirmations: (status?: string) => ipcRenderer.invoke('pending:list', status),
  getPendingConfirmationById: (id: number) => ipcRenderer.invoke('pending:get-by-id', id),
  resolvePendingConfirmation: (id: number) => ipcRenderer.invoke('pending:resolve', id),
  dismissPendingConfirmation: (id: number) => ipcRenderer.invoke('pending:dismiss', id),
  getPendingConfirmationCount: () => ipcRenderer.invoke('pending:count'),
  markOrderUnavailable: (orderId: number) => ipcRenderer.invoke('pending:mark-order-unavailable', orderId),
  confirmPurchaseFromSearch: (confirmationId: number, candidate: { platform: string; productName: string; price: number; imageUrl: string; productUrl: string; shopName?: string }) => ipcRenderer.invoke('pending:confirm-purchase', confirmationId, candidate),
  purchaseCandidate: (confirmationId: number, productUrl: string, candidate: { platform: string; productName: string; price: number; imageUrl: string; productUrl: string; shopName?: string }, paymentMode: string) => ipcRenderer.invoke('pending:purchase-candidate', confirmationId, productUrl, candidate, paymentMode),

  // Event listeners
  onTaskStatusUpdate: (callback: (data: unknown) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: unknown) => callback(data)
    ipcRenderer.on('task:status-update', handler)
    return () => ipcRenderer.removeListener('task:status-update', handler)
  },
  onAppReady: (callback: () => void) => {
    const handler = () => callback()
    ipcRenderer.on('app:ready', handler)
    return () => ipcRenderer.removeListener('app:ready', handler)
  },
  onSyncStatusUpdate: (callback: (data: unknown) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: unknown) => callback(data)
    ipcRenderer.on('sync:status-update', handler)
    return () => ipcRenderer.removeListener('sync:status-update', handler)
  },
  onTaskNotificationClick: (callback: (data: { taskId: number }) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: { taskId: number }) => callback(data)
    ipcRenderer.on('task:notification-click', handler)
    return () => ipcRenderer.removeListener('task:notification-click', handler)
  },
  openInteractionWindow: (url: string, platform?: string) => ipcRenderer.invoke('window:open-interaction', url, platform),
}

contextBridge.exposeInMainWorld('api', api)

export type Api = typeof api
