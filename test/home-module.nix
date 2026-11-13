{
  pkgs,
  self,
}: let
  inherit (pkgs) lib;
  evaluate = settings:
    (lib.evalModules {
      modules = [
        (import ../nix/home.nix self)
        {
          options = {
            assertions = lib.mkOption {
              type = lib.types.listOf lib.types.attrs;
              default = [];
            };
            programs.opencode = {
              enable = lib.mkEnableOption "OpenCode";
              package = lib.mkOption {
                type = lib.types.package;
                default = pkgs.emptyDirectory;
              };
              settings = lib.mkOption {
                type = lib.types.attrs;
                default = {};
              };
            };
          };
        }
        settings
      ];
      specialArgs = {inherit pkgs;};
    }).config;
  disabled = evaluate {};
  v1 = evaluate {
    programs.opencode.enable = true;
    programs.opencode.package = pkgs.emptyDirectory // {harborLlmEnvironmentVersion = 1;};
    programs.harborLlm = {
      enable = true;
      opencode = {
        enable = true;
        apiVersion = "v1";
      };
    };
  };
  unsupported = evaluate {
    programs.opencode.enable = true;
    programs.harborLlm = {
      enable = true;
      opencode = {
        enable = true;
        apiVersion = "v1";
      };
    };
  };
  v2 = evaluate {
    programs.opencode.enable = true;
    programs.harborLlm = {
      enable = true;
      opencode = {
        enable = true;
        options = {
          roots = ["/workspaces/example"];
          serverURL = "http://127.0.0.1:4096";
        };
      };
    };
  };
in
  assert disabled.programs.opencode.settings == {} && disabled.assertions == [];
  assert lib.all (a: a.assertion) (v1.assertions ++ v2.assertions);
  assert !(lib.all (a: a.assertion) unsupported.assertions);
  assert v1.programs.opencode.settings ? plugin && !(v1.programs.opencode.settings ? plugins);
  assert v2.programs.opencode.settings ? plugins && !(v2.programs.opencode.settings ? plugin);
  assert (builtins.head v2.programs.opencode.settings.plugins).options.roots == ["/workspaces/example"];
    pkgs.runCommand "harbor-llm-home-module" {nativeBuildInputs = [pkgs.jq pkgs.nodejs];} ''
      cli=${lib.getExe disabled.programs.harborLlm.lsp.cli}
      jq -e --arg cli "$cli" '.lspServers["harbor-rust"] == {command: $cli, args: ["serve", ".rs"], extensionToLanguage: {".rs": "rust"}}
        and .lspServers["harbor-javascript"].extensionToLanguage[".tsx"] == "typescriptreact"' \
        ${disabled.programs.harborLlm.lsp.claudeCodePlugin}/.claude-plugin/plugin.json
      ext=${disabled.programs.harborLlm.lsp.vscodeExtension}
      grep -qF "\"$cli\"" $ext/extension.js
      node -e 'require.resolve("vscode-languageclient/node", {paths: [process.argv[1]]})' $ext
      # The v2 plugin serves a committed-file server through the CLI (no roots: file only).
      mkdir -p project/.opencode
      echo '{"lsp":{"x":{"command":["x"],"extensions":[".x"]},"y":{"command":["y"],"extensions":[".y"],"disabled":true}}}' > project/.opencode/opencode.jsonc
      HOME=$PWD node --input-type=module -e '
        import assert from "node:assert/strict";
        const plugin = (await import(process.argv[1] + "/server.js")).default;
        const tools = [];
        const dispose = await plugin.setup({
          location: {directory: process.argv[2]},
          tool: {
            transform: async (f) => (f({add: (t) => tools.push(t)}), {dispose: async () => {}}),
            hook: async () => ({dispose: async () => {}}),
          },
        });
        assert.equal(typeof dispose, "function");
        assert.equal(tools.length, 1);
        await dispose();

        // Harbor is authoritative in both directions: the devshell disabled the
        // committed `x` and re-enabled the committed-disabled `y`.
        const {harborOptions} = await import(process.argv[1] + "/server.js");
        const {resolveSettings} = await import(process.argv[1] + "/upstream/src/config.ts");
        const project = process.argv[2];
        const servers = resolveSettings(project, harborOptions(project, {}, {y: {command: ["y"], extensions: [".y"]}})).servers;
        assert.deepEqual(servers.map((s) => [s.id, s.command[1], s.command[2]]), [["y", "serve", "y"]]);
        assert.deepEqual(resolveSettings(project, harborOptions(project, {lsp: false}, {})).servers, []);
      ' ${disabled.programs.harborLlm.lsp.opencodePlugin} $PWD/project
      touch $out
    ''
