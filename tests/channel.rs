//! Rust/JavaScript authenticated channel interoperability and replay rejection.
use harbor_llm_protocol::{
    Body, ErrorCode, Failure, Message,
    channel::{AuthenticatedChannel, Role},
};
use std::process::Command;

fn message() -> Message {
    Message {
        schema_version: 1,
        request_id: "request-🧪".into(),
        body: Body::Error(Failure {
            code: ErrorCode::EffectUnknown,
        }),
    }
}
fn peer(role: Role) -> AuthenticatedChannel {
    AuthenticatedChannel::new(&[1; 32], &[2; 32], &[3; 32], role)
}

#[test]
fn mutated_reflected_truncated_and_replayed_records_are_terminal() {
    let record = peer(Role::Controller).seal(&message()).unwrap();
    for index in 0..record.len() {
        let mut changed = record.clone();
        changed[index] ^= 1;
        let mut receiver = peer(Role::Bridge);
        assert!(receiver.open(&changed).is_err());
        assert_eq!(
            receiver.seal(&message()).unwrap_err().code,
            ErrorCode::TransportFailed
        );
    }
    for end in 0..record.len() {
        assert!(peer(Role::Bridge).open(&record[..end]).is_err());
    }
    assert_eq!(
        peer(Role::Controller).open(&record).unwrap_err().code,
        ErrorCode::AuthorityDenied
    );
    let mut receiver = peer(Role::Bridge);
    assert_eq!(receiver.open(&record).unwrap(), message());
    assert_eq!(
        receiver.open(&record).unwrap_err().code,
        ErrorCode::AuthorityDenied
    );
}

#[test]
fn javascript_and_rust_exchange_exact_authenticated_records_in_both_directions() {
    let mut controller = peer(Role::Controller);
    let outgoing = controller.seal(&message()).unwrap();
    let script = r#"
      const { AuthenticatedChannel } = await import(process.argv[1]);
      const bridge = new AuthenticatedChannel({ key: Buffer.alloc(32, 1), nonce: Buffer.alloc(32, 2), binding: Buffer.alloc(32, 3), role: 'bridge' });
      const value = bridge.open(Buffer.from(process.argv[2], 'hex'));
      process.stdout.write(bridge.seal(value).toString('hex'));
      bridge.close();
    "#;
    let hex: String = outgoing.iter().map(|byte| format!("{byte:02x}")).collect();
    let module = format!(
        "file://{}/src/execution/channel.mjs",
        env!("CARGO_MANIFEST_DIR")
    );
    let output = Command::new(std::env::var("NODE_BINARY").unwrap_or_else(|_| "node".into()))
        .args(["--input-type=module", "-e", script, &module, &hex])
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let hex = std::str::from_utf8(&output.stdout).unwrap();
    let bytes: Vec<_> = hex
        .as_bytes()
        .chunks_exact(2)
        .map(|pair| u8::from_str_radix(std::str::from_utf8(pair).unwrap(), 16).unwrap())
        .collect();
    assert_eq!(controller.open(&bytes).unwrap(), message());
    assert_eq!(peer(Role::Bridge).seal(&message()).unwrap(), bytes);
}

#[test]
fn wrong_channel_or_binding_or_key_cannot_deliver_an_observation() {
    for (key, nonce, binding) in [
        ([4; 32], [2; 32], [3; 32]),
        ([1; 32], [4; 32], [3; 32]),
        ([1; 32], [2; 32], [4; 32]),
    ] {
        let record = peer(Role::Controller).seal(&message()).unwrap();
        let mut receiver = AuthenticatedChannel::new(&key, &nonce, &binding, Role::Bridge);
        assert_eq!(
            receiver.open(&record).unwrap_err().code,
            ErrorCode::AuthorityDenied
        );
    }
}
