import initSqlJs, { type Database as SqlJsDatabase } from 'sql.js'
import { join } from 'path'
import { app } from 'electron'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { MIGRATIONS, MIGRATION_V2, MIGRATION_V3 } from './migrations'
import type { Order, ShoppingTask } from '../../shared/types/task.types'

const MIGRATION_VERSION = 3

function toCamelCase(obj: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(obj)) {
    const camelKey = key.replace(/_([a-z])/g, (_, c) => c.toUpperCase())
    result[camelKey] = value
  }
  return result
}

export class Database {
  private db!: SqlJsDatabase
  private dbPath: string
  private ready: Promise<void>
  private saveTimer: NodeJS.Timeout | null = null
  private pendingSave = false

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

    console.log('[DB] isDev:', isDev)
    console.log('[DB] WASM path:', wasmPath)
    console.log('[DB] WASM exists:', existsSync(wasmPath))
    console.log('[DB] DB path:', this.dbPath)
    console.log('[DB] DB exists:', existsSync(this.dbPath))

    const SQL = await initSqlJs({
      locateFile: () => wasmPath,
    })

    console.log(`[DB] SQL.js loaded in ${Date.now() - startTime}ms`)

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
    const stmt = this.db.prepare('SELECT MAX(version) as max_version FROM schema_migrations')
    if (stmt.step()) {
      const version = stmt.getAsObject().max_version as number | null
      stmt.free()
      return version || 0
    }
    stmt.free()
    return 0
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

  getOrders(platform: string, limit = 100, offset = 0): Order[] {
    const stmt = this.db.prepare('SELECT * FROM orders WHERE platform = ? ORDER BY purchased_at DESC LIMIT ? OFFSET ?')
    stmt.bind([platform, limit, offset])
    const results: Order[] = []
    while (stmt.step()) {
      results.push(toCamelCase(stmt.getAsObject()) as unknown as Order)
    }
    stmt.free()
    return results
  }

  getAllOrders(limit = 100, offset = 0): Order[] {
    const stmt = this.db.prepare('SELECT * FROM orders ORDER BY purchased_at DESC LIMIT ? OFFSET ?')
    stmt.bind([limit, offset])
    const results: Order[] = []
    while (stmt.step()) {
      results.push(toCamelCase(stmt.getAsObject()) as unknown as Order)
    }
    stmt.free()
    return results
  }

  getOrderById(id: number): Order | null {
    const stmt = this.db.prepare('SELECT * FROM orders WHERE id = ?')
    stmt.bind([id])
    if (stmt.step()) {
      const order = toCamelCase(stmt.getAsObject()) as unknown as Order
      stmt.free()
      return order
    }
    stmt.free()
    return null
  }

  searchOrders(keyword: string, platform?: string): Order[] {
    let sql = 'SELECT * FROM orders WHERE product_name LIKE ?'
    const params: unknown[] = [`%${keyword}%`]
    if (platform) {
      sql += ' AND platform = ?'
      params.push(platform)
    }
    sql += ' ORDER BY purchased_at DESC LIMIT 50'
    const stmt = this.db.prepare(sql)
    stmt.bind(params)
    const results: Order[] = []
    while (stmt.step()) {
      results.push(toCamelCase(stmt.getAsObject()) as unknown as Order)
    }
    stmt.free()
    return results
  }

  searchOrdersFuzzy(keyword: string, platform?: string): { orders: Order[]; usedKeyword: string } {
    let results = this.searchOrders(keyword, platform)
    if (results.length > 0) {
      return { orders: results, usedKeyword: keyword }
    }

    const MIN_FUZZY_LENGTH = 2

    for (let len = keyword.length - 1; len >= MIN_FUZZY_LENGTH; len--) {
      for (let start = 0; start <= keyword.length - len; start++) {
        const sub = keyword.substring(start, start + len)
        results = this.searchOrders(sub, platform)
        if (results.length > 0) {
          return { orders: results, usedKeyword: sub }
        }
      }
    }

    return { orders: [], usedKeyword: keyword }
  }

  getOrderCount(platform: string): number {
    const stmt = this.db.prepare('SELECT COUNT(*) as count FROM orders WHERE platform = ?')
    stmt.bind([platform])
    if (stmt.step()) {
      const count = stmt.getAsObject().count as number
      stmt.free()
      return count
    }
    stmt.free()
    return 0
  }

  clearOrders(platform: string): number {
    const stmt = this.db.prepare('SELECT COUNT(*) as count FROM orders WHERE platform = ?')
    stmt.bind([platform])
    let count = 0
    if (stmt.step()) {
      count = stmt.getAsObject().count as number
    }
    stmt.free()
    this.db.run('DELETE FROM orders WHERE platform = ?', [platform])
    this.scheduleSave()
    return count
  }

  upsertOrder(order: Omit<Order, 'id'>): number {
    this.db.run(`
      INSERT INTO orders (platform, order_id, product_name, product_url, price, image_url, purchased_at, raw_data)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(platform, order_id) DO UPDATE SET
        product_name = excluded.product_name,
        product_url = excluded.product_url,
        price = excluded.price,
        image_url = excluded.image_url
    `, [order.platform, order.orderId, order.productName, order.productUrl, order.price, order.imageUrl, order.purchasedAt, order.rawData])
    this.scheduleSave()
    const row = this.db.exec('SELECT last_insert_rowid() as id')
    return row[0]?.values[0]?.[0] as number
  }

  createTask(instruction: string, parsedItems: string, platform = 'taobao'): number {
    this.db.run('INSERT INTO tasks (instruction, parsed_items, platform, created_at) VALUES (?, ?, ?, datetime(\'now\', \'localtime\'))', [instruction, parsedItems, platform])
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
    const stmt = this.db.prepare(sql)
    if (params.length) stmt.bind(params)
    const results: ShoppingTask[] = []
    while (stmt.step()) {
      results.push(toCamelCase(stmt.getAsObject()) as unknown as ShoppingTask)
    }
    stmt.free()
    return results
  }

  updateTaskStatus(id: number, status: string, error?: string) {
    if (status === 'success' || status === 'failed') {
      this.db.run(`UPDATE tasks SET status = ?, error = ?, completed_at = datetime('now', 'localtime') WHERE id = ?`, [status, error || null, id])
    } else {
      this.db.run('UPDATE tasks SET status = ?, error = ? WHERE id = ?', [status, error || null, id])
    }
    this.scheduleSave()
  }

  updateTaskItemResults(id: number, itemResults: string) {
    this.db.run('UPDATE tasks SET item_results = ? WHERE id = ?', [itemResults, id])
    this.scheduleSave()
  }

  getTaskById(id: number): ShoppingTask & { itemResults?: string } | null {
    const stmt = this.db.prepare('SELECT * FROM tasks WHERE id = ?')
    stmt.bind([id])
    if (stmt.step()) {
      const obj = toCamelCase(stmt.getAsObject()) as unknown as (ShoppingTask & { itemResults?: string })
      stmt.free()
      return obj
    }
    stmt.free()
    return null
  }

  getSetting(key: string): string | null {
    const stmt = this.db.prepare('SELECT value FROM settings WHERE key = ?')
    stmt.bind([key])
    if (stmt.step()) {
      const val = stmt.getAsObject().value as string
      stmt.free()
      return val
    }
    stmt.free()
    return null
  }

  setSetting(key: string, value: string) {
    this.db.run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [key, value])
    this.scheduleSave()
  }

  getAccount(platform: string) {
    const stmt = this.db.prepare('SELECT * FROM accounts WHERE platform = ?')
    stmt.bind([platform])
    if (stmt.step()) {
      const obj = toCamelCase(stmt.getAsObject())
      stmt.free()
      return obj
    }
    stmt.free()
    return null
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

  createScheduledTask(task: { name: string; instruction: string; repeatType: string; scheduledTime: string; dayOfWeek?: number; dayOfMonth?: number }): number {
    this.db.run(
      `INSERT INTO scheduled_tasks (name, instruction, repeat_type, scheduled_time, day_of_week, day_of_month, next_run_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [task.name, task.instruction, task.repeatType, task.scheduledTime, task.dayOfWeek ?? null, task.dayOfMonth ?? null, task.scheduledTime]
    )
    this.scheduleSave()
    const row = this.db.exec('SELECT last_insert_rowid() as id')
    return row[0]?.values[0]?.[0] as number
  }

  getScheduledTasks(): Record<string, unknown>[] {
    const stmt = this.db.prepare('SELECT * FROM scheduled_tasks ORDER BY created_at DESC')
    const results: Record<string, unknown>[] = []
    while (stmt.step()) {
      results.push(toCamelCase(stmt.getAsObject()))
    }
    stmt.free()
    return results
  }

  updateScheduledTask(id: number, updates: { name?: string; instruction?: string; repeatType?: string; scheduledTime?: string; dayOfWeek?: number; dayOfMonth?: number; enabled?: boolean; nextRunAt?: string }) {
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
    if (fields.length === 0) return
    values.push(id)
    this.db.run(`UPDATE scheduled_tasks SET ${fields.join(', ')} WHERE id = ?`, values)
    this.scheduleSave()
  }

  deleteScheduledTask(id: number) {
    this.db.run('DELETE FROM scheduled_tasks WHERE id = ?', [id])
    this.scheduleSave()
  }

  getDueScheduledTasks(): Record<string, unknown>[] {
    const now = new Date().toISOString().replace('T', ' ').substring(0, 19)
    const stmt = this.db.prepare('SELECT * FROM scheduled_tasks WHERE enabled = 1 AND next_run_at <= ?')
    stmt.bind([now])
    const results: Record<string, unknown>[] = []
    while (stmt.step()) {
      results.push(toCamelCase(stmt.getAsObject()))
    }
    stmt.free()
    return results
  }

  markScheduledTaskRun(id: number) {
    this.db.run(`UPDATE scheduled_tasks SET last_run_at = datetime('now', 'localtime') WHERE id = ?`, [id])
    this.scheduleSave()
  }

  close() {
    this.saveImmediate()
    this.db.close()
  }
}
