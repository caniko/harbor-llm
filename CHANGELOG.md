# Changelog

## [Unreleased]

- Add shared execution protocol bindings, bounded transport and authenticated
  Rust/JavaScript channels while preserving the predecessor v1 schema bytes.
- Add separately schema-bound v2 command codecs and directional authentication,
  plus single-use content-bound transfers with byte, chunk-count and time bounds.
- Add private Unix controller accounting with durable one-shot reservations and
  content-bound retained output. Reopening never authorizes fresh execution.
- Connect initial authenticated create/admit/release dispatch to fsynced journal
  reservations, with cumulative budgets and local lost-HTTP/IPC/bridge-exit
  conformance. Final supervision and privileged custody remain separate gates.
- Supply a single-owner Unix IPC exchange with whole-channel byte/record/time
  limits, terminal shutdown and no reconnect/retry. Partial progress cannot reset
  its deadline; the installed-dispatcher fixture uses this runtime path.
- Add bounded Linux artifact snapshots with kernel-enforced byte/size/executable
  seals and an independent post-seal digest check for descriptor-based launch.
- Add an opt-in, preparation-only Linux custodian with a root-issued admission
  ledger, kernel-authenticated private control socket, durable consumption and
  bounded per-connection services. Reopen is observational; launch is unavailable.
- Add an integrity-pinned OpenCode V2 adapter for admission, one-shot initial
  release and observational reconciliation. Construction defaults to observation;
  fresh release requires the distinct journal reservation and exclusive session
  writer custody.
- Add isolated native provider/tool recovery fixtures using an existing inbox
  item's steering endpoint, including a competing-input scope control. These
  establish bounded standalone feasibility;
  production custody, source attestation and consumer acceptance remain pending.
