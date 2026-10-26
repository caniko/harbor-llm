# Execution transport

Harbor's LLM component owns provider-independent execution wire contracts and
transport mechanics. The Rust package is `harbor-llm-protocol`; JavaScript and
TypeScript exports are part of `harbor-llm`:

| Export                            | Responsibility                                                                  |
| --------------------------------- | ------------------------------------------------------------------------------- |
| `harbor-llm/execution-protocol`   | Canonical JSON validation and exact-implementation discovery                    |
| `harbor-llm/execution-framing`    | Bounded, incremental length-prefixed message framing                            |
| `harbor-llm/execution-channel`    | Directional authenticated records and replay rejection                          |
| `harbor-llm/execution-commands`   | Separate v2 command codec, authenticated records and bounded transfers          |
| `harbor-llm/execution-dispatcher` | Initial dispatch, observational recovery and separately authorized interruption |
| `harbor-llm/transport`            | One bounded JSON subprocess operation with cancellation                         |
| `harbor-llm/opencode-v2`          | Pinned generated-client transport and bounded observational recovery            |

The pure codec/transport exports work without Canix, OpenCode, a provider, or
installed npm dependencies. `opencode-v2` and `execution-dispatcher` use the published
`@opencode/client@2.0.22` dependency. The packed-package test exercises the
dependency-free exports. Rust tests
exchange authenticated records with the actual JavaScript implementation in
both directions; Node must be available when running those tests.

## Ownership and compatibility

`protocol/execution.json` owns the version-1 inventory, field constraints and
wire error classes. Its bytes and the original shared conformance corpus were
transferred from Toolbelt's `runtime/execution/protocol.json` and
`tests/execution-protocol-fixtures.json`, under the retained MIT license.
The schema SHA-256 remains
`dfaae881ef6cab2981ff63a3d478af684b49ec691192e3bd8981fe77a61e72a3`.
Whitespace is identity-bearing; treefmt excludes this schema and corpus.

Generate Rust and TypeScript types and frozen JavaScript schema metadata from
this one definition, from the Harbor repository root:

```sh
cargo run --locked -p harbor-llm-codegen -- components/llm
cargo run --locked -p harbor-llm-codegen -- --check components/llm
cargo test --locked -p harbor-llm-protocol --jobs 2
cargo test --locked -p harbor-llm-runtime --jobs 2
npm --prefix components/llm test
```

Application contracts remain with consumers: Roborev owns review ranges, jobs,
coverage, findings and delivery; Paperclip owns companies, tasks, PRP and
completion persistence; Chaosbox owns graph/evidence/private-scope and Jev
assessment contracts. Harbor core owns packaging/environment composition;
Toolbelt integrates Harbor with reusable host and review-controller modules.
Canix selects fleet placement, credentials, artifacts, models and budgets.

Toolbelt's existing implementation remains a compatibility predecessor until a
qualified Harbor registry release is available. The intended replacement is a
dependency-backed facade, retaining its public import path. Consumers must not
replace registry dependencies with local paths, Nix-injected sources or copies.

## Discovery and framing

Messages are compact, key-sorted UTF-8 JSON without BOM, duplicate fields,
alternate encodings, extra fields or unsafe numeric counters. Frames are at
most 65,536 payload bytes. Identity bounds count UTF-8 bytes. Generation and
sequence counters are decimal strings preserving the complete unsigned 64-bit
range. Discovery binds request, profile and every implementation digest;
`macos-untrusted-review` remains explicitly inadmissible.

Unauthenticated framing uses a big-endian u32 length followed by the canonical
payload. Rust readers check the length before allocating. JavaScript readers
retain at most one partial frame and reject input chunks larger than a maximum
frame plus its header; transports must split larger network reads. Both callers
must enforce I/O deadlines, cumulative byte/message/queue budgets and discard
the channel after failure. Truncated streams never produce partial messages.

Successful structural negotiation grants no execution authority and is not
evidence that an advertised implementation provides its claimed capabilities.

### Separate command wire

`protocol/commands.json` defines v2 commands without changing the v1 schema or
its compatibility paths. Code generation imports the digest-pinned v1 identity
types and emits command-local Rust/TypeScript types and immutable metadata.
Each command includes its own schema digest, request ID and full execution
binding. Decoding a command never releases an operation or grants authority.

Command records reuse the bounded directional authentication machinery with a
distinct domain and the command-schema digest in key derivation. V1 records
cannot authenticate as commands, or conversely. Every codec failure closes the
channel; transport correlation and sequence numbers never mint application
admission. Callers still supply fresh private channel credentials and custody.

Transfers use explicit purpose, identity, byte count and SHA-256, contiguous
offsets and at most 4096 nonempty chunks of 16 KiB. Receivers bound bytes and
elapsed time and return nothing until a matching end and content digest. Empty
content requires no chunks. Any failure or second consumption is terminal.
Input is capped at 64 MiB; configuration, observation and output at 16 MiB.
These are per-transfer primitives: the dispatcher must additionally bound live
buffers, cumulative bytes, record/transfer counts and whole-channel lifetime,
bind purposes and contents to the exact command, and reserve effects durably.

`InitialDispatcher` connects that wire to the pinned adapter. Construction is
effect-free and defaults to observation; only original Rust admission may select
fresh mode. It checks the configured binding and execution-ID handle, accepts one
configuration and one input transfer, consumes complete references once, and
requires the original inbox ID and input digest on release. Cumulative input,
record count and the whole endpoint deadline are bounded; the deadline also
aborts stalled HTTP. Reopen/reconcile send only bounded observation transfers
with correlated content-bound receipts. Interruption requires an independently
supplied current-authority digest and is one-shot even when its reply is lost.
Revocation and cleanup belong to the supervisor.

`Controller::dispatch_initial` fsyncs its matching reservation before invoking the
authenticated exchange once. A callback never runs when reservation/custody
checks fail. Lost or mismatched replies retain UNKNOWN. This connects journal
fencing to the actual dispatcher/adapter through the explicit conformance example
in the [runtime README](../runtime/README.md). The exchange/launcher must still
establish private channel and executable custody and supervise all descendants.
The runtime's `ipc::Exchange` supplies the bounded private Unix exchange used by
that example: one owned socket/channel, whole-channel deadline and cumulative
record/wire-byte limits, with checks before allocation/writes. It neither opens
nor reconnects a socket; all failures terminally shut down the original channel.
Its observational receiver validates purpose, correlation, the full binding,
length/digest and the final output receipt before returning any bytes.

On Linux, `artifact::Snapshot` supplies a sealed exact-byte image for the
custodian's launch handoff. Capture rejects nonregular/empty sources, bounds
copying, seals the image and independently hashes those immutable bytes. The
supervisor retains the descriptor and the full dependency closure throughout
execution. This closes a source-path replacement race; it does not replace root
custody, admission, source attestation or process-container supervision. See the
[runtime contract](../runtime/README.md#linux-artifact-snapshots) for its setup
deadline and Linux capability requirements.

The disabled Linux preparation custodian consumes an independent root-issued
admission before registering the journal and holding one sealed image. Its
kernel-authenticated control socket accepts an admission reference, not caller
paths or asserted authority. Consumed admissions fence reconnects, changed
generations and missing runtime state. Discovery reports `launch: false`; journal
reopen is observational and never recaptures an artifact. The
[preparation contract](../runtime/README.md#disabled-preparation-custodian)
documents the bounded per-connection service and the remaining worker/supervisor
integration. This private control envelope does not change either execution wire.

The separate experimental [managed-host standalone supervisor](../runtime/README.md#experimental-managed-host-standalone-supervisor)
owns a systemd user unit, sealed-image handoff, private authenticated bridge,
bounded namespaces/resources and revoke-before-whole-cgroup cleanup. It trusts
same-UID host writers and engine/tool code. Its integrated native gate drives the
preparation fixture, journal, installed dispatcher and selected engine through
interruption, process-container crashes, lost release receipts and retained
completion. Closed state is content-bound before a single observational restart;
independent provider/tool counters must remain unchanged. This profile does not
extend the root preparation endpoint or qualify specialist worker custody.

## Authenticated records

The channel codec uses HMAC-SHA-256, with independent controller and bridge keys
derived from a 32-byte secret, the schema digest, a fresh 32-byte channel nonce,
the exact 32-byte execution-binding digest and a direction label. The domain
and layout are declared in `protocol/channel.json`.

Each record contains an unsigned big-endian u64 sequence, a big-endian u32
payload length, the canonical payload and a 32-byte authentication tag. The
sequence starts at one independently in each direction. Authentication precedes
message decoding; reflection, replays, reordering, wrong credentials and changed
bindings fail closed. Failed operations permanently close the codec. Close and
Rust drop zeroize retained directional keys; callers own the lifetime of their
original secret buffers. JavaScript native crypto temporaries are runtime-owned.

This is integrity protection for a private local IPC channel. The launcher must
establish peer/executable custody, deliver secrets privately, generate fresh
cryptographically random nonces and prohibit tuple reuse after reconnect or
restart. Never send the secret in argv or diagnostics. Confidentiality requires
the private pipe/socket or another encrypted transport; these records are not
an encrypted network protocol. The codec neither opens sockets nor persists
credentials or creates processes.

## Native JSON subprocess operations

`runJson` takes an approved absolute executable, an argument array, explicit
environment, optional cwd and abort signal, and four required budgets:
`timeoutMs`, `inputBytes`, `outputBytes`, `stderrBytes`. It never invokes a shell,
inherits ambient credentials, retries a failed operation, or interprets
application success. `protocol/transport.json` owns the non-raiseable ceilings:
one hour, 64 MiB input, 16 MiB output, 1 MiB stderr, 256 arguments and 64 KiB
total argument bytes. Consumers select stricter budgets.

Input serialization bounds bytes while traversing JSON data, rejects excessive
depth and does not run accessors or `toJSON` hooks. Output validation rejects
invalid UTF-8, duplicate keys, trailing documents and excessive nesting. Child
output and native error strings never enter transport diagnostics. Overflow is
sticky even when the child handles termination and exits successfully.

Linux/macOS operations use a private process group. Cancellation, timeouts and
overflow terminate the group, escalate after 250 ms and bound cleanup to two
seconds. A surviving group or unverifiable cleanup returns
`cleanup-unverified`; it cannot establish success. This is not a sandbox and
does not contain a child that deliberately escapes its process group. Production
workers still require their independently qualified host supervision and write
boundaries. Windows is rejected before spawning.

Read-only queries and effectful submissions use the same no-retry primitive.
Only the application's durable admission/reconciliation layer may decide that a
new attempt is eligible. A lost reply must remain uncertain, never trigger an
automatic repeat of a model/provider/tool effect.

## Acceptance and adoption boundary

`harbor-llm-runtime` implements a Unix controller-side one-shot journal. UNKNOWN
is durable before operation release. Missing state is never recreated by reopen;
an independent application ledger retains the original registration. Output is
content-bound and durable before delivery. See [runtime README](../runtime/README.md)
for the store-custody, admission and current-delivery-authorization obligations.
Crash fixtures exercise that accounting, not actual OpenCode engine recovery.

`OpenCodeV2` uses the npm-integrity-pinned generated client. The selected engine
contract remains `047c74ec64ca6029f93be4bb4d1f5797c8838b9a`, specifically
`packages/client/src/promise/generated/{client,types}.ts`; registry version alone
does not attest engine source. The launcher must bind executable/client/config
identities and the private standalone endpoint. Construction does no I/O and
never calls managed-service discovery/startup. Version/PID checks are readiness,
not executable custody. Create receipts must match requested model, agent and
permissions. The pinned `core/src/session/info.ts` materializes an omitted model
variant as `"default"`; that exact default is compared without allowing explicit
variant drift. Construction defaults to observation; only an explicit
`mode: "fresh"` enables start/admission/release. That selection is not application
authority and must never be reconstructed from persisted state. Start, submit,
execute and interrupt are one-shot; submit and interrupt disable resume. The Rust
admission holder must fsync each matching intent before dispatch; local JavaScript
flags do not survive process replacement.

At this exact engine revision, `Session.prompt` wakes execution only when
`resume !== false`. Consequently `submit` is **inbox admission only**, not an
executing model invocation. `execute(inboxID)` releases the same admitted queued input
through `session.inbox.update({delivery: "steer"})`, never another prompt POST.
It requires the adapter's own successful admission, compares its private receipt
snapshot with the only pending item, rejects prior transcript messages and checks
model/agent/permission drift. A rejected, lost or uncertain release cannot be
repeated. The caller must first reserve `Operation::Execute` with the observed
submission's input digest. Observational recovery never issues that release.
The selected delivery transition is queue → steer. Already-steering input is
rejected before requests; the adapter never requeues, reposts or resumes it as a
fallback.
Disabling managed-server restart continuity and disabling prompt wakeup are
different controls.

**Release requires exclusive whole-session writer custody.** The engine wakes the
session, not just the targeted inbox item. The preflight is a bounded observation,
not an atomic single-input fence. The native competing-input control demonstrates
that another steering item admitted after a singleton read is also executed by a
PATCH targeting the original ID. The final custodian/dispatcher must exclude such
writers throughout admission and release; mode flags and matching GETs cannot
qualify that guarantee. A 204 release receipt is not semantic completion.

Requests have no redirects or retries, one outstanding operation, per-body and
aggregate byte/request budgets, page/message bounds and a whole-adapter deadline.
JSON validation precedes generated-client parsing. Lost/malformed mutation
replies return `effect-unknown`; errors exclude raw server details. Reconciliation
reads the exact session, inbox and every transcript page twice, rejects repeated
cursors/identities and changed scans, and always reports `gap: true, complete:
false`. Matching scans are observations, not an atomic snapshot or semantic
completion. Permissions/forms, tools, usage and completion remain application
contracts; the adapter never auto-approves them. Synthetic HTTP tests use the
actual published generated client without a live provider.

Cursor continuation omits `order`: the selected server encodes ordering in the
cursor and rejects a request containing both. Its nonempty pages return a next
cursor even for the last message, so scans include the terminal empty page.

The explicit [native recovery gate](../test/native/README.md) uses a selected,
checksum-bound native artifact, isolated roots, a local synthetic provider and
an instrumented real shell tool. It checks durable interrupted execution claims,
surviving-server reattachment and standalone restart separately. Independent
provider/tool counters and every attempt's state are retained outside engine
roots. It is not part of the default provider-free test glob and fails rather
than skips when its artifact inputs are missing. These are bounded native
feasibility fixtures, not source attestation or production custody acceptance.

The initial dispatcher and the experimental trusted managed-host supervisor have
local conformance, including exact-engine observational restart and synthetic
same-job retained redelivery. Root-service launch integration, distinct-writer
worker custody, source attestation, actual consumer completion/delivery semantics,
copied-state migration/rollback and production admission remain unfinished.
These local tests do not establish native ARM64/macOS worker acceptance or a
qualified consumer release.

Before replacing Toolbelt, Paperclip or Chaosbox implementations, publish and
verify qualified Rust and JavaScript registry artifacts and the exact bridge
artifact, then run each consumer's compatibility gates. The JavaScript package
remains private pending that release setup. Preserve persisted identities,
credentials, observers, frozen transactions and application-specific semantics
during adoption. Remove predecessor mechanics only in the compatibility-proven
consumer change. Live execution and production activation need their separate
acceptance and authorization.
