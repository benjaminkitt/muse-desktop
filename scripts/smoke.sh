#!/usr/bin/env bash
# smoke.sh — offline smoke checklist runner. Verifies everything that can be
# verified without a display or remote login. Native Rust checks run inside
# `nix develop` when available (system webview libs), else they SKIP with the
# exact missing piece. Exit 0 only if every runnable check passes.
set -uo pipefail
cd "$(dirname "$0")/.."
pass=0
fail=0
skip=0
ok() {
  pass=$((pass + 1))
  echo "PASS: $1"
}
no() {
  fail=$((fail + 1))
  echo "FAIL: $1"
}
sk() {
  skip=$((skip + 1))
  echo "SKIP: $1 ($2)"
}
has_nix_shell() { [ -f flake.nix ] && command -v nix >/dev/null 2>&1; }

echo "== 1. frontend tests: adapter + bridge + init-VM + link-policy (offline, no login) =="
if command -v node >/dev/null 2>&1 && node --test test/*.test.js 2>&1 | tail -8; then ok "node:test adapter/bridge/init/link-policy (see output above for pass/fail)"; else no "node:test adapter/bridge/init/link-policy"; fi

echo "== 2. rust policy tests =="
if command -v cargo >/dev/null 2>&1; then
  if bash scripts/test-rust-policy.sh 2>&1 | tail -5; then ok "rust policy tests (see output above for pass/fail)"; else no "rust policy tests"; fi
else sk "rust policy tests" "no cargo toolchain"; fi

echo "== 3. config/capability sanity =="
for f in src-tauri/tauri.conf.json src-tauri/capabilities/main.json src-tauri/capabilities/remote.json package.json; do
  if python3 -c "import json;json.load(open('$f'))" 2>/dev/null; then ok "valid JSON: $f"; else no "valid JSON: $f"; fi
done
if grep -q '"remote": { "urls": \["https://muse.ai"\] }' src-tauri/capabilities/remote.json; then ok "remote capability pinned to exact origin"; else no "remote capability pinned to exact origin"; fi
if grep -qE '"(shell|fs|dialog):' src-tauri/capabilities/*.json; then no "no shell/fs/dialog exposure"; else ok "no shell/fs/dialog exposure"; fi
if grep -q '"trayIcon"' src-tauri/tauri.conf.json; then no "tray built ONLY in Rust (no config trayIcon)"; else ok "tray built ONLY in Rust (no config trayIcon)"; fi
if grep -q '"targets": "all"' src-tauri/tauri.conf.json; then ok 'bundle targets "all" (platform-native)'; else no 'bundle targets "all" (platform-native)'; fi
if grep -q '"withGlobalTauri": false' src-tauri/tauri.conf.json; then ok "withGlobalTauri false (invoke transport only)"; else no "withGlobalTauri false"; fi
code_only=$(sed 's://.*$::' frontend/*.js)
if echo "$code_only" | grep -q '__TAURI_INTERNALS__' && ! echo "$code_only" | grep -q '__TAURI__\.notification' && ! echo "$code_only" | grep -q '__TAURI__\.opener'; then ok "invoke transport only (no __TAURI__ plugin globals)"; else no "invoke transport only (no __TAURI__ plugin globals)"; fi
if grep -q 'open_js_links_on_click(false)' src-tauri/src/main.rs && grep -q 'on_new_window' src-tauri/src/main.rs; then ok "Rust owns externals (opener iife off, on_new_window handled)"; else no "Rust owns externals"; fi
if grep -q 'frontendDist' src-tauri/tauri.conf.json && grep -q '"windows": \[\]' src-tauri/tauri.conf.json; then ok "window created in Rust (config windows empty)"; else no "window created in Rust"; fi
if grep -q 'prevent_close' src-tauri/src/main.rs && grep -q '"show"' src-tauri/src/main.rs && grep -q '"quit"' src-tauri/src/main.rs; then ok "close-to-tray + Show/Quit wiring present"; else no "close-to-tray + Show/Quit wiring"; fi
# Remote page must NOT hold an opener grant (Rust AppHandle opens externals).
if grep -q 'opener:[a-z-]*' src-tauri/capabilities/remote.json; then no "remote capability has no opener grant"; else ok "remote capability has no opener grant"; fi

echo "== 4. native Rust compile (nix develop when available) =="
if has_nix_shell && nix develop --command bash -c 'pkg-config --exists webkit2gtk-4.1' 2>/dev/null; then
  if nix develop --command bash -c 'cd src-tauri && cargo check --offline' 2>&1 | tail -5; then
    ok "cargo check inside nix develop (see output above)"
  else
    no "cargo check inside nix develop"
  fi
elif pkg-config --exists webkit2gtk-4.1 2>/dev/null || [ "$(uname -s)" = "Darwin" ]; then
  sk "cargo check" "system deps present but nix shell not used (run: nix develop --command bash scripts/smoke.sh)"
else
  sk "cargo check" "no system webview deps outside nix (run: nix develop --command bash scripts/smoke.sh)"
fi

echo "== 5. manual checklist (requires built app + login) =="
cat <<'LIST'
  [ ] launch: main window opens https://muse.ai, title "Muse"
  [ ] close (X): window hides, tray icon remains, app keeps running
  [ ] tray Show: hidden window restores + focuses (menu on Linux, menu or left-click on macOS)
  [ ] tray Quit: app exits (no stray process)
  [ ] external link new-tab click: opens in OS browser EXACTLY once, not webview
  [ ] external link same-tab click: opened externally via Rust guard, webview stays
  [ ] window.open popup to external: OS browser, no new webview spawned
  [ ] dangerous scheme link: blocked
  [ ] Notification.requestPermission: OS prompt appears; granted -> new Notification() shows ONE OS toast (no page-toast duplicate)
  [ ] denied permission: new Notification() is a silent no-op (no invoke, no throw)
  [ ] macOS dock click with window hidden: window reopens
LIST

echo
echo "RESULT: pass=$pass fail=$fail skip=$skip"
[ "$fail" -eq 0 ]
