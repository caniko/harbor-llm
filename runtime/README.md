# harbor-llm-runtime

Controller-side execution accounting and an experimental Linux standalone supervisor
for Harbor LLM bridges.

The application authenticates original admission and supplies a private,
pre-existing store protected from backend and daemon writers. Register once and
persist the returned registration in the independent application ledger before
dispatch. Never register replacement state to recover a missing ledger/store.

`Controller::reserve` fsyncs UNKNOWN before the caller releases one exact start,
submit, execute or interrupt operation. Submission admits input; execution is a
separate reservation requiring an observed submission and its exact input digest.
A lost reply, process crash or restart never releases that operation again. A
retained observation does not authorize retry. Reopened handles cannot reserve
fresh start, submission or execution work, including when an older journal has
no execution entry. Current-authority interruption remains separately authorized
against the original execution; reopening never grants that authority.
Kernel locks prevent concurrent controller handles; file/directory identities,
private ownership/modes, random lock identity and bounded journal reads detect
missing or replaced state. Reopen only reads existing state. A failed write
poisons the in-memory handle. Interrupted initialization and orphaned output
remain evidence and are not silently removed or recreated.

`dispatch_initial` connects this fence to one caller-supplied authenticated
exchange for a v2 create, submit or execute command. It checks the original
registration/binding and target, then reserves UNKNOWN before calling the
exchange once. Only a matching observed receipt can be retained. Missing, lost,
rejected or mismatched replies never permit a repeat. Handles equal the
preallocated execution ID; submission and release bind the same canonical
`(handle, inbox ID, input-byte digest)` tuple. Request IDs are correlations only.
This helper does not reconnect, launch or supervise a bridge. The exchange must
enforce its deadline and private executable/channel custody. `dispatch_interrupt`
separately validates a supplied current-authority digest and the original target,
then fsyncs its own one-shot interrupt reservation, including after journal reopen.
Revocation and closure belong to the supervisor.

`ipc::Exchange` owns the supervisor-supplied private Unix socket and authenticated
command channel. Required limits cover whole-channel elapsed time, records and
wire bytes in both directions. Each partial read/write uses the remaining
deadline; slow peer progress never resets it. Length checks and cumulative
budgets precede allocation or the next write. Effects use exactly one matched
reply exchange inside `dispatch_initial`; transfers have no response. Any
failure closes the original socket and zeroizes channel keys, without connecting
or retrying. The launcher must provide original peer/executable and descriptor
custody and dispose of its initial key buffers; an owned socket is not a process
container or exclusive engine-writer boundary.

### Linux artifact snapshots

`artifact::Snapshot::capture` copies a trusted digest-selected regular file into
an anonymous Linux memfd, seals writes/size/seal changes and executable bits,
then independently hashes the sealed bytes. Its close-on-exec descriptor starts
at byte zero and stays pinned while the caller retains the snapshot. Source
replacement, deletion or in-place writes cannot change the captured image.
The supervisor must launch from this descriptor, rather than reopen the original
path after hashing. Linux 6.3+ execution seals are required; there is no mutable
file fallback. Byte and elapsed-time limits are required, with a 512 MiB artifact
ceiling and the shared one-hour time ceiling. Capture performs no execution.

The custodian must run file capture inside its killable setup phase because a
cooperative deadline cannot interrupt a kernel-blocked filesystem read. It must
retain the complete immutable dependency closure, independently qualified source
identity and durable evidence. Sealing one image does not pin shared libraries or
JavaScript imports, establish private session writers, authenticate a process or
provide admission or a sandbox. macOS keeps its separate existing managed-host
snapshot boundary until a qualified implementation is integrated.

### Experimental managed-host standalone supervisor

`standalone::Session` is a Linux-only, non-root, trusted managed-host profile.
It trusts same-UID host writers and the selected engine/tool code. It does not
implement the specialist untrusted-worker custody boundary or a Paperclip,
Roborev or Chaosbox application adapter. The root preparation service below
continues to report launch unavailable.

The application supplies an exact `Plan`, original controller registration,
sealed engine image and a synchronous broker revoker. The complete plan and
engine digest must match the independently admitted implementation digest.
Dependencies, dispatcher imports and the tools-only PATH must be immutable
canonical Nix-store paths. No operator environment or provider credential store
is supplied to the engine. The selected provider talks through a private Unix
broker; the application owns destination/model, authorization, token/spend and
revocation policy. The revoker must return within 250 ms without panicking;
this is a trusted application obligation, not enforced callback preemption.

`start` reserves UNKNOWN before launch. One nondelegated systemd user unit owns
Bubblewrap, the embedded Node bridge, the exact engine and all tool descendants.
The unit enforces wall time, memory with swap disabled, aggregate CPU and task
limits. Bubblewrap isolates network/PID/mount/IPC/UTS/user/cgroup namespaces,
mounts the immutable dependencies read-only and exposes one private tmpfs.
The setup helper bounds its bytes/inodes, disables further user namespaces and
permanently drops capabilities before starting the bridge.

Systemd `OpenFile=` transports the original sealed descriptors across the
manager boundary. Bubblewrap copies their bytes into read-only executable mounts;
the controller independently hashes the running Node executable and the mounted
engine/helper before sending bootstrap credentials. The kernel peer UID, original
unit/cgroup and enforced resource settings are checked first. The shared wire
retains its bootstrap deadline and cumulative bidirectional record/byte counts
when it becomes the authenticated command exchange.

`submit` transfers exact original input only inside its fsynced reservation;
`execute` releases only the original queued inbox item. `interrupt` requires a
separately validated current cancellation grant. `reconcile` reads a bounded,
correlated observation transfer with a content-bound receipt. It never resumes
work, and a gap-bearing snapshot is not application completion.

`close` revokes first, rechecks the original systemd invocation, stops the whole
unit and verifies the original descriptor-pinned cgroup empty. Failed revocation,
changed identity or unverifiable cleanup returns no restart handoff. Successful
cleanup binds the complete closed state tree to its original plan and execution.
`reopen` consumes that handoff's single observational attempt. Because Bubblewrap
cannot directly bind a detached tmpfs directory, it makes a bounded private copy,
checks it against the closed-state digest, copies it into a new bounded tmpfs and
independently reads it back. Missing or changed state fails before engine launch.
The original retained mount remains pinned; a path cannot reconstruct authority.
The new bridge uses observation mode and the exact standalone engine path with
restart continuity uninstalled. There is no automatic retry or replacement launch.

The production `llm-custodian` package includes the private
`harbor-llm-standalone` namespace helper. It has no host launch/admission CLI and
rejects the initial user namespace, including host root. No service is enabled
by packaging it.

The opt-in integrated native gate requires explicit absolute selections for
`HARBOR_OPENCODE_BINARY`, `HARBOR_OPENCODE_SHA256`, `HARBOR_NODE_BINARY`,
`HARBOR_STANDALONE_HELPER`, `HARBOR_INSTALLED_DISPATCHER`,
`HARBOR_BUBBLEWRAP_BINARY`, `HARBOR_NATIVE_EVIDENCE_ROOT` and
`HARBOR_SHELL_TOOL_PATH`. Missing selections fail rather than skip:

```sh
cargo test --locked -p harbor-llm-runtime --features native-conformance --lib custodian::native_tests::custodian_through_exact_engine_execution_interruption_recovery_and_cleanup --jobs 2 -- --exact --nocapture
```

Its same-UID preparation fixture drives the real journal, installed dispatcher,
selected engine and independent synthetic provider/tool observer. Seven phases
cover provider/tool interruption, whole-unit crashes, lost release receipts and
application-validated completion with identical retained redelivery. Observational
restart must preserve suspension/resume claims and produce zero extra provider
or tool attempts. Negative controls cover competing/repeated input, plan drift,
stale cancellation/cleanup identity, reused handoffs, failed revocation and
missing state. Every attempt and failed database capture is retained outside the
unit. Reports remain `accepted: false`: this is local managed-supervisor conformance,
not root-service acceptance, source attestation, consumer parity or deployment.

### Disabled preparation custodian

Harbor exports `nixosModules.llm-custodian` and `packages.<system>.llm-custodian`
from the consolidated flake. The NixOS option
`services.harbor-llm-custodian.enable` defaults to false. Importing the module
creates no service, socket or state directories until explicitly enabled.
The native `harbor-llm-custodian serve --config <root-owned-file>` entrypoint
requires root and a systemd-accepted Unix socket on stdin.

The preparation control endpoint has its own private version-1 JSON envelope;
it is separate from the preserved execution-v1 codec and authenticated v2 bridge.
Each frame has a big-endian u32 byte length, at most 16 KiB of JSON and depth 64.
A connection has a non-renewable deadline, 16 total incoming/outgoing frames and
128 KiB total wire bytes. Unknown/duplicate fields, malformed or partial frames
and exhausted budgets terminate the connection. Errors expose stable codes only.
The supported request shape is:

```json
{
  "version": 1,
  "requestId": "correlation-only",
  "body": { "kind": "prepare", "admission": "<64 lowercase hex characters>" }
}
```

`describe` has no admission field and reports `prepare: true, launch: false`.
`reopen` takes the original admission reference and reads existing registration
evidence only. `launch` always returns `unsupported-capability`; other effects
are absent. No preparation response is an execution or worker-qualification grant.

Requests cannot provide paths, authority bindings, credentials or arguments.
`custodian::admission_id` derives the reference from the original
`(callerAuthority, callerNamespace, intentId)` tuple using the existing journal
key. A different execution generation, request ID or engine selection cannot
create a fresh key. The independent authorized issuer must provision this record
under `/var/lib/harbor-llm-custodian/admissions/pending/<reference>.json`:

```json
{
  "version": 1,
  "controllerUid": 1000,
  "binding": "<complete generated execution Binding object>",
  "engine": "/absolute/path/to/the/selected/artifact",
  "engineDigest": "<independently qualified SHA-256>",
  "outputBytes": 4096
}
```

The binding placeholder above must be replaced with the typed object, not a
string. Provisioning is an application/admission-issuer responsibility; the
socket cannot issue or replace records. The configured file, ledger, state and
every ancestor are root-owned. Ancestors are non-writable by other principals
or use sticky ownership protection, as `/nix/store` does. Leaf ledger and state
directories are private. Symlinks and nonregular/hardlinked record files are
rejected. Readonly configuration hardlinks remain compatible with Nix store
deduplication; this tolerance does not apply to admission/registration records.
Kernel `SO_PEERCRED` authenticates the connecting UID, which
must equal the root-issued record's `controllerUid`. Socket access or a claimed
binding alone grants nothing. This preparation boundary trusts the selected
controller UID as a principal; it does not attest an individual controller
executable or establish the specialist worker's distinct-writer boundary.

Preparation fsyncs the original admission, moves it atomically with no overwrite
to `admissions/consumed`, and fsyncs both directories **before** registration or
artifact capture. It retains the exact admission digest and original registration
in the consumed ledger, independent of the execution store. The original
controller lock and sealed image remain held only for that connection's lifetime.
One connection may prepare one intent. A failure, lost reply, crash or disconnect
never unconsumes it. Missing state, incomplete receipts, reissued pending records
and changed generations cannot restore freshness. Consumed and failed entries
remain evidence; the service never deletes or reconstructs them.

`reopen` verifies the consumed record/receipt and reopens the original journal
without recapturing an artifact, querying an engine or dispatching anything. Its
response reports only the registration, not surviving snapshot custody or
successful preparation. No `Start` reservation is made during preparation.

The module defaults to a root-only socket, allows an explicitly declared
controller group, caps concurrent connections at four and bounds activation rate.
Each accepted connection runs in its own root-owned service with a 30-second
default/60-second maximum lifetime, 768 MiB memory limit, one CPU, four tasks,
no network, restricted filesystem writes and control-group termination. It
cannot restart automatically. Native socket, race, malformed-input and abrupt
process-exit fixtures run unprivileged; they do not establish installed root
service acceptance. Final engine/bridge confinement, dependency-closure custody,
exclusive session writers, broker revocation and descendant cleanup require the
next integration and qualification gates. No Canix host enables this module.

`retain` accepts complete application-validated output and durably binds its
bytes, digest and execution binding before `deliver` can return identical bytes.
Applications must authenticate the current delivery generation themselves.
Changed bindings and path relocation are not implicitly equivalent. Caller
budgets are required and capped at 16 MiB retained output and 16 KiB journal.

The journal itself does not authenticate application admission, verify input manifests,
launch a provider, implement a sandbox or stop descendants. Store owner and
parent-directory custody remain the application's trust boundary; same-owner
malicious writers can undo accounting unless a stronger custodian excludes them.
Read-only journal recovery does not prove zero-effect reopening of an actual
OpenCode engine. That requires separately qualified standalone launch behavior.

Run the native fault tests from the Harbor root:

```sh
cargo test --locked -p harbor-llm-runtime --jobs 2
```

The explicit initial-dispatch conformance example accepts the absolute path to a
JavaScript dispatcher module, including one in a realized production package:

```sh
cargo run --locked -p harbor-llm-runtime --example initial_dispatch -- /absolute/path/to/src/execution/dispatcher.mjs
```

It uses the runtime's `ipc::Exchange`, fresh private IPC credentials, the actual dispatcher and pinned generated
client, a synthetic HTTP observer, and disposable controller stores. The observer
checks the on-disk UNKNOWN reservation before each mutation. Normal release, lost
HTTP/IPC replies and bridge exit all exercise no-replay recovery. This is local
cross-language conformance, not the final supervisor, native engine recovery or
privileged custody acceptance.

Rust registry publication depends on first publishing the qualified
`harbor-llm-protocol` release. Both crates are developed in this Cargo workspace;
downstream consumers must use verified registry releases.
