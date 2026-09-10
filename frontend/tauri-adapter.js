// tauri-adapter: minimal documented invoke bridge for the remote page.
//
// Verified against Tauri v2 sources (NOT assumed from `withGlobalTauri`):
//   - `withGlobalTauri` exposes ONLY `window.__TAURI__` core modules
//     (core/event/window/…, see @tauri-apps/api docs). Plugin JS APIs are
//     NOT on `window.__TAURI__`.
//   - Each plugin registers an initialization script (`js_init_script`):
//       notification plugin → REPLACES `window.Notification` with a
//         native-backed constructor + async `requestPermission()` and a
//         synced `permission` getter (see plugins-workspace
//         `plugins/notification/src/init-iife.js`, `guest-js/index.ts`:
//         `isPermissionGranted` invokes `plugin:notification|is_permission_granted`
//         only while web permission is `default`; `sendNotification`
//         constructs `new window.Notification(...)`; commands are
//         `is_permission_granted`, `request_permission`, `notify`).
//       opener plugin → installs a capture-phase click listener that opens
//         `_blank`/Ctrl/Shift http(s)/mailto/tel links via
//         `plugin:opener|open_url` (see `plugins/opener/src/init-iife.js`;
//         default ON via `open_js_links_on_click`, disabled here in Rust
//         because our own policy-gated handler replaces it; `openUrl`
//         invokes `plugin:opener|open_url` with `{url, with}`).
//   - The single transport under both is `window.__TAURI_INTERNALS__.invoke`
//     (see tauri `src/ipc/`), which is present on ANY Tauri webview
//     (local or remote) — capability-gated per command, per origin.
//     There is NO `__TAURI_PLUGIN_NOTIFICATION__`-style global; claims to
//     the contrary are wrong.
//
// This module wraps that transport with a tiny, testable surface so the rest
// of the bridge never touches Tauri globals directly:
//
//   detect(host) -> adapter | null
//   adapter.invoke(cmd, args) -> Promise (delegates to __TAURI_INTERNALS__)
//   adapter.notify(payload)   -> invoke('plugin:notification|notify', {options})
//   adapter.isGranted()       -> invoke('plugin:notification|is_permission_granted')
//   adapter.requestOs()       -> invoke('plugin:notification|request_permission')
//   adapter.openUrl(url)      -> invoke('plugin:opener|open_url', {url})
//
// `detect` returns null outside a Tauri webview OR when `invoke` is absent
// (e.g. unit tests, plain browsers, locked-down contexts). It MUST NOT probe
// `window.__TAURI__.notification` / `.opener`: those properties do not exist
// (review blocker #1 — the old code read them and always saw null, so the
// native path was silently dead).
//
// Command strings below are pinned to the plugin Rust sources:
//   notification: commands::notify / request_permission / is_permission_granted
//     → invoke ids 'plugin:notification|notify' (args {options:{title,body?}}),
//       'plugin:notification|request_permission' (no args),
//       'plugin:notification|is_permission_granted' (no args → bool|null).
//     NOTE: `request_permission` resolves to a PermissionState string
//     ('granted'|'denied'|'prompt'|'prompt-with-rationale'); callers map
//     prompt-states to 'default'. `is_permission_granted` resolves to
//     true/false/null (null = not yet decided → 'default').
//   opener: commands::open_url → 'plugin:opener|open_url' ({url, with?}).
//   The guest-js string forms are `new window.Notification(title, opts)`
//   for send and `window.Notification.requestPermission()` for prompt —
//   but our shim REPLACES window.Notification itself, so we call invoke
//   directly to avoid recursing into our own constructor.

(() => {
  var CMD_NOTIFY = "plugin:notification|notify";
  var CMD_IS_GRANTED = "plugin:notification|is_permission_granted";
  var CMD_REQUEST = "plugin:notification|request_permission";
  var CMD_OPEN_URL = "plugin:opener|open_url";

  function getInternals(host) {
    try {
      var scope = host || (typeof window === "undefined" ? globalThis : window);
      var internals = scope && scope.__TAURI_INTERNALS__;
      if (!internals || typeof internals.invoke !== "function") return null;
      return internals;
    } catch (_err) {
      return null;
    }
  }

  // detect(host) — returns an adapter bound to the host's invoke, or null.
  // A test override (`host.__museTestInvoke`) is honoured for VM tests:
  // pass `{ __museTestInvoke: fn }` as host to inject a fake transport
  // without any Tauri global.
  function detect(host) {
    var scope = host || (typeof window === "undefined" ? globalThis : window);
    var invokeFn = null;
    try {
      if (scope && typeof scope.__museTestInvoke === "function") {
        invokeFn = scope.__museTestInvoke;
      } else {
        var internals = getInternals(scope);
        if (internals) invokeFn = internals.invoke.bind(internals);
      }
    } catch (_err) {
      return null;
    }
    if (!invokeFn) return null;
    return makeAdapter(invokeFn);
  }

  function makeAdapter(invokeFn) {
    function invoke(cmd, args) {
      return invokeFn(cmd, args || {});
    }
    return {
      invoke: invoke,
      notify: (payload) => invoke(CMD_NOTIFY, { options: payload }),
      isGranted: () => invoke(CMD_IS_GRANTED),
      requestOs: () => invoke(CMD_REQUEST),
      openUrl: (url) => invoke(CMD_OPEN_URL, { url: url }),
      commands: {
        notify: CMD_NOTIFY,
        isGranted: CMD_IS_GRANTED,
        request: CMD_REQUEST,
        openUrl: CMD_OPEN_URL,
      },
    };
  }

  var api = { detect: detect, makeAdapter: makeAdapter };

  /* eslint-disable no-undef */
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
  var root = typeof window === "undefined" ? globalThis : window;
  try {
    if (!root.MuseTauri) {
      Object.defineProperty(root, "MuseTauri", {
        value: api,
        writable: true,
        configurable: true,
      });
    }
  } catch (_err) {
    root.MuseTauri = api;
  }
  /* eslint-enable no-undef */

  return api;
})();
