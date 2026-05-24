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

`;
