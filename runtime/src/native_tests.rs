//! Explicit native gate: missing selected artifacts fail, never skip. The root
//! admission store is a same-UID fixture; these results are not root-service or
//! specialist-worker qualification and every attempt is retained as unaccepted.
use super::*;
use crate::{
    Operation, State,
    standalone::{Plan, Resources, Session, Tools},
};
use serde_json::{Value, json};
use std::{
    fs,
    os::{fd::OwnedFd, unix::fs::PermissionsExt},
    process::{Child, Command, Stdio},
    sync::{Arc, Mutex},
    thread,
};

struct Observer {
    wire: Wire,
    child: Child,
}
impl Observer {
    fn try_call(&mut self, request: Value) -> Result<Value> {
        self.wire.send(&serde_json::to_vec(&request).unwrap())?;
        serde_json::from_slice(&self.wire.receive(16384)?.ok_or_else(lost)?).map_err(|_| lost())
    }
    fn call(&mut self, request: Value) -> Value {
        self.try_call(request).unwrap()
    }
}
impl Drop for Observer {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}
fn selected(name: &str) -> PathBuf {
    let path = PathBuf::from(
        std::env::var_os(name).unwrap_or_else(|| panic!("{name} must select an exact artifact")),
    );
    assert!(path.is_absolute());
    assert_eq!(path.canonicalize().unwrap(), path);
    path
}
fn wait(mut check: impl FnMut() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(15);
    while !check() {
        assert!(Instant::now() < deadline, "native condition timed out");
        thread::sleep(Duration::from_millis(25));
    }
}
fn revoker(observer: &Arc<Mutex<Observer>>) -> Box<dyn FnMut() -> bool> {
    let observer = Arc::clone(observer);
    Box::new(move || {
        observer.lock().ok().is_some_and(|mut observer| {
            observer
                .try_call(json!({"kind":"revoke"}))
                .ok()
                .is_some_and(|reply| reply["revoked"] == true)
        })
    })
}
fn claim(observer: &Arc<Mutex<Observer>>, path: &Path, binding: &Binding) -> Value {
    let path = path
        .to_str()
        .unwrap()
        .replace("/proc/self/", &format!("/proc/{}/", std::process::id()));
    observer.lock().unwrap().call(
        json!({"kind":"claim","path":format!("{path}/engine.db"),"session":binding.execution_id}),
    )
}
fn status(observer: &Arc<Mutex<Observer>>) -> Value {
    observer.lock().unwrap().call(json!({"kind":"status"}))
}
fn save_database(source: &Path, destination: &Path) {
    fs::create_dir(destination).unwrap();
    for name in ["engine.db", "engine.db-wal", "engine.db-shm"] {
        let source = source.join(name);
        if !source.exists() {
            continue;
        }
        let metadata = fs::symlink_metadata(&source).unwrap();
        assert!(metadata.is_file() && metadata.len() <= 16 * 1024 * 1024);
        fs::copy(source, destination.join(name)).unwrap();
        fs::set_permissions(destination.join(name), fs::Permissions::from_mode(0o600)).unwrap();
    }
}

#[test]
fn custodian_through_exact_engine_execution_interruption_recovery_and_cleanup() {
    let engine = selected("HARBOR_OPENCODE_BINARY");
    let engine_digest = std::env::var("HARBOR_OPENCODE_SHA256")
        .expect("HARBOR_OPENCODE_SHA256 must bind the engine");
    let node = selected("HARBOR_NODE_BINARY");
    let helper = selected("HARBOR_STANDALONE_HELPER");
    let dispatcher = selected("HARBOR_INSTALLED_DISPATCHER");
    let bubblewrap = selected("HARBOR_BUBBLEWRAP_BINARY");
    let evidence = selected("HARBOR_NATIVE_EVIDENCE_ROOT");
    for phase in [
        "provider",
        "tool",
        "crash-provider",
        "crash-tool",
        "lost-receipt-provider",
        "lost-receipt-tool",
        "complete",
    ] {
        let root = tempfile::Builder::new()
            .prefix(&format!("supervised-{phase}-"))
            .tempdir_in(&evidence)
            .unwrap()
            .keep();
        eprintln!("retaining native {phase} attempt: {}", root.display());
        for name in [
            "state",
            "admissions",
            "admissions/pending",
            "admissions/consumed",
            "control",
        ] {
            fs::create_dir(root.join(name)).unwrap();
            fs::set_permissions(root.join(name), fs::Permissions::from_mode(0o700)).unwrap();
        }
        fs::write(
            root.join("result.json"),
            br#"{"accepted":false,"status":"started"}"#,
        )
        .unwrap();
        let input =
            serde_json::to_vec(&json!({"text":format!("Exact original synthetic {phase} input.")}))
                .unwrap();
        let mut random = [0; 32];
        getrandom::fill(&mut random).unwrap();
        let mut binding = Binding {
            caller_authority: "native-fixture".into(),
            caller_namespace: "synthetic".into(),
            intent_id: format!("original-{phase}"),
            execution_id: format!("ses_{}", &crate::digest(&random)[..32]),
            execution_generation: "1".into(),
            input_digest: crate::digest(&input),
            policy_digest: "b".repeat(64),
            implementation_digest: "c".repeat(64),
        };
        let plan = Plan {
            tools: Tools {
                systemd_run: Path::new("/run/current-system/sw/bin/systemd-run")
                    .canonicalize()
                    .unwrap(),
                systemctl: Path::new("/run/current-system/sw/bin/systemctl")
                    .canonicalize()
                    .unwrap(),
                bubblewrap: bubblewrap.clone(),
                node: node.clone(),
                node_digest: crate::digest(&fs::read(&node).unwrap()),
                helper: helper.clone(),
                helper_digest: crate::digest(&fs::read(&helper).unwrap()),
                dispatcher: dispatcher.clone(),
                path: format!(
                    "{}:{}",
                    node.parent().unwrap().display(),
                    std::env::var("HARBOR_SHELL_TOOL_PATH")
                        .expect("HARBOR_SHELL_TOOL_PATH must select immutable shell tools")
                ),
            },
            resources: Resources {
                wall_seconds: 60,
                memory_bytes: 1024 * 1024 * 1024,
                cpu_percent: 100,
                tasks: 128,
                scratch_bytes: 64 * 1024 * 1024,
                scratch_inodes: 4096,
            },
            control_directory: root.join("control"),
            provider_id: "fixture".into(),
            engine_version: "2.0.22+047c74e".into(),
            inbox_id: format!("msg_{}", &crate::digest(&random)[..32]),
            interrupt_authority: Some("e".repeat(64)),
            engine_configuration: json!({"update":"disable","share":"disabled","plugins":[],"snapshots":false,"warming":false,"providers":{"fixture":{"package":"@opencode/ai/providers/openai-compatible","settings":{"apiKey":"synthetic-only","timeout":60000},"models":{"fixture":{"limit":{"context":8192,"output":1024},"capabilities":{"tools":true}}}}},"agents":{"title":{"disabled":true},"build":{"steps":1,"model":{"providerID":"fixture","id":"fixture"}}}}),
            session_configuration: json!({"model":{"providerID":"fixture","id":"fixture"},"permissions":[{"action":"*","resource":"*","effect":"deny"},{"action":"shell","resource":"*","effect":if phase.contains("tool"){"allow"}else{"deny"}}]}),
        };
        binding.implementation_digest = plan.implementation_digest(&engine_digest).unwrap();
        let admission = Admission {
            version: 1,
            controller_uid: rustix::process::geteuid().as_raw(),
            binding: binding.clone(),
            engine: engine.clone(),
            engine_digest: engine_digest.clone(),
            output_bytes: 1024 * 1024,
        };
        let id = admission_id(&binding).unwrap();
        let pending = root.join("admissions/pending").join(format!("{id}.json"));
        fs::write(&pending, serde_json::to_vec(&admission).unwrap()).unwrap();
        fs::set_permissions(&pending, fs::Permissions::from_mode(0o600)).unwrap();
        let owner = rustix::process::geteuid().as_raw();
        let config = Config {
            version: 1,
            state_directory: root.join("state"),
            admission_directory: root.join("admissions"),
            maximum_artifact_bytes: 512 * 1024 * 1024,
            timeout_ms: 60000,
        };
        let store = Store {
            pending: safe_directory(&config.admission_directory.join("pending"), owner, true)
                .unwrap(),
            consumed: safe_directory(&config.admission_directory.join("consumed"), owner, true)
                .unwrap(),
            config,
            owner,
            peer_uid: owner,
        };
        let (mut held, _) = store.prepare(&id, Duration::from_secs(30)).unwrap();
        let registration = held._controller.registration().clone();
        let (socket, child_socket) = UnixStream::pair().unwrap();
        let control_directory = File::open(&plan.control_directory).unwrap();
        let observer_directory = format!(
            "/proc/{}/fd/{}",
            std::process::id(),
            control_directory.as_raw_fd()
        );
        let child = Command::new(&node)
            .args([
                "--input-type=module",
                "-e",
                include_str!("native_observer.mjs"),
                &observer_directory,
                phase,
            ])
            .stdin(Stdio::from(OwnedFd::from(
                child_socket.try_clone().unwrap(),
            )))
            .stdout(Stdio::from(OwnedFd::from(child_socket)))
            .stderr(Stdio::from(
                File::create(root.join("observer.stderr")).unwrap(),
            ))
            .spawn()
            .unwrap();
        let mut observer = Observer {
            wire: Wire::new(
                socket,
                Limits {
                    timeout: Duration::from_secs(180),
                    records: 256,
                    bytes: 256 * 1024,
                },
            )
            .unwrap(),
            child,
        };
        assert_eq!(
            serde_json::from_slice::<Value>(&observer.wire.receive(16384).unwrap().unwrap())
                .unwrap(),
            json!({"ready":true})
        );
        let observer = Arc::new(Mutex::new(observer));
        let mut session = Session::start(
            &mut held._controller,
            &held._image,
            plan.clone(),
            revoker(&observer),
        )
        .unwrap();
        let original_unit = session.unit().to_owned();
        assert_eq!(
            session
                .submit(&mut held._controller, b"competing bytes")
                .unwrap_err()
                .code,
            ErrorCode::CustodyLost
        );
        session.submit(&mut held._controller, &input).unwrap();
        assert_eq!(
            session
                .submit(&mut held._controller, &input)
                .unwrap_err()
                .code,
            ErrorCode::EffectUnknown
        );
        thread::sleep(Duration::from_millis(100));
        assert_eq!(status(&observer)["providers"], 0);
        if phase.starts_with("lost-receipt-") {
            assert_eq!(
                session
                    .execute_losing_reply_for_conformance(&mut held._controller)
                    .unwrap_err()
                    .code,
                ErrorCode::EffectUnknown
            );
        } else {
            session.execute(&mut held._controller).unwrap();
        }
        wait(|| status(&observer)["providers"] == 1);
        if phase.contains("tool") {
            wait(|| {
                let status = status(&observer);
                status["tools"] == 1 && status["descendants"] == 1
            });
        }
        wait(|| {
            claim(&observer, &session.state_path().unwrap(), &binding)["time_suspended"].is_number()
                || phase == "complete"
        });
        thread::sleep(Duration::from_millis(100));
        let before_claim = claim(&observer, &session.state_path().unwrap(), &binding);
        let before = status(&observer);
        assert_eq!(before["failure"], false);
        assert_eq!(before["providers"], 1);
        assert_eq!(before["attempts"], 1);
        let snapshot = session.reconcile().unwrap();
        let snapshot_value: Value = serde_json::from_slice(&snapshot).unwrap();
        assert_eq!(snapshot_value["gap"], true);
        assert_eq!(snapshot_value["complete"], false);
        fs::write(root.join("before.json"), &snapshot).unwrap();
        let image = held._image;
        drop(held._controller);
        let mut controller =
            Controller::reopen(&store.config.state_directory, &registration, &binding).unwrap();
        assert_eq!(
            controller.state(Operation::Execute),
            Some(if phase.starts_with("lost-receipt-") {
                State::Unknown
            } else {
                State::Observed
            })
        );
        assert_eq!(
            session.execute(&mut controller).unwrap_err().code,
            ErrorCode::EffectUnknown
        );
        assert_eq!(
            session
                .interrupt(&mut controller, &"f".repeat(64))
                .unwrap_err()
                .code,
            ErrorCode::AuthorityDenied
        );
        session.reconcile().unwrap();
        assert_eq!(status(&observer)["attempts"], before["attempts"]);
        let mut retained_output = None;
        if phase == "complete" {
            wait(|| {
                session.reconcile().ok().is_some_and(|snapshot| {
                    String::from_utf8_lossy(&snapshot).contains("exact synthetic result")
                })
            });
            let snapshot: Value = serde_json::from_slice(&session.reconcile().unwrap()).unwrap();
            assert_eq!(snapshot["session"]["id"], binding.execution_id);
            assert_eq!(snapshot["session"]["outcome"], "succeeded");
            let messages = snapshot["messages"].as_array().unwrap();
            let input_message = messages
                .iter()
                .find(|message| message["id"] == plan.inbox_id)
                .unwrap();
            assert_eq!(
                input_message["text"],
                serde_json::from_slice::<Value>(&input).unwrap()["text"]
            );
            let assistant = messages
                .iter()
                .find(|message| {
                    message["type"] == "assistant"
                        && message["finish"] == "stop"
                        && message["time"]["completed"].is_number()
                })
                .unwrap();
            assert_eq!(
                assistant["content"],
                json!([{"type":"text","text":"exact synthetic result"}])
            );
            let retained=serde_json::to_vec(&json!({"result":assistant["content"],"messageId":assistant["id"],"applicationValidated":true})).unwrap();
            controller.retain(&retained).unwrap();
            assert_eq!(controller.deliver().unwrap(), retained);
            retained_output = Some(retained);
        } else if !phase.starts_with("crash-") && !phase.starts_with("lost-receipt-") {
            session.interrupt(&mut controller, &"e".repeat(64)).unwrap();
            assert_eq!(
                controller.state(Operation::Interrupt),
                Some(State::Observed)
            );
        }
        if phase == "crash-tool" {
            assert_eq!(
                session
                    .reject_stale_cleanup_for_conformance()
                    .unwrap_err()
                    .code,
                ErrorCode::CustodyLost
            );
            assert_eq!(
                status(&observer)["activeTools"],
                2,
                "stale identity must not stop a unit"
            );
        }
        let mut state = if phase.starts_with("crash-") || phase.starts_with("lost-receipt-") {
            session.crash_for_conformance().unwrap()
        } else {
            session.close().unwrap()
        };
        save_database(&state.path(), &root.join("closed-state"));
        wait(|| status(&observer)["activeTools"] == 0);
        assert_eq!(status(&observer)["revoked"], true);
        let closed_claim = claim(&observer, &state.path(), &binding);
        if phase.starts_with("crash-") || phase.starts_with("lost-receipt-") {
            assert_eq!(closed_claim, before_claim);
        }
        let mut changed = plan.clone();
        changed.resources.tasks -= 1;
        assert!(
            matches!(Session::reopen(&binding, &image, changed, &mut state, revoker(&observer)), Err(error) if error.code == ErrorCode::CustodyLost)
        );
        let mut reopened = Session::reopen(
            &binding,
            &image,
            plan.clone(),
            &mut state,
            revoker(&observer),
        )
        .unwrap();
        assert!(
            matches!(Session::reopen(&binding,&image,plan.clone(),&mut state,revoker(&observer)),Err(error) if error.code==ErrorCode::EffectUnknown)
        );
        reopened.reconcile().unwrap();
        thread::sleep(Duration::from_secs(3));
        let recovered = reopened.reconcile().unwrap();
        fs::write(root.join("reopened.json"), recovered).unwrap();
        let after = status(&observer);
        assert_eq!(after["failure"], false);
        assert_eq!(
            after["attempts"], before["attempts"],
            "observational restart attempted provider work"
        );
        assert_eq!(after["tools"], before["tools"]);
        assert_eq!(after["descendants"], before["descendants"]);
        assert_eq!(
            claim(&observer, &reopened.state_path().unwrap(), &binding),
            closed_claim
        );
        let new_unit = reopened.unit().to_owned();
        let mut state = reopened.close().unwrap();
        save_database(&state.path(), &root.join("reopened-state"));
        if phase == "provider" {
            let unverified = Session::reopen(
                &binding,
                &image,
                plan.clone(),
                &mut state,
                Box::new(|| false),
            )
            .unwrap();
            assert!(
                matches!(unverified.close(), Err(error) if error.code == ErrorCode::CustodyLost)
            );
        } else if phase == "complete" {
            fs::rename(
                state.path().join("engine.db"),
                state.path().join("engine.db.quarantined"),
            )
            .unwrap();
            assert!(
                matches!(Session::reopen(&binding, &image, plan.clone(), &mut state, revoker(&observer)), Err(error) if error.code == ErrorCode::CustodyLost)
            );
            assert!(
                !state.path().join("engine.db").exists(),
                "missing state must not be reconstructed"
            );
        }
        assert_eq!(status(&observer)["attempts"], before["attempts"]);
        drop(controller);
        let mut controller =
            Controller::reopen(&store.config.state_directory, &registration, &binding).unwrap();
        if let Some(retained) = retained_output {
            assert_eq!(controller.deliver().unwrap(), retained);
        }
        assert_eq!(
            controller
                .reserve(Operation::Start, &"a".repeat(64))
                .unwrap_err()
                .code,
            ErrorCode::EffectUnknown
        );
        assert!(
            matches!(store.prepare(&id,Duration::from_secs(1)),Err(error) if error.code==ErrorCode::EffectUnknown)
        );
        fs::write(root.join("result.json"),serde_json::to_vec_pretty(&json!({"accepted":false,"status":"passed","scope":"local-managed-supervisor-conformance","phase":phase,"engine":engine,"engineDigest":engine_digest,"plan":plan,"originalUnit":original_unit,"observationalUnit":new_unit,"before":before,"after":after,"claimBefore":before_claim,"claimAfterCleanup":closed_claim,"cleanup":"verified-empty","observationMs":3000,"untrustedWorkerCustody":"unqualified","sourceAttestation":"external-prerequisite"})).unwrap()).unwrap();
    }
}
