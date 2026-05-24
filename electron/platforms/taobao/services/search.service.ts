import type { SearchResult } from '../../../../shared/types/platform.types'
import { CookieManager } from '../infrastructure/cookie-manager'
import { WindowManager } from '../infrastructure/window-manager'
import { TaobaoAuth } from '../taobao.auth'
import { setUserAgent, debugLog } from '../utils/page-helper'

export class SearchService {
  private windowManager: WindowManager
  private cookieManager: CookieManager
  private auth: TaobaoAuth

  constructor(
    windowManager: WindowManager,
    cookieManager: CookieManager,
    auth: TaobaoAuth,
    _emitStatus: (status: string) => void
  ) {
    this.windowManager = windowManager
    this.cookieManager = cookieManager
    this.auth = auth
  }

  async searchProduct(keyword: string): Promise<SearchResult[]> {
    await this.cookieManager.syncCookiesToElectron(null, this.auth)

    const searchWindow = this.windowManager.createSearchWindow()
    setUserAgent(searchWindow)

    try {
      const encodedKeyword = encodeURIComponent(keyword)
      const searchUrl = `https://s.taobao.com/search?page=1&q=${encodedKeyword}&tab=all`

      await new Promise<void>((resolve, reject) => {
        const loadTimeout = setTimeout(() => reject(new Error('搜索页面加载超时')), 30000)
        searchWindow.webContents.on('did-finish-load', () => {
          clearTimeout(loadTimeout)
          resolve()
        })
        searchWindow.webContents.on('did-fail-load', (_event, errorCode, errorDesc) => {
          clearTimeout(loadTimeout)
          reject(new Error(`搜索页面加载失败: ${errorDesc} (${errorCode})`))
        })
        searchWindow.loadURL(searchUrl)
      })

      const currentUrl = searchWindow.webContents.getURL()
      if (currentUrl.includes('login')) {
        return []
      }

      await new Promise<void>((resolve) => {
        let resolved = false
        const checkInterval = setInterval(async () => {
          if (resolved) return
          try {
            const hasItems = await searchWindow.webContents.executeJavaScript(`
              (function() {
                var container = document.getElementById('content_items_wrapper');
                if (container) {
                  var items = container.querySelectorAll('[id^="item_id_"], [data-nid]');
                  if (items.length > 0) return true;
                }
                var cards = document.querySelectorAll('[class*="Card--"], [class*="item-card"], [class*="ItemCard"]');
                if (cards.length > 0) return true;
                var loading = document.querySelector('[class*="loading"], [class*="Loading"], [class*="loadingBox"]');
                if (loading) return false;
                if (document.body && document.body.innerText.length > 200) return true;
                return false;
              })()
            `)
            if (hasItems) {
              resolved = true
              clearInterval(checkInterval)
              resolve()
            }
          } catch {}
        }, 1000)
        const pollTimeout = setTimeout(() => {
          if (!resolved) {
            resolved = true
            clearInterval(checkInterval)
            resolve()
          }
        }, 30000)
      })

      await new Promise<void>(r => setTimeout(r, 3000))

      const results = await searchWindow.webContents.executeJavaScript(`
        (function() {
          var items = [];
          var debugInfo = {
            url: window.location.href,
            elementCount: 0,
            linkCount: 0
          };

          var containerSelectors = [
            '#content_items_wrapper',
            '[class*="ContentItemsWrapper"]',
            '[class*="content--"]',
            '[class*="search-result"]',
            '[class*="SearchResult"]',
            '[class*="m-itemlist"]',
            '#m-itemlist',
            '[data-spm="searchresult"]',
            '[class*="items-wrapper"]',
            '[class*="ItemsWrapper"]'
          ];
          var searchResultContainer = null;
          for (var ci = 0; ci < containerSelectors.length; ci++) {
            searchResultContainer = document.querySelector(containerSelectors[ci]);
            if (searchResultContainer) break;
          }

          if (!searchResultContainer) {
            var allDivs = document.querySelectorAll('div[id], div[class]');
            var divInfo = [];
            for (var di = 0; di < Math.min(allDivs.length, 30); di++) {
              var d = allDivs[di];
              var cls = d.className ? String(d.className).substring(0, 60) : '';
              divInfo.push(d.id ? d.id + ':' + cls : cls);
            }
            var bodyText = document.body ? document.body.innerText.substring(0, 800) : '';
            return { items: [], debug: { url: window.location.href, bodyPreview: bodyText, elementCount: 0, linkCount: 0, divInfo: divInfo } };
          }

          var allItemElements = searchResultContainer.querySelectorAll('[id^="item_id_"], [data-nid], [data-spm-act-id], [class*="Card--"], [class*="card--"], [class*="item-card"], [class*="ItemCard"]');
          debugInfo.elementCount = allItemElements.length;

          if (allItemElements.length === 0) {
            var childInfo = [];
            var children = searchResultContainer.children;
            for (var chi = 0; chi < Math.min(children.length, 10); chi++) {
              var child = children[chi];
              childInfo.push(child.tagName + '#' + (child.id || '') + '.' + (child.className ? String(child.className).substring(0, 60) : ''));
            }
            var bodyText2 = document.body ? document.body.innerText.substring(0, 500) : '';
            return { items: [], debug: { url: window.location.href, bodyPreview: bodyText2, elementCount: 0, linkCount: 0, childInfo: childInfo } };
          }

          var seenIds = {};
          for (var i = 0; i < allItemElements.length; i++) {
            var el = allItemElements[i];
            var itemId = el.id.replace('item_id_', '') || el.getAttribute('data-nid') || el.getAttribute('data-spm-act-id') || el.getAttribute('data-id') || '';
            if (!itemId || seenIds[itemId]) continue;
            seenIds[itemId] = true;

            var container = el;
            if (el.tagName === 'A' && el.parentElement) {
              container = el;
            } else {
              var parentLink = el.closest('a');
              if (parentLink) container = parentLink;
            }

            var title = '';
            var titleEl = container.querySelector('[class*="title"], [class*="Title"]');
            if (titleEl) {
              title = (titleEl.textContent || '').trim();
            }
            if (!title) {
              title = (container.getAttribute('title') || container.textContent || '').trim().substring(0, 200);
            }
            if (!title || title.length < 2) continue;

            var price = 0;
            var priceEl = container.querySelector('[class*="price"], [class*="Price"]');
            if (priceEl) {
              var priceMatch = (priceEl.textContent || '').match(/[0-9]+\\.?[0-9]*/);
              if (priceMatch) price = parseFloat(priceMatch[0]);
            }

            var imageUrl = '';
            var imgEl = container.querySelector('img');
            if (imgEl) {
              imageUrl = imgEl.src || imgEl.getAttribute('data-src') || '';
              if (imageUrl.startsWith('//')) imageUrl = 'https:' + imageUrl;
            }

            var shopName = '';
            var shopEl = container.querySelector('[class*="shop"], [class*="store"], [class*="seller"], [class*="Shop"], [class*="Store"]');
            if (shopEl) {
              var rawShop = (shopEl.textContent || '').trim();
              rawShop = rawShop.replace(/店铺会员/g, '').replace(/旺旺在线/g, '').replace(/旺旺离线/g, '').replace(/旺旺/g, '').replace(/进店/g, '').replace(/收藏店铺/g, '').replace(/\\s+/g, ' ').trim();
              shopName = rawShop;
            }

            var url = container.getAttribute('href') || '';
            if (url.startsWith('//')) url = 'https:' + url;
            if (url.includes('click.simba.taobao.com') || url.includes('click.taobao.com') || url.includes('s.click.taobao.com')) {
              url = 'https://detail.tmall.com/item.htm?id=' + itemId;
            }
            if (!url && itemId) {
              url = 'https://detail.tmall.com/item.htm?id=' + itemId;
            }

            if (price > 0) {
              items.push({ title: title.substring(0, 200), url: url, price: price, imageUrl: imageUrl, shopName: shopName.substring(0, 100) });
              debugInfo.linkCount++;
            }

            if (items.length >= 10) break;
          }

          if (items.length === 0) {
            var bodyText = document.body ? document.body.innerText.substring(0, 500) : '';
            return { items: [], debug: { url: window.location.href, bodyPreview: bodyText, elementCount: debugInfo.elementCount, linkCount: debugInfo.linkCount } };
          }

          return { items: items, debug: debugInfo };
        })()
      `) as { items: SearchResult[]; debug: any }

      if (results.debug) {
        debugLog(`[Search] URL: ${results.debug.url}, elementCount: ${results.debug.elementCount}, linkCount: ${results.debug.linkCount}`)
        debugLog(`[Search] items found: ${results.items?.length || 0}`)
        if (results.debug.divInfo) {
          debugLog(`[Search] divInfo: ${JSON.stringify(results.debug.divInfo)}`)
        }
        if (results.debug.childInfo) {
          debugLog(`[Search] childInfo: ${JSON.stringify(results.debug.childInfo)}`)
        }
        if (results.debug.bodyPreview) {
          debugLog(`[Search] bodyPreview: ${results.debug.bodyPreview.substring(0, 300)}`)
        }
        if (results.items && results.items.length > 0) {
          results.items.forEach((item: SearchResult, idx: number) => {
            debugLog(`[Search] item[${idx}]: title="${item.title}", price=${item.price}, shop="${item.shopName}"`)
          })
        }
      }

      return (results.items || []).filter(r => r.title && r.price > 0)
    } catch (e) {
      console.log(`[Taobao] searchProduct error: ${e}`)
      return []
    } finally {
      searchWindow.close()
    }
  }

  async openSearchPage(keyword: string): Promise<string | null> {
    const searchWindow = this.windowManager.createSearchWindow()
    setUserAgent(searchWindow)

    const encodedKeyword = encodeURIComponent(keyword)
    const searchUrl = `https://s.taobao.com/search?page=1&q=${encodedKeyword}&tab=all`

    return new Promise<string | null>((resolve) => {
      let resolved = false
      const safeResolve = (result: string | null) => {
        if (resolved) return
        resolved = true
        resolve(result)
      }

      const timeout = setTimeout(() => {
        safeResolve(null)
        if (!searchWindow.isDestroyed()) searchWindow.close()
      }, 600000)

      const handleUrl = (url: string) => {
        if (resolved) return
        if (url.includes('item.taobao.com/item.htm') || url.includes('detail.tmall.com/item.htm') || url.includes('detail.1688.com/offer')) {
          clearTimeout(timeout)
          safeResolve(url)
          if (!searchWindow.isDestroyed()) searchWindow.close()
        }
      }

      searchWindow.webContents.on('did-navigate', (_event: any, url: string) => handleUrl(url))
      searchWindow.webContents.on('did-navigate-in-page', (_event: any, url: string) => handleUrl(url))

      searchWindow.webContents.setWindowOpenHandler(({ url: openUrl }: { url: string }) => {
        if (openUrl.includes('item.taobao.com/item.htm') || openUrl.includes('detail.tmall.com/item.htm') || openUrl.includes('detail.1688.com/offer')) {
          handleUrl(openUrl)
        }
        return { action: 'allow' }
      })

      searchWindow.on('closed', () => {
        safeResolve(null)
      })

      searchWindow.webContents.once('did-finish-load', () => {
        const bannerJs = `
          (function() {
            var existing = document.querySelector('[data-hint]');
            if (existing) return;
            var hint = document.createElement('div');
            hint.setAttribute('data-hint', '1');
            hint.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:2147483647;padding:10px 20px;background:rgba(37,99,235,0.9);color:#fff;font-size:14px;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;text-align:center;box-shadow:0 2px 8px rgba(0,0,0,0.15);line-height:1.5;pointer-events:none;';
            hint.textContent = '🔐 自动购物助手：请在搜索结果中找到对应商品并点击进入商品详情页';
            document.documentElement.appendChild(hint);
          })();
        `
        searchWindow.webContents.executeJavaScript(bannerJs).catch(() => {})
        searchWindow.show()
      })

      searchWindow.loadURL(searchUrl)
    })
  }
}
