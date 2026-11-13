# Harbor LSP bridge artifacts: the configured `harbor-llm-lsp` CLI
# (src/lsp.mjs) and one adapter per harness that cannot read a project's Harbor
# LSP map itself. Each adapter starts servers through the CLI.
{
  pkgs,
  package,
  options,
}: let
  inherit (pkgs) lib;
  runtime = "${package}/lib/harbor-llm";

  cli =
    pkgs.runCommand "harbor-llm-lsp" {
      nativeBuildInputs = [pkgs.makeWrapper];
      meta.mainProgram = "harbor-llm-lsp";
    } ''
      makeWrapper ${lib.getExe pkgs.nodejs} $out/bin/harbor-llm-lsp \
        --add-flags ${runtime}/src/lsp.mjs \
        --set HARBOR_LLM_LSP_OPTIONS ${pkgs.writeText "harbor-llm-lsp-options.json" (builtins.toJSON options)}
    '';

  # Claude Code maps each file extension to one plugin server and an LSP
  # languageId, and starts a server on the first matching file. One entry per
  # family serves whichever Harbor server the project declares for it.
  # ponytail: static family table; add a family when Harbor serves a new language.
  families = {
    c = {
      c = [".c" ".h"];
      cpp = [".cc" ".cpp" ".cxx" ".hh" ".hpp" ".hxx"];
    };
    csharp.csharp = [".cs"];
    css = {
      css = [".css"];
      scss = [".scss"];
      less = [".less"];
    };
    dart.dart = [".dart"];
    elixir.elixir = [".ex" ".exs"];
    go.go = [".go"];
    haskell.haskell = [".hs"];
    html.html = [".html" ".htm"];
    java.java = [".java"];
    javascript = {
      typescript = [".ts" ".mts" ".cts"];
      typescriptreact = [".tsx"];
      javascript = [".js" ".mjs" ".cjs"];
      javascriptreact = [".jsx"];
    };
    json = {
      json = [".json"];
      jsonc = [".jsonc"];
    };
    kotlin.kotlin = [".kt" ".kts"];
    lua.lua = [".lua"];
    markdown.markdown = [".md"];
    nix.nix = [".nix"];
    ocaml.ocaml = [".ml" ".mli"];
    php.php = [".php"];
    pkl.pkl = [".pkl"];
    python.python = [".py" ".pyi"];
    ruby.ruby = [".rb"];
    rust.rust = [".rs"];
    scala.scala = [".scala"];
    shell.shellscript = [".sh" ".bash"];
    sql.sql = [".sql"];
    svelte.svelte = [".svelte"];
    swift.swift = [".swift"];
    terraform.terraform = [".tf"];
    tex.latex = [".tex"];
    toml.toml = [".toml"];
    vue.vue = [".vue"];
    yaml.yaml = [".yaml" ".yml"];
    zig.zig = [".zig"];
  };
in {
  inherit cli;

  # Load with CLAUDE_CODE_PLUGIN_DIRS (environment or settings `env`).
  claudeCodePlugin = pkgs.writeTextFile {
    name = "harbor-llm-claude-lsp";
    destination = "/.claude-plugin/plugin.json";
    text = builtins.toJSON {
      name = "harbor-lsp";
      version = "0.1.0";
      description = "Language servers from each project's Harbor LSP map";
      lspServers = lib.mapAttrs' (family: languages: let
        extensions = lib.concatLists (lib.attrValues languages);
      in
        lib.nameValuePair "harbor-${family}" {
          command = lib.getExe cli;
          args = ["serve" (lib.concatStringsSep "," extensions)];
          extensionToLanguage = lib.concatMapAttrs (language: lib.flip lib.genAttrs (_: language)) languages;
        })
      families;
    };
  };

  # VS Code extension directory (publisher.name layout), e.g. for a builtin
  # `resources/app/extensions` entry of a VS Code fork such as Antigravity.
  vscodeExtension = pkgs.runCommand "harbor-lsp-vscode" {} ''
    mkdir -p $out
    cp ${runtime}/editors/vscode/package.json $out/
    substitute ${runtime}/editors/vscode/extension.js $out/extension.js --replace-fail @cli@ ${lib.getExe cli}
    ln -s ${runtime}/node_modules $out/node_modules
  '';
}
