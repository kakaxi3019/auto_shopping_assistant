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
  cancelSync: (platform: string) => ipcRenderer.invoke('orders:cancel-sync', platform),
  getOrders: (platform: string, limit?: number, offset?: number, unavailableFilter?: 'all' | 'excluded' | 'active') => ipcRenderer.invoke('orders:list', platform, limit, offset, unavailableFilter),
  getAllOrders: (limit?: number, offset?: number) => ipcRenderer.invoke('orders:list-all', limit, offset),
  searchOrders: (keyword: string, unavailableFilter?: 'all' | 'excluded' | 'active') => ipcRenderer.invoke('orders:search', keyword, unavailableFilter),
  getOrderCount: (platform: string, unavailableFilter?: 'all' | 'excluded' | 'active') => ipcRenderer.invoke('orders:count', platform, unavailableFilter),
  clearOrders: (platform: string) => ipcRenderer.invoke('orders:clear', platform),
  deleteOrder: (id: number) => ipcRenderer.invoke('orders:delete', id),
  deleteOrders: (ids: number[]) => ipcRenderer.invoke('orders:delete-batch', ids),
  toggleOrderUnavailable: (id: number) => ipcRenderer.invoke('orders:toggle-unavailable', id),
  getUnavailableOrderIds: (ids: number[]) => ipcRenderer.invoke('orders:get-unavailable-ids', ids),
  setAllOrdersUnavailable: (platform: string, unavailable: boolean) => ipcRenderer.invoke('orders:set-all-unavailable', platform, unavailable),

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
  openSearchInBrowser: (keyword: string, platform?: string) => ipcRenderer.invoke('platform:open-search-in-browser', keyword, platform),

  // Execution Cabin
  cabinStartScreencast: (platform?: string) => ipcRenderer.invoke('cabin:start-screencast', platform),
  cabinStopScreencast: (platform?: string) => ipcRenderer.invoke('cabin:stop-screencast', platform),
  cabinIsScreencasting: (platform?: string) => ipcRenderer.invoke('cabin:is-screencasting', platform),
  onCabinFrame: (callback: (base64Jpeg: string) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: string) => callback(data)
    ipcRenderer.on('cabin:frame', handler)
    return () => ipcRenderer.removeListener('cabin:frame', handler)
  },
  cabinSetCabinBounds: (bounds: { x: number; y: number; width: number; height: number }) => ipcRenderer.send('cabin:set-cabin-bounds', bounds),
  cabinSetMode: (mode: 'auto' | 'interactive') => ipcRenderer.send('cabin:set-mode', mode),
  cabinSetOpen: (open: boolean) => ipcRenderer.send('cabin:set-open', open),
  onCabinModeChange: (callback: (mode: 'auto' | 'interactive') => void) => {
    const handler = (_event: Electron.IpcRendererEvent, mode: 'auto' | 'interactive') => callback(mode)
    ipcRenderer.on('cabin:mode-change', handler)
    return () => ipcRenderer.removeListener('cabin:mode-change', handler)
  },
  onCabinInteractionUrl: (callback: (url: string) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, url: string) => callback(url)
    ipcRenderer.on('cabin:interaction-url', handler)
    return () => ipcRenderer.removeListener('cabin:interaction-url', handler)
  },
  onCabinCommand: (callback: (command: { id: string; type: string; payload: any }) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, command: { id: string; type: string; payload: any }) => callback(command)
    ipcRenderer.on('cabin:command', handler)
    return () => ipcRenderer.removeListener('cabin:command', handler)
  },
  cabinSendCommandResult: (commandId: string, result: { success: boolean; data?: any; error?: string }) => ipcRenderer.send('cabin:command-result', commandId, result),
  cabinReportNavigation: (url: string) => ipcRenderer.send('cabin:webview-navigated', url),
  onCabinPaymentInfo: (callback: (info: { amount: number; paymentMode: string } | null) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, info: { amount: number; paymentMode: string } | null) => callback(info)
    ipcRenderer.on('cabin:payment-info', handler)
    return () => ipcRenderer.removeListener('cabin:payment-info', handler)
  },
  cabinLog: (message: string) => ipcRenderer.send('cabin:log', message),
  cabinGetPreloadPath: () => ipcRenderer.invoke('cabin:get-preload-path'),
}

contextBridge.exposeInMainWorld('api', api)

export type Api = typeof api
