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
    ...
  }: let
    forSystems = nixpkgs.lib.genAttrs ["x86_64-linux" "aarch64-linux"];
  in {
    lib.timezone = harbor-meta.lib.timezone;
    lib.environmentContractVersion = 1;
    homeManagerModules.default = import ./nix/home.nix self;
    packages = forSystems (system: let
      pkgs = nixpkgs.legacyPackages.${system};
    in {
      default = pkgs.stdenvNoCC.mkDerivation {
        pname = "harbor-llm";
        version = "0.1.0";
        src = builtins.path {
          path = ./.;
          name = "harbor-llm-source";
          filter = path: _: !builtins.elem (baseNameOf path) [".git" ".opencode" "node_modules" ".direnv" ".nix-results" "result" "graphify-out"];
        };
        nativeBuildInputs = [pkgs.nodejs pkgs.importNpmLock.npmConfigHook];
        npmDeps = pkgs.importNpmLock {npmRoot = ./.;};
        installPhase = ''
          mkdir -p $out/lib/harbor-llm
          cp -r src plugins contracts python node_modules package.json pyproject.toml $out/lib/harbor-llm/
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
