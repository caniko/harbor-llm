# harbor-llm-protocol

Provider-free execution discovery, bounded canonical JSON framing and
authenticated local channel records. Harbor owns the schema and generates Rust
and TypeScript types from it. Version-1 wire identity is preserved from Toolbelt.

```rust
use harbor_llm_protocol::{decode, encode, Body, ErrorCode, Failure, Message};

let observation = Message {
    schema_version: 1,
    request_id: "request-1".into(),
    body: Body::Error(Failure { code: ErrorCode::EffectUnknown }),
};
let bytes = encode(&observation)?;
assert_eq!(decode(&bytes)?, observation);
# Ok::<(), harbor_llm_protocol::ProtocolError>(())
```

`framing::{read_frame, write_frame}` handles bounded length-prefixed I/O;
`channel::AuthenticatedChannel` authenticates canonical messages with directional
HMAC keys and rejects altered/replayed/out-of-order records. The launcher owns
fresh nonces, secret delivery, executable custody, deadlines and cumulative
budgets. Authentication grants no execution admission, and local channel records
provide integrity rather than encryption.

The complete ownership, transport and adoption contract is included at
`docs/execution-transport.md` in the package and in the Harbor source repository
under `components/llm/`. JavaScript peers are published separately as part of
`harbor-llm`; integration tests use the included peer source and require Node.

This library does not launch OpenCode, mutate sessions, replay interrupted work
or implement a production worker. Qualification of those layers remains
separate from structural protocol compatibility.
