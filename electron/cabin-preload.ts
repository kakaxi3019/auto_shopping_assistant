// electron/cabin-preload.ts
// 操作舱专属的 webview preload 拦截脚本。
// 包含：反自动化检测隐身、原生弹窗劫持、真人点击仿真引擎。

(function() {
  console.log('[CABIN-PRELOAD] 注入成功，开始实施反检测隐身 + 弹窗拦截 + 真人点击模拟...');

  try {
    // ============================================================
    // 第一优先级：反自动化检测隐身（必须在页面任何 JS 执行前完成）
    // ============================================================

    // 1. 抹除 navigator.webdriver 标记（最关键的反检测项）
    try {
      delete Object.getPrototypeOf(navigator).__proto__.webdriver;
    } catch(e) {}
    try {
      Object.defineProperty(navigator, 'webdriver', { get: function() { return undefined; }, configurable: true });
    } catch(e) {}

    // 2. 伪装 document.visibilityState / hidden（防止被检测为后台页面）
    try {
      Object.defineProperty(Document.prototype, 'visibilityState', { get: function() { return 'visible'; }, configurable: true });
      Object.defineProperty(Document.prototype, 'hidden', { get: function() { return false; }, configurable: true });
      Object.defineProperty(document, 'visibilityState', { get: function() { return 'visible'; }, configurable: true });
      Object.defineProperty(document, 'hidden', { get: function() { return false; }, configurable: true });
    } catch(e) {}

    // 3. 拦截 visibilitychange 事件（防止页面感知到失焦）
    try {
      window.addEventListener('visibilitychange', function(e) { e.stopImmediatePropagation(); }, true);
      document.addEventListener('visibilitychange', function(e) { e.stopImmediatePropagation(); }, true);
    } catch(e) {}

    // 4. 修正 navigator 指纹
    try {
      Object.defineProperty(navigator, 'languages', { get: function() { return ['zh-CN', 'zh', 'en-US', 'en']; }, configurable: true });
      Object.defineProperty(navigator, 'platform', { get: function() { return 'Win32'; }, configurable: true });
      Object.defineProperty(navigator, 'hardwareConcurrency', { get: function() { return 8; }, configurable: true });
      Object.defineProperty(navigator, 'maxTouchPoints', { get: function() { return 0; }, configurable: true });
    } catch(e) {}

    // 5. 伪装 Permissions API
    try {
      var origQuery = window.navigator.permissions.query.bind(window.navigator.permissions);
      Object.defineProperty(window.navigator.permissions, 'query', {
        value: function(params: any) { return params.name === 'notifications' ? Promise.resolve({ state: Notification.permission }) : origQuery(params); },
        configurable: true,
      });
    } catch(e) {}

    // 6. 模拟 window.chrome 对象（正常 Chrome 浏览器特有，Electron webview 缺失）
    try {
      var w: any = window;
      if (!w.chrome) { w.chrome = {}; }
      if (!w.chrome.runtime) {
        w.chrome.runtime = {
          connect: function() {},
          sendMessage: function() {},
          onMessage: { addListener: function() {} }
        };
      }
      if (!w.chrome.app) {
        w.chrome.app = {
          isInstalled: false,
          InstallState: { DISABLED: 'disabled', INSTALLED: 'installed', NOT_INSTALLED: 'not_installed' },
          RunningState: { CANNOT_RUN: 'cannot_run', READY_TO_RUN: 'ready_to_run', RUNNING: 'running' },
          getDetails: function() {},
          getIsInstalled: function() { return false; }
        };
      }
      if (!w.chrome.csi) { w.chrome.csi = function() {}; }
      if (!w.chrome.loadTimes) {
        w.chrome.loadTimes = function() {
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
    } catch(e) {}

    // 7. 拦截 beforeunload（防止淘宝通过 beforeunload 弹出"即将离开页面"确认框）
    try {
      window.addEventListener('beforeunload', function(e) {
        e.stopImmediatePropagation();
      }, true);
      (window as any).onbeforeunload = null;
    } catch(e) {}

    console.log('[CABIN-PRELOAD] 反检测隐身全部就绪！');

    // ============================================================
    // window.open 拦截：将新窗口导航重定向到当前页面
    // 淘宝"再买一单"等按钮使用 target=_blank 打开新窗口
    // 在 webview 中无法像 BrowserWindow 那样通过 setWindowOpenHandler 处理
    // 所以将 window.open 重定向为当前页面内跳转，避免触发中转确认页
    // ============================================================

    try {
        (window as any).open = function(url: any, _target: any, _features: any) {
        console.log('[CABIN-PRELOAD] 拦截 window.open: ' + (url || '').substring(0, 80));
        if (url) {
          window.location.href = url;
        }
        return null;
      };
      console.log('[CABIN-PRELOAD] window.open 拦截就绪！');
    } catch(e) {}

    // ============================================================
    // 弹窗劫持：阻断所有阻塞式原生弹窗
    // ============================================================

    window.confirm = function(message) {
      console.log('[CABIN-PRELOAD] 拦截并自动放行 confirm 弹窗: "' + (message || '').substring(0, 50) + '"');
      return true;
    };
    window.alert = function(message) {
      console.log('[CABIN-PRELOAD] 拦截并放行 alert 弹窗: "' + (message || '').substring(0, 50) + '"');
      return true;
    };
    window.prompt = function(message, defaultVal) {
      console.log('[CABIN-PRELOAD] 拦截并放行 prompt 弹窗: "' + (message || '').substring(0, 50) + '"');
      return defaultVal || '';
    };
    (window as any).showModalDialog = function() {
      console.log('[CABIN-PRELOAD] 拦截并放行 showModalDialog 弹窗');
      return true;
    };

    console.log('[CABIN-PRELOAD] 原生弹窗劫持就绪！');

    // ============================================================
    // 真人点击仿真引擎 (window._hs.click)
    // ============================================================

    var _hs = {
      rand: function(min: number, max: number) { return Math.floor(Math.random() * (max - min + 1)) + min; },
      click: function(el: any) {
        if (!el) return false;
        var rect = el.getBoundingClientRect();
        var x = rect.left + rect.width * (0.3 + Math.random() * 0.4);
        var y = rect.top + rect.height * (0.3 + Math.random() * 0.4);

        console.log('[CABIN-PRELOAD] 仿真点击 <' + el.tagName + '> 坐标: (' + Math.round(x) + ', ' + Math.round(y) + ')');

        var opts = { view: window, bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, buttons: 1 };
        var pointerOpts = Object.assign({}, opts, { pointerId: 1, pointerType: 'mouse', isPrimary: true, pressure: 0.5, width: 1, height: 1, tiltX: 0, tiltY: 0 });

        el.dispatchEvent(new PointerEvent('pointerover', Object.assign({}, pointerOpts, { pressure: 0 })));
        el.dispatchEvent(new MouseEvent('mouseover', opts));
        el.dispatchEvent(new PointerEvent('pointerenter', Object.assign({}, pointerOpts, { pressure: 0 })));
        el.dispatchEvent(new MouseEvent('mouseenter', opts));
        el.dispatchEvent(new PointerEvent('pointermove', Object.assign({}, pointerOpts, { clientX: x + _hs.rand(-2,2), clientY: y + _hs.rand(-2,2) })));
        el.dispatchEvent(new MouseEvent('mousemove', Object.assign({}, opts, { clientX: x + _hs.rand(-2,2), clientY: y + _hs.rand(-2,2) })));
        el.dispatchEvent(new PointerEvent('pointerdown', Object.assign({}, pointerOpts, { pressure: 0.5 })));
        el.dispatchEvent(new MouseEvent('mousedown', opts));
        el.dispatchEvent(new PointerEvent('pointerup', Object.assign({}, pointerOpts, { pressure: 0 })));
        el.dispatchEvent(new MouseEvent('mouseup', opts));
        el.dispatchEvent(new PointerEvent('pointerout', Object.assign({}, pointerOpts, { pressure: 0 })));
        el.dispatchEvent(new MouseEvent('mouseout', opts));
        el.dispatchEvent(new PointerEvent('pointerleave', Object.assign({}, pointerOpts, { pressure: 0 })));
        el.dispatchEvent(new MouseEvent('mouseleave', opts));
        el.dispatchEvent(new MouseEvent('click', opts));

        console.log('[CABIN-PRELOAD] 仿真物理事件流分发完毕');
        return true;
      }
    };

    (window as any)._hs = _hs;
    (window as any).__confirmHijacked = true;

    console.log('[CABIN-PRELOAD] 全部初始化完成：反检测隐身 + 弹窗劫持 + 真人仿真引擎');

  } catch (e) {
    console.error('[CABIN-PRELOAD] 初始化失败:', e);
  }
})();
