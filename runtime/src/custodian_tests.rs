use super::*;
use std::{fs, os::unix::fs::PermissionsExt, thread};

struct Fixture {
    _root: tempfile::TempDir,
    config: Config,
    admission: Admission,
    id: String,
}
impl Fixture {
    fn new() -> Self {
        // Every ancestor is root- or test-UID-owned and not group/world writable.
        let root = tempfile::tempdir_in(env!("CARGO_MANIFEST_DIR")).unwrap();
        for name in [
            "admissions",
            "admissions/pending",
            "admissions/consumed",
            "state",
        ] {
            fs::create_dir(root.path().join(name)).unwrap();
            fs::set_permissions(root.path().join(name), fs::Permissions::from_mode(0o700)).unwrap();
        }
        let engine = root.path().join("engine");
        fs::write(&engine, b"never executed fixture image").unwrap();
        let binding = Binding {
            caller_authority: "controller".into(),
            caller_namespace: "fixture".into(),
            intent_id: "original".into(),
            execution_id: "ses_original".into(),
            execution_generation: "1".into(),
            input_digest: "a".repeat(64),
            policy_digest: "b".repeat(64),
            implementation_digest: "c".repeat(64),
        };
        let admission = Admission {
            version: 1,
            controller_uid: rustix::process::geteuid().as_raw(),
            binding,
            engine: engine.clone(),
            engine_digest: crate::digest(&fs::read(engine).unwrap()),
            output_bytes: 4096,
        };
        let id = admission_id(&admission.binding).unwrap();
        let config = Config {
            version: 1,
            state_directory: root.path().join("state"),
            admission_directory: root.path().join("admissions"),
            maximum_artifact_bytes: 4096,
            timeout_ms: 2000,
        };
        let fixture = Self {
            _root: root,
            config,
            admission,
            id,
        };
        fixture.pending();
        fixture
    }
    fn pending(&self) {
        let path = self
            .config
            .admission_directory
            .join("pending")
            .join(format!("{}.json", self.id));
        fs::write(&path, serde_json::to_vec(&self.admission).unwrap()).unwrap();
        fs::set_permissions(path, fs::Permissions::from_mode(0o600)).unwrap();
    }
    fn request(&self, body: Request) -> Envelope {
        Envelope {
            version: 1,
            request_id: "original-correlation".into(),
            body,
        }
    }
    fn connect(&self) -> (Wire, thread::JoinHandle<Result<(), ProtocolError>>) {
        let (client, server) = UnixStream::pair().unwrap();
        let config = self.config.clone();
        let worker =
            thread::spawn(move || serve_owned(config, server, rustix::process::geteuid().as_raw()));
        (Wire::new(client, connection_limits(2000)).unwrap(), worker)
    }
    fn call(&self, wire: &mut Wire, body: Request) -> Reply {
        wire.send(&serde_json::to_vec(&self.request(body)).unwrap())
            .unwrap();
        let reply: Response =
            serde_json::from_slice(&wire.receive(MAX_FRAME).unwrap().unwrap()).unwrap();
        assert_eq!(reply.request_id, "original-correlation");
        reply.body
    }
}

#[test]
fn preparation_consumes_admission_before_holding_an_image_and_reopen_is_observational() {
    let fixture = Fixture::new();
    let (mut wire, worker) = fixture.connect();
    assert!(matches!(
        fixture.call(&mut wire, Request::Describe),
        Reply::Capabilities {
            prepare: true,
            launch: false
        }
    ));
    let registration = match fixture.call(
        &mut wire,
        Request::Prepare {
            admission: fixture.id.clone(),
        },
    ) {
        Reply::Prepared {
            registration,
            artifact_digest,
            artifact_bytes,
        } => {
            assert_eq!(artifact_digest, fixture.admission.engine_digest);
            assert_eq!(artifact_bytes, 28);
            registration
        }
        _ => panic!("expected held preparation"),
    };
    assert!(
        !fixture
            .config
            .admission_directory
            .join("pending")
            .join(format!("{}.json", fixture.id))
            .exists()
    );
    assert!(
        Controller::reopen(
            &fixture.config.state_directory,
            &registration,
            &fixture.admission.binding
        )
        .is_err(),
        "custodian holds the original controller lock"
    );
    assert!(matches!(
        fixture.call(
            &mut wire,
            Request::Launch {
                admission: fixture.id.clone()
            }
        ),
        Reply::Error {
            code: ErrorCode::UnsupportedCapability
        }
    ));
    drop(wire);
    worker.join().unwrap().unwrap();
    let (mut wire, worker) = fixture.connect();
    assert!(
        matches!(fixture.call(&mut wire, Request::Reopen { admission: fixture.id.clone() }), Reply::Reopened { registration: observed } if observed == registration)
    );
    drop(wire);
    worker.join().unwrap().unwrap();
    let reopened = Controller::reopen(
        &fixture.config.state_directory,
        &registration,
        &fixture.admission.binding,
    )
    .unwrap();
    assert_eq!(
        reopened.state(crate::Operation::Start),
        None,
        "artifact preparation is not a backend start"
    );
}

#[test]
fn lost_reply_or_lost_runtime_state_never_reissues_a_consumed_intent() {
    let mut fixture = Fixture::new();
    let (mut wire, worker) = fixture.connect();
    wire.send(
        &serde_json::to_vec(&fixture.request(Request::Prepare {
            admission: fixture.id.clone(),
        }))
        .unwrap(),
    )
    .unwrap();
    // Wait for the response without decoding or accepting it, then lose custody.
    wire.receive(MAX_FRAME).unwrap().unwrap();
    drop(wire);
    worker.join().unwrap().unwrap();
    fs::remove_dir_all(&fixture.config.state_directory).unwrap();
    fs::create_dir(&fixture.config.state_directory).unwrap();
    fs::set_permissions(
        &fixture.config.state_directory,
        fs::Permissions::from_mode(0o700),
    )
    .unwrap();
    fixture.admission.binding.execution_generation = "2".into();
    fixture.pending();
    let (mut wire, worker) = fixture.connect();
    assert!(matches!(
        fixture.call(
            &mut wire,
            Request::Prepare {
                admission: fixture.id.clone()
            }
        ),
        Reply::Error {
            code: ErrorCode::EffectUnknown
        }
    ));
    drop(wire);
    worker.join().unwrap().unwrap();
    let (mut wire, worker) = fixture.connect();
    assert!(matches!(
        fixture.call(
            &mut wire,
            Request::Reopen {
                admission: fixture.id.clone()
            }
        ),
        Reply::Error {
            code: ErrorCode::CustodyLost
        }
    ));
    drop(wire);
    worker.join().unwrap().unwrap();
    assert_eq!(
        fs::read_dir(&fixture.config.state_directory)
            .unwrap()
            .count(),
        0
    );
}

#[test]
fn peer_and_admission_changes_reject_before_consumption_and_artifact_failure_stays_consumed() {
    for fault in ["peer", "digest", "mode", "identity"] {
        let mut fixture = Fixture::new();
        match fault {
            "peer" => fixture.admission.controller_uid += 1,
            "digest" => fixture.admission.engine_digest = "d".repeat(64),
            "identity" => fixture.admission.binding.intent_id = "different".into(),
            _ => (),
        }
        fixture.pending();
        if fault == "mode" {
            fs::set_permissions(
                fixture
                    .config
                    .admission_directory
                    .join("pending")
                    .join(format!("{}.json", fixture.id)),
                fs::Permissions::from_mode(0o666),
            )
            .unwrap();
        }
        let (mut wire, worker) = fixture.connect();
        let reply = fixture.call(
            &mut wire,
            Request::Prepare {
                admission: fixture.id.clone(),
            },
        );
        assert!(matches!(reply, Reply::Error { .. }));
        drop(wire);
        worker.join().unwrap().unwrap();
        assert_eq!(
            fixture
                .config
                .admission_directory
                .join("pending")
                .join(format!("{}.json", fixture.id))
                .exists(),
            fault != "digest"
        );
        if fault == "digest" {
            let (mut wire, worker) = fixture.connect();
            assert!(matches!(
                fixture.call(
                    &mut wire,
                    Request::Prepare {
                        admission: fixture.id.clone()
                    }
                ),
                Reply::Error {
                    code: ErrorCode::EffectUnknown
                }
            ));
            drop(wire);
            worker.join().unwrap().unwrap();
        }
    }
}

#[test]
fn unsupported_malformed_and_partial_control_requests_never_consume_admission() {
    let fixture = Fixture::new();
    for body in [
        Request::Launch {
            admission: fixture.id.clone(),
        },
        Request::Reopen {
            admission: fixture.id.clone(),
        },
    ] {
        let (mut wire, worker) = fixture.connect();
        assert!(matches!(fixture.call(&mut wire, body), Reply::Error { .. }));
        drop(wire);
        worker.join().unwrap().unwrap();
    }
    let (mut wire, worker) = fixture.connect();
    wire.send(br#"{"version":1,"version":1,"requestId":"original-correlation","body":{"kind":"prepare","admission":"x"}}"#).unwrap();
    assert!(wire.receive(MAX_FRAME).unwrap().is_none());
    drop(wire);
    assert!(worker.join().unwrap().is_err());
    assert!(
        fixture
            .config
            .admission_directory
            .join("pending")
            .join(format!("{}.json", fixture.id))
            .exists()
    );
    assert_eq!(
        fs::read_dir(&fixture.config.state_directory)
            .unwrap()
            .count(),
        0
    );
}

#[test]
fn untrusted_roots_and_nonroot_production_entry_are_rejected() {
    let fixture = Fixture::new();
    let directory = fixture.config.admission_directory.join("pending");
    fs::set_permissions(&directory, fs::Permissions::from_mode(0o777)).unwrap();
    let (mut wire, worker) = fixture.connect();
    assert!(wire.receive(MAX_FRAME).unwrap().is_none());
    assert!(worker.join().unwrap().is_err());
    if !rustix::process::geteuid().is_root() {
        let (stream, _) = UnixStream::pair().unwrap();
        assert!(
            matches!(serve(Path::new("/absent/config"), stream), Err(error) if error.code == ErrorCode::AuthorityDenied)
        );
    }
}

#[test]
fn store_shaped_configuration_keeps_sticky_parent_protection_and_readonly_hardlinks() {
    let fixture = Fixture::new();
    let store = fixture._root.path().join("store");
    fs::create_dir(&store).unwrap();
    fs::set_permissions(&store, fs::Permissions::from_mode(0o1777)).unwrap();
    let configuration = store.join("configuration");
    fs::write(&configuration, b"{}").unwrap();
    fs::set_permissions(&configuration, fs::Permissions::from_mode(0o444)).unwrap();
    fs::hard_link(&configuration, store.join("deduplicated-link")).unwrap();
    let owner = rustix::process::geteuid().as_raw();
    let directory = safe_directory(&store, owner, false).unwrap();
    assert_eq!(
        read_owned(&directory, "configuration".as_ref(), owner, false)
            .unwrap()
            .0,
        b"{}"
    );
    assert!(
        read_owned(&directory, "configuration".as_ref(), owner, true).is_err(),
        "admission records cannot use configuration hardlink tolerance"
    );
    assert!(
        safe_directory(&store, owner, true).is_err(),
        "ledger/state leaves must remain private"
    );
    fs::set_permissions(&store, fs::Permissions::from_mode(0o777)).unwrap();
    assert!(
        safe_directory(&store, owner, false).is_err(),
        "world-write without sticky ownership protection is untrusted"
    );
}

#[test]
fn concurrent_preparations_have_one_consumed_admission_and_one_original_controller() {
    let fixture = Fixture::new();
    let (mut first, first_worker) = fixture.connect();
    let (mut second, second_worker) = fixture.connect();
    let request = serde_json::to_vec(&fixture.request(Request::Prepare {
        admission: fixture.id.clone(),
    }))
    .unwrap();
    first.send(&request).unwrap();
    second.send(&request).unwrap();
    let first_reply: Response = parse(&first.receive(MAX_FRAME).unwrap().unwrap()).unwrap();
    let second_reply: Response = parse(&second.receive(MAX_FRAME).unwrap().unwrap()).unwrap();
    let replies = [first_reply.body, second_reply.body];
    assert_eq!(
        replies
            .iter()
            .filter(|reply| matches!(reply, Reply::Prepared { .. }))
            .count(),
        1
    );
    assert_eq!(
        replies
            .iter()
            .filter(|reply| matches!(reply, Reply::Error { .. }))
            .count(),
        1
    );
    assert_eq!(
        fs::read_dir(&fixture.config.state_directory)
            .unwrap()
            .count(),
        1
    );
    drop(first);
    drop(second);
    first_worker.join().unwrap().unwrap();
    second_worker.join().unwrap().unwrap();
}

#[test]
fn linked_admissions_and_oversized_deep_or_partial_frames_cannot_prepare() {
    for fault in ["symlink", "hardlink"] {
        let fixture = Fixture::new();
        let pending = fixture
            .config
            .admission_directory
            .join("pending")
            .join(format!("{}.json", fixture.id));
        let other = fixture._root.path().join("unrelated");
        fs::rename(&pending, &other).unwrap();
        if fault == "symlink" {
            std::os::unix::fs::symlink(&other, &pending).unwrap();
        } else {
            fs::hard_link(&other, &pending).unwrap();
        }
        let before = fs::read(&other).unwrap();
        let (mut wire, worker) = fixture.connect();
        assert!(matches!(
            fixture.call(
                &mut wire,
                Request::Prepare {
                    admission: fixture.id.clone()
                }
            ),
            Reply::Error {
                code: ErrorCode::CustodyLost
            }
        ));
        drop(wire);
        worker.join().unwrap().unwrap();
        assert_eq!(fs::read(other).unwrap(), before);
        assert_eq!(
            fs::read_dir(&fixture.config.state_directory)
                .unwrap()
                .count(),
            0
        );
    }
    let fixture = Fixture::new();
    let cases = [vec![b' '; MAX_FRAME + 1], format!("{}0{}", "[".repeat(65), "]".repeat(65)).into_bytes(),
        br#"{"version":1,"requestId":"original-correlation","body":{"kind":"prepare","admission":"../escape"}}"#.to_vec()];
    for (index, bytes) in cases.into_iter().enumerate() {
        let (mut wire, worker) = fixture.connect();
        wire.send(&bytes).unwrap();
        // A structurally valid but invalid admission ID gets a redacted error;
        // an invalid frame terminates without any response.
        match wire.receive(MAX_FRAME) {
            Ok(Some(reply)) if index == 2 => assert!(matches!(
                parse::<Response>(&reply).unwrap().body,
                Reply::Error {
                    code: ErrorCode::InvalidFrame
                }
            )),
            Ok(None)
            | Err(ProtocolError {
                code: ErrorCode::TransportFailed,
            }) if index != 2 => (),
            reply => panic!("unexpected control result: {reply:?}"),
        }
        drop(wire);
        assert_eq!(worker.join().unwrap().is_err(), index != 2);
    }
    let (mut socket, server) = UnixStream::pair().unwrap();
    let config = fixture.config.clone();
    let worker =
        thread::spawn(move || serve_owned(config, server, rustix::process::geteuid().as_raw()));
    socket.write_all(&[0, 0]).unwrap();
    socket.shutdown(std::net::Shutdown::Write).unwrap();
    assert_eq!(socket.read(&mut [0; 4]).unwrap(), 0);
    assert!(worker.join().unwrap().is_err());
    assert!(
        fixture
            .config
            .admission_directory
            .join("pending")
            .join(format!("{}.json", fixture.id))
            .exists()
    );
    assert_eq!(
        fs::read_dir(&fixture.config.state_directory)
            .unwrap()
            .count(),
        0
    );
}

#[test]
fn abrupt_custodian_exit_preserves_consumption_and_does_not_restore_freshness() {
    use std::{
        os::fd::OwnedFd,
        process::{Command, Stdio},
    };
    let fixture = Fixture::new();
    let configuration = fixture._root.path().join("child-config.json");
    fs::write(&configuration, serde_json::to_vec(&fixture.config).unwrap()).unwrap();
    let (socket, server) = UnixStream::pair().unwrap();
    let owned: OwnedFd = server.into();
    let child = Command::new(std::env::current_exe().unwrap())
        .args(["--exact", "custodian::tests::custodian_process_fixture"])
        .env("HARBOR_LLM_CUSTODIAN_TEST_CONFIG", configuration)
        .stdin(Stdio::from(owned))
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    struct ChildGuard(std::process::Child);
    impl Drop for ChildGuard {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }
    // The child is a disposable copy of this test executable, not a root service.
    let mut child = ChildGuard(child);
    let mut wire = Wire::new(socket, connection_limits(2000)).unwrap();
    let registration = match fixture.call(
        &mut wire,
        Request::Prepare {
            admission: fixture.id.clone(),
        },
    ) {
        Reply::Prepared { registration, .. } => registration,
        _ => panic!("expected preparation"),
    };
    child.0.kill().unwrap();
    child.0.wait().unwrap();
    drop(wire);
    assert!(
        !fixture
            .config
            .admission_directory
            .join("pending")
            .join(format!("{}.json", fixture.id))
            .exists()
    );
    let (mut wire, worker) = fixture.connect();
    assert!(
        matches!(fixture.call(&mut wire, Request::Reopen { admission: fixture.id.clone() }), Reply::Reopened { registration: observed } if observed == registration)
    );
    drop(wire);
    worker.join().unwrap().unwrap();
    fixture.pending();
    let (mut wire, worker) = fixture.connect();
    assert!(matches!(
        fixture.call(
            &mut wire,
            Request::Prepare {
                admission: fixture.id.clone()
            }
        ),
        Reply::Error {
            code: ErrorCode::EffectUnknown
        }
    ));
    drop(wire);
    worker.join().unwrap().unwrap();
}

#[test]
fn custodian_process_fixture() {
    let Some(configuration) = std::env::var_os("HARBOR_LLM_CUSTODIAN_TEST_CONFIG") else {
        return;
    };
    use std::os::fd::AsFd;
    let stream = UnixStream::from(std::io::stdin().as_fd().try_clone_to_owned().unwrap());
    serve_owned(
        parse(&fs::read(configuration).unwrap()).unwrap(),
        stream,
        rustix::process::geteuid().as_raw(),
    )
    .unwrap();
}
