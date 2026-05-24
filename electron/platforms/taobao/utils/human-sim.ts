export const HUMAN_SIM_JS = `
  if (!window._hs) {
  var _hs = {
    rand: function(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; },
    gaussRand: function() {
      var u1 = Math.random(), u2 = Math.random();
      return Math.sqrt(-2 * Math.log(Math.max(u1, 1e-10))) * Math.cos(2 * Math.PI * u2);
    },
    bezierPoint: function(t, p0, p1, p2, p3) {
      var mt = 1 - t;
      return mt * mt * mt * p0 + 3 * mt * mt * t * p1 + 3 * mt * t * t * p2 + t * t * t * p3;
    },
    moveMouseTo: function(targetX, targetY, callback) {
      var startX = window._lastMouseX || 0;
      var startY = window._lastMouseY || 0;
      var dx = targetX - startX;
      var dy = targetY - startY;
      var dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < 5) {
        window._lastMouseX = targetX;
        window._lastMouseY = targetY;
        if (callback) callback();
        return;
      }
      var cp1x = startX + dx * 0.25 + (_hs.gaussRand() * dist * 0.1);
      var cp1y = startY + dy * 0.25 + (_hs.gaussRand() * dist * 0.1);
      var cp2x = startX + dx * 0.75 + (_hs.gaussRand() * dist * 0.1);
      var cp2y = startY + dy * 0.75 + (_hs.gaussRand() * dist * 0.1);
      var steps = Math.max(8, Math.min(40, Math.floor(dist / 8)));
      var step = 0;
      function animateStep() {
        if (step > steps) {
          window._lastMouseX = targetX;
          window._lastMouseY = targetY;
          if (callback) callback();
          return;
        }
        var t = step / steps;
        var ease = t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;
        var x = _hs.bezierPoint(ease, startX, cp1x, cp2x, targetX) + _hs.gaussRand() * 1.5;
        var y = _hs.bezierPoint(ease, startY, cp1y, cp2y, targetY) + _hs.gaussRand() * 1.5;
        var evt = new MouseEvent('mousemove', { view: window, bubbles: true, cancelable: true, clientX: x, clientY: y });
        document.elementFromPoint(x, y)?.dispatchEvent(evt);
        window._lastMouseX = x;
        window._lastMouseY = y;
        step++;
        var delay = 8 + Math.abs(_hs.gaussRand()) * 12;
        setTimeout(animateStep, delay);
      }
      animateStep();
    },
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
      duration = duration || _hs.rand(400, 900);
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
    scrollFriction: function(distance, duration) {
      distance = distance || _hs.rand(300, 600);
      duration = duration || _hs.rand(600, 1200);
      var startY = window.pageYOffset;
      var targetY = startY + distance;
      var start = null;
      return new Promise(function(resolve) {
        function step(ts) {
          if (!start) start = ts;
          var elapsed = ts - start;
          var progress = Math.min(elapsed / duration, 1);
          var friction = 1 - Math.pow(1 - progress, 3);
          var currentY = startY + distance * friction;
          window.scrollTo(0, currentY);
          if (progress < 1) {
            requestAnimationFrame(step);
          } else {
            var overshoot = _hs.gaussRand() * 15;
            window.scrollTo(0, targetY + overshoot);
            setTimeout(function() {
              window.scrollTo(0, targetY);
              resolve();
            }, _hs.rand(50, 150));
          }
        }
        requestAnimationFrame(step);
      });
    },
    delay: function(min, max) {
      var base = (min + max) / 2;
      var sigma = (max - min) / 6;
      var ms = base + _hs.gaussRand() * sigma;
      ms = Math.max(min, Math.min(max, ms));
      return new Promise(function(r) { setTimeout(r, Math.round(ms)); });
    },
    _checkEl: function(el, textTargets) {
      var rect = el.getBoundingClientRect();
      var ow = el.offsetWidth || 0;
      var oh = el.offsetHeight || 0;
      var visible = (rect.width > 0 && rect.height > 0) || (ow > 0 && oh > 0);
      if (!visible) return null;
      var text = (el.textContent || '').trim();
      if (!text) return null;
      var normalized = text.replace(/\\s+/g, '');
      var matched = !textTargets || textTargets.some(function(t) { return normalized.includes(t); });
      if (!matched) return null;
      var w = rect.width > 0 ? rect.width : ow;
      var h = rect.height > 0 ? rect.height : oh;
      return { el: el, text: text.substring(0, 200), area: w * h, rect: rect.width > 0 ? rect : { width: ow, height: oh, left: 0, top: 0 } };
    },
    findVisible: function(selectors, textTargets) {
      var results = [];
      for (var si = 0; si < selectors.length; si++) {
        var els = document.querySelectorAll(selectors[si]);
        for (var i = 0; i < els.length; i++) {
          var r = _hs._checkEl(els[i], textTargets);
          if (r) results.push(r);
        }
      }
      return results;
    },
    findByText: function(textTargets, maxTextLength) {
      maxTextLength = maxTextLength || 30;
      var results = [];
      var allEls = document.querySelectorAll('*');
      for (var i = 0; i < allEls.length; i++) {
        var el = allEls[i];
        var text = (el.textContent || '').trim();
        if (!text || text.length > maxTextLength) continue;
        var r = _hs._checkEl(el, textTargets);
        if (r) results.push(r);
      }
      return results;
    },
    findInShadowDOM: function(selectors, textTargets) {
      var results = [];
      function searchRoot(root) {
        for (var si = 0; si < selectors.length; si++) {
          try {
            var els = root.querySelectorAll(selectors[si]);
            for (var i = 0; i < els.length; i++) {
              var r = _hs._checkEl(els[i], textTargets);
              if (r) results.push(r);
            }
          } catch(e) {}
        }
        try {
          var allEls = root.querySelectorAll('*');
          for (var j = 0; j < allEls.length; j++) {
            try {
              if (allEls[j].shadowRoot) {
                searchRoot(allEls[j].shadowRoot);
              }
            } catch(e) {}
          }
        } catch(e) {}
      }
      searchRoot(document);
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
