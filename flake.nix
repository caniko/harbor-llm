{
  description = "Generic LLM harness integrations and project-scoped environments";

  inputs = {
    harbor-meta.url = "git+https://github.com/caniko/harbor-meta.git?ref=feat/shared-timezone-env&rev=1f272a44dea9dc531b30efb384720ddb46f083e3";
    nixpkgs.follows = "harbor-meta/nixpkgs";
  };

  outputs = {
    self,
    nixpkgs,
    harbor-meta,
    harbor-rs,
    harborRoot,
    ...
  }: let
    forSystems = nixpkgs.lib.genAttrs ["x86_64-linux" "aarch64-linux"];
  in {
    lib.timezone = harbor-meta.lib.timezone;
    lib.environmentContractVersion = 1;
    lib.preparationAdmissionVersion = 1;
    homeManagerModules.default = import ./nix/home.nix self;
    nixosModules.custodian = {
      lib,
      pkgs,
      ...
    }: {
      imports = [./nix/custodian.nix];
      services.harbor-llm-custodian.package = lib.mkDefault self.packages.${pkgs.stdenv.hostPlatform.system}.custodian;
    };
    packages = forSystems (system: let
      pkgs = nixpkgs.legacyPackages.${system};
      rustPkgs = import nixpkgs {
        inherit system;
        overlays = [(import harbor-rs.inputs.rust-overlay)];
      };
      inherit
        (harbor-rs.lib.mkToolchain {
          pkgs = rustPkgs;
          toolchainProfile = "stable";
          cache.enable = false;
        })
        craneLib
        ;
      custodianArgs = {
        pname = "harbor-llm-custodian";
        version = "0.1.0";
        src = pkgs.lib.cleanSourceWith {
          src = harborRoot.outPath;
          filter = path: type:
            craneLib.filterCargoSources path type
            || pkgs.lib.hasPrefix "${toString ./.}/protocol/" path
            || path == "${toString ./.}/rust/README.md"
            || builtins.elem path ["${toString ./.}/runtime/src/standalone.mjs" "${toString ./.}/runtime/src/native_observer.mjs"];
        };
        strictDeps = true;
        cargoExtraArgs = "--locked -p harbor-llm-runtime --bin harbor-llm-custodian --bin harbor-llm-standalone";
        # Receipt/admission authority must not run through a caller-owned loader.
        CARGO_BUILD_TARGET = pkgs.stdenv.hostPlatform.rust.rustcTarget;
        RUSTFLAGS = "-C target-feature=+crt-static -L native=${pkgs.glibc.static}/lib";
      };
    in {
      custodian = craneLib.buildPackage (custodianArgs
        // {
          cargoArtifacts = craneLib.buildDepsOnly custodianArgs;
          doCheck = false;
          meta = {
            description = "Harbor LLM preparation custodian and experimental Linux namespace setup";
            license = pkgs.lib.licenses.mit;
            mainProgram = "harbor-llm-custodian";
            platforms = pkgs.lib.platforms.linux;
          };
        });
      default = pkgs.stdenvNoCC.mkDerivation {
        pname = "harbor-llm";
        version = "0.1.0";
        passthru.preparationAdmissionVersion = 1;
        src = builtins.path {
          path = ./.;
          name = "harbor-llm-source";
          filter = path: _: !builtins.elem (baseNameOf path) [".git" ".opencode" "node_modules" ".direnv" ".nix-results" "result" "graphify-out"];
        };
        nativeBuildInputs = [pkgs.nodejs pkgs.importNpmLock.npmConfigHook];
        npmDeps = pkgs.importNpmLock {npmRoot = ./.;};
        installPhase = ''
          mkdir -p $out/lib/harbor-llm
          cp -r src plugins contracts protocol python node_modules package.json pyproject.toml $out/lib/harbor-llm/
        '';
      };
    });
    devShells = forSystems (system: let
      pkgs = nixpkgs.legacyPackages.${system};
    in {
      default = harbor-meta.lib.devShell.mkShell {
        inherit pkgs;
        packages = [pkgs.nodejs pkgs.alejandra pkgs.treefmt pkgs.direnv pkgs.nix pkgs.util-linux];
      };
    });
    checks = forSystems (system: let
      pkgs = nixpkgs.legacyPackages.${system};
    in {
      environments = pkgs.runCommand "harbor-llm-environments" {nativeBuildInputs = [pkgs.nodejs pkgs.python3 pkgs.util-linux pkgs.gnutar];} ''
        cp -r ${./src} src
        cp -r ${./test} test
        cp -r ${./contracts} contracts
        cp -r ${./protocol} protocol
        cp -r ${./python} python
        cp ${./package.json} package.json
        ln -s ${self.packages.${system}.default}/lib/harbor-llm/node_modules node_modules
        export HOME="$PWD/test-home"
        export XDG_RUNTIME_DIR="$PWD/test-runtime"
        mkdir -m 700 "$HOME" "$XDG_RUNTIME_DIR"
        DIRENV_BIN=${pkgs.direnv}/bin/direnv NIX_BIN=${pkgs.nix}/bin/nix \
          node --test test/*.test.mjs
        python3 -I test/test_mcp_admission.py
        touch $out
      '';
      plugin = pkgs.runCommand "harbor-llm-plugin" {nativeBuildInputs = [pkgs.nodejs];} ''
        node --input-type=module -e '
          import assert from "node:assert/strict";
          import {HarborLlm} from "${self.packages.${system}.default}/lib/harbor-llm/src/opencode.mjs";
          const plugin = await HarborLlm({}, {registry: "${./test/empty-registry.json}"});
          assert.equal(await plugin.tool.harbor_devshell.execute({action: "list"}, {sessionID: "test"}), "[]");
          assert.equal(typeof plugin["shell.env"], "function");
          const v2 = (await import("${self.packages.${system}.default}/lib/harbor-llm/src/project-environment-v2.mjs")).default;
          assert.equal(v2.id, "harbor-llm.project-environment-prototype");
          assert.equal(typeof v2.setup, "function");
        '
        touch $out
      '';
      module = import ./test/home-module.nix {
        inherit pkgs self;
      };
      custodian-module = import ./test/custodian-module.nix {
        inherit pkgs;
        module = self.nixosModules.custodian;
      };
      custodian-package = self.packages.${system}.custodian;
      formatting = pkgs.runCommand "harbor-llm-formatting" {nativeBuildInputs = [pkgs.treefmt pkgs.alejandra];} ''
        cp -r ${self} source
        chmod -R u+w source
        cd source
        treefmt --ci
        touch $out
      '';
      shell = harbor-meta.lib.devShellTests.mkCheck {
        inherit pkgs;
        name = "harbor-llm-dev-shell";
        shell = self.devShells.${system}.default;
        commands = ["node" "npm"];
      };
    });
    formatter = forSystems (system: nixpkgs.legacyPackages.${system}.treefmt);
  };
}
