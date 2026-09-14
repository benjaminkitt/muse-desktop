# Muse Desktop

A Windows, macOS, and Linux desktop client for [Muse](https://muse.ai), Meta's Muse agent. It uses Electron's Chromium webview so Muse receives the browser platform it expects, while keeping the main experience in a focused window.

The app keeps a dedicated browser profile, opens the system file picker for uploads, saves downloads to the user's Downloads directory without overwriting existing names, and grants Muse's web notifications through the native desktop notification system.

## Download and install

Download an installer from the [latest GitHub release](https://github.com/benjaminkitt/muse-desktop/releases/latest). Choose the file matching your operating system and CPU:

- **Windows (x64):** download the `.exe` and run the installer.
- **macOS:** choose `arm64` for Apple Silicon or `x64` for Intel. Open the `.dmg` and drag Muse into Applications, or extract the `.zip` and move Muse into Applications.
- **Linux (x64):** install the `.deb` on Debian/Ubuntu (`sudo apt install ./Muse-*.deb`) or the `.rpm` on Fedora (`sudo dnf install ./Muse-*.rpm`). Alternatively, download the AppImage, make it executable with `chmod +x Muse-*.AppImage`, and run it with `./Muse-*.AppImage`. AppImages may require your distribution's FUSE compatibility package. On NixOS, use the Nix package below instead.

These builds are not developer-signed or notarized. Windows SmartScreen and macOS Gatekeeper may show warnings or block launch. Only approve a downloaded app if you trust its source; on macOS, **System Settings → Privacy & Security → Open Anyway** may be available after attempting to open it. Managed devices may prohibit unsigned applications.

## Install or run with Nix

The flake supports `x86_64-linux`, `aarch64-linux`, `x86_64-darwin`, and `aarch64-darwin`. It uses Nixpkgs' Electron runtime, so no npm install is needed. Enable Nix's `nix-command` and `flakes` experimental features first (for example, set `experimental-features = nix-command flakes` in `~/.config/nix/nix.conf`).

Run without installing:

```bash
nix run github:benjaminkitt/muse-desktop
```

Or install into your user profile:

```bash
nix profile add github:benjaminkitt/muse-desktop
muse-desktop
```

From a local checkout, use `nix run .` or `nix build .`. The package is exported as both `packages.<system>.default` and `packages.<system>.muse-desktop`; the app is exported as both `apps.<system>.default` and `apps.<system>.muse-desktop`. Linux includes a desktop entry and icon, and macOS includes an `Applications/Muse.app` launcher. A graphical desktop session is required. Nix on non-NixOS Linux may need host graphics integration such as [nixGL](https://github.com/nix-community/nixGL).

### Add to a Nix configuration

Add the input to your configuration's `flake.nix`:

```nix
inputs.muse-desktop.url = "github:benjaminkitt/muse-desktop";
```

Pass your flake inputs to modules with `specialArgs = { inherit inputs; };` in `nixosSystem` or `darwinSystem`. Then add this to a NixOS or nix-darwin module:

```nix
{ inputs, pkgs, ... }: {
  environment.systemPackages = [
    inputs.muse-desktop.packages.${pkgs.stdenv.hostPlatform.system}.default
  ];
}
```

For Home Manager, pass `extraSpecialArgs = { inherit inputs; };` to `homeManagerConfiguration` (or set `home-manager.extraSpecialArgs` when used as a NixOS/nix-darwin module), and use:

```nix
{ inputs, pkgs, ... }: {
  home.packages = [
    inputs.muse-desktop.packages.${pkgs.stdenv.hostPlatform.system}.default
  ];
}
```

Here `inputs` is the input set from your flake's `outputs = inputs@{ ... }: ...` function. Rebuild or switch your configuration normally. Keep this input's own Nixpkgs pins unless you deliberately want to change its Electron/platform support. Your `flake.lock` pins the app revision; update the `muse-desktop` input to receive newer versions.

## Run and build from source

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

On Linux this creates AppImage, `.deb`, and `.rpm` packages. On macOS it creates `.dmg` and `.zip` artifacts. On Windows, use Node.js 22 and `npm ci`, then `npm run build` to create an NSIS `.exe` installer. Packages are written to `dist/` with platform and architecture in their filenames.

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

## License

Muse Desktop's source code is available under the [MIT License](LICENSE). Muse itself and third-party dependencies remain subject to their respective terms and licenses.
