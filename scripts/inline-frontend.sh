#!/usr/bin/env bash
# inline-frontend.sh — copy the framework-free bridge sources into
# frontend/dist/ for `include_str!` in src-tauri/src/main.rs.
# No bundler, no minifier: byte-identical copies keep the offline
# node/VM test files and the shipped init script provably the same logic.
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p frontend/dist
for f in tauri-adapter.js notification-bridge.js link-policy.js main.js; do
  cp "frontend/$f" "frontend/dist/$f"
done
# Placeholder page so Tauri's frontendDist check passes without a dev server.
cat >frontend/dist/index.html <<'HTML'
<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Muse</title></head>
<body><p>Muse desktop wrapper. The main window loads https://muse.ai at runtime.</p></body>
</html>
HTML
echo "frontend/dist ready: $(ls frontend/dist)"
