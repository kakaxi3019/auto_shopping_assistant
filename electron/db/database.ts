import initSqlJs, { type Database as SqlJsDatabase } from 'sql.js'
import { join } from 'path'
import { app, safeStorage } from 'electron'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { MIGRATIONS, MIGRATION_V2, MIGRATION_V3, MIGRATION_V4, MIGRATION_V5, MIGRATION_V6, MIGRATION_V7, MIGRATION_V8, MIGRATION_V9, MIGRATION_V10, MIGRATION_V11, MIGRATION_V12, MIGRATION_V13, MIGRATION_V14, MIGRATION_V15 } from './migrations'
import type { ShoppingTask, PendingConfirmation } from '../../shared/types/task.types'
import type { Order } from '../../shared/types/platform.types'

const MIGRATION_VERSION = 15

const SENSITIVE_KEYS = new Set(['openai_api_key', 'anthropic_api_key'])

function toCamelCase(obj: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(obj)) {
    const camelKey = key.replace(/_([a-z])/g, (_, c) => c.toUpperCase())
    result[camelKey] = typeof value === 'bigint' ? Number(value) : value
  }
  return result
}

export class Database {
  private db!: SqlJsDatabase
  private dbPath: string
  private ready: Promise<void>
  private saveTimer: NodeJS.Timeout | null = null
  private pendingSave = false

  private withStmt<T>(sql: string, fn: (stmt: ReturnType<SqlJsDatabase['prepare']>) => T): T {
    const stmt = this.db.prepare(sql)
    try {
      return fn(stmt)
    } finally {
      stmt.free()
    }
  }

  constructor() {
    this.dbPath = join(app.getPath('userData'), 'auto-shopping.db')
    this.ready = this.init()
  }

  private async init() {
    const startTime = Date.now()
    console.log('[DB] Initializing database...')

    const isDev = !!process.env.VITE_DEV_SERVER_URL
    let wasmPath: string
    if (isDev) {
      wasmPath = join(process.cwd(), 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm')
    } else {
      const resWasmPath1 = join(process.resourcesPath, 'sql-wasm.wasm')
      const resWasmPath2 = join(process.resourcesPath, 'sql.js', 'sql-wasm.wasm')
      const asarWasmPath = join(__dirname, '../node_modules/sql.js/dist/sql-wasm.wasm')
      if (existsSync(resWasmPath1)) {
        wasmPath = resWasmPath1
      } else if (existsSync(resWasmPath2)) {
        wasmPath = resWasmPath2
      } else {
        wasmPath = asarWasmPath
      }
    }

    const SQL = await initSqlJs({
      locateFile: () => wasmPath,
    })

    if (existsSync(this.dbPath)) {
      const buffer = readFileSync(this.dbPath)
      this.db = new SQL.Database(buffer)
      console.log('[DB] Loaded existing database')
    } else {
      this.db = new SQL.Database()
      console.log('[DB] Created new database')
    }

    this.ensureMigrationTable()
    this.runMigrations()

    console.log(`[DB] Database ready in ${Date.now() - startTime}ms`)
  }

  private ensureMigrationTable() {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
      )
    `)
  }

  private getMigrationVersion(): number {
    return this.withStmt('SELECT MAX(version) as max_version FROM schema_migrations', (stmt) => {
      if (stmt.step()) {
        return (stmt.getAsObject().max_version as number | null) || 0
      }
      return 0
    })
  }

  private runMigrations() {
    const currentVersion = this.getMigrationVersion()

    if (currentVersion >= MIGRATION_VERSION) {
      return
    }

    if (currentVersion < 1) {
      for (const sql of MIGRATIONS) {
        this.db.run(sql)
      }
    }

    if (currentVersion < 2) {
      for (const sql of MIGRATION_V2) {
        this.db.run(sql)
      }
    }

    if (currentVersion < 3) {
      for (const sql of MIGRATION_V3) {
        this.db.run(sql)
      }
    }

    if (currentVersion < 4) {
      for (const sql of MIGRATION_V4) {
        this.db.run(sql)
      }
    }

    if (currentVersion < 5) {
      for (const sql of MIGRATION_V5) {
        this.db.run(sql)
      }
    }

    if (currentVersion < 6) {
      for (const sql of MIGRATION_V6) {
        this.db.run(sql)
      }
    }

    if (currentVersion < 7) {
      for (const sql of MIGRATION_V7) {
        this.db.run(sql)
      }
    }

    if (currentVersion < 8) {
      for (const sql of MIGRATION_V8) {
        this.db.run(sql)
      }
    }

    if (currentVersion < 9) {
      for (const sql of MIGRATION_V9) {
        this.db.run(sql)
      }
    }

    if (currentVersion < 10) {
      for (const sql of MIGRATION_V10) {
        this.db.run(sql)
      }
    }

    if (currentVersion < 11) {
      for (const sql of MIGRATION_V11) {
        this.db.run(sql)
      }
    }

    if (currentVersion < 12) {
      for (const sql of MIGRATION_V12) {
        this.db.run(sql)
      }
    }

    if (currentVersion < 13) {
      for (const sql of MIGRATION_V13) {
        this.db.run(sql)
      }
    }

    if (currentVersion < 14) {
      for (const sql of MIGRATION_V14) {
        this.db.run(sql)
      }
    }

    if (currentVersion < 15) {
      for (const sql of MIGRATION_V15) {
        this.db.run(sql)
      }
    }

    this.db.run('INSERT INTO schema_migrations (version) VALUES (?)', [MIGRATION_VERSION])
    this.saveImmediate()
  }

  private scheduleSave() {
    this.pendingSave = true
    if (this.saveTimer) {
      return
    }
    this.saveTimer = setTimeout(() => {
      this.saveImmediate()
    }, 500)
  }

  private saveImmediate() {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer)
      this.saveTimer = null
    }
    if (!this.pendingSave) {
      return
    }
    this.pendingSave = false
    try {
      const data = this.db.export()
      writeFileSync(this.dbPath, Buffer.from(data))
    } catch (e) {
      console.error('Failed to save database:', e)
    }
  }

  async waitReady() {
    await this.ready
  }

  getOrders(platform: string, limit = 100, offset = 0, unavailableFilter?: 'all' | 'excluded' | 'active'): Order[] {
    let sql = 'SELECT * FROM orders WHERE platform = ?'
    const params: unknown[] = [platform]
    if (unavailableFilter === 'excluded') {
      sql += ' AND unavailable = 1'
    } else if (unavailableFilter === 'active') {
      sql += ' AND unavailable = 0'
    }
    sql += ' ORDER BY purchased_at DESC LIMIT ? OFFSET ?'
    params.push(limit, offset)
    return this.withStmt(sql, (stmt) => {
      stmt.bind(params)
      const results: Order[] = []
      while (stmt.step()) {
        results.push(toCamelCase(stmt.getAsObject()) as unknown as Order)
      }
      return results
    })
  }

  getAllOrders(limit = 100, offset = 0): Order[] {
    return this.withStmt('SELECT * FROM orders ORDER BY purchased_at DESC LIMIT ? OFFSET ?', (stmt) => {
      stmt.bind([limit, offset])
      const results: Order[] = []
      while (stmt.step()) {
        results.push(toCamelCase(stmt.getAsObject()) as unknown as Order)
      }
      return results
    })
  }

  getOrderById(id: number): Order | null {
    return this.withStmt('SELECT * FROM orders WHERE id = ?', (stmt) => {
      stmt.bind([id])
      if (stmt.step()) {
        return toCamelCase(stmt.getAsObject()) as unknown as Order
      }
      return null
    })
  }

  searchOrders(keyword: string, platform?: string, excludeUnavailable = false, unavailableFilter?: 'all' | 'excluded' | 'active'): Order[] {
    const escaped = keyword.replace(/[%_\\]/g, '\\$&')
    let sql = "SELECT * FROM orders WHERE product_name LIKE ? ESCAPE '\\'"
    const params: unknown[] = [`%${escaped}%`]
    if (excludeUnavailable || unavailableFilter === 'active') {
      sql += ' AND unavailable = 0'
    } else if (unavailableFilter === 'excluded') {
      sql += ' AND unavailable = 1'
    }
    if (platform) {
      sql += ' AND platform = ?'
      params.push(platform)
    }
    sql += ' ORDER BY purchased_at DESC LIMIT 50'
    return this.withStmt(sql, (stmt) => {
      stmt.bind(params)
      const results: Order[] = []
      while (stmt.step()) {
        results.push(toCamelCase(stmt.getAsObject()) as unknown as Order)
      }
      return results
    })
  }

  hasExcludedOrders(keyword: string): boolean {
    const escaped = keyword.replace(/[%_\\]/g, '\\$&')
    const sql = "SELECT COUNT(*) as cnt FROM orders WHERE product_name LIKE ? ESCAPE '\\' AND unavailable = 1"
    return this.withStmt(sql, (stmt) => {
      stmt.bind([`%${escaped}%`])
      if (stmt.step()) {
        return ((stmt.getAsObject() as any).cnt as number) > 0
      }
      return false
    })
  }

  searchOrdersFuzzy(keyword: string, platform?: string, excludeUnavailable = false): { orders: Order[]; usedKeyword: string } {
    const MIN_FUZZY_LENGTH = 2
    const MAX_SUBSTRINGS = 10
    const MAX_FUZZY_RESULTS = 20
    const MAX_KEYWORD_LENGTH = 10
    const seen = new Set<string>()
    const allOrders: Order[] = []
    let usedKeyword = keyword

    const addUnique = (orders: Order[], limit?: number) => {
      let added = 0
      for (const o of orders) {
        const key = `${o.platform}:${o.orderId}`
        if (!seen.has(key)) {
          seen.add(key)
          allOrders.push(o)
          added++
          if (limit && added >= limit) break
        }
      }
      return added
    }

    const exactResults = this.searchOrders(keyword, platform, excludeUnavailable)
    if (exactResults.length > 0) {
      addUnique(exactResults)
      usedKeyword = keyword
    }

    const effectiveKeyword = keyword.length > MAX_KEYWORD_LENGTH
      ? keyword.substring(0, MAX_KEYWORD_LENGTH)
      : keyword

    if (allOrders.length < MAX_FUZZY_RESULTS && effectiveKeyword.length >= MIN_FUZZY_LENGTH + 1) {
      let count = 0
      for (let len = effectiveKeyword.length - 1; len >= MIN_FUZZY_LENGTH; len--) {
        const subResults: { sub: string; orders: Order[] }[] = []
        for (let start = 0; start <= effectiveKeyword.length - len; start++) {
          const sub = effectiveKeyword.substring(start, start + len)
          const orders = this.searchOrders(sub, platform, excludeUnavailable)
          if (orders.length > 0) {
            subResults.push({ sub, orders })
          }
          count++
          if (count >= MAX_SUBSTRINGS) break
        }
        if (subResults.length > 0) {
          subResults.sort((a, b) => a.orders.length - b.orders.length)
          if (usedKeyword === keyword && exactResults.length === 0) {
            usedKeyword = subResults[0].sub
          }
          for (const { sub, orders } of subResults) {
            if (orders.length > 10 && subResults.some(sr => sr.orders.length <= 10 && sr.orders.length > 0)) {
              continue
            }
            const perSubLimit = orders.length <= 5 ? orders.length : 5
            addUnique(orders, perSubLimit)
            if (allOrders.length >= MAX_FUZZY_RESULTS) break
          }
          break
        }
        if (count >= MAX_SUBSTRINGS) break
      }
    }

    return { orders: allOrders, usedKeyword }
  }

  getOrderCount(platform: string, unavailableFilter?: 'all' | 'excluded' | 'active'): number {
    let sql = 'SELECT COUNT(*) as count FROM orders WHERE platform = ?'
    const params: unknown[] = [platform]
    if (unavailableFilter === 'excluded') {
      sql += ' AND unavailable = 1'
    } else if (unavailableFilter === 'active') {
      sql += ' AND unavailable = 0'
    }
    return this.withStmt(sql, (stmt) => {
      stmt.bind(params)
      if (stmt.step()) {
        return stmt.getAsObject().count as number
      }
      return 0
    })
  }

  clearOrders(platform: string): number {
    const count = this.withStmt('SELECT COUNT(*) as count FROM orders WHERE platform = ?', (stmt) => {
      stmt.bind([platform])
      if (stmt.step()) {
        return stmt.getAsObject().count as number
      }
      return 0
    })
    this.db.run('DELETE FROM unavailable_orders WHERE order_id IN (SELECT id FROM orders WHERE platform = ?)', [platform])
    this.db.run('UPDATE tasks SET order_id = NULL WHERE order_id IN (SELECT id FROM orders WHERE platform = ?)', [platform])
    this.db.run('UPDATE pending_confirmations SET order_id = NULL WHERE order_id IN (SELECT id FROM orders WHERE platform = ?)', [platform])
    this.db.run('DELETE FROM orders WHERE platform = ?', [platform])
    this.scheduleSave()
    return count
  }

  upsertOrder(order: Omit<Order, 'id' | 'unavailable'>): number {
    this.db.run(`
      INSERT INTO orders (platform, order_id, product_name, product_url, price, image_url, purchased_at, shop_name, sku, raw_data)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(platform, order_id) DO UPDATE SET
        product_name = excluded.product_name,
        product_url = excluded.product_url,
        price = excluded.price,
        image_url = excluded.image_url,
        shop_name = excluded.shop_name,
        sku = excluded.sku
    `, [order.platform, order.orderId, order.productName, order.productUrl, order.price, order.imageUrl, order.purchasedAt, order.shopName, order.sku, order.rawData])
    this.scheduleSave()
    const row = this.db.exec('SELECT id FROM orders WHERE platform = ? AND order_id = ?', [order.platform, order.orderId])
    return Number(row[0]?.values[0]?.[0])
  }

  markOrderUnavailable(id: number) {
    this.db.run('INSERT OR IGNORE INTO unavailable_orders (order_id) VALUES (?)', [id])
    this.db.run('UPDATE orders SET unavailable = 1 WHERE id = ?', [id])
    this.scheduleSave()
  }

  getUnavailableOrderIds(ids: number[]): number[] {
    if (ids.length === 0) return []
    const placeholders = ids.map(() => '?').join(',')
    return this.withStmt(`SELECT order_id FROM unavailable_orders WHERE order_id IN (${placeholders})`, (stmt) => {
      stmt.bind(ids)
      const results: number[] = []
      while (stmt.step()) {
        const row = stmt.getAsObject()
        results.push(Number(row.order_id))
      }
      return results
    })
  }

  setAllOrdersUnavailable(platform: string, unavailable: boolean): number {
    const orderIds = this.withStmt('SELECT id FROM orders WHERE platform = ?', (stmt) => {
      stmt.bind([platform])
      const results: number[] = []
      while (stmt.step()) {
        results.push(Number(stmt.getAsObject().id))
      }
      return results
    })
    if (unavailable) {
      for (const id of orderIds) {
        this.db.run('INSERT OR IGNORE INTO unavailable_orders (order_id) VALUES (?)', [id])
      }
    } else {
      for (const id of orderIds) {
        this.db.run('DELETE FROM unavailable_orders WHERE order_id = ?', [id])
      }
    }
    const result = this.db.run('UPDATE orders SET unavailable = ? WHERE platform = ?', [unavailable ? 1 : 0, platform])
    this.scheduleSave()
    return result.changes ?? 0
  }

  toggleOrderUnavailable(id: number): boolean {
    const isUnavailable = this.withStmt('SELECT 1 FROM unavailable_orders WHERE order_id = ?', (stmt) => {
      stmt.bind([id])
      return stmt.step()
    })
    if (isUnavailable) {
      this.db.run('DELETE FROM unavailable_orders WHERE order_id = ?', [id])
      this.db.run('UPDATE orders SET unavailable = 0 WHERE id = ?', [id])
    } else {
      this.db.run('INSERT OR IGNORE INTO unavailable_orders (order_id) VALUES (?)', [id])
      this.db.run('UPDATE orders SET unavailable = 1 WHERE id = ?', [id])
    }
    this.scheduleSave()
    return true
  }

  deleteOrder(id: number): boolean {
    const order = this.getOrderById(id)
    if (!order) return false
    this.db.run('UPDATE tasks SET order_id = NULL WHERE order_id = ?', [id])
    this.db.run('UPDATE pending_confirmations SET order_id = NULL WHERE order_id = ?', [id])
    this.db.run('DELETE FROM orders WHERE id = ?', [id])
    this.scheduleSave()
    return true
  }

  deleteOrders(ids: number[]): number {
    if (ids.length === 0) return 0
    const placeholders = ids.map(() => '?').join(',')
    this.db.run(`UPDATE tasks SET order_id = NULL WHERE order_id IN (${placeholders})`, ids)
    this.db.run(`UPDATE pending_confirmations SET order_id = NULL WHERE order_id IN (${placeholders})`, ids)
    this.db.run(`DELETE FROM orders WHERE id IN (${placeholders})`, ids)
    this.scheduleSave()
    return ids.length
  }

  createOrderFromSearch(params: { platform: string; productName: string; price: number; imageUrl: string; productUrl: string; shopName?: string }): number {
    const orderId = `search_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`
    this.db.run(`
      INSERT INTO orders (platform, order_id, product_name, product_url, price, image_url, purchased_at, shop_name, sku, raw_data)
      VALUES (?, ?, ?, ?, ?, ?, datetime('now', 'localtime'), ?, '', '')
    `, [params.platform, orderId, params.productName, params.productUrl, params.price, params.imageUrl, params.shopName || ''])
    this.scheduleSave()
    const row = this.db.exec('SELECT last_insert_rowid() as id')
    return row[0]?.values[0]?.[0] as number
  }

  createTask(instruction: string, parsedItems: string, platform = 'taobao', paymentMode = 'cart_only', source = 'manual', repeatType?: string, dayOfWeek?: number | null, dayOfMonth?: number | null): number {
    this.db.run('INSERT INTO tasks (instruction, parsed_items, platform, payment_mode, source, repeat_type, day_of_week, day_of_month, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime(\'now\', \'localtime\'))', [instruction, parsedItems, platform, paymentMode, source, repeatType || null, dayOfWeek ?? null, dayOfMonth ?? null])
    this.scheduleSave()
    const row = this.db.exec('SELECT last_insert_rowid() as id')
    return row[0]?.values[0]?.[0] as number
  }

  getTasks(status?: string): ShoppingTask[] {
    let sql = 'SELECT * FROM tasks'
    let params: unknown[] = []
    if (status) {
      sql += ' WHERE status = ?'
      params = [status]
    }
    sql += ' ORDER BY created_at DESC'
    return this.withStmt(sql, (stmt) => {
      if (params.length) stmt.bind(params)
      const results: ShoppingTask[] = []
      while (stmt.step()) {
        results.push(toCamelCase(stmt.getAsObject()) as unknown as ShoppingTask)
      }
      return results
    })
  }

  updateTaskStatus(id: number, status: string, error?: string) {
    if (status === 'success' || status === 'failed' || status === 'partial' || status === 'cancelled') {
      this.db.run(`UPDATE tasks SET status = ?, error = ?, completed_at = datetime('now', 'localtime') WHERE id = ?`, [status, error || null, id])
    } else if (status === 'running') {
      this.db.run(`UPDATE tasks SET status = ?, error = ?, started_at = datetime('now', 'localtime') WHERE id = ?`, [status, error || null, id])
    } else {
      this.db.run('UPDATE tasks SET status = ?, error = ? WHERE id = ?', [status, error || null, id])
    }
    this.scheduleSave()
  }

  updateTaskItemResults(id: number, itemResults: string) {
    this.db.run('UPDATE tasks SET item_results = ? WHERE id = ?', [itemResults, id])
    this.scheduleSave()
  }

  appendTaskProgressLog(id: number, message: string) {
    const log = this.withStmt('SELECT progress_log FROM tasks WHERE id = ?', (stmt) => {
      stmt.bind([id])
      if (stmt.step()) {
        try {
          return JSON.parse(stmt.getAsObject().progress_log as string || '[]')
        } catch { /* ignore */ }
      }
      return [] as string[]
    })
    log.push(message)
    this.db.run('UPDATE tasks SET progress_log = ? WHERE id = ?', [JSON.stringify(log), id])
    this.scheduleSave()
  }

  clearTaskProgressLog(id: number) {
    this.db.run('UPDATE tasks SET progress_log = ? WHERE id = ?', ['[]', id])
    this.scheduleSave()
  }

  getTaskById(id: number): ShoppingTask & { itemResults?: string } | null {
    return this.withStmt('SELECT * FROM tasks WHERE id = ?', (stmt) => {
      stmt.bind([id])
      if (stmt.step()) {
        return toCamelCase(stmt.getAsObject()) as unknown as (ShoppingTask & { itemResults?: string })
      }
      return null
    })
  }

  deleteTask(id: number): boolean {
    const task = this.getTaskById(id)
    if (!task) return false
    this.db.run('DELETE FROM pending_confirmations WHERE task_id = ?', [id])
    this.db.run('DELETE FROM tasks WHERE id = ?', [id])
    this.scheduleSave()
    return true
  }

  deleteTasks(ids: number[]): number {
    if (ids.length === 0) return 0
    const placeholders = ids.map(() => '?').join(',')
    this.db.run(`DELETE FROM pending_confirmations WHERE task_id IN (${placeholders})`, ids)
    this.db.run(`DELETE FROM tasks WHERE id IN (${placeholders})`, ids)
    this.scheduleSave()
    return ids.length
  }

  clearCompletedTasks(): number {
    const result = this.db.run("DELETE FROM pending_confirmations WHERE task_id IN (SELECT id FROM tasks WHERE status IN ('success', 'failed', 'cancelled', 'partial'))")
    this.db.run("DELETE FROM tasks WHERE status IN ('success', 'failed', 'cancelled', 'partial')")
    this.scheduleSave()
    return result.changes ?? 0
  }

  resetStaleRunningTasks(): number {
    const result = this.db.run(
      "UPDATE tasks SET status = 'cancelled', error = '应用重启，任务已自动取消', completed_at = datetime('now', 'localtime') WHERE status IN ('running', 'pending', 'partial')"
    )
    this.scheduleSave()
    return result.changes ?? 0
  }

  getSetting(key: string): string | null {
    return this.withStmt('SELECT value, encrypted FROM settings WHERE key = ?', (stmt) => {
      stmt.bind([key])
      if (stmt.step()) {
        const row = stmt.getAsObject() as Record<string, unknown>
        if (row.encrypted === 1 && typeof row.value === 'string' && safeStorage.isEncryptionAvailable()) {
          try {
            return safeStorage.decryptString(Buffer.from(row.value, 'base64'))
          } catch {
            return row.value as string
          }
        }
        return row.value as string
      }
      return null
    })
  }

  setSetting(key: string, value: string) {
    if (SENSITIVE_KEYS.has(key) && safeStorage.isEncryptionAvailable()) {
      const encrypted = safeStorage.encryptString(value).toString('base64')
      this.db.run('INSERT INTO settings (key, value, encrypted) VALUES (?, ?, 1) ON CONFLICT(key) DO UPDATE SET value = excluded.value, encrypted = excluded.encrypted', [key, encrypted])
    } else {
      this.db.run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [key, value])
    }
    this.scheduleSave()
  }

  getAccount(platform: string) {
    return this.withStmt('SELECT * FROM accounts WHERE platform = ?', (stmt) => {
      stmt.bind([platform])
      if (stmt.step()) {
        return toCamelCase(stmt.getAsObject())
      }
      return null
    })
  }

  upsertAccount(platform: string, username: string, cookiePath: string, loggedIn: boolean) {
    this.db.run(`
      INSERT INTO accounts (platform, username, cookie_path, logged_in, last_login)
      VALUES (?, ?, ?, ?, datetime('now', 'localtime'))
      ON CONFLICT(platform) DO UPDATE SET
        username = excluded.username,
        cookie_path = excluded.cookie_path,
        logged_in = excluded.logged_in,
        last_login = datetime('now', 'localtime')
    `, [platform, username, cookiePath, loggedIn ? 1 : 0])
    this.scheduleSave()
  }

  createScheduledTask(task: { name: string; instruction: string; repeatType: string; scheduledTime: string; dayOfWeek?: number; dayOfMonth?: number; paymentMode?: string; platform?: string }): number {
    this.db.run(
      `INSERT INTO scheduled_tasks (name, instruction, repeat_type, scheduled_time, day_of_week, day_of_month, next_run_at, payment_mode, platform)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [task.name, task.instruction, task.repeatType, task.scheduledTime, task.dayOfWeek ?? null, task.dayOfMonth ?? null, task.scheduledTime, task.paymentMode || '', task.platform || 'taobao']
    )
    this.scheduleSave()
    const row = this.db.exec('SELECT last_insert_rowid() as id')
    return row[0]?.values[0]?.[0] as number
  }

  getScheduledTasks(): Record<string, unknown>[] {
    return this.withStmt('SELECT * FROM scheduled_tasks ORDER BY created_at DESC', (stmt) => {
      const results: Record<string, unknown>[] = []
      while (stmt.step()) {
        results.push(toCamelCase(stmt.getAsObject()))
      }
      return results
    })
  }

  updateScheduledTask(id: number, updates: { name?: string; instruction?: string; repeatType?: string; scheduledTime?: string; dayOfWeek?: number; dayOfMonth?: number; enabled?: boolean; nextRunAt?: string; paymentMode?: string; platform?: string }) {
    const fields: string[] = []
    const values: unknown[] = []
    if (updates.name !== undefined) { fields.push('name = ?'); values.push(updates.name) }
    if (updates.instruction !== undefined) { fields.push('instruction = ?'); values.push(updates.instruction) }
    if (updates.repeatType !== undefined) { fields.push('repeat_type = ?'); values.push(updates.repeatType) }
    if (updates.scheduledTime !== undefined) { fields.push('scheduled_time = ?'); values.push(updates.scheduledTime) }
    if (updates.dayOfWeek !== undefined) { fields.push('day_of_week = ?'); values.push(updates.dayOfWeek) }
    if (updates.dayOfMonth !== undefined) { fields.push('day_of_month = ?'); values.push(updates.dayOfMonth) }
    if (updates.enabled !== undefined) { fields.push('enabled = ?'); values.push(updates.enabled ? 1 : 0) }
    if (updates.nextRunAt !== undefined) { fields.push('next_run_at = ?'); values.push(updates.nextRunAt) }
    if (updates.paymentMode !== undefined) { fields.push('payment_mode = ?'); values.push(updates.paymentMode) }
    if (updates.platform !== undefined) { fields.push('platform = ?'); values.push(updates.platform) }
    if (fields.length === 0) return
    values.push(id)
    this.db.run(`UPDATE scheduled_tasks SET ${fields.join(', ')} WHERE id = ?`, values)
    this.scheduleSave()
  }

  batchUpdateScheduledTasks(ids: number[], updates: { enabled?: boolean }) {
    if (ids.length === 0) return
    const fields: string[] = []
    const values: unknown[] = []
    if (updates.enabled !== undefined) { fields.push('enabled = ?'); values.push(updates.enabled ? 1 : 0) }
    if (fields.length === 0) return
    const placeholders = ids.map(() => '?').join(',')
    this.db.run(`UPDATE scheduled_tasks SET ${fields.join(', ')} WHERE id IN (${placeholders})`, [...values, ...ids])
    this.scheduleSave()
  }

  batchDeleteScheduledTasks(ids: number[]) {
    if (ids.length === 0) return
    const placeholders = ids.map(() => '?').join(',')
    this.db.run(`DELETE FROM scheduled_tasks WHERE id IN (${placeholders})`, ids)
    this.scheduleSave()
  }

  deleteScheduledTask(id: number) {
    this.db.run('DELETE FROM scheduled_tasks WHERE id = ?', [id])
    this.scheduleSave()
  }

  getDueScheduledTasks(): Record<string, unknown>[] {
    const now = new Date()
    const pad = (n: number) => String(n).padStart(2, '0')
    const nowStr = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`
    return this.withStmt('SELECT * FROM scheduled_tasks WHERE enabled = 1 AND next_run_at <= ?', (stmt) => {
      stmt.bind([nowStr])
      const results: Record<string, unknown>[] = []
      while (stmt.step()) {
        results.push(toCamelCase(stmt.getAsObject()))
      }
      return results
    })
  }

  markScheduledTaskRun(id: number) {
    this.db.run(`UPDATE scheduled_tasks SET last_run_at = datetime('now', 'localtime') WHERE id = ?`, [id])
    this.scheduleSave()
  }

  createPendingConfirmation(item: { taskId: number; productName: string; originalPrice: number; failureReason: string; searchKeyword: string; candidates: string; orderId?: number }): number {
    this.db.run(
      `INSERT INTO pending_confirmations (task_id, product_name, original_price, failure_reason, search_keyword, candidates, order_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [item.taskId, item.productName, item.originalPrice, item.failureReason, item.searchKeyword, item.candidates, item.orderId || null]
    )
    this.scheduleSave()
    const row = this.db.exec('SELECT last_insert_rowid() as id')
    return row[0]?.values[0]?.[0] as number
  }

  getPendingConfirmations(status?: string): PendingConfirmation[] {
    let sql = 'SELECT * FROM pending_confirmations'
    let params: unknown[] = []
    if (status) {
      sql += ' WHERE status = ?'
      params = [status]
    }
    sql += ' ORDER BY created_at DESC'
    return this.withStmt(sql, (stmt) => {
      if (params.length) stmt.bind(params)
      const results: PendingConfirmation[] = []
      while (stmt.step()) {
        results.push(toCamelCase(stmt.getAsObject()) as unknown as PendingConfirmation)
      }
      return results
    })
  }

  getPendingConfirmationById(id: number): PendingConfirmation | null {
    return this.withStmt('SELECT * FROM pending_confirmations WHERE id = ?', (stmt) => {
      stmt.bind([id])
      if (stmt.step()) {
        return toCamelCase(stmt.getAsObject()) as unknown as PendingConfirmation
      }
      return null
    })
  }

  updatePendingConfirmationStatus(id: number, status: 'pending' | 'resolved' | 'dismissed') {
    if (status === 'resolved' || status === 'dismissed') {
      this.db.run('UPDATE pending_confirmations SET status = ?, resolved_at = datetime(\'now\', \'localtime\') WHERE id = ?', [status, id])
    } else {
      this.db.run('UPDATE pending_confirmations SET status = ? WHERE id = ?', [status, id])
    }
    this.scheduleSave()
  }

  getPendingConfirmationCount(): number {
    return this.withStmt('SELECT COUNT(*) as count FROM pending_confirmations WHERE status = \'pending\'', (stmt) => {
      if (stmt.step()) {
        return stmt.getAsObject().count as number
      }
      return 0
    })
  }

  hasPendingConfirmationsForTask(taskId: number): boolean {
    return this.withStmt('SELECT COUNT(*) as count FROM pending_confirmations WHERE task_id = ? AND status = \'pending\'', (stmt) => {
      stmt.bind([taskId])
      if (stmt.step()) {
        return (stmt.getAsObject().count as number) > 0
      }
      return false
    })
  }

  dismissPendingConfirmationsForTask(taskId: number) {
    this.db.run('UPDATE pending_confirmations SET status = \'dismissed\', resolved_at = datetime(\'now\', \'localtime\') WHERE task_id = ? AND status = \'pending\'', [taskId])
    this.scheduleSave()
  }

  close() {
    this.saveImmediate()
    this.db.close()
  }
}
