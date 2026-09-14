# Muse Desktop

A macOS and Linux desktop client for [Muse](https://muse.ai), Meta's Muse agent. It uses Electron's Chromium webview so Muse receives the browser platform it expects, while keeping the main experience in a focused window.

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

The embedded window has Node integration disabled and uses a sandboxed, isolated renderer. The main window permits in-app navigation only to Muse and the small set of Meta-hosted sign-in redirect pages required by Muse. Other same-window links open in the system browser.

Links requesting a new window and OAuth popups open in managed, sandboxed child windows sharing the Muse profile. These preserve `window.opener`, callback messaging, and blank-window-then-redirect flows without navigating away from the main Muse page. Child windows allow HTTP(S) navigation for identity providers and callbacks, block unsafe URL schemes, and close when their opener closes. They receive no Node or shell access; notification permissions remain restricted to the exact Muse origin.

Some identity providers may prohibit authentication in embedded browsers. The popup regression tests verify desktop handler behavior, not successful authorization with every provider; authenticated connection flows still require manual testing.
