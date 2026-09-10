// notification-bridge: permission cache + native sender over the invoke adapter.
//
// Transport: `frontend/tauri-adapter.js` (`MuseTauri.detect(host)`), which
// binds `window.__TAURI_INTERNALS__.invoke` — the ONLY plugin transport that
// exists on a remote page. The old revision probed
// `window.__TAURI__.notification`, which does not exist (plugins are never on
// `__TAURI__`), so its native path was silently dead. This revision deletes
// that probe: no `__TAURI__` access anywhere in this file.
//
// Role split (deliberate):
//   - This module owns the async permission CACHE ('default'|'granted'|'denied')
//     and the direct `notify` sender. It does NOT install `window.Notification`.
//   - The notification plugin's own init-iife ALSO replaces
//     `window.Notification` (it runs before/after ours depending on script
//     order). Our `main.js` installs the page-facing shim exactly once and
//     wins by running last; it delegates sends to this module, never to the
//     plugin's constructor (which would recurse into our shim).
//   - `refresh()` / `request()` consult the OS via invoke; the WEB
//     `Notification.permission` is only a fallback seed when no adapter exists.
//
// Public surface (window.MuseBridge):
//   setup(host)               — detect adapter, seed permission, idempotent
//   ready()                   — true when an adapter is bound
//   refresh(host?)            — re-query OS grant (bool|null → granted/default…)
//   request(host?)            — OS prompt; maps prompt-states → 'default'
//   notify(title, body|{body})— sends iff cache is 'granted'; else typed fallback
//   state() / reset()
//
// Mapping (pinned to plugin Rust commands):
//   is_permission_granted → true|'granted' ⇒ 'granted'; false|'denied' ⇒ 'denied';
//     null/undefined (undecided) or invoke failure ⇒ 'default'.
//   request_permission → 'granted' ⇒ 'granted'; 'denied' ⇒ 'denied';
//     'prompt'|'prompt-with-rationale'|anything else/failure ⇒ 'default'.
// The cache NEVER fabricates 'denied' from a transport failure.

(() => {
  var PERMISSIONS = ["default", "granted", "denied"];

  var state = {
    permission: "default",
    native: false,
    canRequest: false,
    disabledReason: "uninitialised",
  };

  function isPlainObject(value) {
    return Object.prototype.toString.call(value) === "[object Object]";
  }

  function toText(value, max) {
    if (typeof value !== "string") return "";
    var trimmed = value
      .trim()
      .replace(/[\u0000-\u001F\u007F]+/g, " ")
      .replace(/\s+/g, " ");
    return trimmed.slice(0, max);
  }

  function normalizeOptions(title, bodyOrOptions) {
    var titleText = toText(title, 120);
    var bodyText = "";
    if (typeof bodyOrOptions === "string") {
      bodyText = toText(bodyOrOptions, 500);
    } else if (
      isPlainObject(bodyOrOptions) &&
      typeof bodyOrOptions.body === "string"
    ) {
      bodyText = toText(bodyOrOptions.body, 500);
    }
    return { title: titleText, body: bodyText };
  }

  function validPermission(value) {
    return PERMISSIONS.indexOf(value) === -1 ? "default" : value;
  }

  function adapterFor(host) {
    try {
      var scope = host || (typeof window === "undefined" ? globalThis : window);
      // Test seam: explicit adapter object takes precedence.
      if (scope && scope.__museTestAdapter) return scope.__museTestAdapter;
      var Tauri = scope && scope.MuseTauri;
      if (Tauri && typeof Tauri.detect === "function")
        return Tauri.detect(scope);
      if (
        typeof scope.__museTestInvoke === "function" &&
        Tauri &&
        typeof Tauri.makeAdapter === "function"
      ) {
        return Tauri.makeAdapter(scope.__museTestInvoke);
      }
      // Node VM tests: neighbouring module may live on globalThis only.
      if (typeof globalThis !== "undefined" && globalThis !== scope) {
        var G = globalThis.MuseTauri;
        if (G && typeof G.detect === "function") {
          var found = G.detect(scope);
          if (found) return found;
        }
      }
      return null;
    } catch (_err) {
      return null;
    }
  }

  // Reads the web Notification permission for this origin when exposed.
  // Missing API => 'default' (unknown), never throws.
  function readWebPermission(host) {
    try {
      var scope = host || (typeof window === "undefined" ? globalThis : window);
      var N = scope && scope.Notification;
      if (typeof N === "undefined") return "default";
      return validPermission(N.permission);
    } catch (_err) {
      return "default";
    }
  }

  // setup(host): bind adapter + seed permission cache. Idempotent.
  function setup(host) {
    var scope = host || (typeof window === "undefined" ? globalThis : window);
    var adapter = adapterFor(scope);
    setup.cache = adapter;
    state.native = Boolean(adapter);
    state.canRequest = Boolean(adapter);
    if (!adapter) {
      state.disabledReason = "native-unavailable";
      state.permission = readWebPermission(scope);
      return snapshot();
    }
    state.disabledReason = "none";
    state.permission = readWebPermission(scope);
    return snapshot();
  }

  function snapshot() {
    return {
      permission: state.permission,
      native: state.native,
      canRequest: state.canRequest,
      disabledReason: state.disabledReason,
    };
  }

  function mapGrantedResult(value) {
    if (value === true || value === "granted") return "granted";
    if (value === false || value === "denied") return "denied";
    return "default";
  }

  function mapRequestResult(value) {
    if (value === "granted") return "granted";
    if (value === "denied") return "denied";
    return "default";
  }

  // refresh(host?): re-query the OS grant. Never rejects.
  async function refresh(host) {
    var adapter = setup.cache;
    if (adapter) {
      try {
        var value = await adapter.isGranted();
        state.permission = mapGrantedResult(value);
      } catch (_err) {
        state.permission = "default";
      }
      return state.permission;
    }
    var scope = host;
    if (typeof scope === "undefined") {
      scope = typeof window === "undefined" ? globalThis : window;
    }
    state.permission = readWebPermission(scope);
    return state.permission;
  }

  // request(host?): trigger the OS prompt via invoke. Never rejects.
  async function request(host) {
    var adapter = setup.cache;
    if (adapter) {
      try {
        var value = await adapter.requestOs();
        state.permission = mapRequestResult(value);
      } catch (_err) {
        state.permission = "default";
      }
      return state.permission;
    }
    return refresh(host);
  }

  function ready() {
    return Promise.resolve(Boolean(setup.cache));
  }

  // notify(title, body|options): direct invoke sender. Sends ONLY when the
  // cache is 'granted'; otherwise resolves a typed non-delivery (callers show
  // in-page UI). Never rejects on invalid input or transport failure.
  async function notify(title, bodyOrOptions) {
    var opts = normalizeOptions(title, bodyOrOptions);
    if (!opts.title) {
      return { delivered: false, reason: "invalid-title" };
    }
    if (state.permission !== "granted") {
      return { delivered: false, reason: "permission-" + state.permission };
    }
    var adapter = setup.cache;
    if (!adapter) {
      return { delivered: false, reason: "fallback", fallback: true };
    }
    try {
      await adapter.notify({ title: opts.title, body: opts.body || undefined });
      return { delivered: true };
    } catch (err) {
      return {
        delivered: false,
        reason: "send-failed",
        fallback: true,
        error: String((err && err.message) || err),
      };
    }
  }

  function reset() {
    setup.cache = null;
    state.permission = "default";
    state.native = false;
    state.canRequest = false;
    state.disabledReason = "uninitialised";
  }

  var api = {
    setup: setup,
    ready: ready,
    request: request,
    refresh: refresh,
    notify: notify,
    state: snapshot,
    reset: reset,
  };

  /* eslint-disable no-undef */
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
  var root = typeof window === "undefined" ? globalThis : window;
  try {
    Object.defineProperty(root, "MuseBridge", {
      value: api,
      writable: true,
      configurable: true,
    });
  } catch (_err) {
    root.MuseBridge = api;
  }
  /* eslint-enable no-undef */

  return api;
})();
