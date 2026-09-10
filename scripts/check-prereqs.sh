#!/usr/bin/env bash
# check-prereqs.sh — report macOS/Linux build prerequisites for the Tauri v2
# system-webview wrapper. Exits 0 when the current machine can build, 1 otherwise.
# Missing system deps are reported as infra gaps (see README), not failures.
set -uo pipefail
missing=0
need() { command -v "$1" >/dev/null 2>&1 || {
  echo "MISSING: $1 ($2)"
  missing=1
}; }
have() { command -v "$1" >/dev/null 2>&1 && echo "ok: $1 ($(command -v "$1"))" || true; }

echo "== toolchains =="
need rustc "rust >= 1.77 (https://rustup.rs)"
need cargo "rust cargo"
need node "node >= 18"
have bun
have flatpak

echo "== tauri cli =="
if npx -y @tauri-apps/cli@2 --version >/dev/null 2>&1; then echo "ok: tauri cli v2 (via npx)"; else
  echo "MISSING: tauri cli v2 (npm i -g @tauri-apps/cli@2)"
  missing=1
fi

echo "== platform deps =="
case "$(uname -s)" in
Darwin)
  need xcode-select "Xcode command line tools (xcode-select --install)"
  xcrun --show-sdk-path >/dev/null 2>&1 && echo "ok: macos sdk" || {
    echo "MISSING: macos sdk"
    missing=1
  }
  ;;
Linux)
  for pc in webkit2gtk-4.1 gtk+-3.0 libsoup-3.0 javascriptcoregtk-4.1; do
    if pkg-config --exists "$pc" 2>/dev/null; then echo "ok: $pc"; else
      echo "MISSING: $pc (install webkit2gtk + gtk3 dev packages)"
      missing=1
    fi
  done
  need pkg-config "pkg-config"
  ;;
*)
  echo "UNSUPPORTED: $(uname -s) (macOS and Linux only)"
  missing=1
  ;;
esac

if [ "$missing" -eq 0 ]; then echo "READY: all prerequisites present"; else echo "NOT READY: install the MISSING items above (see README)"; fi
exit "$missing"
