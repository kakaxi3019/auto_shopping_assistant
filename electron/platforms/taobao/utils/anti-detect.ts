export const ANTI_DETECT_JS = `
  Object.defineProperty(Document.prototype, 'visibilityState', { get: () => 'visible', configurable: true });
  Object.defineProperty(Document.prototype, 'hidden', { get: () => false, configurable: true });
  Object.defineProperty(document, 'visibilityState', { get: () => 'visible', configurable: true });
  Object.defineProperty(document, 'hidden', { get: () => false, configurable: true });
  window.addEventListener('visibilitychange', function(e) { e.stopImmediatePropagation(); }, true);

  delete Object.getPrototypeOf(navigator).__proto__.webdriver;
  Object.defineProperty(navigator, 'webdriver', { get: () => undefined, configurable: true });
  Object.defineProperty(navigator, 'languages', { get: () => ['zh-CN', 'zh', 'en-US', 'en'], configurable: true });
  Object.defineProperty(navigator, 'platform', { get: () => 'Win32', configurable: true });
  Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8, configurable: true });
  Object.defineProperty(navigator, 'maxTouchPoints', { get: () => 0, configurable: true });

  var origQuery = window.navigator.permissions.query.bind(window.navigator.permissions);
  Object.defineProperty(window.navigator.permissions, 'query', {
    value: function(params) { return params.name === 'notifications' ? Promise.resolve({ state: Notification.permission }) : origQuery(params); },
    configurable: true,
  });

  if (!window.chrome) { window.chrome = {}; }
  if (!window.chrome.runtime) { window.chrome.runtime = { connect: function(){}, sendMessage: function(){}, onMessage: { addListener: function(){} } }; }
  if (!window.chrome.app) { window.chrome.app = { isInstalled: false, InstallState: { DISABLED: 'disabled', INSTALLED: 'installed', NOT_INSTALLED: 'not_installed' }, RunningState: { CANNOT_RUN: 'cannot_run', READY_TO_RUN: 'ready_to_run', RUNNING: 'running' }, getDetails: function(){}, getIsInstalled: function(){ return false; } }; }
  if (!window.chrome.csi) { window.chrome.csi = function(){}; }
  if (!window.chrome.loadTimes) { window.chrome.loadTimes = function(){ return { commitLoadTime: Date.now()/1000, connectionInfo: 'h2', finishDocumentLoadTime: 0, finishLoadTime: 0, firstPaintAfterLoadTime: 0, firstPaintTime: 0, navigationType: 'Other', npnNegotiatedProtocol: 'h2', requestTime: Date.now()/1000 - 0.5, startLoadTime: Date.now()/1000 - 0.5, wasAlternateProtocolAvailable: false, wasFetchedViaSpdy: true, wasNpnNegotiated: true }; }; }

  var origGetContext = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function(type) {
    var result = origGetContext.apply(this, arguments);
    if (type === '2d' && result) {
      var origGetImageData = result.getImageData;
      result.getImageData = function() {
        var imageData = origGetImageData.apply(this, arguments);
        for (var i = 0; i < imageData.data.length; i += 4) {
          imageData.data[i] += Math.random() > 0.5 ? 1 : -1;
        }
        return imageData;
      };
      var origToDataURL = result.canvas.toDataURL;
      result.canvas.toDataURL = function() {
        var ctx2 = origGetContext.call(this, '2d');
        if (ctx2) {
          var imgData = origGetImageData.call(ctx2, 0, 0, this.width, this.height);
          for (var i = 0; i < imgData.data.length; i += 4) {
            imgData.data[i] += Math.random() > 0.5 ? 1 : -1;
          }
          ctx2.putImageData(imgData, 0, 0);
        }
        return origToDataURL.apply(this, arguments);
      };
    }
    return result;
  };
`
