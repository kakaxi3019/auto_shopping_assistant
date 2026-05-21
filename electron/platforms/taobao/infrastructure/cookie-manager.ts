import { session } from 'electron'
import type { BrowserContext } from 'playwright'
import type { TaobaoAuth } from '../taobao.auth'

export class CookieManager {
  private lastCookieSyncTime = 0
  private lastCookieToElectronSyncTime = 0
  private cookieSyncInProgress = false
  private pendingSyncTimer: ReturnType<typeof setTimeout> | null = null
  private pendingSyncResolve: (() => void) | null = null

  resetToElectronSyncTimer() {
    this.lastCookieToElectronSyncTime = 0
  }

  async syncCookiesToElectron(context: BrowserContext | null, auth: TaobaoAuth): Promise<void> {
    if (this.pendingSyncTimer) {
      await new Promise<void>(resolve => {
        this.pendingSyncResolve = resolve
      })
      return
    }

    await new Promise<void>(resolve => {
      this.pendingSyncTimer = setTimeout(() => {
        this.pendingSyncTimer = null
        resolve()
      }, 1500)
    })

    if (this.pendingSyncResolve) {
      this.pendingSyncResolve()
      this.pendingSyncResolve = null
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
              sameSite: c.sameSite === 'Strict' ? 'strict' : c.sameSite === 'None' ? 'no_restriction' : 'lax',
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
            let sameSite: string | undefined
            if (ec.sameSite === 'no_restriction' || ec.sameSite === 'None') {
              sameSite = ec.secure ? 'None' : 'Lax'
            } else if (ec.sameSite === 'strict' || ec.sameSite === 'Strict') {
              sameSite = 'Strict'
            } else if (ec.secure) {
              sameSite = 'None'
            } else {
              sameSite = 'Lax'
            }
            sessionOnlyCookies.push({
              name: ec.name,
              value: ec.value,
              domain: ec.domain,
              path: ec.path,
              secure: ec.secure,
              httpOnly: ec.httpOnly,
              sameSite: sameSite === 'Strict' ? 'strict' : sameSite === 'None' ? 'no_restriction' : 'lax',
              expires: ec.expirationDate && ec.expirationDate > 0 ? ec.expirationDate : undefined,
            })
          }
        } else {
          const sourceExpired = sourceEntry.expires && sourceEntry.expires > 0 && sourceEntry.expires <= nowSec
          const ecExpired = ec.expirationDate && ec.expirationDate > 0 && ec.expirationDate <= nowSec
          if (sourceExpired && !ecExpired) {
            let sameSite: string | undefined
            if (ec.sameSite === 'no_restriction' || ec.sameSite === 'None') {
              sameSite = ec.secure ? 'None' : 'Lax'
            } else if (ec.sameSite === 'strict' || ec.sameSite === 'Strict') {
              sameSite = 'Strict'
            } else if (ec.secure) {
              sameSite = 'None'
            } else {
              sameSite = 'Lax'
            }
            sessionOnlyCookies.push({
              name: ec.name,
              value: ec.value,
              domain: ec.domain,
              path: ec.path,
              secure: ec.secure,
              httpOnly: ec.httpOnly,
              sameSite: sameSite === 'Strict' ? 'strict' : sameSite === 'None' ? 'no_restriction' : 'lax',
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
            sameSite: (c.sameSite === 'strict' ? 'Strict' : c.sameSite === 'no_restriction' ? 'None' : 'Lax') as 'Strict' | 'Lax' | 'None',
            ...(c.expires && c.expires > 0 ? { expires: c.expires } : {}),
          }))
          await context.addCookies(pwCookies)
        }
        auth.saveElectronCookies(taobaoExisting as any)
        sourceCookies = [...sourceCookies, ...sessionOnlyCookies]
        console.log(`[Taobao] syncCookiesToElectron: supplemented ${sessionOnlyCookies.length} cookies from Electron session`)
      }

      if (sourceCookies.length === 0) {
        console.log(`[Taobao] syncCookiesToElectron: no source cookies to sync`)
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
        console.log(`[Taobao] syncCookiesToElectron: all cookies up to date, nothing to sync`)
        return
      }

      console.log(`[Taobao] Syncing ${cookiesToSet.length} cookies to Electron session (out of ${sourceCookies.length} source, ${taobaoExisting.length} existing)`)

      let synced = 0
      for (const cookie of cookiesToSet) {
        try {
          const rawSameSite = (cookie as any).sameSite as string | undefined
          let sameSite: 'unspecified' | 'no_restriction' | 'lax' | 'strict'
          if (rawSameSite && ['unspecified', 'no_restriction', 'lax', 'strict'].includes(rawSameSite)) {
            sameSite = rawSameSite as any
          } else if (cookie.secure) {
            sameSite = 'no_restriction'
          } else {
            sameSite = 'lax'
          }
          if (sameSite === 'no_restriction' && !cookie.secure) {
            sameSite = 'lax'
          }

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
      console.log(`[Taobao] Synced ${synced} cookies to Electron session`)

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
          let sameSite: 'Strict' | 'Lax' | 'None' = 'Lax'
          if (c.sameSite === 'no_restriction' || c.sameSite === 'None') {
            sameSite = c.secure ? 'None' : 'Lax'
          } else if (c.sameSite === 'strict' || c.sameSite === 'Strict') {
            sameSite = 'Strict'
          } else if (c.secure) {
            sameSite = 'None'
          }
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
      console.log(`[Taobao] Synced ${taobaoCookies.length} cookies from Electron session`)
    } catch (e) {
      console.log(`[Taobao] syncCookiesFromElectron error: ${e}`)
    } finally {
      this.cookieSyncInProgress = false
    }
  }
}
