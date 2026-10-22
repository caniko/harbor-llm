//! Explicit local conformance: Rust journal -> private authenticated IPC -> actual
//! JavaScript dispatcher/generated client -> synthetic HTTP observer. No provider.
use harbor_llm_protocol::{
    Binding, ErrorCode, ProtocolError,
    channel::Role,
    commands::{
        self, AuthenticatedChannel, Command, CommandBody, TransferPurpose, TransferReference,
    },
};
use harbor_llm_runtime::{
    Controller, Operation, State,
    ipc::{Exchange, Limits},
};
use sha2::{Digest as _, Sha256};
use std::{
    fs,
    io::Write,
    os::{
        fd::OwnedFd,
        unix::{fs::PermissionsExt, net::UnixStream},
    },
    process::{Child, Command as Process, Stdio},
    time::Duration,
};

struct Peer(Child);
impl Drop for Peer {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}
fn io_error(_: std::io::Error) -> ProtocolError {
    ProtocolError {
        code: ErrorCode::TransportFailed,
    }
}
fn write_frame(stream: &mut UnixStream, bytes: &[u8]) -> Result<(), ProtocolError> {
    assert!(bytes.len() <= 65580);
    stream
        .write_all(&(bytes.len() as u32).to_be_bytes())
        .map_err(io_error)?;
    stream.write_all(bytes).map_err(io_error)
}
fn command(binding: &Binding, body: CommandBody) -> Command {
    Command {
        schema_version: 2,
        command_schema_digest: commands::SCHEMA_DIGEST.into(),
        request_id: "fixture-correlation".into(),
        binding: binding.clone(),
        body,
    }
}
fn transfer(
    exchange: &mut Exchange,
    binding: &Binding,
    purpose: TransferPurpose,
    bytes: &[u8],
) -> TransferReference {
    let reference = TransferReference {
        transfer_id: if purpose == TransferPurpose::Configuration {
            "configuration"
        } else {
            "input"
        }
        .into(),
        purpose,
        bytes: bytes.len().to_string(),
        digest: format!("{:x}", Sha256::digest(bytes)),
    };
    let hex = bytes.iter().map(|byte| format!("{byte:02x}")).collect();
    for body in [
        CommandBody::TransferBegin(commands::TransferBegin {
            reference: reference.clone(),
        }),
        CommandBody::TransferChunk(commands::TransferChunk {
            transfer_id: reference.transfer_id.clone(),
            offset: "0".into(),
            data: hex,
        }),
        CommandBody::TransferEnd(commands::TransferEnd {
            transfer_id: reference.transfer_id.clone(),
        }),
    ] {
        exchange.send_transfer(&command(binding, body)).unwrap();
    }
    reference
}
fn main() {
    let module = std::env::args()
        .nth(1)
        .expect("usage: initial_dispatch ABSOLUTE_DISPATCHER_MODULE");
    assert!(std::path::Path::new(&module).is_absolute());
    for fault in ["none", "lost-http", "lost-ipc", "bridge-exit"] {
        let root = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
        fs::set_permissions(root.path(), fs::Permissions::from_mode(0o700)).unwrap();
        let binding = Binding {
            caller_authority: "conformance-controller".into(),
            caller_namespace: "synthetic".into(),
            intent_id: "original".into(),
            execution_id: "ses_fixture".into(),
            execution_generation: "1".into(),
            input_digest: "a".repeat(64),
            policy_digest: "b".repeat(64),
            implementation_digest: "c".repeat(64),
        };
        let mut controller = Controller::register(root.path(), &binding, 4096).unwrap();
        let registration = controller.registration().clone();
        let journal = controller.entry().join("journal.json");
        let (mut stream, child_stream) = UnixStream::pair().unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(3)))
            .unwrap();
        stream
            .set_write_timeout(Some(Duration::from_secs(3)))
            .unwrap();
        let _peer = Peer(
            Process::new(std::env::var("NODE_BINARY").unwrap_or_else(|_| "node".into()))
                .args([
                    "--input-type=module",
                    "-e",
                    include_str!("initial_dispatch_peer.mjs"),
                    &module,
                    journal.to_str().unwrap(),
                    fault,
                ])
                .stdin(Stdio::from(OwnedFd::from(
                    child_stream.try_clone().unwrap(),
                )))
                .stdout(Stdio::from(OwnedFd::from(child_stream)))
                .spawn()
                .unwrap(),
        );
        let mut key = [0; 32];
        let mut nonce = [0; 32];
        getrandom::fill(&mut key).unwrap();
        getrandom::fill(&mut nonce).unwrap();
        let binding_digest: [u8; 32] = Sha256::digest(serde_json::to_vec(&binding).unwrap()).into();
        write_frame(&mut stream, &serde_json::to_vec(&serde_json::json!({ "binding": binding, "key": key, "nonce": nonce, "digest": binding_digest })).unwrap()).unwrap();
        let channel = AuthenticatedChannel::new(&key, &nonce, &binding_digest, Role::Controller);
        let mut exchange = Exchange::new(
            stream,
            channel,
            binding.clone(),
            Limits {
                timeout: Duration::from_secs(3),
                records: 64,
                bytes: 1024 * 1024,
            },
        )
        .unwrap();
        let config = transfer(
            &mut exchange,
            &binding,
            TransferPurpose::Configuration,
            br#"{"model":{"providerID":"synthetic","id":"fixture"},"permissions":[]}"#,
        );
        controller
            .dispatch_initial(
                &command(
                    &binding,
                    CommandBody::Create(commands::Create {
                        configuration: config,
                    }),
                ),
                |request| exchange.request(request),
            )
            .unwrap();
        let input = transfer(
            &mut exchange,
            &binding,
            TransferPurpose::Input,
            br#"{"text":"exact original input"}"#,
        );
        controller
            .dispatch_initial(
                &command(
                    &binding,
                    CommandBody::Submit(commands::Submit {
                        handle: binding.execution_id.clone(),
                        inbox_id: "msg_original".into(),
                        input: input.clone(),
                    }),
                ),
                |request| exchange.request(request),
            )
            .unwrap();
        let release = command(
            &binding,
            CommandBody::Execute(commands::Execute {
                handle: binding.execution_id.clone(),
                inbox_id: "msg_original".into(),
                input_digest: input.digest,
            }),
        );
        let result = controller.dispatch_initial(&release, |request| exchange.request(request));
        if fault == "none" {
            result.unwrap();
        } else {
            assert_eq!(result.unwrap_err().code, ErrorCode::EffectUnknown);
        }
        assert_eq!(
            controller.state(Operation::Execute),
            Some(if fault == "none" {
                State::Observed
            } else {
                State::Unknown
            })
        );
        assert_eq!(
            controller
                .dispatch_initial(&release, |_| panic!("no redispatch"))
                .unwrap_err()
                .code,
            ErrorCode::EffectUnknown
        );
        exchange.close();
        let effects = fs::read_to_string(journal.with_extension("requests")).unwrap();
        assert_eq!(
            effects,
            if fault == "bridge-exit" {
                "start\nsubmit\n"
            } else {
                "start\nsubmit\nexecute\n"
            }
        );
        drop(controller);
        let mut reopened = Controller::reopen(root.path(), &registration, &binding).unwrap();
        assert_eq!(
            reopened
                .dispatch_initial(&release, |_| panic!("reopen is observational"))
                .unwrap_err()
                .code,
            ErrorCode::EffectUnknown
        );
        println!("initial dispatch {fault}: passed; replay count 0");
    }
}
