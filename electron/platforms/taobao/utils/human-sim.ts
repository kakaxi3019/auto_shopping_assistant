export const HUMAN_SIM_JS = `
  if (!window._hs) {
  var _hs = {
    rand: function(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; },
    click: function(el) {
      if (!el) return false;
      var rect = el.getBoundingClientRect();
      var x = rect.left + rect.width * (0.3 + Math.random() * 0.4);
      var y = rect.top + rect.height * (0.3 + Math.random() * 0.4);
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
      return true;
    },
    scrollSmooth: function(targetY, duration) {
      duration = duration || _hs.rand(300, 800);
      var startY = window.pageYOffset;
      var diff = targetY - startY;
      var start = null;
      return new Promise(function(resolve) {
        function step(ts) {
          if (!start) start = ts;
          var progress = Math.min((ts - start) / duration, 1);
          var ease = progress < 0.5 ? 2 * progress * progress : -1 + (4 - 2 * progress) * progress;
          window.scrollTo(0, startY + diff * ease);
          if (progress < 1) requestAnimationFrame(step);
          else resolve();
        }
        requestAnimationFrame(step);
      });
    },
    delay: function(min, max) {
      return new Promise(function(r) { setTimeout(r, _hs.rand(min, max)); });
    },
    findVisible: function(selectors, textTargets) {
      var results = [];
      for (var si = 0; si < selectors.length; si++) {
        var els = document.querySelectorAll(selectors[si]);
        for (var i = 0; i < els.length; i++) {
          var el = els[i];
          var rect = el.getBoundingClientRect();
          if (rect.width <= 0 || rect.height <= 0) continue;
          var text = (el.textContent || '').trim();
          if (!text || text.length > 100) continue;
          var normalized = text.replace(/\\s+/g, '');
          var matched = !textTargets || textTargets.some(function(t) { return normalized.includes(t); });
          if (matched) results.push({ el: el, text: text, area: rect.width * rect.height, rect: rect });
        }
      }
      return results;
    },
    findAndClick: function(selectors, textTargets) {
      var results = _hs.findVisible(selectors, textTargets);
      if (results.length === 0) return null;
      results.sort(function(a, b) { return a.area - b.area; });
      return _hs.click(results[0].el) ? results[0] : null;
    }
  };
  window._hs = _hs;
  }
`
