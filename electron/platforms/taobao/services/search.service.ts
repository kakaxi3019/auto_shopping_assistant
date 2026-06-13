import type { SearchResult } from '../../../../shared/types/platform.types'
import { CookieManager } from '../infrastructure/cookie-manager'
import { WindowManager } from '../infrastructure/window-manager'
import { TaobaoAuth } from '../taobao.auth'
import { CHROME_UA } from '../utils/constants'
import { isLoginPage } from '../utils/url-helper'
import { attachAntiDetectStealth, injectHumanSim, injectOverlayBanner, injectCenterToast } from '../utils/page-helper'

export class SearchService {
  private windowManager: WindowManager

  constructor(
    windowManager: WindowManager,
    _cookieManager: CookieManager,
    _auth: TaobaoAuth,
    _emitStatus: (status: string) => void
  ) {
    this.windowManager = windowManager
  }

  async searchProduct(keyword: string): Promise<SearchResult[]> {
    const searchWindow = this.windowManager.createSearchWindow()
    searchWindow.webContents.setMaxListeners(20)
    searchWindow.webContents.setUserAgent(CHROME_UA)
    injectHumanSim(searchWindow)
    await Promise.race([
      attachAntiDetectStealth(searchWindow),
      new Promise<void>(resolve => setTimeout(resolve, 3000))
    ])

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
        setTimeout(() => {
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
    searchWindow.webContents.setMaxListeners(20)
    searchWindow.webContents.setUserAgent(CHROME_UA)
    injectHumanSim(searchWindow)
    await Promise.race([
      attachAntiDetectStealth(searchWindow),
      new Promise<void>(resolve => setTimeout(resolve, 3000))
    ])

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

      const isProductDetailUrl = (urlStr: string): boolean => {
        if (!urlStr) return false
        const lowerUrl = urlStr.toLowerCase()
        const isTaobaoTmall = lowerUrl.includes('taobao.com') || lowerUrl.includes('tmall.com') || lowerUrl.includes('tmall.hk') || lowerUrl.includes('1688.com')
        if (isTaobaoTmall) {
          if (lowerUrl.includes('/item.htm') || 
              lowerUrl.includes('/detail.htm') || 
              lowerUrl.includes('/item_o.htm') || 
              lowerUrl.includes('/offer/') ||
              lowerUrl.includes('detail.1688.com')) {
            return true
          }
          if (lowerUrl.includes('id=') && 
              !lowerUrl.includes('search') && 
              !lowerUrl.includes('list') && 
              !lowerUrl.includes('cart')) {
            return true
          }
        }
        return false
      }

      const handleUrl = (url: string) => {
        if (resolved) return
        if (isProductDetailUrl(url)) {
          clearTimeout(timeout)
          safeResolve(url)
          if (!searchWindow.isDestroyed()) searchWindow.close()
        }
      }

      searchWindow.webContents.on('did-navigate', (_event: any, url: string) => handleUrl(url))
      searchWindow.webContents.on('did-navigate-in-page', (_event: any, url: string) => handleUrl(url))

      searchWindow.webContents.setWindowOpenHandler(({ url: openUrl }: { url: string }) => {
        if (isProductDetailUrl(openUrl)) {
          handleUrl(openUrl)
        }
        return { action: 'allow' }
      })

      searchWindow.on('closed', () => {
        safeResolve(null)
      })

      searchWindow.webContents.on('did-finish-load', () => {
        if (resolved || searchWindow.isDestroyed()) return
        const currentUrl = searchWindow.webContents.getURL()
        if (isLoginPage(currentUrl)) {
          injectOverlayBanner(searchWindow, '⚠️ 自动购物助手：搜索页面需要登录，请在弹出的窗口中完成登录后继续操作')
          injectCenterToast(searchWindow, '请先完成登录')
        } else {
          injectOverlayBanner(searchWindow, '🛒 自动购物助手：由于该商品直接“再买一单”失败，已为您打开搜索页。请在下方结果中点击正确的商品进入详情页，系统会自动检测并重新接管后续流程。')
          injectCenterToast(searchWindow, '请点击对应商品进入，系统将自动接管')
        }
      })

      searchWindow.loadURL(searchUrl)
      searchWindow.show()
    })
  }
}
