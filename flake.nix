{
  description = "Muse Desktop application and development environment";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    # Current nixpkgs has dropped Intel macOS; retain a supported Darwin channel
    # so contributors can still enter the same development shell there.
    nixpkgs-intel-darwin.url = "github:NixOS/nixpkgs/nixpkgs-26.05-darwin";
  };

  outputs = { self, nixpkgs, nixpkgs-intel-darwin }:
    let
      systems = [
        "x86_64-linux"
        "aarch64-linux"
        "x86_64-darwin"
        "aarch64-darwin"
      ];
      eachSystem = nixpkgs.lib.genAttrs systems;
      nixpkgsFor = system:
        if system == "x86_64-darwin" then nixpkgs-intel-darwin else nixpkgs;
    in {
      packages = eachSystem (system:
        let
          pkgs = import (nixpkgsFor system) { inherit system; };
          inherit (pkgs) lib;
          muse-desktop = pkgs.stdenvNoCC.mkDerivation {
            pname = "muse-desktop";
            version = (builtins.fromJSON (builtins.readFile ./package.json)).version;
            # Only runtime sources are needed: the app has no npm runtime dependencies.
            src = lib.cleanSourceWith {
              src = ./.;
              filter = path: type:
                let relative = lib.removePrefix (toString ./. + "/") (toString path);
                in type == "directory" && builtins.elem relative [ "electron" "build" ]
                  || builtins.elem relative [
                    "package.json" "LICENSE"
                    "electron/main.cjs" "electron/utils.cjs"
                    "build/icon.png" "build/icon.icns"
                  ];
            };
            nativeBuildInputs = [ pkgs.makeWrapper ]
              ++ lib.optionals pkgs.stdenv.hostPlatform.isLinux [ pkgs.copyDesktopItems ];
            dontBuild = true;
            desktopItems = lib.optionals pkgs.stdenv.hostPlatform.isLinux [
              (pkgs.makeDesktopItem {
                name = "muse-desktop";
                desktopName = "Muse";
                comment = "Desktop client for Muse";
                exec = "muse-desktop";
                icon = "muse-desktop";
                categories = [ "Utility" ];
                terminal = false;
              })
            ];
            installPhase = ''
              runHook preInstall
              mkdir -p "$out/share/muse-desktop" "$out/bin"
              cp -r electron build package.json "$out/share/muse-desktop/"
              install -Dm644 LICENSE "$out/share/licenses/muse-desktop/LICENSE"
              makeWrapper ${lib.getExe pkgs.electron_43} "$out/bin/muse-desktop" \
                --add-flags "$out/share/muse-desktop"
            '' + lib.optionalString pkgs.stdenv.hostPlatform.isLinux ''
              install -Dm644 build/icon.png "$out/share/icons/hicolor/1024x1024/apps/muse-desktop.png"
            '' + lib.optionalString pkgs.stdenv.hostPlatform.isDarwin ''
              mkdir -p "$out/Applications/Muse.app/Contents/"{MacOS,Resources}
              makeWrapper "$out/bin/muse-desktop" "$out/Applications/Muse.app/Contents/MacOS/Muse"
              cp build/icon.icns "$out/Applications/Muse.app/Contents/Resources/icon.icns"
              cat > "$out/Applications/Muse.app/Contents/Info.plist" <<EOF
              <?xml version="1.0" encoding="UTF-8"?>
              <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
              <plist version="1.0"><dict>
                <key>CFBundleName</key><string>Muse</string>
                <key>CFBundleIdentifier</key><string>ai.muse.desktop</string>
                <key>CFBundleExecutable</key><string>Muse</string>
                <key>CFBundleIconFile</key><string>icon.icns</string>
                <key>CFBundlePackageType</key><string>APPL</string>
                <key>CFBundleShortVersionString</key><string>$version</string>
              </dict></plist>
              EOF
            '' + ''
              runHook postInstall
            '';
            meta = {
              description = "Desktop client for Muse";
              homepage = "https://github.com/benjaminkitt/muse-desktop";
              license = lib.licenses.mit;
              mainProgram = "muse-desktop";
              platforms = systems;
            };
          };
        in {
          inherit muse-desktop;
          default = muse-desktop;
        });

      apps = eachSystem (system:
        let
          app = {
            type = "app";
            meta.description = "Launch Muse Desktop";
            program = "${self.packages.${system}.muse-desktop}/bin/muse-desktop";
          };
        in {
          default = app;
          muse-desktop = app;
        });

      devShells = eachSystem (system:
        let
          pkgs = import (nixpkgsFor system) { inherit system; };
          isLinux = pkgs.stdenv.hostPlatform.isLinux;
        in {
          default = pkgs.mkShell ({
            packages = [ pkgs.nodejs_24 pkgs.electron_43 ]
              ++ pkgs.lib.optionals isLinux [ pkgs.libxcrypt-legacy pkgs.rpm ];
            ELECTRON_SKIP_BINARY_DOWNLOAD = "1";
            ELECTRON_OVERRIDE_DIST_PATH = "${pkgs.electron_43}/bin";
          } // pkgs.lib.optionalAttrs isLinux {
            # electron-builder's Linux packaging helper needs legacy libcrypt.
            LD_LIBRARY_PATH = "${pkgs.libxcrypt-legacy}/lib";
          });
        });
    };
}
