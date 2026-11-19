(function () {
  'use strict';
  var guardKey = 'pathflow.assets.recovery.v2';
  var reloading = false;
  var refreshParameter = '__pathflow_reload';
  try {
    var current = new URL(location.href);
    if (current.searchParams.has(refreshParameter)) {
      current.searchParams.delete(refreshParameter);
      history.replaceState(history.state, '', current.href);
    }
  } catch (_) {}

  function freshUrl(target) {
    var url = new URL(target);
    url.searchParams.set(refreshParameter, String(Date.now()));
    return url.href;
  }

  function localUrl(value) {
    try {
      var url = new URL(value || location.href, location.origin);
      if (url.origin === location.origin && !/^\/\.auth(?:\/|$)|^\/api(?:\/|$)/i.test(url.pathname)) return url.href;
    } catch (_) {}
    return location.href;
  }

  function isAssetFailure(error) {
    var message = '';
    for (var depth = 0; error && depth < 4; depth++) {
      message += ' ' + (error.message || String(error));
      if (/(?:chrome|moz|safari)-extension:\/\//i.test(message + (error.stack || ''))) return false;
      error = error.cause || error.ngOriginalError || error.rejection;
    }
    if (!/failed to fetch dynamically imported module|error loading dynamically imported module|importing a module script failed|loading chunk .+ failed|loading pathflow asset failed/i.test(message)) return false;
    var source = message.match(/https?:\/\/[^\s'"<>\)]+/i);
    try { return !source || new URL(source[0]).origin === location.origin; } catch (_) { return false; }
  }

  function showNotice(target) {
    if (!document.body) {
      document.addEventListener('DOMContentLoaded', function () { showNotice(target); }, { once: true });
      return;
    }
    var notice = document.getElementById('pathflow-asset-recovery');
    if (!notice) {
      notice = document.createElement('aside');
      notice.id = 'pathflow-asset-recovery';
      notice.setAttribute('role', 'alert');
      notice.style.cssText = 'position:fixed;bottom:16px;right:16px;z-index:2147483647;box-sizing:border-box;width:min(380px,calc(100% - 32px));padding:16px;border:1px solid #d99e2c;border-radius:8px;background:#fff8e5;color:#332b18;font:15px/1.5 system-ui,sans-serif;box-shadow:0 6px 24px #0003';
      var text = document.createElement('p');
      text.textContent = 'Pathflow could not load this page. Reload to continue.'
        + (document.querySelector('app-internal-shell') ? ' Save any changes first.' : '');
      text.style.margin = '0 0 12px';
      var link = document.createElement('a');
      link.textContent = 'Reload page';
      link.style.cssText = 'display:inline-flex;align-items:center;min-height:40px;padding:0 14px;border-radius:6px;background:#066fd1;color:#fff;text-decoration:none;font-weight:600';
      notice.append(text, link);
      document.body.appendChild(notice);
    }
    notice.querySelector('a').href = freshUrl(target);
  }

  function recover(error, destination, automatic) {
    if (!isAssetFailure(error)) return false;
    if (reloading) return true;
    var target = localUrl(destination);
    if (automatic && navigator.onLine !== false) {
      try {
        var previous = JSON.parse(sessionStorage.getItem(guardKey) || 'null');
        var now = Date.now();
        if (!previous || (Number.isFinite(previous.at) && now - previous.at > 120000)) {
          sessionStorage.setItem(guardKey, JSON.stringify({ at: now }));
          reloading = true;
          location.replace(freshUrl(target));
          return true;
        }
      } catch (_) {
        // A persistent guard is required before automatically reloading.
      }
    }
    showNotice(target);
    return true;
  }

  window.pathflowAssetRecovery = { recover: recover };
  window.addEventListener('error', function (event) {
    var element = event.target;
    var isScript = element && element.tagName === 'SCRIPT';
    var isStylesheet = element && element.tagName === 'LINK' && element.rel === 'stylesheet';
    if (isScript || isStylesheet) {
      var source = element.src || element.href;
      if (source && new URL(source, location.href).origin === location.origin) {
        recover(new Error('Loading Pathflow asset failed: ' + source), location.href,
          !document.querySelector('app-root > *') || /^\/(?:login)?$/.test(location.pathname));
      }
      return;
    }
    recover(event.error || event.message, location.href, /^\/(?:login)?$/.test(location.pathname));
  }, true);
  window.addEventListener('unhandledrejection', function (event) {
    recover(event.reason, location.href, /^\/(?:login)?$/.test(location.pathname));
  });
}());
