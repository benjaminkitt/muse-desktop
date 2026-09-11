# Muse Desktop

A macOS and Linux desktop client for [Muse](https://muse.ai), Meta's Muse agent. It uses Electron's Chromium webview so Muse receives the browser platform it expects, while remaining a focused, single-window app.

The app keeps a dedicated browser profile, opens the system file picker for uploads, saves downloads to the user's Downloads directory without overwriting existing names, and grants Muse's web notifications through the native desktop notification system.

## Run and build

On Linux/NixOS:

```bash
nix develop
npm install
npm run dev
```

The Nix shell supports both Intel and Apple Silicon macOS, as well as x86_64 and ARM Linux, and supplies Electron 43. On macOS, enter `nix develop`, run `npm install`, then use the same commands.

Create installers with:

```bash
nix develop --command npm run build
```

On Linux this creates AppImage, `.deb`, and `.rpm` packages. On macOS it creates `.dmg` and `.zip` artifacts.

## Clear app data

Quit Muse, then remove its profile and cache:

```bash
rm -rf "${XDG_CONFIG_HOME:-$HOME/.config}/Muse" \
       "${XDG_CACHE_HOME:-$HOME/.cache}/Muse"
```

On macOS:

```bash
rm -rf "$HOME/Library/Application Support/Muse" \
       "$HOME/Library/Caches/Muse"
```

This signs out of Muse and clears its cookies, local storage, downloads history, and cached content.

## Security

The embedded window has Node integration disabled and uses a sandboxed, isolated renderer. It permits in-app navigation only to Muse and the small set of Meta-hosted sign-in redirect pages required by Muse. Other links open in the system browser.
