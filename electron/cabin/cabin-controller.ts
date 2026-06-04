import { BrowserWindow, ipcMain } from 'electron'
import { debugLog } from '../utils/debug-log'
import type { WindowManager } from '../platforms/taobao/infrastructure/window-manager'

export interface CabinCommandResult {
  success: boolean
  data?: any
  error?: string
}

/**
 * CabinController 负责与前端 ExecutionCabin webview 通信
 * 通过 IPC 发送命令（导航、执行JS、检测页面状态）到前端 webview
 * 前端 webview 执行后通过 IPC 返回结果
 */
export class CabinController {
  private mainWindow: BrowserWindow | null = null
  private windowManager: WindowManager
  private pendingCommands = new Map<string, {
    resolve: (result: CabinCommandResult) => void
    timer: ReturnType<typeof setTimeout>
  }>()

  constructor(windowManager: WindowManager) {
    this.windowManager = windowManager
    this.setupIpcListeners()
  }

  setMainWindow(win: BrowserWindow) {
    this.mainWindow = win
  }

  private setupIpcListeners() {
    // 前端 webview 执行完命令后的回调
    ipcMain.on('cabin:command-result', (_event, commandId: string, result: CabinCommandResult) => {
      debugLog('DIAG', `[CabinController] 收到前端指令执行结果: id=${commandId}, success=${result.success}, error=${result.error}`)
      const pending = this.pendingCommands.get(commandId)
      if (pending) {
        clearTimeout(pending.timer)
        this.pendingCommands.delete(commandId)
        pending.resolve(result)
      } else {
        debugLog('DIAG', `[CabinController] 收到过期或未知指令结果: id=${commandId}`)
      }
    })

    // 前端 webview 的导航事件上报
    ipcMain.on('cabin:webview-navigated', (_event, url: string) => {
      debugLog('DIAG', `[CabinController] 收到前端 webview 导航上报: url=${url}`)
      this._lastNavigatedUrl = url
      const callbacks = this._navigationCallbacks
      for (const cb of callbacks) {
        cb(url)
      }
    })
  }

  private _lastNavigatedUrl = ''
  private _navigationCallbacks: Array<(url: string) => void> = []

  /** 获取 webview 最后导航到的 URL */
  get lastUrl(): string {
    return this._lastNavigatedUrl
  }

  /** 监听 webview 导航事件 */
  onNavigation(callback: (url: string) => void): () => void {
    this._navigationCallbacks.push(callback)
    return () => {
      this._navigationCallbacks = this._navigationCallbacks.filter(cb => cb !== callback)
    }
  }

  /** 发送命令到前端 webview */
  private sendCommand(type: string, payload: any, timeoutMs = 30000): Promise<CabinCommandResult> {
    debugLog('DIAG', `[CabinController] 准备发送指令: type=${type}`)
    return new Promise((resolve) => {
      if (!this.mainWindow || this.mainWindow.isDestroyed()) {
        debugLog('DIAG', `[CabinController] 发送失败: mainWindow 不可用或已销毁`)
        resolve({ success: false, error: 'mainWindow not available' })
        return
      }

      const commandId = `cmd_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
      const timer = setTimeout(() => {
        debugLog('DIAG', `[CabinController] 指令超时! id=${commandId}, type=${type}`)
        this.pendingCommands.delete(commandId)
        resolve({ success: false, error: 'command timeout' })
      }, timeoutMs)

      this.pendingCommands.set(commandId, { resolve, timer })
      debugLog('DIAG', `[CabinController] 正在通过 WebContents 发送指令: id=${commandId}, type=${type}`)
      this.mainWindow.webContents.send('cabin:command', {
        id: commandId,
        type,
        payload,
      })
    })
  }

  /** 在 webview 中导航到指定 URL */
  async navigate(url: string): Promise<CabinCommandResult> {
    return this.sendCommand('navigate', { url }, 30000)
  }

  /** 在 webview 中执行 JavaScript 并返回结果 */
  async executeJs(script: string, timeoutMs = 15000): Promise<any> {
    const result = await this.sendCommand('execute_js', { script }, timeoutMs)
    if (result.success) return result.data
    throw new Error(result.error || 'JS execution failed')
  }

  /** 在 webview 中对指定相对视口坐标执行原生物理模拟点击 */
  async simulateClick(x: number, y: number): Promise<boolean> {
    debugLog('DIAG', `[CabinController] 准备发送原生物理模拟点击指令: x=${x}, y=${y}`)
    const result = await this.sendCommand('simulate_click', { x, y }, 5000)
    return result.success
  }

  /** 在 webview 中查找并点击匹配文本的按钮 */
  async findAndClickButton(textTargets: string[], timeoutMs = 10000): Promise<boolean> {
    const script = `
      (function() {
        if (!window.__confirmHijacked) {
          try {
            window.confirm = function() { return true; };
            window.alert = function() { return true; };
            window.showModalDialog = function() { return true; };
            window.__confirmHijacked = true;
          } catch(e) {}
        }

        if (!window.__windowOpenIntercepted) {
          window.open = function(url, target, features) {
            if (url) {
              window.location.href = url;
            }
            return null;
          };
          window.__windowOpenIntercepted = true;
        }

        var targets = ${JSON.stringify(textTargets)};
        var selectors = ['button', 'a', '[role="button"]', '[class*="btn"]', '[class*="Button"]', 'input[type="submit"]', 'div', 'span'];
        var candidates = [];

        for (var si = 0; si < selectors.length; si++) {
          var els = document.querySelectorAll(selectors[si]);
          for (var ei = 0; ei < els.length; ei++) {
            var el = els[ei];
            var text = (el.textContent || el.value || '').replace(/\\s+/g, '').trim();
            var rect = el.getBoundingClientRect();
            if (rect.width <= 0 || rect.height <= 0) continue;
            if (rect.width > 250 || rect.height > 80) continue;
            
            for (var ti = 0; ti < targets.length; ti++) {
              if (text.includes(targets[ti])) {
                var hasBetterChild = false;
                var children = el.querySelectorAll('button, a, div, span');
                for (var ci = 0; ci < children.length; ci++) {
                  var child = children[ci];
                  var childText = (child.textContent || '').replace(/\\s+/g, '').trim();
                  var childRect = child.getBoundingClientRect();
                  if (childRect.width > 0 && childRect.height > 0 && childRect.width < rect.width && childText.includes(targets[ti])) {
                    hasBetterChild = true;
                    break;
                  }
                }
                if (hasBetterChild) continue;

                var centerX = rect.left + rect.width / 2;
                var centerY = rect.top + rect.height / 2;
                
                var score = 0;
                
                var currentEl = el;
                var isModal = false;
                for (var depth = 0; depth < 8 && currentEl; depth++) {
                  var cls = (currentEl.className || '').toString().toLowerCase();
                  var idName = (currentEl.id || '').toString().toLowerCase();
                  if (
                    cls.includes('modal') || cls.includes('dialog') || cls.includes('pop') || 
                    cls.includes('layer') || cls.includes('confirm') || cls.includes('mask') || 
                    cls.includes('alert') || cls.includes('overlay') || cls.includes('tip') ||
                    cls.includes('msg') || cls.includes('window') ||
                    idName.includes('modal') || idName.includes('dialog') || idName.includes('pop') ||
                    idName.includes('confirm') || idName.includes('alert')
                  ) {
                    isModal = true;
                    break;
                  }
                  currentEl = currentEl.parentElement;
                }
                if (isModal) score += 1000;
                
                var viewW = window.innerWidth || 800;
                var viewH = window.innerHeight || 600;
                if (centerX > viewW * 0.2 && centerX < viewW * 0.8 && centerY > viewH * 0.2 && centerY < viewH * 0.8) {
                  score += 200;
                }
                
                var tagName = el.tagName.toLowerCase();
                if (tagName === 'button' || tagName === 'a' || el.getAttribute('role') === 'button') {
                  score += 100;
                }
                
                candidates.push({
                  el: el,
                  x: rect.left + rect.width * (0.3 + Math.random() * 0.4),
                  y: rect.top + rect.height * (0.3 + Math.random() * 0.4),
                  text: text.substring(0, 30),
                  score: score
                });
              }
            }
          }
        }

        if (candidates.length > 0) {
          candidates.sort(function(a, b) { return b.score - a.score; });
          var best = candidates[0];
          var bestEl = best.el;

          // 判断是否为 <a> 标签或被 <a> 包裹
          var linkEl = null;
          var isLink = bestEl.tagName && bestEl.tagName.toLowerCase() === 'a';
          if (isLink) {
            linkEl = bestEl;
          } else {
            var parentLink = bestEl.closest('a');
            if (parentLink) linkEl = parentLink;
          }

          if (linkEl) {
            // <a> 标签：sendInputEvent 不触发默认导航行为，必须用 JS 直接导航
            var href = linkEl.href || linkEl.getAttribute('href') || '';
            if (href && href !== '#' && href !== 'javascript:void(0)') {
              // 将 target=_blank 改为 _self，避免中转确认页
              if (linkEl.target === '_blank' || linkEl.target === 'blank') {
                linkEl.target = '_self';
              }
              // 先用 _hs.click 触发事件监听器（如淘宝的点击埋点等）
              if (window._hs && typeof window._hs.click === 'function') {
                window._hs.click(linkEl);
              }
              // 然后直接导航，确保跳转一定发生
              window.location.href = href;
              return { found: true, text: best.text, score: best.score, tag: bestEl.tagName, method: 'link_navigate', href: href.substring(0, 100) };
            }
          }

          // 非 <a> 标签：使用 sendInputEvent 原生点击（isTrusted=true）
          return { found: true, x: Math.round(best.x), y: Math.round(best.y), text: best.text, score: best.score, tag: bestEl.tagName, method: 'sendInputEvent' };
        }
        return { found: false };
      })()
    `
    try {
      const result = await this.executeJs(script, timeoutMs)
      if (!result || result.found !== true) {
        debugLog('DIAG', `[CabinController] 未能在页面中定位查找到任何匹配的目标按钮: ${JSON.stringify(textTargets)}`)
        return false
      }

      if (result.method === 'link_navigate') {
        debugLog('DIAG', `[CabinController] 定位 <a> 链接: "${result.text}" <${result.tag}>，评分: ${result.score} 分，已通过 JS 直接导航 href=${result.href}`)
        return true
      }

      if (result.x !== undefined && result.y !== undefined) {
        debugLog('DIAG', `[CabinController] 定位按钮: "${result.text}" <${result.tag}>，评分: ${result.score} 分，坐标: (${result.x}, ${result.y})，正在通过 sendInputEvent 执行原生点击`)
        const clicked = await this.simulateClick(result.x, result.y)
        if (clicked) {
          debugLog('DIAG', `[CabinController] 原生点击成功! isTrusted=true`)
        } else {
          debugLog('DIAG', `[CabinController] 原生点击 sendInputEvent 返回失败`)
        }
        return clicked
      }

      debugLog('DIAG', `[CabinController] 按钮定位结果异常: ${JSON.stringify(result)}`)
      return false
    } catch (e) {
      debugLog('DIAG', `[CabinController] findAndClickButton 执行异常: ${e}`)
      return false
    }
  }

  /** 检测当前页面的关键特征 */
  async detectPageFeatures(): Promise<{
    url: string
    hasCaptcha: boolean
    hasLoginForm: boolean
    hasPayButton: boolean
    hasPaySuccess: boolean
    hasSubmitOrder: boolean
    bodyTextPreview: string
  }> {
    const script = `
      (function() {
        var url = location.href;
        var bodyText = (document.body?.innerText || '').substring(0, 1000);
        
        // 检测验证码
        var captchaSelectors = ['#nocaptcha', '#nc_1_wrapper', '[class*="nc-container"]', '[class*="slider"]', '[class*="captcha"]', '[class*="Captcha"]'];
        var hasCaptcha = false;
        for (var i = 0; i < captchaSelectors.length; i++) {
          var el = document.querySelector(captchaSelectors[i]);
          if (el) { var rect = el.getBoundingClientRect(); if (rect.width > 50 && rect.height > 20) { hasCaptcha = true; break; } }
        }
        if (!hasCaptcha && (bodyText.includes('验证') || bodyText.includes('滑块'))) hasCaptcha = true;
        
        // 检测登录
        var hasLoginForm = url.includes('login') || bodyText.includes('密码登录') || bodyText.includes('短信登录') || bodyText.includes('扫码登录');
        
        // 检测支付按钮
        var payTexts = ['免密支付', '立即支付', '确认支付', '去支付', '立即付款'];
        var submitTexts = ['提交订单', '确认订单'];
        var hasPayButton = false;
        var hasSubmitOrder = false;
        var btns = document.querySelectorAll('button, a, [role="button"], span, div, input[type="submit"]');
        for (var j = 0; j < btns.length; j++) {
          var btnText = (btns[j].textContent || btns[j].value || '').replace(/\\s+/g, '');
          var btnRect = btns[j].getBoundingClientRect();
          if (btnRect.width <= 0 || btnRect.height <= 0) continue;
          for (var k = 0; k < payTexts.length; k++) { if (btnText.includes(payTexts[k])) { hasPayButton = true; break; } }
          for (var m = 0; m < submitTexts.length; m++) { if (btnText.includes(submitTexts[m])) { hasSubmitOrder = true; break; } }
        }
        
        // 检测支付成功
        var hasPaySuccess = bodyText.includes('支付成功') || bodyText.includes('已付款') || bodyText.includes('支付完成') || url.includes('payresult') || url.includes('trade_success') || url.includes('paySuccess');
        
        return {
          url: url,
          hasCaptcha: hasCaptcha,
          hasLoginForm: hasLoginForm,
          hasPayButton: hasPayButton,
          hasPaySuccess: hasPaySuccess,
          hasSubmitOrder: hasSubmitOrder,
          bodyTextPreview: bodyText.substring(0, 200)
        };
      })()
    `
    try {
      return await this.executeJs(script)
    } catch {
      return {
        url: '',
        hasCaptcha: false,
        hasLoginForm: false,
        hasPayButton: false,
        hasPaySuccess: false,
        hasSubmitOrder: false,
        bodyTextPreview: '',
      }
    }
  }

  /** 等待 URL 匹配特定模式 */
  async waitForUrlMatch(patterns: string[], timeoutMs = 60000): Promise<string | null> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        unsubscribe()
        resolve(null)
      }, timeoutMs)

      // 先检查当前 URL
      if (this._lastNavigatedUrl) {
        for (const pattern of patterns) {
          if (this._lastNavigatedUrl.includes(pattern)) {
            clearTimeout(timer)
            resolve(this._lastNavigatedUrl)
            return
          }
        }
      }

      const unsubscribe = this.onNavigation((url) => {
        for (const pattern of patterns) {
          if (url.includes(pattern)) {
            clearTimeout(timer)
            unsubscribe()
            resolve(url)
            return
          }
        }
      })
    })
  }

  /** 通知前端切换操作舱模式 */
  setMode(mode: 'auto' | 'interactive') {
    this.windowManager.cabinDisplayMode = mode
  }

  /** 通知前端显示支付信息条 */
  showPaymentInfo(amount: number, paymentMode: string) {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send('cabin:payment-info', { amount, paymentMode })
    }
  }

  /** 隐藏支付信息条 */
  hidePaymentInfo() {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send('cabin:payment-info', null)
    }
  }

  /** 清理资源 */
  cleanup() {
    for (const [id, pending] of this.pendingCommands) {
      clearTimeout(pending.timer)
      pending.resolve({ success: false, error: 'cleanup' })
    }
    this.pendingCommands.clear()
    this._navigationCallbacks = []
  }
}
