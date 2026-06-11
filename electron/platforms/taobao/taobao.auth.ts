import { join } from 'path'
import { app, safeStorage } from 'electron'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import type { BrowserContext } from 'playwright'

interface ElectronCookie {
  name: string
  value: string
  domain: string
  path: string
  secure: boolean
  httpOnly: boolean
  sameSite?: 'unspecified' | 'no_restriction' | 'lax' | 'strict'
  expirationDate?: number
}

interface SavedCookie {
  name: string
  value: string
  domain: string
  path: string
  secure: boolean
  httpOnly?: boolean
  sameSite?: 'unspecified' | 'no_restriction' | 'lax' | 'strict'
  expires?: number
}

const SESSION_COOKIES = ['cookie2', 'sgcookie']

export class TaobaoAuth {
  private cookiePath: string

  constructor() {
    this.cookiePath = join(app.getPath('userData'), 'taobao-cookies.json')
  }

  private saveRaw(cookies: SavedCookie[]) {
    const json = JSON.stringify(cookies)
    if (safeStorage.isEncryptionAvailable()) {
      const encrypted = safeStorage.encryptString(json)
      writeFileSync(this.cookiePath, JSON.stringify({ encrypted: true, data: encrypted.toString('base64') }))
    } else {
      writeFileSync(this.cookiePath, JSON.stringify({ encrypted: false, data: json }))
    }
  }

  private loadRaw(): SavedCookie[] {
    if (!existsSync(this.cookiePath)) return []
    try {
      const raw = readFileSync(this.cookiePath, 'utf-8')
      const parsed = JSON.parse(raw)
      // 兼容旧版明文格式：直接是数组
      if (Array.isArray(parsed)) return parsed
      // 新版格式
      if (parsed && parsed.data) {
        if (parsed.encrypted && safeStorage.isEncryptionAvailable()) {
          const buf = Buffer.from(parsed.data, 'base64')
          return JSON.parse(safeStorage.decryptString(buf))
        }
        return JSON.parse(parsed.data)
      }
      return []
    } catch {
      return []
    }
  }

  saveElectronCookies(electronCookies: ElectronCookie[]) {
    const playwrightCookies: SavedCookie[] = electronCookies.map((c) => ({
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: c.path,
      secure: c.secure,
      httpOnly: c.httpOnly,
      sameSite: c.sameSite || (c.secure ? 'no_restriction' : 'lax'),
      ...(c.expirationDate ? { expires: c.expirationDate } : {}),
    }))
    this.saveRaw(playwrightCookies)
  }

  async loadCookies(context: BrowserContext): Promise<boolean> {
    const cookies = this.loadRaw()
    if (cookies.length > 0) {
      await context.addCookies(cookies)
      return true
    }
    return false
  }

  loadCookiesRaw(): SavedCookie[] {
    return this.loadRaw()
  }

  hasSavedCookies(): boolean {
    const cookies = this.loadRaw()
    if (cookies.length === 0) return false

    const now = Date.now() / 1000
    return cookies.some((c) => {
      if (!c.expires || c.expires <= 0) return true
      return c.expires > now
    })
  }

  getCookieAge(): string | null {
    const cookies = this.loadRaw()
    if (cookies.length === 0) return null

    const keyCookies = cookies.filter(c => SESSION_COOKIES.includes(c.name) && c.expires && c.expires > 0)
    if (keyCookies.length === 0) return null

    const minExpiry = Math.min(...keyCookies.map(c => c.expires!))
    const now = Date.now() / 1000
    const remaining = minExpiry - now
    if (remaining <= 0) return '已过期'

    const days = Math.floor(remaining / 86400)
    if (days > 365) return '长期有效'
    if (days > 0) return `约 ${days} 天后过期`
    const hours = Math.floor(remaining / 3600)
    if (hours > 0) return `约 ${hours} 小时后过期`
    const minutes = Math.floor(remaining / 60)
    return `约 ${minutes} 分钟后过期`
  }

  clearCookies() {
    if (existsSync(this.cookiePath)) {
      this.saveRaw([])
    }
  }
}
