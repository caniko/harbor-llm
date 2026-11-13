self: {
  config,
  lib,
  pkgs,
  ...
}: let
  cfg = config.programs.harborLlm;
  registryText = builtins.toJSON {
    version = 1;
    projects =
      lib.mapAttrsToList (name: project: {
        inherit name;
        inherit (project) root;
        # Retain the derivation, not an eager dependency on all shell outputs.
        shells = lib.mapAttrs (_: shell: builtins.unsafeDiscardOutputDependency shell.drvPath) project.shells;
      })
      cfg.projects;
  };
  registry = assert lib.all (context: !(context.allOutputs or false)) (builtins.attrValues (builtins.getContext registryText));
    pkgs.writeText "harbor-llm-registry.json" registryText;
  runtime = "${cfg.package}/lib/harbor-llm/src";
  lsp = import ./lsp.nix {
    inherit pkgs;
    inherit (cfg) package;
    options = {
      inherit (cfg.lsp) roots;
      direnv = lib.getExe pkgs.direnv;
      nix = lib.getExe pkgs.nix;
      setsid = "${pkgs.util-linux}/bin/setsid";
      flock = "${pkgs.util-linux}/bin/flock";
      system = pkgs.stdenv.hostPlatform.system;
    };
  };
  opencodeSettings =
    if cfg.opencode.apiVersion == "v1"
    then {
      plugin = [
        [
          "${runtime}/opencode.mjs"
          {
            inherit registry;
            nix = lib.getExe pkgs.nix;
            node = lib.getExe pkgs.nodejs;
            capture = "${runtime}/capture.mjs";
          }
        ]
      ];
      permission = {
        harbor_devshell = "allow";
        harbor_dev_shell_prepare = "ask";
      };
    }
    else {
      plugins = [
        {
          package = "${cfg.package}/lib/harbor-llm/plugins/project-environment-prototype";
          options =
            {
              direnv = lib.getExe pkgs.direnv;
              nix = lib.getExe pkgs.nix;
              setsid = "${pkgs.util-linux}/bin/setsid";
              flock = "${pkgs.util-linux}/bin/flock";
              system = pkgs.stdenv.hostPlatform.system;
            }
            // cfg.opencode.options;
        }
      ];
    };
in {
  options.programs.harborLlm = {
    enable = lib.mkEnableOption "generic LLM harness integrations";
    package = lib.mkOption {
      type = lib.types.package;
      default = self.packages.${pkgs.stdenv.hostPlatform.system}.default;
    };
    projects = lib.mkOption {
      default = {};
      description = "Operator-approved canonical project roots and immutable dev-shell derivations. This trusts their builds and shell hooks, not just their names.";
      type = lib.types.attrsOf (lib.types.submodule {
        options = {
          root = lib.mkOption {type = lib.types.str;};
          shells = lib.mkOption {type = lib.types.attrsOf lib.types.package;};
        };
      });
    };
    lsp = {
      roots = lib.mkOption {
        type = lib.types.listOf lib.types.str;
        default = lib.mapAttrsToList (_: project: project.root) cfg.projects;
        defaultText = lib.literalExpression "project roots from programs.harborLlm.projects";
        description = "Absolute roots inside which an already approved `.envrc` may run to resolve a project's Harbor LSP map. Elsewhere only the committed `.opencode/opencode.jsonc` applies. Never approves an `.envrc`.";
      };
      cli = lib.mkOption {
        type = lib.types.package;
        readOnly = true;
        default = lsp.cli;
        description = "`harbor-llm-lsp`: lists a project's Harbor LSP map and serves its servers in the project environment.";
      };
      claudeCodePlugin = lib.mkOption {
        type = lib.types.package;
        readOnly = true;
        default = lsp.claudeCodePlugin;
        description = "Claude Code plugin directory serving Harbor LSP servers; load it with CLAUDE_CODE_PLUGIN_DIRS.";
      };
      opencodePlugin = lib.mkOption {
        type = lib.types.package;
        readOnly = true;
        default = lsp.opencodePlugin;
        description = "OpenCode v2 plugin directory serving Harbor LSP servers through opencode-v2-lsp-support; add it to `plugins`.";
      };
      vscodeExtension = lib.mkOption {
        type = lib.types.package;
        readOnly = true;
        default = lsp.vscodeExtension;
        description = "VS Code extension directory serving Harbor LSP servers, for VS Code forks such as Antigravity.";
      };
    };
    opencode.enable = lib.mkEnableOption "OpenCode environment replacement adapter";
    opencode.apiVersion = lib.mkOption {
      type = lib.types.enum ["v1" "v2"];
      default = "v2";
      description = "Native plugin API. V1 requires the versioned environment replacement capability.";
    };
    opencode.options = lib.mkOption {
      type = lib.types.attrsOf lib.types.anything;
      default = {};
      description = "Explicit V2 project environment options, including roots, backend URL and bootstrap environment.";
    };
    opencode.configFile = lib.mkOption {
      type = lib.types.package;
      readOnly = true;
      default = pkgs.writeText "harbor-llm-opencode.json" (builtins.toJSON opencodeSettings);
      description = "Harbor-only configuration overlay for a scoped backend rollout through OPENCODE_CONFIG, without replacing unrelated harness settings.";
    };
  };
  config = lib.mkIf cfg.enable {
    assertions = [
      {
        assertion = pkgs.stdenv.hostPlatform.isLinux;
        message = "harbor-llm currently supports Linux only";
      }
      {
        assertion = !cfg.opencode.enable || config.programs.opencode.enable;
        message = "Enable OpenCode before enabling its harbor-llm adapter";
      }
      {
        assertion = !cfg.opencode.enable || cfg.opencode.apiVersion != "v1" || (config.programs.opencode.package.harborLlmEnvironmentVersion or 0) == 1;
        message = "The V1 runtime must implement Harbor environment replacement contract version 1; wrappers must preserve its harborLlmEnvironmentVersion capability";
      }
    ];
    programs.opencode.settings = lib.mkIf cfg.opencode.enable opencodeSettings;
  };
}
