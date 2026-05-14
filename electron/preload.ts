import { contextBridge, ipcRenderer } from 'electron'

const api = {
  // App
  isBackendReady: () => ipcRenderer.invoke('app:is-ready'),

  // Tasks
  previewTask: (instruction: string) => ipcRenderer.invoke('task:preview', instruction),
  confirmTask: (instruction: string, items: { name: string; quantity: number; sku?: string; orderRef?: number }[], platform?: string, dryRun?: boolean) => ipcRenderer.invoke('task:confirm', instruction, items, platform, dryRun),
  createTask: (instruction: string) => ipcRenderer.invoke('task:create', instruction),
  listTasks: (status?: string) => ipcRenderer.invoke('task:list', status),
  cancelTask: (id: number) => ipcRenderer.invoke('task:cancel', id),
  retryTaskItem: (taskId: number, itemName: string) => ipcRenderer.invoke('task:retry-item', taskId, itemName),

  // Account
  login: (platform: string) => ipcRenderer.invoke('account:login', platform),
  getAccountStatus: (platform: string) => ipcRenderer.invoke('account:status', platform),
  logout: (platform: string) => ipcRenderer.invoke('account:logout', platform),

  // Orders
  syncOrders: (platform: string, timeRange?: { beginTime?: string; endTime?: string }) => ipcRenderer.invoke('orders:sync', platform, timeRange),
  getOrders: (platform: string, limit?: number, offset?: number) => ipcRenderer.invoke('orders:list', platform, limit, offset),
  searchOrders: (keyword: string) => ipcRenderer.invoke('orders:search', keyword),
  getOrderCount: (platform: string) => ipcRenderer.invoke('orders:count', platform),
  clearOrders: (platform: string) => ipcRenderer.invoke('orders:clear', platform),

  // Settings
  getSetting: (key: string) => ipcRenderer.invoke('settings:get', key),
  setSetting: (key: string, value: string) => ipcRenderer.invoke('settings:set', key, value),
  verifyLlm: () => ipcRenderer.invoke('settings:verify-llm'),
  fetchModels: () => ipcRenderer.invoke('settings:fetch-models'),

  // Scheduled Tasks
  createScheduledTask: (task: { name: string; instruction: string; repeatType: string; scheduledTime: string; dayOfWeek?: number; dayOfMonth?: number }) => ipcRenderer.invoke('scheduled:create', task),
  listScheduledTasks: () => ipcRenderer.invoke('scheduled:list'),
  updateScheduledTask: (id: number, updates: Record<string, unknown>) => ipcRenderer.invoke('scheduled:update', id, updates),
  deleteScheduledTask: (id: number) => ipcRenderer.invoke('scheduled:delete', id),

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
}

contextBridge.exposeInMainWorld('api', api)

export type Api = typeof api
