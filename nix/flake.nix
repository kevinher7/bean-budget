{
  description = "Bean Budget development tools and server package";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs = {nixpkgs, ...}: let
    forAllSystems = nixpkgs.lib.genAttrs ["x86_64-linux" "aarch64-linux" "aarch64-darwin"];
  in {
    packages = forAllSystems (system: let
      pkgs = nixpkgs.legacyPackages.${system};
      inherit (pkgs) lib;
      app = "$out/lib/bean-budget";
      tsxNode = name: script: ''
        makeWrapper ${lib.getExe pkgs.nodejs_22} $out/bin/${name} \
          --add-flags "--import ${app}/node_modules/tsx/dist/loader.mjs ${app}/apps/server/src/${script}"
      '';
    in rec {
      server = pkgs.buildNpmPackage {
        pname = "bean-budget-server";
        version = "0.0.0";
        src = lib.fileset.toSource {
          root = ../.;
          fileset = lib.fileset.unions [
            ../package.json
            ../package-lock.json
            ../apps/server
            ../packages/budget
            ../packages/protocol
          ];
        };
        npmDepsHash = "sha256-ClTgpgKtkdpUnamFIQ+VL5Mck0xEYNdJNg16L8Vizww=";
        nodejs = pkgs.nodejs_22;
        npmInstallFlags = ["--workspace=@bean-budget/server" "--include-workspace-root"];
        nativeBuildInputs = [pkgs.makeWrapper];
        dontNpmBuild = true;
        installPhase = ''
          runHook preInstall
          mkdir -p ${app}
          cp -r package.json node_modules apps packages ${app}/
          ${tsxNode "bean-budget-server" "main.ts"}
          ${tsxNode "bean-budget-backup" "backup.mts"}
          runHook postInstall
        '';
        meta.mainProgram = "bean-budget-server";
      };
      default = server;
    });

    devShells = forAllSystems (system: let
      pkgs = nixpkgs.legacyPackages.${system};
    in {
      default = pkgs.mkShell {
        packages = [pkgs.nodejs_22 pkgs.jdk17];
        JAVA_HOME = pkgs.jdk17.home;
        shellHook = ''
          export ANDROID_HOME="''${ANDROID_HOME:-$HOME/Library/Android/sdk}"
          export ANDROID_AVD_HOME="''${ANDROID_AVD_HOME:-$HOME/.android/avd}"
          export PATH="$ANDROID_HOME/cmdline-tools/latest/bin:$ANDROID_HOME/platform-tools:$ANDROID_HOME/emulator:$PATH"
        '';
      };
    });
  };
}
