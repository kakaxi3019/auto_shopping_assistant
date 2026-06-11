export interface Order {
  id: number
  platform: string
  orderId: string
  productName: string
  productUrl: string
  price: number
  imageUrl: string
  purchasedAt: string
  shopName: string
  sku: string
  skuId: string
  rawData: string
  unavailable: number
}

export interface OrderRefMatch {
  orderRef: number
  confidence: number
}

export interface ParsedShoppingItem {
  name: string
  quantity: number
  sku?: string
  orderRef?: number
  platform?: string
  matchedOrders?: OrderRefMatch[]
}

export interface CandidateOrder {
  id: number
  productName: string
  price: number
  imageUrl: string
  platform: string
  purchasedAt: string
  shopName: string
  matchScore?: number
}

export type AmbiguityLevel = 'none' | 'low' | 'high'

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
  candidates?: CandidateOrder[]
  ambiguityLevel?: AmbiguityLevel
  totalMatchCount?: number
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
  currentPrice?: number
}

export interface CheckoutResult {
  success: boolean
  orderId?: string
  error?: string
  currentPrice?: number
}

export interface PayResult {
  success: boolean
  transactionId?: string
  error?: string
}

export interface SearchResult {
  title: string
  url: string
  price: number
  imageUrl: string
  shopName?: string
}

export type PaymentMode = 'cart_only' | 'checkout_only' | 'auto_pay'

export interface PlatformAdapter {
  name: string
  login(): Promise<boolean>
  isLoggedIn(): Promise<boolean>
  logout(): Promise<void>
  getCookieAge?(): string | null
  fetchOrderHistory(page?: number, timeRange?: { beginTime?: string; endTime?: string }): Promise<Order[]>
  searchOrders(keyword: string): Promise<Order[]>
  searchProduct(keyword: string): Promise<SearchResult[]>
  openSearchPage(keyword: string): Promise<string | null>
  getProductUrl(order: Order): string
  addToCart(productUrl: string, sku?: string, orderId?: string, cartOnly?: boolean, skuId?: string): Promise<AddToCartResult>
  openProductPage(productUrl: string): Promise<void>
  purchaseFromUrl(productUrl: string): Promise<AddToCartResult>
  checkout(directToPay?: boolean, quantity?: number): Promise<CheckoutResult>
  pay(totalAmount?: number, dryRun?: boolean, paymentMode?: string): Promise<PayResult>
  showPaymentWindow(title?: string, silent?: boolean): Promise<{ paid: boolean }>
  cleanup?(): Promise<void>
  onStatusChange(callback: (status: string) => void): () => void
  resolveConfirmation?(confirmed: boolean): Promise<void>
  reopenConfirmationWindow?(): Promise<void>
  setMainWindow?(win: any): void
  destroy?(): void
}
