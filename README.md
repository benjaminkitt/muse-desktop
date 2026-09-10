# Muse Desktop

Lightweight, unofficial desktop wrapper for **<https://muse.ai>** (Meta's personal-agent site, verified live 2026-09-09: title *"Your Personal AI Agent"*).
**macOS and Linux only.** Smallest-footprint Tauri v2 system-webview shell: no frontend framework, no bundler — four hand-auditable JS files injected as an initialization script, close hides to tray, tray has exactly **Show** and **Quit**, and the web `Notification` API is replaced by a genuinely native-backed shim.

## What it does

| Behavior | Implementation |
|---|---|
| Main window loads `https://muse.ai` | Rust `WebviewWindowBuilder` (`src-tauri/src/main.rs`), not config JSON, so the init script + navigation guards attach to the same window |
| Close (×) hides to tray | `CloseRequested` → `prevent_close()` + `hide()`; only tray **Quit** exits |
| Tray: Show / Quit | Rust-only `TrayIconBuilder` menu (`show`, `quit`) — no `trayIcon` key in `tauri.conf.json` (single owner, no duplicate id); left-click release restores on macOS/Windows; on Linux click events are unsupported so the right-click menu is the restore path |
| Native notifications | `frontend/tauri-adapter.js` (invoke transport) + `frontend/notification-bridge.js` (permission cache/sender) + `frontend/main.js` shim: `new Notification()` sends EXACTLY ONE OS toast via `plugin:notification\|notify` — no web-toast duplicate, works with no web Notification present |
| External links | Rust owns them: `on_navigation` + `on_new_window` open external http(s) via `AppHandle` opener and cancel/deny in-webview; JS click/`window.open` interception invokes the same `plugin:opener\|open_url` for gestures; dangerous schemes blocked |

## Quick start

```bash
nix develop                          # NixOS/nix: system webview libs + node (Rust comes from host 1.97; see below)
bash scripts/check-prereqs.sh        # report build prerequisites for this machine
npm install                          # installs @tauri-apps/cli + JS API bindings (lockfile: package-lock.json)
npm test                             # offline tests: adapter + bridge + init-VM + link policy (no login needed)
bash scripts/smoke.sh                # full offline smoke + manual checklist (runs cargo check in nix shell when available)
npm run dev                          # dev window (loads https://muse.ai)
npm run build                        # platform-native bundles (see "Bundling" below)
```

## Build prerequisites

**Nix (reproducible, recommended on Linux):** `flake.nix` provides a devShell with webkitgtk_4_1, gtk3, libsoup_3, glib, dbus, openssl, librsvg, ayatana-appindicator + libappindicator-gtk3, nodejs_24, pkg-config. `flake.lock` pins nixpkgs (nixos-25.05).

```bash
nix develop --command bash scripts/smoke.sh   # full validation incl. cargo check + tests
nix develop --command bash -c 'cd src-tauri && cargo check'
```

Caveats, honestly stated: the shell intentionally does NOT ship Rust (nixpkgs 25.05 has rustc 1.86, but the pinned Tauri 2.11.5 tree needs ≥1.89; the host Rust 1.97 is used instead), and it does NOT set `LD_LIBRARY_PATH` (leaking nix openssl into host cargo breaks TLS — if your shell sets it, `export LD_LIBRARY_PATH=""` inside `nix develop` before running cargo).

**macOS:** Xcode command-line tools (`xcode-select --install`), Rust ≥ 1.89, Node ≥ 18. The flake's darwin shells supply toolchains only; WebKit comes from the Xcode SDK.

**Linux without nix (Debian/Ubuntu):**

```bash
sudo apt install libwebkit2gtk-4.1-dev libgtk-3-dev libsoup-3.0-dev \
  libjavascriptcoregtk-4.1-dev libdbus-1-dev pkg-config
```

Fedora: `sudo dnf install webkit2gtk4.1-devel gtk3-devel libsoup3-devel dbus-devel pkgconf-pkg-config`.
Plus Rust ≥ 1.89 and Node ≥ 18.

## Bundling

`bundle.targets` is `"all"`: `npm run build` produces the platform-native formats for the machine it runs on (macOS: `.app` + `.dmg`; Linux: `.deb` + `.appimage`). There is deliberately NO cross-platform target list — a single config cannot emit macOS bundles on Linux or vice versa, so platform-specific `tauri build --bundles` flags are used only when narrowing output (e.g. `tauri build --bundles deb`).

## Security decisions

- **Exact trusted origin:** the remote capability (`src-tauri/capabilities/remote.json`) grants `https://muse.ai` ONLY `notification:allow-is-permission-granted`, `allow-request-permission`, `allow-notify` (+ `core:default` for the invoke transport). No wildcards. The remote page has NO opener grant — external URLs are opened from Rust via `AppHandle` under the local-window opener scope (`opener:allow-open-url(https://**)` in `main.json`). **No shell, filesystem, or dialog exposure anywhere** — `scripts/smoke.sh` asserts this.
- **Transport truth (verified, not assumed):** `withGlobalTauri` is `false`. Plugins are reached ONLY via `window.__TAURI_INTERNALS__.invoke` with command ids pinned to the plugin Rust sources (`plugin:notification|notify`, `|is_permission_granted`, `|request_permission`, `plugin:opener|open_url`). The old `window.__TAURI__.notification/.opener` probe was dead code (those properties don't exist) and is deleted; smoke asserts no such access remains. Command strings are asserted in `test/bridge.test.js`.
- **Policy mirroring (corrected claim):** `src-tauri/src/policy.rs` (`TRUSTED_APP_HOSTS`, `AUTH_FLOW_HOSTS`, `classify_navigation`) and `frontend/link-policy.js` (`decide`) are TWO implementations of the same matrix, kept in sync by MIRROR TESTS on both sides (8 Rust + 5 JS pinning lookalikes like `muse.ai.evil.com` → external, `javascript:`/`data:`/`file:` → blocked, garbage → fail-closed). They are not a single module — `policy.rs` governs top-level navigations/popups in Rust; `link-policy.js` governs click/`window.open` gestures in JS.
- **External links:** opened from Rust (`on_navigation` cancels + `OpenerExt::open_url`; `on_new_window` denies ALL popups as webviews — trusted popups must navigate their own tab, externals go to the OS browser, dangerous are denied). The JS layer invokes the same `open_url` for new-context gestures only (same-tab external clicks are left for the Rust guard, asserting zero JS invokes). The opener plugin's own click listener is disabled (`open_js_links_on_click(false)`) so it can't double-fire.
- **Auth compatibility (unvalidated surface, explicit):** Muse login may bounce through `auth.meta.com`, `www.facebook.com`, `m.facebook.com`. These hosts may *render* in the webview so login completes, but they receive **no IPC grants** and the JS bridge **does not install** there (`main.js` guards on `location.origin === 'https://muse.ai'`, VM-tested). Review `AUTH_HOSTS` before extending; prefer removing entries.
- **CSP scope (corrected claim):** `tauri.conf.json` ships a CSP (`navigate-to` allowlist, `object-src 'none'`, `base-uri 'none'`, auth `frame-src`) that constrains OUR window's own loads — it is NOT a sandbox around `muse.ai`'s remote content (the remote page's own headers/CSP govern what it fetches; our CSP cannot and does not audit Meta's scripts). Treat it as defense-in-depth for the shell, not protection from the remote page.
- **Permissions respected:** the shim sends ONLY when its async OS-synced cache is `'granted'`; `false`/denied → `'denied'` (no send); undecided `null` or transport failure → `'default'` (no send, never fabricated `'denied'`).

## Notification bridge — semantics and limitations

- `new Notification(title, {body})` delivers EXACTLY ONE OS toast (VM-tested: single `notify` invoke per construction). There is no page-visible web toast alongside it — the old double-toast behaviour (construct web + mirror native) is deleted.
- `permission` getter reflects the async OS cache (seeded `'default'`, refreshed fire-and-forget on load and on every `requestPermission()`); `requestPermission()` supports the legacy callback form and never rejects (failure → `'default'`).
- `window.MuseBridge` (`setup/ready/request/refresh/notify/state/reset`) is the testable seam; `test/bridge.test.js` covers the cache/sender against a fake invoke transport, and `test/init.test.js` runs the REAL shipped files in a Node VM webview (absent `Notification`, denied/failed permission, single-delivery, single-open, `window.open` patch, untrusted-origin refusal).
- **Explicitly unsupported (not faked):** `onclick`/`onclose`/event-listener notifications are accepted but NEVER fired (no desktop click-delivery to JS); `close()` dispatches a local `close` event only (no server cancel); `maxActions` is 0; actions/icons/sounds/tags/data/ channels/listeners are dropped (title ≤120 chars + body ≤500 chars only); service-worker/push is out of scope — notifications fire only while the page is open and constructs them.

## Project layout

```
frontend/tauri-adapter.js      invoke transport (MuseTauri.detect; command strings pinned)
frontend/notification-bridge.js  OS permission cache + direct sender (MuseBridge)
frontend/link-policy.js          pure decide(url)->webview|external|block (MuseLinks; mirror of policy.rs)
frontend/main.js                 init script: origin guard + native Notification shim + link interception
src-tauri/src/main.rs            window, tray (Show/Quit, Rust-only), close-to-tray, on_navigation/on_new_window
src-tauri/src/policy.rs          trusted-origin classifier + 8 unit tests (Rust side of the mirror)
src-tauri/capabilities/main.json   local-window grants (core, notification, opener https only)
src-tauri/capabilities/remote.json exact-origin remote grants (notification ×3 + core transport; NO opener)
src-tauri/tauri.conf.json        app config; windows: [] (window built in Rust); no trayIcon; targets "all"
scripts/                         inline-frontend.sh, check-prereqs.sh, smoke.sh, test-rust-policy.sh
test/bridge.test.js              adapter + bridge + link-policy tests (fake invoke transport)
test/init.test.js                real-file VM integration (shim, single-delivery, links, guards)
flake.nix / flake.lock           reproducible Linux devShell (system webview libs + node)
```

Icons in `src-tauri/icons/` are generated RGBA placeholders (indigo disc); replace with final artwork and run `npm run icon`.

## Reproducibility

- `package-lock.json` (npm) and `src-tauri/Cargo.lock` pin all dependencies (Tauri 2.11.5, api 2.11.1, cli 2.11.4, notification 2.4.0, opener 2.5.5 — versions verified against crates.io/npm at build time, researched from v2.tauri.app + docs.rs).
- `flake.lock` pins the nix system-dependency closure (nixpkgs nixos-25.05).
- `scripts/inline-frontend.sh` (run automatically via `beforeDevCommand`/`beforeBuildCommand`) copies the exact tested JS sources into `frontend/dist/` for `include_str!` — no bundler transform between tested and shipped code. Tauri default features are OFF in `Cargo.toml` (wry + tray-icon + protocol subset only, smallest footprint).
