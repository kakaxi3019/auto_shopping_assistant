import { session } from 'electron'
import type { BrowserContext } from 'playwright'
import type { TaobaoAuth } from '../taobao.auth'

export class CookieManager {
  private lastCookieSyncTime = 0
  private lastCookieToElectronSyncTime = 0
  private cookieSyncInProgress = false
  private pendingSyncTimer: ReturnType<typeof setTimeout> | null = null
  private pendingSyncResolves: (() => void)[] = []

  toPlaywrightSameSite(sameSite: string | undefined, secure: boolean | undefined): 'Strict' | 'Lax' | 'None' {
    const isSecure = secure ?? false
    if (sameSite === 'no_restriction' || sameSite === 'None') {
      return isSecure ? 'None' : 'Lax'
    }
    if (sameSite === 'strict' || sameSite === 'Strict') {
      return 'Strict'
    }
    if (isSecure) {
      return 'None'
    }
    return 'Lax'
  }

  private toElectronSameSite(sameSite: 'Strict' | 'Lax' | 'None'): 'strict' | 'no_restriction' | 'lax' {
    return sameSite === 'Strict' ? 'strict' : sameSite === 'None' ? 'no_restriction' : 'lax'
  }

  private toElectronApiSameSite(sameSite: string | undefined, secure: boolean): 'unspecified' | 'no_restriction' | 'lax' | 'strict' {
    if (sameSite && ['unspecified', 'no_restriction', 'lax', 'strict'].includes(sameSite)) {
      const result = sameSite as 'unspecified' | 'no_restriction' | 'lax' | 'strict'
      if (result === 'no_restriction' && !secure) {
        return 'lax'
      }
      return result
    }
    return secure ? 'no_restriction' : 'lax'
  }

  resetToElectronSyncTimer() {
    this.lastCookieToElectronSyncTime = 0
  }

  async syncCookiesToElectron(context: BrowserContext | null, auth: TaobaoAuth): Promise<void> {
    if (this.pendingSyncTimer) {
      await new Promise<void>(resolve => {
        this.pendingSyncResolves.push(resolve)
      })
      return
    }

    await new Promise<void>(resolve => {
      this.pendingSyncTimer = setTimeout(() => {
        this.pendingSyncTimer = null
        resolve()
      }, 1500)
    })

    const resolves = this.pendingSyncResolves
    this.pendingSyncResolves = []
    for (const r of resolves) {
      r()
    }

    const now = Date.now()
    if (now - this.lastCookieToElectronSyncTime < 1500) return

    try {
      let sourceCookies: { name: string; value: string; domain: string; path: string; secure: boolean; httpOnly?: boolean; sameSite?: string; expires?: number }[] = []

      if (context) {
        try {
          const pwCookies = await context.cookies()
          sourceCookies = pwCookies
            .filter(c => c.domain.includes('taobao') || c.domain.includes('tmall') || c.domain.includes('alipay'))
            .map(c => ({
              name: c.name,
              value: c.value,
              domain: c.domain,
              path: c.path,
              secure: c.secure,
              httpOnly: c.httpOnly,
              sameSite: this.toElectronSameSite(c.sameSite as 'Strict' | 'Lax' | 'None'),
              expires: c.expires && c.expires > 0 ? c.expires : undefined,
            }))
        } catch (e) {
          console.log(`[Taobao] syncCookiesToElectron: failed to read Playwright cookies: ${e}`)
        }
      }

      if (sourceCookies.length === 0) {
        const loaded = auth.loadCookiesRaw()
        sourceCookies = loaded.filter(
          (c) => c.domain.includes('taobao') || c.domain.includes('tmall') || c.domain.includes('alipay')
        )
      } else {
        const loaded = auth.loadCookiesRaw()
        const fileCookies = loaded.filter(
          (c) => c.domain.includes('taobao') || c.domain.includes('tmall') || c.domain.includes('alipay')
        )
        const pwKeySet = new Set(sourceCookies.map(c => `${c.domain}:${c.name}:${c.path}`))
        for (const fc of fileCookies) {
          const key = `${fc.domain}:${fc.name}:${fc.path}`
          if (!pwKeySet.has(key)) {
            sourceCookies.push(fc)
            pwKeySet.add(key)
          }
        }
      }

      const existingCookies = await session.defaultSession.cookies.get({})
      const taobaoExisting = existingCookies.filter(
        (c) => c.domain.includes('taobao') || c.domain.includes('tmall') || c.domain.includes('alipay')
      )

      const normalizeDomain = (d: string) => d.startsWith('.') ? d : '.' + d

      const nowSec = Date.now() / 1000
      const sourceMap = new Map<string, { value: string; expires?: number }>()
      for (const c of sourceCookies) {
        const key = `${normalizeDomain(c.domain)}:${c.name}:${c.path}`
        sourceMap.set(key, { value: c.value, expires: c.expires })
      }

      const sessionOnlyCookies: { name: string; value: string; domain: string; path: string; secure: boolean; httpOnly?: boolean; sameSite?: string; expires?: number }[] = []
      for (const ec of taobaoExisting) {
        const key = `${normalizeDomain(ec.domain)}:${ec.name}:${ec.path}`
        const sourceEntry = sourceMap.get(key)
        if (!sourceEntry) {
          const ecExpired = ec.expirationDate && ec.expirationDate > 0 && ec.expirationDate <= nowSec
          if (!ecExpired) {
            const pwSameSite = this.toPlaywrightSameSite(ec.sameSite, ec.secure)
            sessionOnlyCookies.push({
              name: ec.name,
              value: ec.value,
              domain: ec.domain,
              path: ec.path,
              secure: ec.secure,
              httpOnly: ec.httpOnly,
              sameSite: this.toElectronSameSite(pwSameSite),
              expires: ec.expirationDate && ec.expirationDate > 0 ? ec.expirationDate : undefined,
            })
          }
        } else {
          const sourceExpired = sourceEntry.expires && sourceEntry.expires > 0 && sourceEntry.expires <= nowSec
          const ecExpired = ec.expirationDate && ec.expirationDate > 0 && ec.expirationDate <= nowSec
          if (sourceExpired && !ecExpired) {
            const pwSameSite = this.toPlaywrightSameSite(ec.sameSite, ec.secure)
            sessionOnlyCookies.push({
              name: ec.name,
              value: ec.value,
              domain: ec.domain,
              path: ec.path,
              secure: ec.secure,
              httpOnly: ec.httpOnly,
              sameSite: this.toElectronSameSite(pwSameSite),
              expires: ec.expirationDate && ec.expirationDate > 0 ? ec.expirationDate : undefined,
            })
          }
        }
      }

      if (sessionOnlyCookies.length > 0) {
        if (context) {
          const pwCookies = sessionOnlyCookies.map(c => ({
            name: c.name,
            value: c.value,
            domain: c.domain,
            path: c.path,
            secure: c.secure,
            httpOnly: c.httpOnly,
            sameSite: this.toPlaywrightSameSite(c.sameSite, c.secure),
            ...(c.expires && c.expires > 0 ? { expires: c.expires } : {}),
          }))
          await context.addCookies(pwCookies)
        }
        auth.saveElectronCookies(taobaoExisting as any)
        sourceCookies = [...sourceCookies, ...sessionOnlyCookies]
      }

      if (sourceCookies.length === 0) {
        return
      }

      const existingMap = new Map<string, { value: string; expirationDate?: number }>()
      for (const c of taobaoExisting) {
        const key = `${normalizeDomain(c.domain)}:${c.name}:${c.path}`
        existingMap.set(key, { value: c.value, expirationDate: c.expirationDate })
      }

      const cookiesToSet: { name: string; value: string; domain: string; path: string; secure: boolean; httpOnly?: boolean; sameSite?: string; expires?: number }[] = []

      for (const cookie of sourceCookies) {
        const key = `${normalizeDomain(cookie.domain)}:${cookie.name}:${cookie.path}`
        const existing = existingMap.get(key)

        if (existing) {
          const sourceExpired = cookie.expires && cookie.expires > 0 && cookie.expires <= nowSec
          const existingExpired = existing.expirationDate && existing.expirationDate > 0 && existing.expirationDate <= nowSec

          if (sourceExpired && !existingExpired) {
            continue
          }

          if (!sourceExpired && existingExpired) {
            cookiesToSet.push(cookie)
            continue
          }

          if (cookie.value !== existing.value) {
            cookiesToSet.push(cookie)
            continue
          }
        } else {
          const sourceExpired = cookie.expires && cookie.expires > 0 && cookie.expires <= nowSec
          if (!sourceExpired) {
            cookiesToSet.push(cookie)
          }
        }
      }

      if (cookiesToSet.length === 0) {
        return
      }

      let synced = 0
      for (const cookie of cookiesToSet) {
        try {
          const sameSite = this.toElectronApiSameSite((cookie as any).sameSite as string | undefined, cookie.secure)

          await session.defaultSession.cookies.set({
            url: `https://${cookie.domain.replace(/^\./, '')}${cookie.path}`,
            name: cookie.name,
            value: cookie.value,
            domain: cookie.domain,
            path: cookie.path,
            secure: cookie.secure,
            httpOnly: cookie.httpOnly ?? false,
            sameSite,
            expirationDate: cookie.expires && cookie.expires > 0 ? cookie.expires : undefined,
          })
          synced++
        } catch (e) {
          console.log(`[Taobao] Failed to sync cookie ${cookie.name}: ${e}`)
        }
      }

      this.lastCookieToElectronSyncTime = Date.now()

      if (synced > 0) {
        await new Promise(r => setTimeout(r, 200))
      }
    } catch (e) {
      console.log(`[Taobao] syncCookiesToElectron error: ${e}`)
    }
  }

  async syncCookiesFromElectron(context: BrowserContext | null, auth: TaobaoAuth): Promise<void> {
    if (this.cookieSyncInProgress) return
    const now = Date.now()
    if (now - this.lastCookieSyncTime < 1000) return

    this.cookieSyncInProgress = true
    try {
      const electronCookies = await session.defaultSession.cookies.get({})
      const taobaoCookies = electronCookies.filter(
        (c) => c.domain.includes('taobao') || c.domain.includes('tmall') || c.domain.includes('alipay')
      )

      if (context) {
        const playwrightCookies = taobaoCookies.map((c) => {
          const sameSite = this.toPlaywrightSameSite(c.sameSite, c.secure)
          return {
            name: c.name,
            value: c.value,
            domain: c.domain,
            path: c.path,
            secure: c.secure,
            httpOnly: c.httpOnly,
            sameSite,
            ...(c.expirationDate && c.expirationDate > 0 ? { expires: c.expirationDate } : {}),
          }
        })
        if (playwrightCookies.length > 0) {
          await context.addCookies(playwrightCookies)
        }
      }

      if (taobaoCookies.length > 0) {
        auth.saveElectronCookies(taobaoCookies as any)
      }

      this.lastCookieSyncTime = Date.now()
    } catch (e) {
      console.log(`[Taobao] syncCookiesFromElectron error: ${e}`)
    } finally {
      this.cookieSyncInProgress = false
    }
  }
}
