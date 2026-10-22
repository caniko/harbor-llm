# MCP admission

`harbor-llm/mcp-admission` is a provider-neutral ESM library with TypeScript
declarations. The entrypoint has no runtime imports from OpenCode, Paperclip,
Hermes or an MCP transport SDK. It performs no I/O and retains no credentials,
grants or session state. The existing harness integration remains a separate
entrypoint with its own dependencies.

Consumers obtain this private source package from an exact Harbor revision and
package `components/llm` for installation. Git installation of the repository
root does not select this component. The MCP library and its contract assets
use the MIT license in `../src/mcp-admission.LICENSE`.

```js
import {
  bindMcpServersToRun,
  requireMcpRunBinding,
} from "harbor-llm/mcp-admission";

const [server] = bindMcpServersToRun({
  servers: [{ connectionId: "reader", url: "https://tools.example/mcp" }],
  runId: "run-1",
  executionHostId: "host-a",
  policy: {
    version: 1,
    servers: {
      reader: {
        url: "https://tools.example/mcp",
        gatewayUrl: "https://worker.example/api",
        serverHostId: "host-a",
        executionHostIds: ["host-a"],
      },
    },
  },
});
requireMcpRunBinding(server.runBinding, {
  runId: "run-1",
  executionHostId: "host-a",
  gatewayUrl: "https://worker.example/api",
});
```

The operator/controller supplies the trusted policy after its own authorization.
`connectionId`, `runId` and host IDs are opaque consumer identities. `url` is the
exact resolved MCP endpoint; `gatewayUrl` is the exact approved credential
recipient. Both require HTTPS or explicit loopback HTTP, without URL credentials,
query strings or fragments. Display names and caller extensions survive binding;
old binding metadata is replaced by a fresh frozen binding. Cross-host delivery
requires an explicitly allowed execution host and an own `authorizedCrossHost:
true` field at the consumer boundary. Consumers map an omitted execution target
to their trusted local worker identity before calling; a missing identity is
blocked rather than guessed.

Consumer-owned recipient aliases may be supplied through `normalizeRecipient`.
Raw approved and actual URLs are validated before normalization. Either callback
failure yields a content-free `McpAdmissionError` with
`code: "runtime_mcp_admission_blocked"` and a finite `reason`, without a retained
exception cause. Limits cover eight servers per run, 64 execution hosts per
server, 128-character identities, 2048-character endpoints and 64 KiB policies.

Policy version is the JSON number equal to `1` (`1.0` is equivalent); booleans
and strings are rejected. Every policy endpoint, including unused entries, is a
bounded ASCII string, so character limits have identical meaning in both
languages. Credential delivery additionally requires printable ASCII and the
transport syntax above. The policy byte limit measures the compact UTF-8 JSON
of the validated copy with version normalized to `1`, including JSON escapes.
An empty delivery means an actual empty server array; malformed containers and
entries yield finite errors. Alias callbacks must return two nonempty primitive
strings. Invalid results and callback failures are content-free binding errors.
Both binding creation and consumer recheck return read-only snapshots of validated
metadata (a frozen ESM object or a Python mapping over a fresh dictionary), never
the caller's original proxy or mutable mapping. Python dictionary/proxy read
failures are redacted, and endpoint/identity comparisons require primitive strings.
The ESM native-object boundary requires own data properties; accessors are
rejected without invoking getters and descriptor-read failures are redacted. Inherited
identities, endpoints, recipient aliases and JSON serializers cannot supply
admission fields or participate in policy size accounting.

Portable assets are exported under `harbor-llm/contracts/`:

- `mcp-admission-policy.v1.schema.json`
- `mcp-run-binding.v1.schema.json`
- `mcp-admission-conformance.v1.json`

These are the same schemas imported by the runtime, not a consumer-maintained
copy. Version 1's identifier pattern requires a regex engine supporting negative
lookahead (JavaScript and Python do; RE2 does not). Validators must reject a final
newline rather than relying on `$` end-of-line semantics. Other languages must
implement the semantic checks as well as structural schema validation. A JSON
binding is metadata, never a bearer credential or an authenticated grant.
Tenant/project/agent/task/operation grants, destination authentication, token
expiry/revocation, physical-host attestation, network and shell isolation,
provenance, recovery reauthorization, cancellation and verified operation
settlement remain integration responsibilities. Sharing this metadata does not
establish a reusable lifecycle runtime or prove live worker acceptance.

Run the focused checks with `node --test test/mcp-admission*.test.mjs` from the
component directory. They cover the portable vectors, inherited authorization
attacks, callback redaction, an independent authenticated loopback MCP service,
and packed exports without installed harness dependencies. Consumers qualify
their actual delivery paths separately.

## Python consumers

The component `pyproject.toml` builds the `harbor-llm` Python distribution. Pin
the full Harbor Git revision and select `components/llm` as its subdirectory.
`harbor_llm.mcp_admission` exposes `bind_mcp_servers_to_run`,
`require_mcp_run_binding`, `parse_mcp_admission_policy`,
`require_mcp_credential_endpoint`, and `is_mcp_admission_identifier`. Bindings
use read-only mappings; exceptions carry the same finite `reason` and
content-free `runtime_mcp_admission_blocked` code. It has no transport, harness,
or third-party runtime dependency.

Packaged assets come from the canonical `contracts/` directory. Both languages
run its vectors and differential checks across policy parsing, binding,
consumer rechecks, identifiers and endpoint parsing, including exact byte limits,
JSON numeric spellings, Unicode exclusions, malformed lists and callback results.
Exact endpoints require explicit authorities and portable host spelling:
encoded hostnames and repaired abbreviated/numeric IPv4 forms are rejected.
Consumer-owned alias normalization runs only after raw URL validation. Multiple
trailing hostname dots are rejected in both languages. This is a tightened
syntax check, not physical-host attestation.

Run Python checks with `python3 -I test/test_mcp_admission.py`; the Node suite
also runs the differential check (`HARBOR_TEST_PYTHON` selects an interpreter).
