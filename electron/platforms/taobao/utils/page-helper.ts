import * as path from 'path'
import * as fs from 'fs'
import { app, BrowserWindow } from 'electron'
import { CHROME_UA } from './constants'
import { HUMAN_SIM_JS } from './human-sim'
import { ANTI_DETECT_JS } from './anti-detect'

export function getChromiumPath(): string | undefined {
  if (app.isPackaged) {
    const packagedPath = path.join(
      process.resourcesPath,
      'playwright-browsers',
      'chromium-1217',
      'chrome-win64',
      'chrome.exe'
    )
    if (fs.existsSync(packagedPath)) {
      return packagedPath
    }
  }
  return undefined
}

const DEBUG_LOG_PATH = path.join(app.getAppPath(), 'electron_debug.log')

export function debugLog(msg: string) {
  const line = `[${new Date().toISOString()}] ${msg}\n`
  console.log(msg)
  try {
    fs.appendFileSync(DEBUG_LOG_PATH, line)
  } catch { /* ignore */ }
}

export function setUserAgent(win: BrowserWindow) {
  win.webContents.setMaxListeners(20)
  win.webContents.setUserAgent(CHROME_UA)
  injectHumanSim(win)
}

export function injectHumanSim(win: BrowserWindow) {
  const inject = () => {
    if (win.isDestroyed()) return
    const url = win.webContents.getURL()
    const isCaptchaPage = url.includes('nocaptcha') || url.includes('captcha') || url.includes('slider') || url.includes('baxia') || url.includes('passport.taobao.com/iv')
    if (!isCaptchaPage) {
      win.webContents.executeJavaScript(ANTI_DETECT_JS + '\n' + HUMAN_SIM_JS).catch(() => {})
    } else {
      win.webContents.executeJavaScript(HUMAN_SIM_JS).catch(() => {})
    }
  }
  if (!(win as any).__humanSimInjected) {
    (win as any).__humanSimInjected = true
    win.webContents.on('did-start-navigation', () => {
      if (win.isDestroyed()) return
      const url = win.webContents.getURL()
      const isCaptchaPage = url.includes('nocaptcha') || url.includes('captcha') || url.includes('slider') || url.includes('baxia') || url.includes('passport.taobao.com/iv')
      if (!isCaptchaPage) {
        win.webContents.executeJavaScript(ANTI_DETECT_JS).catch(() => {})
      }
    })
    win.webContents.on('did-finish-load', inject)
  }
  if (!win.webContents.isLoading()) {
    inject()
  }
}

export async function execJS(win: BrowserWindow | null, js: string): Promise<any> {
  if (!win || win.isDestroyed()) return undefined
  await win.webContents.executeJavaScript(HUMAN_SIM_JS).catch(() => {})
  return win.webContents.executeJavaScript(js)
}

export async function humanClickAt(win: BrowserWindow, x: number, y: number): Promise<void> {
  if (win.isDestroyed()) return
  const jitterX = x + Math.floor(Math.random() * 6) - 3
  const jitterY = y + Math.floor(Math.random() * 6) - 3

  const prevX = (win as any).__lastMouseX ?? jitterX - rand(50, 200)
  const prevY = (win as any).__lastMouseY ?? jitterY - rand(50, 200)
  const dx = jitterX - prevX
  const dy = jitterY - prevY
  const dist = Math.sqrt(dx * dx + dy * dy)
  const steps = Math.max(5, Math.min(20, Math.floor(dist / 15)))

  const cp1x = prevX + dx * 0.25 + (gaussRand() * dist * 0.08)
  const cp1y = prevY + dy * 0.25 + (gaussRand() * dist * 0.08)
  const cp2x = prevX + dx * 0.75 + (gaussRand() * dist * 0.08)
  const cp2y = prevY + dy * 0.75 + (gaussRand() * dist * 0.08)

  win.webContents.sendInputEvent({ type: 'mouseEnter', x: prevX, y: prevY })
  await new Promise(r => setTimeout(r, rand(20, 50)))

  for (let i = 0; i <= steps; i++) {
    const t = i / steps
    const ease = t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t
    const mt = 1 - ease
    const px = Math.round(mt * mt * mt * prevX + 3 * mt * mt * ease * cp1x + 3 * mt * ease * ease * cp2x + ease * ease * ease * jitterX)
    const py = Math.round(mt * mt * mt * prevY + 3 * mt * mt * ease * cp1y + 3 * mt * ease * ease * cp2y + ease * ease * ease * jitterY)
    win.webContents.sendInputEvent({ type: 'mouseMove', x: px, y: py })
    await new Promise(r => setTimeout(r, 6 + Math.abs(gaussRand()) * 10))
  }

  await new Promise(r => setTimeout(r, rand(30, 80)))
  win.webContents.sendInputEvent({ type: 'mouseDown', x: jitterX, y: jitterY, button: 'left', clickCount: 1 })
  await new Promise(r => setTimeout(r, rand(50, 120)))
  win.webContents.sendInputEvent({ type: 'mouseUp', x: jitterX, y: jitterY, button: 'left', clickCount: 1 })
  await new Promise(r => setTimeout(r, rand(30, 60)))

  ;(win as any).__lastMouseX = jitterX
  ;(win as any).__lastMouseY = jitterY
}

export async function humanClickElement(win: BrowserWindow, selectors: string[], textTargets?: string[]): Promise<{ clicked: boolean; text?: string; x?: number; y?: number }> {
  if (win.isDestroyed()) return { clicked: false }
  const result = await execJS(win, `
    (function() {
      var found = _hs.findVisible(${JSON.stringify(selectors)}, ${textTargets ? JSON.stringify(textTargets) : 'null'});
      if (found.length === 0) return { clicked: false };
      found.sort(function(a, b) { return a.area - b.area; });
      var best = found[0];
      var rect = best.rect;
      var x = rect.left + rect.width * (0.3 + Math.random() * 0.4);
      var y = rect.top + rect.height * (0.3 + Math.random() * 0.4);
      return { clicked: true, text: best.text, x: Math.round(x), y: Math.round(y) };
    })()
  `)
  if (!result || !result.clicked) return { clicked: false }
  await humanClickAt(win, result.x, result.y)
  return result
}

export function rand(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min
}

export function gaussRand(): number {
  const u1 = Math.random()
  const u2 = Math.random()
  return Math.sqrt(-2 * Math.log(Math.max(u1, 1e-10))) * Math.cos(2 * Math.PI * u2)
}

export async function humanDelay(base: number, jitter?: number): Promise<void> {
  const range = jitter ?? Math.ceil(base * 0.4)
  const ms = base + Math.round(gaussRand() * range * 0.5)
  await new Promise(r => setTimeout(r, Math.max(200, ms)))
}

export function injectOverlayBanner(win: BrowserWindow, message: string) {
  const js = `
    (function() {
      var existing = document.getElementById('site-nav');
      if (existing && existing.querySelector('[data-hint]')) return;
      var nav = document.getElementById('site-nav') || document.body.firstChild;
      var hint = document.createElement('div');
      hint.setAttribute('data-hint', '1');
      hint.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:2147483647;padding:10px 20px;background:rgba(37,99,235,0.9);color:#fff;font-size:14px;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;text-align:center;backdrop-filter:blur(4px);box-shadow:0 2px 8px rgba(0,0,0,0.15);line-height:1.5;';
      hint.textContent = ${JSON.stringify(message)};
      var closeBtn = document.createElement('span');
      closeBtn.textContent = '✕';
      closeBtn.style.cssText = 'position:absolute;right:12px;top:50%;transform:translateY(-50%);cursor:pointer;font-size:16px;opacity:0.7;';
      closeBtn.onmouseover = function() { closeBtn.style.opacity = '1'; };
      closeBtn.onmouseout = function() { closeBtn.style.opacity = '0.7'; };
      closeBtn.onclick = function() { hint.remove(); };
      hint.appendChild(closeBtn);
      document.documentElement.appendChild(hint);
      document.body.style.paddingTop = (hint.offsetHeight + 8) + 'px';
    })();
  `;
  win.webContents.executeJavaScript(js).catch(() => {});
  win.webContents.once('did-navigate', () => {
    win.webContents.once('did-finish-load', () => {
      win.webContents.executeJavaScript(js).catch(() => {});
    });
  });
  win.webContents.once('did-navigate-in-page', () => {
    win.webContents.executeJavaScript(js).catch(() => {});
  });
}

export function injectCenterToast(win: BrowserWindow, message: string) {
  const js = `
    (function() {
      var old = document.getElementById('__auto_shop_toast__');
      if (old) old.remove();
      var toast = document.createElement('div');
      toast.id = '__auto_shop_toast__';
      toast.style.cssText = 'position:fixed;top:50%;left:50%;transform:translate(-50%,-50%) scale(0.9);z-index:2147483647;padding:24px 40px;border-radius:16px;background:linear-gradient(135deg,rgba(37,99,235,0.95),rgba(29,78,216,0.95));color:#fff;font-size:18px;font-weight:600;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;text-align:center;line-height:1.6;pointer-events:none;opacity:0;transition:opacity 0.5s ease,transform 0.5s ease;max-width:420px;backdrop-filter:blur(12px);box-shadow:0 12px 40px rgba(37,99,235,0.4),0 0 0 1px rgba(255,255,255,0.1);border:1px solid rgba(255,255,255,0.15);text-shadow:0 1px 2px rgba(0,0,0,0.2);';
      toast.textContent = ${JSON.stringify(message)};
      document.documentElement.appendChild(toast);
      requestAnimationFrame(function() {
        toast.style.opacity = '1';
        toast.style.transform = 'translate(-50%,-50%) scale(1)';
      });
      setTimeout(function() {
        toast.style.opacity = '0';
        toast.style.transform = 'translate(-50%,-50%) scale(0.95)';
        setTimeout(function() { toast.remove(); }, 500);
      }, 8000);
    })();
  `;
  win.webContents.executeJavaScript(js).catch(() => {});
}

export const ORDER_API_JS = `
async function(pageNum, beginTime, endTime) {
  const form = new URLSearchParams();
  form.append('action', 'itemlist/BoughtQueryAction');
  form.append('event_submit_do_query', '1');
  form.append('_input_charset', 'utf8');
  form.append('pageNum', String(pageNum));
  form.append('pageSize', '20');
  form.append('prePageNo', String(pageNum - 1));
  if (beginTime) form.append('beginTime', beginTime);
  if (endTime) form.append('endTime', endTime);

  const resp = await fetch('${ORDER_API_URL}?action=itemlist/BoughtQueryAction&event_submit_do_query=1&_input_charset=utf8', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
    credentials: 'include',
  });

  const buffer = await resp.arrayBuffer();
  const utf8Text = new TextDecoder('utf-8').decode(buffer);
  let text;
  if (utf8Text.includes('\\ufffd')) {
    text = new TextDecoder('gbk').decode(buffer);
  } else {
    text = utf8Text;
  }
  const data = JSON.parse(text);
  const orders = [];

  if (data.mainOrders) {
    for (const order of data.mainOrders) {
      const subOrders = order.subOrders || [];
      const seller = order.seller || {};
      const orderInfo = order.orderInfo || {};
      const payInfo = order.payInfo || {};

      for (let si = 0; si < subOrders.length; si++) {
        const sub = subOrders[si];
        const itemInfo = sub.itemInfo || {};
        const priceInfo = sub.priceInfo || {};

        const productName = itemInfo.title || '';
        const productUrl = itemInfo.itemUrl || itemInfo.url || '';
        const imageUrl = itemInfo.pic ? (itemInfo.pic.startsWith('//') ? 'https:' + itemInfo.pic : itemInfo.pic) : '';
        const price = parseFloat(priceInfo.realPrice || payInfo.actualFee || '0');
        const orderId = order.id ? String(order.id) + (subOrders.length > 1 ? '_' + si : '') : '';
        const purchasedAt = orderInfo.createTime || '';
        const rawShopName = seller.shopName || seller.shopTitle || seller.nick || '';
        const shopName = typeof rawShopName === 'string' ? rawShopName : String(rawShopName);
        const rawSkuText = itemInfo.skuText || (sub.skuInfo && sub.skuInfo.skuText) || '';
        let skuText = '';
        if (Array.isArray(rawSkuText)) {
          skuText = rawSkuText.map(function(s) {
            if (s && typeof s === 'object' && s.name && s.value) return s.name + ':' + s.value;
            if (typeof s === 'string') return s;
            return '';
          }).filter(Boolean).join(';');
        } else if (typeof rawSkuText === 'string') {
          skuText = rawSkuText;
        }

        if (productName) {
          orders.push({ productName, productUrl, price, imageUrl, orderId, purchasedAt, shopName, sku: skuText });
        }
      }
    }
  }

  const hasNext = !!(data.mainOrders && data.mainOrders.length > 0);
  const totalOrders = data.totalResults || 0;
  return { orders, hasNext, totalOrders, mainOrderCount: data.mainOrders ? data.mainOrders.length : 0 };
}
`
