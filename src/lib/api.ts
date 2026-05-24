declare global {
  interface Window {
    api: {
      isBackendReady: () => Promise<boolean>
      previewTask: (instruction: string) => Promise<unknown>
      confirmTask: (instruction: string, items: { name: string; quantity: number; sku?: string; orderRef?: number }[], platform?: string, dryRun?: boolean, paymentMode?: string) => Promise<unknown>
      createTask: (instruction: string) => Promise<unknown>
      listTasks: (status?: string) => Promise<unknown>
      cancelTask: (id: number) => Promise<unknown>
      retryTaskItem: (taskId: number, itemName: string) => Promise<unknown>
      confirmPayment: (taskId: number, itemName: string) => Promise<unknown>
      markUnpaid: (taskId: number, itemName: string) => Promise<unknown>
      deleteTask: (id: number) => Promise<unknown>
      deleteTasks: (ids: number[]) => Promise<unknown>
      clearHistory: () => Promise<unknown>
      login: (platform: string) => Promise<unknown>
      getAccountStatus: (platform: string) => Promise<unknown>
      logout: (platform: string) => Promise<unknown>
      syncOrders: (platform: string, timeRange?: { beginTime?: string; endTime?: string }) => Promise<unknown>
      cancelSync: (platform: string) => Promise<unknown>
      getOrders: (platform: string, limit?: number, offset?: number, unavailableFilter?: 'all' | 'excluded' | 'active') => Promise<unknown>
      getAllOrders: (limit?: number, offset?: number) => Promise<unknown>
      searchOrders: (keyword: string, unavailableFilter?: 'all' | 'excluded' | 'active') => Promise<unknown>
      getOrderCount: (platform: string, unavailableFilter?: 'all' | 'excluded' | 'active') => Promise<unknown>
      clearOrders: (platform: string) => Promise<unknown>
      deleteOrder: (id: number) => Promise<unknown>
      deleteOrders: (ids: number[]) => Promise<unknown>
      toggleOrderUnavailable: (id: number) => Promise<unknown>
      getUnavailableOrderIds: (ids: number[]) => Promise<unknown>
      setAllOrdersUnavailable: (platform: string, unavailable: boolean) => Promise<unknown>
      getSetting: (key: string) => Promise<unknown>
      setSetting: (key: string, value: string) => Promise<unknown>
      verifyLlm: () => Promise<unknown>
      fetchModels: () => Promise<unknown>
      createScheduledTask: (task: { name: string; instruction: string; repeatType: string; scheduledTime: string; dayOfWeek?: number; dayOfMonth?: number; paymentMode?: string; platform?: string }) => Promise<unknown>
      listScheduledTasks: () => Promise<unknown>
      updateScheduledTask: (id: number, updates: Record<string, unknown>) => Promise<unknown>
      deleteScheduledTask: (id: number) => Promise<unknown>
      batchUpdateScheduledTasks: (ids: number[], updates: Record<string, unknown>) => Promise<unknown>
      batchDeleteScheduledTasks: (ids: number[]) => Promise<unknown>
      listPendingConfirmations: (status?: string) => Promise<unknown>
      getPendingConfirmationById: (id: number) => Promise<unknown>
      resolvePendingConfirmation: (id: number) => Promise<unknown>
      dismissPendingConfirmation: (id: number) => Promise<unknown>
      getPendingConfirmationCount: () => Promise<unknown>
      markOrderUnavailable: (orderId: number) => Promise<unknown>
      confirmPurchaseFromSearch: (confirmationId: number, candidate: { platform: string; productName: string; price: number; imageUrl: string; productUrl: string; shopName?: string }) => Promise<unknown>
      purchaseCandidate: (confirmationId: number, productUrl: string, candidate: { platform: string; productName: string; price: number; imageUrl: string; productUrl: string; shopName?: string }, paymentMode: string) => Promise<unknown>
      onTaskStatusUpdate: (callback: (data: unknown) => void) => () => void
      onAppReady: (callback: () => void) => () => void
      onSyncStatusUpdate: (callback: (data: unknown) => void) => () => void
      onTaskNotificationClick: (callback: (data: { taskId: number }) => void) => () => void
      openInteractionWindow: (url: string, platform?: string) => Promise<unknown>
      openSearchInBrowser: (keyword: string, platform?: string) => Promise<unknown>
      confirmAction: (platform?: string) => Promise<unknown>
      rejectAction: (platform?: string) => Promise<unknown>
      reopenConfirmationWindow: (platform?: string) => Promise<unknown>
    }
  }
}

export const api = window.api
