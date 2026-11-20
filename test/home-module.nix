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

        // Sessions of one serve process share a manager per root, settings and
        // Harbor map; only the last release shuts it down. A devshell change
        // that only moves the fingerprint still gets its own manager.
        const {acquire} = await import(process.argv[1] + "/server.js");
        const map = {y: {command: ["y"], extensions: [".y"], fingerprint: "a"}};
        const settings = resolveSettings(project, harborOptions(project, {}, map));
        const first = acquire(project, settings, map);
        const second = acquire(project, settings, map);
        assert.equal(first.manager, second.manager);
        assert.notEqual(acquire(project + "/other", settings, map).manager, first.manager);
        const bumped = {y: {...map.y, fingerprint: "b"}};
        assert.deepEqual(resolveSettings(project, harborOptions(project, {}, bumped)), settings);
        assert.notEqual(acquire(project, settings, bumped).manager, first.manager);
        await first.release();
        await first.release();
        assert.equal(acquire(project, settings, map).manager, first.manager);

        // A server idle past idleTimeoutMs stops; the next use restarts it and
        // reopens the file, so diagnostics still arrive.
        const {LspManager} = await import(process.argv[1] + "/upstream/src/manager.ts");
        (await import("node:fs")).writeFileSync(project + "/a.z", "BAD");
        const fake = {fake: {command: [process.execPath, process.argv[3]], extensions: [".z"]}};
        const idle = new LspManager(resolveSettings(project, {idleTimeoutMs: 50, lsp: fake}), project);
        const [cold] = await idle.sync(project + "/a.z");
        assert.ok(cold.client.running);
        await new Promise((resolve) => setTimeout(resolve, 300));
        assert.equal(cold.client.running, false);
        const [warm] = await idle.sync(project + "/a.z");
        assert.ok(warm.client.running && warm.client !== cold.client);
        assert.equal((await idle.diagnostics(project + "/a.z")).file?.[0]?.message, "BAD is not allowed");
        await idle.shutdown();
        // A server that cannot start leaves the file unchecked, not clean, and
        // the edit result says so.
        const gone = {gone: {command: ["/nonexistent/lsp"], extensions: [".z"]}};
        const broken = new LspManager(resolveSettings(project, {lsp: gone}), project);
        assert.match((await broken.diagnostics(project + "/a.z")).unavailable ?? "", /^gone: /);
        const {afterTool} = await import(process.argv[1] + "/upstream/src/diagnostics.ts");
        const edit = {tool: "write", status: "completed", input: {path: project + "/a.z"}, result: {output: "ok"}};
        await afterTool(broken, project, true)(edit);
        assert.match(JSON.stringify(edit.result), /could not check/);
        await broken.shutdown();
        // A server that does not apply (deno without a Deno marker) is not a failed one.
        const denoless = new LspManager(resolveSettings(project, {lsp: {deno: {command: ["/nonexistent/lsp"], extensions: [".z"]}}}), project);
        assert.equal((await denoless.diagnostics(project + "/a.z")).unavailable, undefined);
        await denoless.shutdown();
        // Nor is a file the manager cannot read while its server runs.
        const fs = await import("node:fs");
        fs.writeFileSync(project + "/locked.z", "BAD");
        fs.chmodSync(project + "/locked.z", 0);
        const reading = new LspManager(resolveSettings(project, {lsp: fake}), project);
        assert.equal((await reading.diagnostics(project + "/locked.z")).unavailable, undefined);
        await reading.shutdown();
      ' ${disabled.programs.harborLlm.lsp.opencodePlugin} $PWD/project ${./fake-lsp.mjs}

      # Antigravity hook: edits are recorded, the next other call reports the
      # red file once, and clean files pass with a decision (none denies).
      pass='{"decision":"ask"}'
      hooks=${disabled.programs.harborLlm.lsp.antigravityHooks}
      command=$(jq -er '.["harbor-lsp"].PreToolUse[0].hooks[0].command' $hooks)
      mkdir -p red/.opencode
      echo '{"lsp":{"fake":{"command":["node","${./fake-lsp.mjs}"],"extensions":[".x"]}}}' > red/.opencode/opencode.jsonc
      echo BAD > red/a.x
      echo ok > red/b.x
      hook() { (cd red && echo "{\"toolCall\":$1,\"conversationId\":\"c\"}" | HOME=$PWD $command); }
      [ "$(hook '{"name":"write_to_file","args":{"TargetFile":"a.x"}}')" = "$pass" ]
      [ "$(hook '{"name":"replace_file_content","args":{"TargetFile":"b.x"}}')" = "$pass" ]
      hook '{"name":"run_command","args":{}}' | jq -e '.decision == "deny" and (.reason | contains("a.x") and contains("BAD is not allowed") and (contains("b.x") | not))'
      [ "$(hook '{"name":"run_command","args":{}}')" = "$pass" ]
      [ "$(hook '{"name":"write_to_file","args":{"TargetFile":"b.x"}}')" = "$pass" ]
      [ "$(hook '{"name":"view_file","args":{"AbsolutePath":"b.x"}}')" = "$pass" ]
      # Hooks run in the hooks.json folder, so the root is the agent's `cwd`.
      wd() { echo "{\"toolCall\":$1,\"conversationId\":\"w\",\"cwd\":\"$PWD/red\"}" | HOME=$PWD $command; }
      [ "$(wd '{"name":"write_to_file","args":{"TargetFile":"a.x"}}')" = "$pass" ]
      wd '{"name":"run_command","args":{}}' | jq -e '.decision == "deny" and (.reason | contains("a.x"))'
      # A file whose server cannot start is reported as unchecked.
      mkdir -p gone/.opencode
      echo '{"lsp":{"gone":{"command":["/nonexistent/lsp"],"extensions":[".x"]}}}' > gone/.opencode/opencode.jsonc
      echo ok > gone/c.x
      gonehook() { (cd gone && echo "{\"toolCall\":$1,\"conversationId\":\"g\"}" | HOME=$PWD $command); }
      [ "$(gonehook '{"name":"write_to_file","args":{"TargetFile":"c.x"}}')" = "$pass" ]
      gonehook '{"name":"run_command","args":{}}' | jq -e '.decision == "deny" and (.reason | contains("could not check") and contains("c.x") and (contains("please fix") | not))'
      [ "$(gonehook '{"name":"run_command","args":{}}')" = "$pass" ]
      # Edit hooks running beside each other and beside a check lose no file.
      for i in 1 2 3 4 5 6 7 8; do echo BAD > red/p$i.x; done
      for round in 1 2 3 4 5; do
        hook '{"name":"write_to_file","args":{"TargetFile":"a.x"}}'
        for i in 1 2 3 4 5 6 7 8; do hook "{\"name\":\"write_to_file\",\"args\":{\"TargetFile\":\"p$i.x\"}}" & done
        hook '{"name":"run_command","args":{}}' > first &
        hook '{"name":"run_command","args":{}}' > second &
        wait
        hook '{"name":"run_command","args":{}}' > third
        jq -s -e '[.[].reason // ""] | add as $r | [range(1; 9) as $i | $r | contains("p\($i).x")] | all' first second third
      done

      touch $out
    ''
