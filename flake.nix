{
  description = "Development environment for Muse Desktop";

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
