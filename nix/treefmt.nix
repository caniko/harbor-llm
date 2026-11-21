{
  harbor-meta,
  harbor-rs,
  harbor-js,
  harbor-py,
}: _: {
  imports = [
    harbor-meta.treefmtModules.nix
    harbor-meta.treefmtModules.toml
    harbor-meta.treefmtModules.markdown
    harbor-meta.treefmtModules.shell
    harbor-meta.treefmtModules.svg
    harbor-rs.treefmtModules.rust
    harbor-js.treefmtModules.javascript
    harbor-py.treefmtModules.python
  ];
  projectRootFile = "flake.nix";
  programs.rustfmt.edition = "2021";
  # The pinned JavaScript helper does not yet cover TypeScript ES modules.
  settings.formatter.prettier.includes = ["*.mts"];
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
    # Negative TS fixtures depend on @ts-expect-error applying to the next line.
    "test/execution.types.mts"
    "package-lock.json"
    "node_modules/**"
    ".opencode/**"
    ".direnv/**"
    ".nix-results/**"
  ];
}
