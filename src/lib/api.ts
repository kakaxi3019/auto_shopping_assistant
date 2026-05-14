declare global {
  interface Window {
    api: {
      isBackendReady: () => Promise<boolean>
      previewTask: (instruction: string) => Promise<unknown>
      confirmTask: (instruction: string, items: { name: string; quantity: number; sku?: string; orderRef?: number }[], platform?: string, dryRun?: boolean) => Promise<unknown>
      createTask: (instruction: string) => Promise<unknown>
      listTasks: (status?: string) => Promise<unknown>
      cancelTask: (id: number) => Promise<unknown>
      retryTaskItem: (taskId: number, itemName: string) => Promise<unknown>
      login: (platform: string) => Promise<unknown>
      getAccountStatus: (platform: string) => Promise<unknown>
      logout: (platform: string) => Promise<unknown>
      syncOrders: (platform: string, timeRange?: { beginTime?: string; endTime?: string }) => Promise<unknown>
      getOrders: (platform: string, limit?: number, offset?: number) => Promise<unknown>
      searchOrders: (keyword: string) => Promise<unknown>
      getOrderCount: (platform: string) => Promise<unknown>
      clearOrders: (platform: string) => Promise<unknown>
      getSetting: (key: string) => Promise<unknown>
      setSetting: (key: string, value: string) => Promise<unknown>
      verifyLlm: () => Promise<unknown>
      fetchModels: () => Promise<unknown>
      createScheduledTask: (task: { name: string; instruction: string; repeatType: string; scheduledTime: string; dayOfWeek?: number; dayOfMonth?: number }) => Promise<unknown>
      listScheduledTasks: () => Promise<unknown>
      updateScheduledTask: (id: number, updates: Record<string, unknown>) => Promise<unknown>
      deleteScheduledTask: (id: number) => Promise<unknown>
      onTaskStatusUpdate: (callback: (data: unknown) => void) => () => void
      onAppReady: (callback: () => void) => () => void
      onSyncStatusUpdate: (callback: (data: unknown) => void) => () => void
    }
  }
}

export const api = window.api
