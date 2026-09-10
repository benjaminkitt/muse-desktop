// main.js — main-window bootstrap, injected as a Tauri initialization script
// (document-start, main frame only) on every navigation. Not bundled with the
// remote page: Tauri prepends it before any page script runs.
//
// Script order on the page (all run before page scripts):
//   1. plugin init-iifes (notification replaces window.Notification with a
//      native-backed constructor; opener installs a click→open_url listener —
//      the opener one is DISABLED in Rust via open_js_links_on_click(false)
//      because our own policy-gated handler replaces it; see main.rs).
//   2. THIS script (runs last): installs the page-facing Notification shim
//      exactly once, plus the external-link interceptor.
//
// What it does:
//   1. Origin-guard: activates ONLY on https://muse.ai. Auth hosts get no
//      shim, no interception — pristine page APIs (see README "Auth").
//   2. Notification shim: a genuinely NATIVE-backed `window.Notification`
//      replacement. Construction sends EXACTLY ONE OS toast via invoke
//      (`plugin:notification|notify`) when the cached permission is
//      'granted' — the page's own toast path is NOT also invoked, so there
//      are no duplicate toasts. Works when the web Notification API is
//      entirely absent (no `Original` to delegate to) because delivery never
//      depends on it.
//   3. Link interception: `_blank`/Ctrl/Meta/middle-click on http(s) links —
//      trusted/auth → webview; external → SINGLE `plugin:opener|open_url`
//      invoke (the Rust on_navigation guard is the backstop for top-level
//      and window.open navigations); dangerous schemes → blocked.
//   4. No tray logic here (Rust handles it).
//
// Unsupported Notification surface (documented, not faked):
//   - onclick/onclose/onshow/onerror handlers: ACCEPTED and stored per
//     instance (page code can assign them) but NEVER FIRED — the plugin
//     offers no click/close delivery to JS on desktop. Documented on the
//     constructor as `MuseNotification.unsupported = [...]`.
//   - close(): present, no-op (server-side cancel needs a notification id
//     the page never sees).
//   - actions/actionTypeId/icon/badge/image/data/tag/renotify/requireInteraction/
//     silent/vibrate/sound/channelId: accepted in options, NOT forwarded —
//     only title/body are sent (see NotificationData; extras would imply
//     capabilities we do not grant: channels, listeners, action types).
//   - static `maxActions`: reported as 0.
//   - `eventTarget` semantics: instances expose addEventListener/
//     removeEventListener/dispatchEvent backed by a REAL EventTarget when
//     available (so feature-detects pass), but notification events are never
//     dispatched (see above). `show`/`click`/`close`/`error` listener
//     registration therefore never fires — same honesty as the handlers.
//   - Service workers / push: out of scope (README "Limitations").
//   - Permission: async cache seeded 'default', synced from the OS on setup
//     (fire-and-forget refresh) and on every requestPermission(). The
//     `permission` getter reflects the cache — matching the plugin iife's
//     own behaviour of syncing permission into the property.

(() => {
  var TRUSTED_ORIGIN = "https://muse.ai";

  var UNSUPPORTED = [
    "click/close/show/error events (onclick, onclose, addEventListener) are accepted but never fired: the plugin has no desktop click-delivery to JS",
    "close() is a no-op (no notification id is exposed to cancel)",
    "actions, icons, sounds, tags, data payloads are dropped (title/body only)",
    "service-worker / push notifications are not supported",
  ];

  function isTrustedContext(loc) {
    try {
      return loc && loc.origin === TRUSTED_ORIGIN;
    } catch (_err) {
      return false;
    }
  }

  // Real EventTarget backing when available; minimal stub otherwise (never throws).
  function makeEventTarget() {
    try {
      if (typeof EventTarget === "function") return new EventTarget();
    } catch (_err) {
      /* fall through */
    }
    var listeners = {};
    return {
      addEventListener: (type, cb) => {
        listeners[type] = listeners[type] || [];
        listeners[type].push(cb);
      },
      removeEventListener: (type, cb) => {
        var arr = listeners[type] || [];
        var i = arr.indexOf(cb);
        if (i !== -1) arr.splice(i, 1);
      },
      dispatchEvent: () => true,
    };
  }

  function installBridge() {
    if (!isTrustedContext(window.location))
      return { installed: false, reason: "untrusted-origin" };
    if (window.__museBridgeInstalled)
      return { installed: true, reason: "already-installed" };

    var Bridge = window.MuseBridge;
    var Links = window.MuseLinks;
    var Tauri = window.MuseTauri;
    if (!Bridge || !Links || !Tauri)
      return { installed: false, reason: "missing-modules" };
    Bridge.setup(window);

    installNotificationShim(Bridge);
    installLinkInterception(Links, Tauri);
    window.__museBridgeInstalled = true;
    return { installed: true, reason: "ok" };
  }

  // Natively-backed Notification replacement. Construction delivers AT MOST
  // one OS toast (via Bridge.notify → invoke), and NEVER constructs the web
  // Notification — so no duplicate toasts, and no dependence on a web
  // Notification implementation existing at all.
  function installNotificationShim(Bridge) {
    if (window.__museNotifInstalled) return;
    window.__museNotifInstalled = true;

    function readCache() {
      try {
        return Bridge.state().permission;
      } catch (_err) {
        return "default";
      }
    }

    // Seed the cache from the OS without blocking page load.
    try {
      var p = Bridge.refresh(window);
      if (p && typeof p.catch === "function") p.catch(() => {});
    } catch (_err) {
      /* cache stays 'default' */
    }

    function MuseNotification(title, options) {
      var opts = options && typeof options === "object" ? options : {};
      var titleText = typeof title === "string" ? title : "";
      var bodyText = typeof opts.body === "string" ? opts.body : "";

      var et = makeEventTarget();
      this.addEventListener = et.addEventListener.bind(et);
      this.removeEventListener = et.removeEventListener.bind(et);
      this.dispatchEvent = et.dispatchEvent.bind(et);

      // Assignable handler slots (accepted, never fired — see UNSUPPORTED).
      this.onclick = null;
      this.onclose = null;
      this.onshow = null;
      this.onerror = null;

      // Echo the (dropped) option surface so feature reads don't throw.
      this.title = titleText;
      this.body = bodyText;
      this.tag = typeof opts.tag === "string" ? opts.tag : "";
      this.data = "data" in opts ? opts.data : null;
      this.close = () => {
        try {
          var ev;
          try {
            ev = new Event("close");
          } catch (_e2) {
            ev = { type: "close" };
          }
          this.dispatchEvent(ev);
        } catch (_e3) {
          /* no-op */
        }
      };

      // Single native delivery. Fire-and-forget EXCEPT failures are routed
      // to the instance's `error` channel (handler slot, never fired —
      // recorded as a property instead so tests can observe them).
      this.__delivery = null;
      try {
        var delivery = Bridge.notify(titleText, bodyText);
        this.__delivery = delivery;
        if (delivery && typeof delivery.catch === "function") {
          delivery.catch((err) => {
            try {
              this.__deliveryError = String((err && err.message) || err);
            } catch (_e4) {
              /* ignore */
            }
          });
        }
      } catch (err) {
        try {
          this.__deliveryError = String((err && err.message) || err);
        } catch (_e5) {
          /* ignore */
        }
      }
    }

    MuseNotification.prototype = null;
    try {
      MuseNotification.prototype = Object.create(Object.prototype);
    } catch (_err) {
      MuseNotification.prototype = {};
    }

    // requestPermission(callback?): OS prompt via invoke. Legacy callback
    // form supported. Never rejects: transport failure → 'default'.
    function requestPermission(callback) {
      var done;
      try {
        done = Bridge.request(window);
      } catch (_err) {
        done = Promise.resolve("default");
      }
      var result = Promise.resolve(done).then((perm) =>
        perm === "granted" || perm === "denied" ? perm : "default",
      );
      if (typeof callback === "function") {
        result.then((perm) => {
          try {
            callback(perm);
          } catch (_err) {
            /* page callback threw: ignore */
          }
        });
      }
      return result;
    }

    Object.defineProperties(MuseNotification, {
      permission: {
        enumerable: true,
        configurable: true,
        get: () => readCache(),
      },
      requestPermission: {
        value: requestPermission,
        writable: true,
        configurable: true,
      },
      maxActions: { value: 0, writable: false, configurable: true },
      unsupported: {
        value: UNSUPPORTED.slice(),
        writable: false,
        configurable: true,
      },
    });

    try {
      window.Notification = MuseNotification;
    } catch (_err) {
      /* frozen page global: leave pristine */
    }
  }

  // External-link interception. Trusted/auth → untouched (webview).
  // External http(s) + new-context gesture → SINGLE open_url invoke
  // (JS side). Same-tab external clicks are left for the Rust on_navigation
  // guard, which opens them externally via AppHandle and cancels in-webview.
  // Dangerous schemes → always blocked. window.open to external http(s) is
  // patched to the same single-invoke path so popups don't spawn webviews.
  function installLinkInterception(Links, Tauri) {
    if (window.__museLinksInstalled) return;
    window.__museLinksInstalled = true;

    function openExternal(url) {
      try {
        var adapter = Tauri.detect(window);
        if (adapter) {
          var r = adapter.openUrl(url);
          if (r && typeof r.catch === "function") r.catch(() => {});
          return true;
        }
      } catch (_err) {
        /* fall through to window.open fallback */
      }
      try {
        window.open(url, "_blank", "noopener");
      } catch (_e2) {
        /* blocked popup: acceptable */
      }
      return false;
    }

    document.addEventListener(
      "click",
      (event) => {
        try {
          var anchor =
            event.target && event.target.closest
              ? event.target.closest("a[href]")
              : null;
          if (!anchor) return;
          var href = anchor.getAttribute("href");
          if (!href) return;
          var url;
          try {
            url = new URL(href, window.location.href).toString();
          } catch (_err) {
            return;
          }
          var decision = Links.decide(url);
          if (decision === "block") {
            event.preventDefault();
            event.stopPropagation();
            return;
          }
          if (decision !== "external") return;
          var opensNewContext =
            anchor.target === "_blank" ||
            event.metaKey ||
            event.ctrlKey ||
            event.shiftKey ||
            event.button === 1;
          if (!opensNewContext) return; // same-tab: Rust on_navigation handles it
          event.preventDefault();
          event.stopPropagation();
          openExternal(url);
        } catch (_err) {
          /* never break page clicks */
        }
      },
      true,
    );

    // window.open patch: external http(s) popups → OS browser (single
    // invoke), trusted → untouched, dangerous → null. Preserved when the
    // page has no window.open at all.
    try {
      var originalOpen = window.open;
      window.open = (url, target, features) => {
        try {
          if (typeof url === "undefined" || url === null || url === "") {
            return typeof originalOpen === "function"
              ? originalOpen.call(window, url, target, features)
              : null;
          }
          var absolute;
          try {
            absolute = new URL(String(url), window.location.href).toString();
          } catch (_err) {
            return null;
          }
          var decision = Links.decide(absolute);
          if (decision === "block") return null;
          if (decision === "external") {
            openExternal(absolute);
            return null;
          }
        } catch (_err) {
          /* fall through to original */
        }
        try {
          return typeof originalOpen === "function"
            ? originalOpen.call(window, url, target, features)
            : null;
        } catch (_e2) {
          return null;
        }
      };
      window.__museOriginalOpen = originalOpen;
    } catch (_err) {
      /* non-configurable window.open: leave pristine */
    }
  }

  var status = installBridge();
  try {
    window.__museBridgeStatus = status;
  } catch (_err) {
    /* ignore */
  }
})();
