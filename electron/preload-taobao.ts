import { webFrame } from 'electron'

try {
  const ANTI_DETECT_JS = `
    try {
      // 1. 屏蔽 visibilitychange 事件以防后台感知
      Object.defineProperty(Document.prototype, 'visibilityState', { get: () => 'visible', configurable: true });
      Object.defineProperty(Document.prototype, 'hidden', { get: () => false, configurable: true });
      Object.defineProperty(document, 'visibilityState', { get: () => 'visible', configurable: true });
      Object.defineProperty(document, 'hidden', { get: () => false, configurable: true });
      
      // 2. 抹除 navigator.webdriver 标识
      if (typeof navigator !== 'undefined') {
        try {
          const proto = Object.getPrototypeOf(navigator);
          if (proto && Object.prototype.hasOwnProperty.call(proto, 'webdriver')) {
            delete proto.webdriver;
          }
        } catch (e) {}
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined, configurable: true });
        Object.defineProperty(navigator, 'languages', { get: () => ['zh-CN', 'zh', 'en-US', 'en'], configurable: true });
        Object.defineProperty(navigator, 'platform', { get: () => 'Win32', configurable: true });
        Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8, configurable: true });
        Object.defineProperty(navigator, 'maxTouchPoints', { get: () => 0, configurable: true });
      }

      // 3. 拦截并模拟 permissions.query
      if (typeof navigator !== 'undefined' && navigator.permissions) {
        const origQuery = navigator.permissions.query.bind(navigator.permissions);
        Object.defineProperty(navigator.permissions, 'query', {
          value: function(params) { 
            return params.name === 'notifications' 
              ? Promise.resolve({ state: Notification.permission }) 
              : origQuery(params); 
          },
          configurable: true,
        });
      }

      // 4. 补全 window.chrome 属性，模拟正常 Chrome
      const win = window;
      if (!win.chrome) { win.chrome = {}; }
      if (!win.chrome.runtime) { 
        win.chrome.runtime = { 
          connect: function(){}, 
          sendMessage: function(){}, 
          onMessage: { addListener: function(){} } 
        }; 
      }
      if (!win.chrome.app) { 
        win.chrome.app = { 
          isInstalled: false, 
          InstallState: { DISABLED: 'disabled', INSTALLED: 'installed', NOT_INSTALLED: 'not_installed' }, 
          RunningState: { CANNOT_RUN: 'cannot_run', READY_TO_RUN: 'ready_to_run', RUNNING: 'running' }, 
          getDetails: function(){}, 
          getIsInstalled: function(){ return false; } 
        }; 
      }
      if (!win.chrome.csi) { win.chrome.csi = function(){}; }
      if (!win.chrome.loadTimes) { 
        win.chrome.loadTimes = function() { 
          return { 
            commitLoadTime: Date.now() / 1000, 
            connectionInfo: 'h2', 
            finishDocumentLoadTime: 0, 
            finishLoadTime: 0, 
            firstPaintAfterLoadTime: 0, 
            firstPaintTime: 0, 
            navigationType: 'Other', 
            npnNegotiatedProtocol: 'h2', 
            requestTime: Date.now() / 1000 - 0.5, 
            startLoadTime: Date.now() / 1000 - 0.5, 
            wasAlternateProtocolAvailable: false, 
            wasFetchedViaSpdy: true, 
            wasNpnNegotiated: true 
          }; 
        }; 
      }
    } catch (e) {
      console.error('[Stealth] Main world injection failed:', e);
    }
  `;
  webFrame.executeJavaScript(ANTI_DETECT_JS);
} catch (e) {
  console.error('[Stealth] Preload execution error:', e);
}
