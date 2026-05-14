export interface Order {
  id: number
  platform: string
  orderId: string
  productName: string
  productUrl: string
  price: number
  imageUrl: string
  purchasedAt: string
  rawData: string
}

export interface ParsedShoppingItem {
  name: string
  quantity: number
  sku?: string
  orderRef?: number
  platform?: string
}

export interface PreviewItem {
  name: string
  quantity: number
  sku?: string
  orderRef?: number
  matched: boolean
  matchedProduct?: string
  matchMethod?: 'llm_direct' | 'exact' | 'fuzzy'
  lastPrice?: number
  imageUrl?: string
  platform?: string
}

export interface TaskPreview {
  instruction: string
  items: PreviewItem[]
  platform: string
}

export interface AddToCartResult {
  success: boolean
  directToPay?: boolean
  error?: string
}

export interface CheckoutResult {
  success: boolean
  orderId?: string
  error?: string
}

export interface PayResult {
  success: boolean
  transactionId?: string
  error?: string
}

export interface PlatformAdapter {
  name: string
  login(): Promise<boolean>
  isLoggedIn(): Promise<boolean>
  logout(): Promise<void>
  getCookieAge?(): string | null
  fetchOrderHistory(page?: number, timeRange?: { beginTime?: string; endTime?: string }): Promise<Order[]>
  searchOrders(keyword: string): Promise<Order[]>
  getProductUrl(order: Order): string
  addToCart(productUrl: string, sku?: string, orderId?: string): Promise<AddToCartResult>
  checkout(directToPay?: boolean, quantity?: number): Promise<CheckoutResult>
  pay(totalAmount?: number, dryRun?: boolean): Promise<PayResult>
  cleanup?(): Promise<void>
  onStatusChange(callback: (status: string) => void): void
}
