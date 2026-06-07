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

export class JdAuth {
  private cookiePath: string

  constructor() {
    this.cookiePath = join(app.getPath('userData'), 'jd-cookies.json')
  }

  saveElectronCookies(electronCookies: ElectronCookie[]) {
    const playwrightCookies = electronCookies.map((c) => {
      let sameSite: 'Strict' | 'Lax' | 'None' | undefined = undefined
      if (c.sameSite) {
        const ss = c.sameSite.toLowerCase()
        if (ss === 'lax') {
          sameSite = 'Lax'
        } else if (ss === 'strict') {
          sameSite = 'Strict'
        } else if (ss === 'no_restriction' || ss === 'none') {
          sameSite = 'None'
        }
      } else {
        sameSite = c.secure ? 'None' : 'Lax'
      }
      return {
        name: c.name,
        value: c.value,
        domain: c.domain,
        path: c.path,
        secure: c.secure,
        httpOnly: c.httpOnly,
        ...(sameSite ? { sameSite } : {}),
        ...(c.expirationDate ? { expires: c.expirationDate } : {}),
      }
    })
    writeFileSync(this.cookiePath, JSON.stringify(playwrightCookies, null, 2))
  }

  async loadCookies(context: BrowserContext): Promise<boolean> {
    if (!existsSync(this.cookiePath)) return false
    try {
      const cookies = JSON.parse(readFileSync(this.cookiePath, 'utf-8'))
      if (Array.isArray(cookies) && cookies.length > 0) {
        const sanitizedCookies = cookies.map((c) => {
          const newCookie = { ...c }
          if (c.sameSite) {
            const ss = c.sameSite.toLowerCase()
            if (ss === 'lax') {
              newCookie.sameSite = 'Lax'
            } else if (ss === 'strict') {
              newCookie.sameSite = 'Strict'
            } else if (ss === 'no_restriction' || ss === 'none') {
              newCookie.sameSite = 'None'
            } else {
              delete newCookie.sameSite
            }
          } else {
            delete newCookie.sameSite
          }
          return newCookie
        })
        await context.addCookies(sanitizedCookies)
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

  getCookieAge(): string | null {
    if (!existsSync(this.cookiePath)) return null
    try {
      const stat = readFileSync(this.cookiePath, 'utf-8')
      const cookies: SavedCookie[] = JSON.parse(stat)
      if (!Array.isArray(cookies) || cookies.length === 0) return null

      // 对京东来说，pin (用户ID) 是比较稳定的 session/持久 cookie。
      const keyCookies = cookies.filter(c => ['pin', 'unick'].includes(c.name) && c.expires && c.expires > 0)
      const testCookies = keyCookies.length > 0 ? keyCookies : cookies.filter(c => c.expires && c.expires > 0)
      if (testCookies.length === 0) return '长期有效'

      const minExpiry = Math.min(...testCookies.map(c => c.expires!))
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

  clearCookies() {
    if (existsSync(this.cookiePath)) {
      writeFileSync(this.cookiePath, '[]')
    }
  }
}
