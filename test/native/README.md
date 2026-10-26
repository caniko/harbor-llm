# Native standalone recovery gate

This explicit gate starts the selected OpenCode engine with disposable state,
a loopback-only synthetic provider and synthetic credentials. It does not connect
to an installed managed server. The helpers are test fixtures, not a production
launcher, sandbox or privileged custodian.

Supply an approved artifact's absolute real executable path and SHA-256, plus a
private directory for retained evidence. Missing or changed inputs fail the gate;
there is no optional-success or skip path. For example, in Nu:

```nu
with-env {
  HARBOR_OPENCODE_BINARY: "/absolute/approved/opencode"
  HARBOR_OPENCODE_SHA256: "<approved executable SHA-256>"
  HARBOR_NATIVE_EVIDENCE_ROOT: "/data/scratch/tmp/opencode/harbor-native-recovery"
} {
  node --test components/llm/test/native/opencode-recovery.test.mjs
}
```

Run from the Harbor root in its approved environment. The gate requires Node's
`node:sqlite` and the exact server version `2.0.22+047c74e`. Executable checksums
and version/PID readiness bind the selected fixture artifact; qualifying its
source/build provenance remains an external prerequisite.

## What the cases establish

- An admit-only prompt (`resume: false`) produces no provider request. The fresh
  adapter's one-time PATCH steers that existing inbox item and reaches the
  independent provider observer. The selected transition requires queued input;
  an already-steering admission is rejected with no provider/tool work, unchanged
  pending input and no fallback. That negative case is not interrupted recovery.
  This positive control prevents an idle session from masquerading as interrupted
  execution without reposting the prompt. The isolated fixture is its only writer;
  the engine wakes the whole session, so an inbox read is not a writer lock.
  Production recovery never sends that wake.
- A deliberately unfenced competing-input control admits unrelated steering input
  after a singleton read. The PATCH still targets the original inbox ID, but both
  inputs reach the provider. This demonstrates why private, exclusive writer
  custody is a release prerequisite; the negative control is never a production
  dispatch or UNKNOWN-recovery path.
- One case stalls a provider response. The other returns a synthetic shell-tool
  call that reaches a second, independently recorded endpoint and remains active.
  The tool uses an absolute Node executable and has its own finite deadline.
- The observer reads the engine database **read-only** and requires a real durable
  execution claim before termination. It never writes database state to construct
  a fixture or to manufacture completion.
- Reattachment uses a fresh adapter while the original server lives. Restart uses
  the same state after SIGKILL, with the original claim still present. Both use
  read-only reconciliation, and the restart observation window is three seconds.
- Counters must not increase and the claim must not change. Provider/title
  background generation is disabled explicitly through the fixture configuration;
  the configuration digest is part of each successful result.

The fixture bounds server startup, HTTP requests/bodies, provider/tool calls,
captured diagnostics, observation time and direct-child termination. Every attempt
gets a new private directory; state, counters and failure records are retained.
No provider response bodies, authorization headers or lease passwords are written
to the reports.

## Acceptance boundary

A passing test establishes only the exercised native standalone behavior over
that observation window. Result reports retain `accepted: false`, the pending
source-attestation prerequisite and unproven production custody. This does not
qualify arbitrary configurations, managed-server mode, final bridge/supervisor
recovery, escaped-descendant cleanup, credential revocation, another platform or
consumer completion. Repeat these faults through the final qualified supervisor
before advertising the corresponding runtime capabilities.
