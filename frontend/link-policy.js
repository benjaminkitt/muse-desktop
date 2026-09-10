// External-link policy for the main window.
//
// Runs inside the same initialization script as the bridge (see
// notification-bridge.js). Pure decision function first, DOM wiring second,
// so the policy is unit-testable without a webview.
//
// Policy:
//   - Same-origin https://muse.ai navigations stay in the webview.
//   - Auth-adjacent hosts that Muse may redirect through during login are
//     allowed to stay in the webview (documented, review before changing).
//   - Everything else (other https hosts, custom schemes, non-http(s))
//     is delegated to the OS browser via the opener plugin when present,
//     otherwise left to the webview with a console warning.

(() => {
  var TRUSTED_HOSTS = ["muse.ai", "www.muse.ai"];

  // Hosts the Muse login flow may legitimately bounce through (OAuth-style
  // popups/redirects). Kept as data (not code) so reviewers can audit the
  // unvalidated-auth surface explicitly. See README "Auth compatibility".
  var AUTH_HOSTS = [
    "auth.muse.ai",
    "auth.meta.com",
    "www.facebook.com",
    "m.facebook.com",
    "www.instagram.com",
  ];

  function hostOf(url) {
    try {
      return new URL(url, "https://muse.ai").hostname.toLowerCase();
    } catch (_err) {
      return "";
    }
  }

  function schemeOf(url) {
    try {
      return new URL(url, "https://muse.ai").protocol.toLowerCase();
    } catch (_err) {
      return "";
    }
  }

  // decide(url) -> 'webview' | 'external' | 'block'
  //   webview:  trusted/app or auth hosts over https
  //   external: safe to open in the OS browser (http(s) elsewhere)
  //   block:    dangerous schemes (javascript:, data:, file:, …)
  function decide(url) {
    var scheme = schemeOf(url);
    if (scheme !== "https:" && scheme !== "http:") return "block";
    var host = hostOf(url);
    if (TRUSTED_HOSTS.indexOf(host) !== -1) return "webview";
    if (AUTH_HOSTS.indexOf(host) !== -1) return "webview";
    return "external";
  }

  function isTrusted(url) {
    return decide(url) === "webview";
  }

  var api = {
    decide: decide,
    isTrusted: isTrusted,
    TRUSTED_HOSTS: TRUSTED_HOSTS.slice(),
    AUTH_HOSTS: AUTH_HOSTS.slice(),
  };

  /* eslint-disable no-undef */
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
  var root = typeof window === "undefined" ? globalThis : window;
  try {
    root.MuseLinks = root.MuseLinks || api;
  } catch (_err) {
    root.MuseLinks = api;
  }
  /* eslint-enable no-undef */

  return api;
})();
