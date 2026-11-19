{
  harbor-meta,
  harbor-rs,
  harbor-js,
  harbor-py,
}: _: {
  imports = [
    harbor-meta.treefmtModules.nix
    harbor-meta.treefmtModules.toml
    harbor-rs.treefmtModules.rust
    harbor-js.treefmtModules.javascript
    harbor-py.treefmtModules.python
  ];
  projectRootFile = "flake.nix";
  programs.rustfmt.edition = "2021";
  settings.excludes = [
    ".github/workflows/*.yaml"
    # Shared wire contracts, conformance vectors, and fixtures.
    "contracts/*.json"
    "protocol/*.json"
    "test/*.json"
    # Generated; codegen checks these bytes.
    "rust/command_types.rs"
    "rust/types.rs"
    "src/execution/*.d.ts"
    "src/execution/command-schema.mjs"
    "src/execution/schema.mjs"
    "package-lock.json"
    "node_modules/**"
    ".opencode/**"
    ".direnv/**"
    ".nix-results/**"
  ];
}
