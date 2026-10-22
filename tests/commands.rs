//! Separately versioned command and bounded transfer interoperability.
use harbor_llm_protocol::{
    Binding, ErrorCode,
    channel::Role,
    commands::{
        self, AuthenticatedChannel, TransferChunk, TransferPurpose, TransferReceiver,
        TransferReference,
    },
};
use sha2::{Digest as _, Sha256};
use std::{
    io::Write,
    process::{Command, Stdio},
    time::Duration,
};

fn binding() -> Binding {
    Binding {
        caller_authority: "controller".into(),
        caller_namespace: "fixture".into(),
        intent_id: "job".into(),
        execution_id: "execution".into(),
        execution_generation: "1".into(),
        input_digest: "a".repeat(64),
        policy_digest: "b".repeat(64),
        implementation_digest: "c".repeat(64),
    }
}
fn reference(bytes: &[u8]) -> TransferReference {
    TransferReference {
        transfer_id: "input".into(),
        bytes: bytes.len().to_string(),
        digest: format!("{:x}", Sha256::digest(bytes)),
        purpose: TransferPurpose::Input,
    }
}
fn receiver(reference: TransferReference) -> TransferReceiver {
    TransferReceiver::new(reference, 100000, Duration::from_secs(5)).unwrap()
}

#[test]
fn command_authentication_is_interoperable_and_separate_from_v1() {
    let message = commands::Command {
        schema_version: 2,
        command_schema_digest: commands::SCHEMA_DIGEST.into(),
        request_id: "request".into(),
        binding: binding(),
        body: commands::CommandBody::Reopen(commands::Target {
            handle: "original".into(),
        }),
    };
    let peer = |role| AuthenticatedChannel::new(&[1; 32], &[2; 32], &[3; 32], role);
    let mut controller = peer(Role::Controller);
    let bytes = controller.seal(&message).unwrap();
    let mut child = Command::new(std::env::var("NODE_BINARY").unwrap_or_else(|_| "node".into())).args(["--input-type=module", "-e", r#"
        import {AuthenticatedChannel} from './src/execution/commands.mjs';
        const peer = new AuthenticatedChannel({key: Buffer.alloc(32, 1), nonce: Buffer.alloc(32, 2), binding: Buffer.alloc(32, 3), role: 'bridge'});
        const chunks = []; for await (const chunk of process.stdin) chunks.push(chunk);
        process.stdout.write(peer.seal(peer.open(Buffer.concat(chunks))));
    "#]).current_dir(env!("CARGO_MANIFEST_DIR")).stdin(Stdio::piped()).stdout(Stdio::piped()).spawn().unwrap();
    child.stdin.take().unwrap().write_all(&bytes).unwrap();
    let output = child.wait_with_output().unwrap();
    assert!(output.status.success());
    assert_eq!(controller.open(&output.stdout).unwrap(), message);
    assert_eq!(
        controller.open(&output.stdout).unwrap_err().code,
        ErrorCode::AuthorityDenied
    );
    assert_eq!(
        controller.seal(&message).unwrap_err().code,
        ErrorCode::TransportFailed
    );
    assert_eq!(
        harbor_llm_protocol::channel::AuthenticatedChannel::new(
            &[1; 32],
            &[2; 32],
            &[3; 32],
            Role::Bridge
        )
        .open(&bytes)
        .unwrap_err()
        .code,
        ErrorCode::AuthorityDenied
    );
    for index in 0..bytes.len() {
        let mut altered = bytes.clone();
        altered[index] ^= 1;
        let mut receiver = peer(Role::Bridge);
        assert!(receiver.open(&altered).is_err());
        assert_eq!(
            receiver.open(&bytes).unwrap_err().code,
            ErrorCode::TransportFailed
        );
    }
}

#[test]
fn rust_and_javascript_exchange_commands_without_changing_v1_schema() {
    let message = commands::Command {
        schema_version: 2,
        command_schema_digest: commands::SCHEMA_DIGEST.into(),
        request_id: "request".into(),
        binding: binding(),
        body: commands::CommandBody::Execute(commands::Execute {
            handle: "original".into(),
            inbox_id: "msg_original".into(),
            input_digest: "d".repeat(64),
        }),
    };
    let bytes = commands::encode(&message).unwrap();
    assert_eq!(
        harbor_llm_protocol::decode(&bytes).unwrap_err().code,
        ErrorCode::IncompatibleVersion
    );
    let mut child = Command::new(std::env::var("NODE_BINARY").unwrap_or_else(|_| "node".into()))
        .args([
            "--input-type=module",
            "-e",
            r#"
        import {decode, encode} from './src/execution/commands.mjs';
        const chunks = []; for await (const chunk of process.stdin) chunks.push(chunk);
        process.stdout.write(encode(decode(Buffer.concat(chunks))));
    "#,
        ])
        .current_dir(env!("CARGO_MANIFEST_DIR"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    child.stdin.take().unwrap().write_all(&bytes).unwrap();
    let output = child.wait_with_output().unwrap();
    assert!(output.status.success());
    assert_eq!(bytes, output.stdout);
    assert_eq!(commands::decode(&output.stdout).unwrap(), message);
    assert_eq!(
        format!("{:x}", Sha256::digest(commands::SCHEMA)),
        commands::SCHEMA_DIGEST
    );
}

#[test]
fn transfers_require_exact_sequence_length_digest_and_single_consumption() {
    let bytes = vec![b'x'; 80000];
    let mut transfer = receiver(reference(&bytes));
    for offset in (0..bytes.len()).step_by(16384) {
        transfer
            .push(&TransferChunk {
                transfer_id: "input".into(),
                offset: offset.to_string(),
                data: "78".repeat((bytes.len() - offset).min(16384)),
            })
            .unwrap();
    }
    assert_eq!(transfer.finish("input").unwrap(), bytes);
    assert_eq!(
        transfer.finish("input").unwrap_err().code,
        ErrorCode::TransportFailed
    );
    for chunk in [
        TransferChunk {
            transfer_id: "other".into(),
            offset: "0".into(),
            data: "78".into(),
        },
        TransferChunk {
            transfer_id: "input".into(),
            offset: "1".into(),
            data: "78".into(),
        },
        TransferChunk {
            transfer_id: "input".into(),
            offset: "0".into(),
            data: "AA".into(),
        },
        TransferChunk {
            transfer_id: "input".into(),
            offset: "0".into(),
            data: "78".repeat(16385),
        },
        TransferChunk {
            transfer_id: "input".into(),
            offset: "0".into(),
            data: "".into(),
        },
    ] {
        let mut transfer = receiver(reference(&bytes));
        assert!(transfer.push(&chunk).is_err());
        assert_eq!(
            transfer.finish("input").unwrap_err().code,
            ErrorCode::TransportFailed
        );
    }
    assert!(receiver(reference(&bytes)).finish("input").is_err());
    let mut wrong = reference(b"x");
    wrong.digest = "a".repeat(64);
    let mut transfer = receiver(wrong);
    transfer
        .push(&TransferChunk {
            transfer_id: "input".into(),
            offset: "0".into(),
            data: "78".into(),
        })
        .unwrap();
    assert_eq!(
        transfer.finish("input").unwrap_err().code,
        ErrorCode::CustodyLost
    );
}

#[test]
fn transfers_bound_deadline_chunk_count_and_aggregate_length() {
    assert_eq!(receiver(reference(b"")).finish("input").unwrap(), b"");
    assert!(TransferReceiver::new(reference(b"x"), 1, Duration::ZERO).is_err());
    assert!(TransferReceiver::new(reference(b"x"), 1, Duration::from_secs(3601)).is_err());
    let mut overflow = receiver(reference(b"x"));
    assert_eq!(
        overflow
            .push(&TransferChunk {
                transfer_id: "input".into(),
                offset: "0".into(),
                data: "7878".into()
            })
            .unwrap_err()
            .code,
        ErrorCode::BudgetExhausted
    );
    let mut many = receiver(reference(&vec![b'x'; 5000]));
    for offset in 0..4096 {
        many.push(&TransferChunk {
            transfer_id: "input".into(),
            offset: offset.to_string(),
            data: "78".into(),
        })
        .unwrap();
    }
    assert_eq!(
        many.push(&TransferChunk {
            transfer_id: "input".into(),
            offset: "4096".into(),
            data: "78".into()
        })
        .unwrap_err()
        .code,
        ErrorCode::BudgetExhausted
    );
    let mut expired = TransferReceiver::new(reference(b"x"), 1, Duration::from_millis(1)).unwrap();
    std::thread::sleep(Duration::from_millis(10));
    assert_eq!(
        expired.finish("input").unwrap_err().code,
        ErrorCode::BudgetExhausted
    );
    assert_eq!(
        expired.finish("input").unwrap_err().code,
        ErrorCode::TransportFailed
    );
}
