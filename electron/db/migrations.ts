export const MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    platform TEXT NOT NULL,
    order_id TEXT NOT NULL,
    product_name TEXT NOT NULL,
    product_url TEXT NOT NULL DEFAULT '',
    price REAL NOT NULL DEFAULT 0,
    image_url TEXT NOT NULL DEFAULT '',
    purchased_at TEXT NOT NULL DEFAULT '',
    raw_data TEXT NOT NULL DEFAULT '',
    UNIQUE(platform, order_id)
  )`,
  `CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    status TEXT NOT NULL DEFAULT 'pending',
    instruction TEXT NOT NULL,
    parsed_items TEXT NOT NULL DEFAULT '[]',
    order_id INTEGER,
    platform TEXT NOT NULL DEFAULT 'taobao',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    completed_at TEXT,
    error TEXT,
    FOREIGN KEY (order_id) REFERENCES orders(id)
  )`,
  `CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    platform TEXT NOT NULL UNIQUE,
    username TEXT NOT NULL DEFAULT '',
    cookie_path TEXT NOT NULL DEFAULT '',
    logged_in INTEGER NOT NULL DEFAULT 0,
    last_login TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_orders_platform ON orders(platform)`,
  `CREATE INDEX IF NOT EXISTS idx_orders_product_name ON orders(product_name)`,
  `CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status)`,
]

export const MIGRATION_V2 = [
  `ALTER TABLE tasks ADD COLUMN item_results TEXT`,
]

export const MIGRATION_V3 = [
  `CREATE TABLE IF NOT EXISTS scheduled_tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    instruction TEXT NOT NULL,
    repeat_type TEXT NOT NULL DEFAULT 'once',
    scheduled_time TEXT NOT NULL,
    day_of_week INTEGER,
    day_of_month INTEGER,
    enabled INTEGER NOT NULL DEFAULT 1,
    last_run_at TEXT,
    next_run_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
  )`,
]

export const MIGRATION_V4 = [
  `CREATE TABLE IF NOT EXISTS pending_confirmations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id INTEGER NOT NULL,
    product_name TEXT NOT NULL,
    original_price REAL NOT NULL DEFAULT 0,
    failure_reason TEXT NOT NULL DEFAULT '',
    search_keyword TEXT NOT NULL DEFAULT '',
    candidates TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
    resolved_at TEXT,
    FOREIGN KEY (task_id) REFERENCES tasks(id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_pending_confirmations_status ON pending_confirmations(status)`,
]

export const MIGRATION_V5 = [
  `ALTER TABLE orders ADD COLUMN shop_name TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE orders ADD COLUMN sku TEXT NOT NULL DEFAULT ''`,
]

export const MIGRATION_V6 = [
  `ALTER TABLE tasks ADD COLUMN progress_log TEXT NOT NULL DEFAULT '[]'`,
]

export const MIGRATION_V7 = [
  `ALTER TABLE orders ADD COLUMN unavailable INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE pending_confirmations ADD COLUMN order_id INTEGER`,
]

export const MIGRATION_V8 = [
  `ALTER TABLE tasks ADD COLUMN started_at TEXT`,
]

export const MIGRATION_V9 = [
  `ALTER TABLE tasks ADD COLUMN payment_mode TEXT NOT NULL DEFAULT 'auto_pay'`,
]

export const MIGRATION_V10 = [
  `ALTER TABLE scheduled_tasks ADD COLUMN payment_mode TEXT NOT NULL DEFAULT ''`,
]

export const MIGRATION_V11 = [
  `ALTER TABLE scheduled_tasks ADD COLUMN platform TEXT NOT NULL DEFAULT 'taobao'`,
  `UPDATE tasks SET payment_mode = 'cart_only' WHERE payment_mode = 'auto_pay'`,
]

export const MIGRATION_V12 = [
  `ALTER TABLE settings ADD COLUMN encrypted INTEGER NOT NULL DEFAULT 0`,
]
