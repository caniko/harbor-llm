//! Real private sockets exercise whole-channel bounds and terminal no-retry I/O.
use harbor_llm_protocol::{
    Binding, ErrorCode, OutputReceipt,
    channel::Role,
    commands::{self, AuthenticatedChannel, Command, CommandBody},
};
use harbor_llm_runtime::ipc::{Exchange, Limits};
use sha2::{Digest, Sha256};
use std::{
    io::{Read, Write},
    os::unix::net::UnixStream,
    thread,
    time::{Duration, Instant},
};

fn binding() -> Binding {
    Binding {
        caller_authority: "controller".into(),
        caller_namespace: "fixture".into(),
        intent_id: "original".into(),
        execution_id: "ses_fixture".into(),
        execution_generation: "1".into(),
        input_digest: "a".repeat(64),
        policy_digest: "b".repeat(64),
        implementation_digest: "c".repeat(64),
    }
}
fn command(body: CommandBody) -> Command {
    Command {
        schema_version: 2,
        command_schema_digest: commands::SCHEMA_DIGEST.into(),
        request_id: "original-request".into(),
        binding: binding(),
        body,
    }
}
fn execute() -> Command {
    command(CommandBody::Execute(commands::Execute {
        handle: "ses_fixture".into(),
        inbox_id: "inb_original".into(),
        input_digest: "d".repeat(64),
    }))
}
fn limits() -> Limits {
    Limits {
        timeout: Duration::from_secs(1),
        records: 16,
        bytes: 65536,
    }
}
fn peer(role: Role) -> AuthenticatedChannel {
    AuthenticatedChannel::new(&[1; 32], &[2; 32], &[3; 32], role)
}
fn exchange(stream: UnixStream, limits: Limits) -> Exchange {
    Exchange::new(stream, peer(Role::Controller), binding(), limits).unwrap()
}
fn read(stream: &mut UnixStream, channel: &mut AuthenticatedChannel) -> Command {
    stream
        .set_read_timeout(Some(Duration::from_secs(2)))
        .unwrap();
    let mut header = [0; 4];
    stream.read_exact(&mut header).unwrap();
    let length = u32::from_be_bytes(header) as usize;
    assert!(length <= 65580);
    let mut bytes = vec![0; length];
    stream.read_exact(&mut bytes).unwrap();
    channel.open(&bytes).unwrap()
}
fn write(stream: &mut UnixStream, channel: &mut AuthenticatedChannel, command: &Command) {
    let bytes = channel.seal(command).unwrap();
    stream
        .write_all(&(bytes.len() as u32).to_be_bytes())
        .unwrap();
    stream.write_all(&bytes).unwrap();
}
fn receipt(request: Command) -> Command {
    Command {
        body: CommandBody::Receipt(commands::EffectReceipt {
            operation: commands::Effect::Execute,
            state: commands::EffectState::Observed,
            receipt_digest: "e".repeat(64),
        }),
        ..request
    }
}

#[test]
fn owned_exchange_sends_transfers_then_correlates_one_authenticated_reply() {
    let (socket, mut remote) = UnixStream::pair().unwrap();
    let worker = thread::spawn(move || {
        let mut channel = peer(Role::Bridge);
        assert!(matches!(
            read(&mut remote, &mut channel).body,
            CommandBody::TransferEnd(_)
        ));
        let request = read(&mut remote, &mut channel);
        assert_eq!(request, execute());
        write(&mut remote, &mut channel, &receipt(request));
    });
    let mut exchange = exchange(socket, limits());
    exchange
        .send_transfer(&command(CommandBody::TransferEnd(commands::TransferEnd {
            transfer_id: "input".into(),
        })))
        .unwrap();
    assert_eq!(exchange.request(&execute()).unwrap(), receipt(execute()));
    exchange.close();
    assert_eq!(
        exchange.request(&execute()).unwrap_err().code,
        ErrorCode::TransportFailed
    );
    worker.join().unwrap();
}

#[test]
fn lost_partial_and_mismatched_replies_permanently_close_the_original_socket() {
    for fault in ["lost", "partial", "request", "binding", "oversized"] {
        let (socket, mut remote) = UnixStream::pair().unwrap();
        let worker = thread::spawn(move || {
            let mut channel = peer(Role::Bridge);
            let request = read(&mut remote, &mut channel);
            match fault {
                "lost" => (),
                "partial" => remote.write_all(&[0, 0]).unwrap(),
                "oversized" => remote.write_all(&65581u32.to_be_bytes()).unwrap(),
                _ => {
                    let mut response = receipt(request);
                    if fault == "request" {
                        response.request_id = "replacement".into();
                    } else {
                        response.binding.execution_generation = "2".into();
                    }
                    write(&mut remote, &mut channel, &response);
                }
            }
        });
        let mut exchange = exchange(socket, limits());
        assert!(exchange.request(&execute()).is_err());
        assert_eq!(
            exchange.request(&execute()).unwrap_err().code,
            ErrorCode::TransportFailed
        );
        worker.join().unwrap();
    }
}

#[test]
fn observations_require_exact_transfer_receipt_and_correlation_before_returning_bytes() {
    for fault in [
        "none",
        "purpose",
        "request",
        "binding",
        "receipt-binding",
        "digest",
        "length",
        "budget",
    ] {
        let (socket, mut remote) = UnixStream::pair().unwrap();
        let worker = thread::spawn(move || {
            let mut channel = peer(Role::Bridge);
            let mut request = read(&mut remote, &mut channel);
            if fault == "request" {
                request.request_id = "other-request".into();
            }
            if fault == "binding" {
                request.binding.intent_id = "other-intent".into();
            }
            let bytes = b"original observation";
            let reference = commands::TransferReference {
                transfer_id: "observation".into(),
                purpose: if fault == "purpose" {
                    commands::TransferPurpose::Input
                } else {
                    commands::TransferPurpose::Observation
                },
                digest: format!("{:x}", Sha256::digest(bytes)),
                bytes: bytes.len().to_string(),
            };
            write(
                &mut remote,
                &mut channel,
                &Command {
                    body: CommandBody::TransferBegin(commands::TransferBegin {
                        reference: reference.clone(),
                    }),
                    ..request.clone()
                },
            );
            if ["purpose", "request", "binding", "budget"].contains(&fault) {
                return;
            }
            write(
                &mut remote,
                &mut channel,
                &Command {
                    body: CommandBody::TransferChunk(commands::TransferChunk {
                        transfer_id: reference.transfer_id.clone(),
                        offset: "0".into(),
                        data: bytes.iter().map(|byte| format!("{byte:02x}")).collect(),
                    }),
                    ..request.clone()
                },
            );
            write(
                &mut remote,
                &mut channel,
                &Command {
                    body: CommandBody::TransferEnd(commands::TransferEnd {
                        transfer_id: reference.transfer_id,
                    }),
                    ..request.clone()
                },
            );
            let mut receipt = OutputReceipt {
                binding: binding(),
                output_digest: reference.digest,
                output_bytes: reference.bytes,
            };
            if fault == "receipt-binding" {
                receipt.binding.intent_id = "other-intent".into();
            }
            if fault == "digest" {
                receipt.output_digest = "e".repeat(64);
            }
            if fault == "length" {
                receipt.output_bytes = "1".into();
            }
            write(
                &mut remote,
                &mut channel,
                &Command {
                    body: CommandBody::OutputReceipt(receipt),
                    ..request
                },
            );
        });
        let mut exchange = exchange(socket, limits());
        let request = command(CommandBody::Reconcile(commands::Target {
            handle: binding().execution_id,
        }));
        let observed = exchange.reconcile(&request, if fault == "budget" { 1 } else { 1024 });
        if fault == "none" {
            assert_eq!(observed.unwrap(), b"original observation");
        } else {
            assert!(observed.is_err(), "{fault}");
            assert_eq!(
                exchange.reconcile(&request, 1024).unwrap_err().code,
                ErrorCode::TransportFailed
            );
        }
        worker.join().unwrap();
    }
}

#[test]
fn byte_and_record_budgets_are_cumulative_and_reject_before_the_next_write() {
    let transfer = command(CommandBody::TransferEnd(commands::TransferEnd {
        transfer_id: "input".into(),
    }));
    let size = peer(Role::Controller).seal(&transfer).unwrap().len() as u64 + 4;
    for budget in [
        Limits {
            records: 1,
            ..limits()
        },
        Limits {
            bytes: size,
            ..limits()
        },
    ] {
        let (socket, mut remote) = UnixStream::pair().unwrap();
        let worker = thread::spawn(move || {
            read(&mut remote, &mut peer(Role::Bridge));
            let mut byte = [0];
            assert_eq!(
                remote.read(&mut byte).unwrap(),
                0,
                "second write must not reach the peer"
            );
        });
        let mut exchange = exchange(socket, budget);
        exchange.send_transfer(&transfer).unwrap();
        assert_eq!(
            exchange.send_transfer(&transfer).unwrap_err().code,
            ErrorCode::BudgetExhausted
        );
        assert_eq!(
            exchange.request(&execute()).unwrap_err().code,
            ErrorCode::TransportFailed
        );
        worker.join().unwrap();
    }
}

#[test]
fn a_slow_drip_cannot_refresh_the_whole_channel_deadline() {
    let (socket, mut remote) = UnixStream::pair().unwrap();
    let worker = thread::spawn(move || {
        read(&mut remote, &mut peer(Role::Bridge));
        for byte in [0, 0, 2, 0] {
            if remote.write_all(&[byte]).is_err() {
                break;
            }
            thread::sleep(Duration::from_millis(30));
        }
    });
    let mut exchange = exchange(
        socket,
        Limits {
            timeout: Duration::from_millis(70),
            ..limits()
        },
    );
    let started = Instant::now();
    assert_eq!(
        exchange.request(&execute()).unwrap_err().code,
        ErrorCode::BudgetExhausted
    );
    assert!(started.elapsed() < Duration::from_millis(300));
    assert_eq!(
        exchange.request(&execute()).unwrap_err().code,
        ErrorCode::TransportFailed
    );
    worker.join().unwrap();
}

#[test]
fn a_peer_that_does_not_read_cannot_block_writes_past_the_deadline() {
    let (socket, remote) = UnixStream::pair().unwrap();
    let (release, wait) = std::sync::mpsc::channel::<()>();
    let worker = thread::spawn(move || {
        let _ = wait.recv_timeout(Duration::from_secs(2));
        drop(remote);
    });
    let mut exchange = exchange(
        socket,
        Limits {
            timeout: Duration::from_millis(70),
            records: 64,
            bytes: 4 * 1024 * 1024,
        },
    );
    let chunk = command(CommandBody::TransferChunk(commands::TransferChunk {
        transfer_id: "input".into(),
        offset: "0".into(),
        data: "aa".repeat(16384),
    }));
    let started = Instant::now();
    let error = (0..64)
        .find_map(|_| exchange.send_transfer(&chunk).err())
        .expect("stalled socket must exhaust its deadline");
    assert_eq!(error.code, ErrorCode::BudgetExhausted);
    assert!(started.elapsed() < Duration::from_secs(1));
    drop(release);
    worker.join().unwrap();
}

#[test]
fn changed_bindings_and_wrong_operation_classes_close_without_socket_writes() {
    for transfer_method in [false, true] {
        let (socket, mut remote) = UnixStream::pair().unwrap();
        let mut exchange = exchange(socket, limits());
        let mut changed = execute();
        if !transfer_method {
            changed.binding.intent_id = "other".into();
        }
        let error = if transfer_method {
            exchange.send_transfer(&changed).unwrap_err()
        } else {
            exchange.request(&changed).unwrap_err()
        };
        assert_eq!(
            error.code,
            if transfer_method {
                ErrorCode::UnsupportedCapability
            } else {
                ErrorCode::AuthorityDenied
            }
        );
        let mut byte = [0];
        assert_eq!(remote.read(&mut byte).unwrap(), 0);
    }
    for budget in [
        Limits {
            timeout: Duration::ZERO,
            ..limits()
        },
        Limits {
            timeout: Duration::from_secs(3601),
            ..limits()
        },
        Limits {
            records: 0,
            ..limits()
        },
        Limits {
            records: 8203,
            ..limits()
        },
        Limits {
            bytes: 0,
            ..limits()
        },
        Limits {
            bytes: u64::MAX,
            ..limits()
        },
    ] {
        let (socket, _) = UnixStream::pair().unwrap();
        assert!(Exchange::new(socket, peer(Role::Controller), binding(), budget).is_err());
    }
}
