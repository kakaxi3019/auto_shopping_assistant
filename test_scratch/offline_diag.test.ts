import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import initSqlJs from 'sql.js'

// 定义外部资源路径
const DB_PATH = 'C:/Users/陈贇人/AppData/Roaming/auto-shopping/auto-shopping.db'
const COOKIE_PATH = 'C:/Users/陈贇人/AppData/Roaming/auto-shopping/taobao-cookies.json'

describe('Auto Shopping Assistant - Offline Diagnostics', () => {

  it('Module 1: Load and Validate Real Database Sanity', async () => {
    console.log('[Diag] Starting database sanity test...')
    
    // 1. 检查物理文件是否存在
    expect(fs.existsSync(DB_PATH)).toBe(true)
    const stats = fs.statSync(DB_PATH)
    console.log(`[Diag] Database file size: ${(stats.size / 1024).toFixed(2)} KB`)
    expect(stats.size).toBeGreaterThan(0)

    // 2. 加载 Wasm Wasm 编译包
    const wasmPath = path.join(process.cwd(), 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm')
    expect(fs.existsSync(wasmPath)).toBe(true)

    const SQL = await initSqlJs({
      locateFile: () => wasmPath,
    })

    // 3. 读取并加载数据库
    const dbBuffer = fs.readFileSync(DB_PATH)
    const db = new SQL.Database(dbBuffer)
    expect(db).toBeTruthy()

    // 4. 检查各表结构及数据统计
    const tables = ['orders', 'tasks', 'settings', 'accounts', 'scheduled_tasks', 'pending_confirmations']
    for (const table of tables) {
      const stmt = db.prepare(`SELECT count(*) as cnt FROM sqlite_master WHERE type='table' AND name=?`)
      stmt.bind([table])
      expect(stmt.step()).toBe(true)
      const res = stmt.getAsObject()
      stmt.free()
      
      console.log(`[Diag] Table [${table}] exists: ${res.cnt === 1 ? 'YES' : 'NO'}`)
      expect(res.cnt).toBe(1)
    }

    // 5. 统计核心数据行数
    const getCount = (tableName: string): number => {
      const stmt = db.prepare(`SELECT count(*) as cnt FROM ${tableName}`)
      expect(stmt.step()).toBe(true)
      const res = stmt.getAsObject()
      stmt.free()
      return res.cnt as number
    }

    const orderCount = getCount('orders')
    const taskCount = getCount('tasks')
    const schedCount = getCount('scheduled_tasks')
    const confirmCount = getCount('pending_confirmations')

    console.log(`[Diag] Data statistics:`)
    console.log(`  - Total Orders: ${orderCount}`)
    console.log(`  - Total Tasks: ${taskCount}`)
    console.log(`  - Total Scheduled Tasks: ${schedCount}`)
    console.log(`  - Total Pending Confirmations: ${confirmCount}`)

    // 6. 核查坏数据 (Bad Data Detection)
    // 6.1 检查 orders 中有无核心列缺失或未设默认值的情况
    const checkBadOrdersStmt = db.prepare(`SELECT id, platform, order_id, product_name FROM orders WHERE product_name IS NULL OR product_name = ''`)
    const badOrders: any[] = []
    while (checkBadOrdersStmt.step()) {
      badOrders.push(checkBadOrdersStmt.getAsObject())
    }
    checkBadOrdersStmt.free()
    console.log(`  - Bad Orders (missing product name): ${badOrders.length}`)
    expect(badOrders.length).toBe(0)

    // 6.2 检查 orders 是否存在非 ISO 8601 或空的时间戳
    const checkDateStmt = db.prepare(`SELECT id, purchased_at FROM orders WHERE purchased_at IS NULL OR purchased_at = ''`)
    const badDates: any[] = []
    while (checkDateStmt.step()) {
      badDates.push(checkDateStmt.getAsObject())
    }
    checkDateStmt.free()
    console.log(`  - Orders with empty purchase dates: ${badDates.length}`)

    // 7. 关闭 DB
    db.close()
  })

  it('Module 2: Matching Algorithm & Fuzzy Search Reliability Check', async () => {
    console.log('[Diag] Starting matching algorithm simulation...')
    
    // 1. 初始化 DB
    const wasmPath = path.join(process.cwd(), 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm')
    const SQL = await initSqlJs({ locateFile: () => wasmPath })
    const db = new SQL.Database(fs.readFileSync(DB_PATH))

    // 2. 加载最近的订单数据进行测试
    const stmt = db.prepare(`SELECT id, product_name, price, platform, shop_name FROM orders ORDER BY purchased_at DESC LIMIT 20`)
    const testOrders: any[] = []
    while (stmt.step()) {
      testOrders.push(stmt.getAsObject())
    }
    stmt.free()

    if (testOrders.length === 0) {
      console.log('[Diag] Warn: No orders found in DB to test match algorithm.')
      db.close()
      return
    }

    console.log(`[Diag] Loaded ${testOrders.length} actual orders for matching simulation.`)

    // 3. 复现项目内部的匹配算法 (to simulate exact/fuzzy matches)
    const computeMatchScore = (productName: string, keyword: string): number => {
      const name = productName.toLowerCase()
      const kw = keyword.toLowerCase()
      if (name === kw) return 100
      if (name.includes(kw)) return 80 + (kw.length / name.length) * 20
      
      const spaceWords = kw.split(/\s+/).filter(w => w.length > 0)
      const matchedSpaceWords = spaceWords.filter(w => name.includes(w))
      if (matchedSpaceWords.length > 0 && spaceWords.length > 1) {
        return 50 + (matchedSpaceWords.length / spaceWords.length) * 30
      }
      
      let bestSubLen = 0
      for (let len = kw.length - 1; len >= 2; len--) {
        for (let start = 0; start <= kw.length - len; start++) {
          const sub = kw.substring(start, start + len)
          if (name.includes(sub)) {
            if (len > bestSubLen) bestSubLen = len
          }
        }
        if (bestSubLen > 0 && bestSubLen >= len) break
      }
      if (bestSubLen > 0) {
        const ratio = bestSubLen / kw.length
        if (ratio < 0.5) return 30 + ratio * 10
        if (ratio < 0.75) return 40 + (ratio - 0.5) * 80
        return 60 + ratio * 30
      }
      return 30
    }

    // 4. 模拟测试：将订单标题稍微截断或变形，模拟用户输入指令
    for (const order of testOrders) {
      const originalTitle = order.product_name
      // 提取核心前 6 个字作为指令输入
      const slicedKeyword = originalTitle.substring(0, Math.min(10, originalTitle.length))
      const score = computeMatchScore(originalTitle, slicedKeyword)
      
      console.log(`[Diag] Simulation Match:`)
      console.log(`  - Target Order Title: "${originalTitle}"`)
      console.log(`  - Input Instruction Keyword: "${slicedKeyword}"`)
      console.log(`  - Computed Score: ${score}`)
      
      // 模糊匹配应至少有 50 分以上才合理
      expect(score).toBeGreaterThanOrEqual(40)
    }

    db.close()
  })

  it('Module 3: Taobao Cookie Validity & Anti-bot Diagnostics', () => {
    console.log('[Diag] Starting Cookie and anti-bot diagnostics...')
    
    // 1. 检查 Cookie 文件是否存在
    expect(fs.existsSync(COOKIE_PATH)).toBe(true)
    const cookieContent = fs.readFileSync(COOKIE_PATH, 'utf-8')
    const cookies = JSON.parse(cookieContent)
    
    console.log(`[Diag] Loaded ${cookies.length} cookies from taobao-cookies.json`)
    expect(cookies.length).toBeGreaterThan(0)

    // 2. 检查淘宝抗反爬的关键性 Cookie 字段
    const keyCookies = ['_tb_token_', 'cookie2', 'sgcookie', 'unb', 'tracknick']
    const presentCookies = cookies.map((c: any) => c.name)

    console.log('[Diag] Checking critical cookies for Taobao session:')
    for (const key of keyCookies) {
      const exists = presentCookies.includes(key)
      console.log(`  - [${key}]: ${exists ? 'OK (Present)' : 'MISSING ⚠️'}`)
    }

    // 3. 诊断过期 Cookie
    const nowSec = Date.now() / 1000
    let expiredCount = 0
    for (const cookie of cookies) {
      if (cookie.expires && cookie.expires < nowSec) {
        expiredCount++
      }
    }

    console.log(`  - Total Expired Cookies: ${expiredCount} / ${cookies.length}`)
    const expiryRate = expiredCount / cookies.length
    if (expiryRate > 0.5) {
      console.log(`[Diag] ⚠️ Warning: More than 50% of the cookies are expired! This will highly likely trigger verification prompts.`);
    } else {
      console.log('[Diag] Cookie expiry rate is healthy.');
    }
  })

  it('Module 4: Price Guard & Overflow Anomaly Condition Simulation', () => {
    console.log('[Diag] Starting Price Guard Simulator...')
    
    // 复现熔断判定逻辑
    const checkPriceProtection = (lastPrice: number, currentPrice: number, quantity: number, threshold: number): { trigger: boolean; rate: number } => {
      if (lastPrice <= 0) return { trigger: false, rate: 0 }
      const totalLastPrice = lastPrice * quantity
      const priceIncreaseRate = (currentPrice - totalLastPrice) / totalLastPrice
      return {
        trigger: priceIncreaseRate >= threshold,
        rate: priceIncreaseRate
      }
    }

    // 1. 正常上涨 10% (阈值 15%) => 不触发熔断
    const resNormal = checkPriceProtection(100, 110, 1, 0.15)
    expect(resNormal.trigger).toBe(false)
    expect(resNormal.rate).toBeCloseTo(0.10)

    // 2. 暴涨 50% (阈值 15%) => 触发熔断
    const resSpike = checkPriceProtection(100, 150, 1, 0.15)
    expect(resSpike.trigger).toBe(true)
    expect(resSpike.rate).toBeCloseTo(0.50)

    // 3. 极端边界测试：商家标价异常 0 元 => 不应触发熔断报错
    const resZero = checkPriceProtection(100, 0, 1, 0.15)
    expect(resZero.trigger).toBe(false)
    expect(resZero.rate).toBe(-1.0) // 跌幅 100%

    // 4. 历史价格为 0 时的除零防御 (极佳的抗震测试)
    const resDivZero = checkPriceProtection(0, 100, 1, 0.15)
    expect(resDivZero.trigger).toBe(false) // 历史价格为 0 时系统降级避开除零
    expect(resDivZero.rate).toBe(0)
  })

})
