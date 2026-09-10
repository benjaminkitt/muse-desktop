{
  description = "muse-desktop dev shell: Rust + Node + Tauri v2 Linux system-webview libraries (macOS: SDK-provided WebKit, shell supplies toolchains only).";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-25.05";
  };

  outputs = { self, nixpkgs }:
    let
      lib = nixpkgs.lib;
      systems = [ "x86_64-linux" "aarch64-linux" "x86_64-darwin" "aarch64-darwin" ];
      forSystem = system:
        let
          pkgs = import nixpkgs { inherit system; };
          linuxOnly = lib.optionals pkgs.stdenv.isLinux [
            pkgs.webkitgtk_4_1
            pkgs.gtk3
            pkgs.libsoup_3
            pkgs.glib
            pkgs.glib-networking
            pkgs.dconf
            pkgs.dbus
            pkgs.openssl
            pkgs.librsvg
            # Tray / AppIndicator support (best effort; DE-dependent at runtime).
            pkgs.libayatana-appindicator
            pkgs.libappindicator-gtk3
          ];
        in
        pkgs.mkShell {
          name = "muse-desktop";
          buildInputs = [
            # NOTE: nixpkgs 25.05 ships rustc 1.86, but the pinned Cargo.lock
            # (Tauri 2.11.5 tree) needs rustc >= 1.89. Use the host Rust
            # 1.97 toolchain from PATH instead; nix supplies ONLY the
            # system webview libraries + node + pkg-config here.
            pkgs.nodejs_24
            pkgs.pkg-config
          ] ++ linuxOnly;
          shellHook = lib.optionalString pkgs.stdenv.isLinux ''
            export PKG_CONFIG_PATH="${pkgs.lib.makeSearchPath "lib/pkgconfig" linuxOnly}:$PKG_CONFIG_PATH"
            # libappindicator-sys uses dlopen by library name, so buildInputs
            # and linker RPATHs alone do not make the tray library discoverable.
            # Keep this narrow: adding all linuxOnly libraries would expose
            # Nix OpenSSL to the host Rust toolchain and can break its TLS.
            export LD_LIBRARY_PATH="${lib.makeLibraryPath [ pkgs.libayatana-appindicator pkgs.libappindicator-gtk3 ]}''${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
            # Do not inherit host GIO modules: they can target a newer glibc
            # than this pinned shell. Include TLS/proxy and settings modules
            # from the same nixpkgs revision as WebKit instead.
            export GIO_EXTRA_MODULES="${lib.makeSearchPath "lib/gio/modules" [ pkgs.glib-networking pkgs.dconf.lib ]}"
            # WebKit's DMA-BUF renderer may fail to initialize EGL with host
            # graphics drivers. Default to its fallback renderer in this dev
            # shell; set this to 0 before entering to test accelerated rendering.
            export WEBKIT_DISABLE_DMABUF_RENDERER="''${WEBKIT_DISABLE_DMABUF_RENDERER:-1}"
            # Use EGL drivers built against this shell's glibc, not the
            # host /run/opengl-driver (which may be from newer nixpkgs).
            export __EGL_VENDOR_LIBRARY_FILENAMES="${pkgs.mesa}/share/glvnd/egl_vendor.d/50_mesa.json"
            unset EGL_PLATFORM
            # Media plugins must also match the pinned WebKit/glibc stack.
            export GST_PLUGIN_SYSTEM_PATH_1_0="${lib.makeSearchPath "lib/gstreamer-1.0" [ pkgs.gst_all_1.gstreamer pkgs.gst_all_1.gst-plugins-base pkgs.gst_all_1.gst-plugins-good pkgs.gst_all_1.gst-plugins-bad pkgs.gst_all_1.gst-libav ]}"
            unset GST_PLUGIN_PATH GST_PLUGIN_PATH_1_0 GST_PLUGIN_SYSTEM_PATH GST_PLUGIN_SCANNER GST_PLUGIN_SCANNER_1_0
            echo "muse-desktop nix shell (linux): webkitgtk/gtk3/soup3/appindicator available"
          '' + lib.optionalString pkgs.stdenv.isDarwin ''
            echo "muse-desktop nix shell (macos): toolchains only; WebKit comes from the Xcode SDK"
          '';
        };
    in
    {
      devShells = lib.genAttrs systems (system: { default = forSystem system; });
    };
}
