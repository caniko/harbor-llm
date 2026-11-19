{
  harbor-meta,
  harbor-rs,
}: _: {
  imports = [
    harbor-meta.treefmtModules.nix
    harbor-meta.treefmtModules.toml
    harbor-rs.treefmtModules.rust
  ];
  projectRootFile = "flake.nix";
  programs.rustfmt.edition = "2021";
  settings.excludes = [
    ".github/workflows/*.yaml"
    "protocol/*.json"
    "test/*.json"
    "src/execution/*.d.ts"
    "node_modules/**"
    ".opencode/**"
    ".direnv/**"
    ".nix-results/**"
  ];
}
