import { join } from 'path'
import { app } from 'electron'
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

const LOGIN_KEY_COOKIES = ['_m_h5_tk', 'cookie2', 'sgcookie', '_tb_token_']
const SESSION_COOKIES = ['cookie2', 'sgcookie']

export class TaobaoAuth {
  private cookiePath: string

  constructor() {
    this.cookiePath = join(app.getPath('userData'), 'taobao-cookies.json')
  }

  saveElectronCookies(electronCookies: ElectronCookie[]) {
    const playwrightCookies = electronCookies.map((c) => ({
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: c.path,
      secure: c.secure,
      httpOnly: c.httpOnly,
      sameSite: c.sameSite || (c.secure ? 'no_restriction' : 'lax'),
      ...(c.expirationDate ? { expires: c.expirationDate } : {}),
    }))
    writeFileSync(this.cookiePath, JSON.stringify(playwrightCookies, null, 2))
  }

  async saveCookies(context: BrowserContext) {
    const cookies = await context.cookies()
    writeFileSync(this.cookiePath, JSON.stringify(cookies, null, 2))
  }

  async loadCookies(context: BrowserContext): Promise<boolean> {
    if (!existsSync(this.cookiePath)) return false
    try {
      const cookies = JSON.parse(readFileSync(this.cookiePath, 'utf-8'))
      if (Array.isArray(cookies) && cookies.length > 0) {
        await context.addCookies(cookies)
        return true
      }
      return false
    } catch {
      return false
    }
  }

  loadCookiesRaw(): SavedCookie[] {
    if (!existsSync(this.cookiePath)) return []
    try {
      const cookies = JSON.parse(readFileSync(this.cookiePath, 'utf-8'))
      if (Array.isArray(cookies) && cookies.length > 0) {
        return cookies
      }
      return []
    } catch {
      return []
    }
  }

  hasSavedCookies(): boolean {
    if (!existsSync(this.cookiePath)) return false
    try {
      const data = readFileSync(this.cookiePath, 'utf-8')
      const cookies: SavedCookie[] = JSON.parse(data)
      if (!Array.isArray(cookies) || cookies.length === 0) return false

      const now = Date.now() / 1000
      const hasValidCookie = cookies.some((c) => {
        if (!c.expires || c.expires <= 0) return true
        return c.expires > now
      })

      return hasValidCookie
    } catch {
      return false
    }
  }

  isLikelyLoggedIn(): boolean {
    if (!existsSync(this.cookiePath)) return false
    try {
      const data = readFileSync(this.cookiePath, 'utf-8')
      const cookies: SavedCookie[] = JSON.parse(data)
      if (!Array.isArray(cookies) || cookies.length === 0) return false

      const now = Date.now() / 1000
      const cookieNames = new Set(cookies.map((c) => c.name))

      const hasLoginKey = LOGIN_KEY_COOKIES.some((key) => cookieNames.has(key))
      const hasNonExpired = cookies.some((c) => {
        if (!c.expires || c.expires <= 0) return true
        return c.expires > now
      })

      return hasLoginKey && hasNonExpired
    } catch {
      return false
    }
  }

  getCookieAge(): string | null {
    if (!existsSync(this.cookiePath)) return null
    try {
      const stat = readFileSync(this.cookiePath, 'utf-8')
      const cookies: SavedCookie[] = JSON.parse(stat)
      if (!Array.isArray(cookies) || cookies.length === 0) return null

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
    } catch {
      return null
    }
  }

  getCookiePath(): string {
    return this.cookiePath
  }

  clearCookies() {
    if (existsSync(this.cookiePath)) {
      writeFileSync(this.cookiePath, '[]')
    }
  }
}
