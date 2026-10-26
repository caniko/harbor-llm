//! The command callback cannot run before the durable one-shot reservation.
use harbor_llm_protocol::{
    Binding, ErrorCode, ProtocolError,
    commands::{
        self, Command, CommandBody, Effect, EffectReceipt, EffectState, TransferPurpose,
        TransferReference,
    },
};
use harbor_llm_runtime::{Controller, Operation, State};
use std::{fs, os::unix::fs::PermissionsExt};

fn binding() -> Binding {
    Binding {
        caller_authority: "controller".into(),
        caller_namespace: "fixture".into(),
        intent_id: "job".into(),
        execution_id: "ses_fixture".into(),
        execution_generation: "1".into(),
        input_digest: "a".repeat(64),
        policy_digest: "b".repeat(64),
        implementation_digest: "c".repeat(64),
    }
}
fn root() -> tempfile::TempDir {
    let root = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
    fs::set_permissions(root.path(), fs::Permissions::from_mode(0o700)).unwrap();
    root
}
fn command(body: CommandBody) -> Command {
    Command {
        schema_version: 2,
        command_schema_digest: commands::SCHEMA_DIGEST.into(),
        request_id: "request".into(),
        binding: binding(),
        body,
    }
}
fn initial() -> [Command; 3] {
    let reference = TransferReference {
        transfer_id: "configuration".into(),
        bytes: "10".into(),
        digest: "d".repeat(64),
        purpose: TransferPurpose::Configuration,
    };
    [
        command(CommandBody::Create(commands::Create {
            configuration: reference.clone(),
        })),
        command(CommandBody::Submit(commands::Submit {
            handle: binding().execution_id,
            inbox_id: "msg_original".into(),
            input: TransferReference {
                purpose: TransferPurpose::Input,
                ..reference
            },
        })),
        command(CommandBody::Execute(commands::Execute {
            handle: binding().execution_id,
            inbox_id: "msg_original".into(),
            input_digest: "d".repeat(64),
        })),
    ]
}
fn reply(request: &Command) -> Command {
    let operation = match request.body {
        CommandBody::Create(_) => Effect::Create,
        CommandBody::Submit(_) => Effect::Submit,
        CommandBody::Execute(_) => Effect::Execute,
        CommandBody::Interrupt(_) => Effect::Interrupt,
        _ => panic!("not initial"),
    };
    Command {
        body: CommandBody::Receipt(EffectReceipt {
            operation,
            state: EffectState::Observed,
            receipt_digest: "e".repeat(64),
        }),
        ..request.clone()
    }
}

#[test]
fn initial_dispatch_is_durable_before_callback_and_one_shot_after_receipt() {
    let root = root();
    let mut controller = Controller::register(root.path(), &binding(), 4096).unwrap();
    let path = controller.entry().join("journal.json");
    for (request, (operation, name)) in initial().iter().zip([
        (Operation::Start, "start"),
        (Operation::Submit, "submit"),
        (Operation::Execute, "execute"),
    ]) {
        controller
            .dispatch_initial(request, |request| {
                let journal: serde_json::Value =
                    serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
                assert!(journal["operations"][name].is_object());
                assert!(journal["operations"][name]["receipt"].is_null());
                Ok(reply(request))
            })
            .unwrap();
        assert_eq!(controller.state(operation), Some(State::Observed));
        assert_eq!(
            controller
                .dispatch_initial(request, |_| panic!("must not replay"))
                .unwrap_err()
                .code,
            ErrorCode::EffectUnknown
        );
    }
    assert_eq!(
        controller.receipt(Operation::Submit).unwrap().0,
        controller.receipt(Operation::Execute).unwrap().0
    );
}

#[test]
fn lost_or_mismatched_reply_stays_unknown_and_cannot_be_redispatched() {
    for phase in 0..3 {
        for fault in [
            "lost",
            "request",
            "binding",
            "schema",
            "operation",
            "unknown",
        ] {
            let root = root();
            let mut controller = Controller::register(root.path(), &binding(), 4096).unwrap();
            let requests = initial();
            for request in &requests[..phase] {
                controller
                    .dispatch_initial(request, |request| Ok(reply(request)))
                    .unwrap();
            }
            let operation = [Operation::Start, Operation::Submit, Operation::Execute][phase];
            assert_eq!(
                controller
                    .dispatch_initial(&requests[phase], |request| {
                        if fault == "lost" {
                            return Err(ProtocolError {
                                code: ErrorCode::TransportFailed,
                            });
                        }
                        let mut response = reply(request);
                        match fault {
                            "request" => response.request_id = "other".into(),
                            "binding" => response.binding.execution_generation = "2".into(),
                            "schema" => response.command_schema_digest = "a".repeat(64),
                            "operation" => {
                                response.body = CommandBody::Receipt(EffectReceipt {
                                    operation: Effect::Close,
                                    state: EffectState::Observed,
                                    receipt_digest: "f".repeat(64),
                                })
                            }
                            "unknown" => {
                                if let CommandBody::Receipt(ref mut receipt) = response.body {
                                    receipt.state = EffectState::Unknown;
                                }
                            }
                            _ => unreachable!(),
                        }
                        Ok(response)
                    })
                    .unwrap_err()
                    .code,
                ErrorCode::EffectUnknown
            );
            assert_eq!(controller.state(operation), Some(State::Unknown));
            assert_eq!(
                controller
                    .dispatch_initial(&requests[phase], |_| panic!("must not retry"))
                    .unwrap_err()
                    .code,
                ErrorCode::EffectUnknown
            );
        }
    }
}

#[test]
fn changed_targets_inputs_and_fresh_reopen_cannot_release_commands() {
    let root = root();
    let mut controller = Controller::register(root.path(), &binding(), 4096).unwrap();
    let requests = initial();
    for request in &requests[..2] {
        controller
            .dispatch_initial(request, |request| Ok(reply(request)))
            .unwrap();
    }
    for field in ["handle", "inbox", "input", "binding"] {
        let mut changed = requests[2].clone();
        if field == "binding" {
            changed.binding.intent_id = "other".into();
        }
        if let CommandBody::Execute(ref mut execute) = changed.body {
            match field {
                "handle" => execute.handle = "ses_other".into(),
                "inbox" => execute.inbox_id = "msg_other".into(),
                "input" => execute.input_digest = "f".repeat(64),
                _ => (),
            }
        }
        assert!(
            controller
                .dispatch_initial(&changed, |_| panic!("must not release changed input"))
                .is_err()
        );
        assert_eq!(controller.state(Operation::Execute), None);
    }
    let registration = controller.registration().clone();
    drop(controller);
    let mut reopened = Controller::reopen(root.path(), &registration, &binding()).unwrap();
    assert_eq!(
        reopened
            .dispatch_initial(&requests[2], |_| panic!("reopen is not fresh"))
            .unwrap_err()
            .code,
        ErrorCode::EffectUnknown
    );
    assert_eq!(reopened.state(Operation::Execute), None);
}

#[test]
fn journal_failure_and_unsupported_cancellation_never_invoke_callback() {
    let root = root();
    let mut controller = Controller::register(root.path(), &binding(), 4096).unwrap();
    let cancel = command(CommandBody::Interrupt(commands::Cancel {
        handle: binding().execution_id,
        authority_digest: "f".repeat(64),
    }));
    assert_eq!(
        controller
            .dispatch_initial(&cancel, |_| panic!("no cancellation authority"))
            .unwrap_err()
            .code,
        ErrorCode::UnsupportedCapability
    );
    fs::rename(
        controller.entry().join("journal.json"),
        controller.entry().join("preserved-journal.json"),
    )
    .unwrap();
    assert_eq!(
        controller
            .dispatch_initial(&initial()[0], |_| panic!("no durable fence"))
            .unwrap_err()
            .code,
        ErrorCode::CustodyLost
    );
}

#[test]
fn abrupt_exit_inside_the_exchange_keeps_the_execution_reservation_unknown() {
    const CHILD_ROOT: &str = "HARBOR_INITIAL_DISPATCH_CRASH_ROOT";
    if let Some(path) = std::env::var_os(CHILD_ROOT) {
        let path = std::path::Path::new(&path);
        let mut controller = Controller::register(path, &binding(), 4096).unwrap();
        fs::write(
            path.join("registration.json"),
            serde_json::to_vec(controller.registration()).unwrap(),
        )
        .unwrap();
        let requests = initial();
        for request in &requests[..2] {
            controller
                .dispatch_initial(request, |request| Ok(reply(request)))
                .unwrap();
        }
        controller
            .dispatch_initial(&requests[2], |_| std::process::exit(0))
            .unwrap();
        panic!("exchange must exit abruptly");
    }
    let root = root();
    let status = std::process::Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "abrupt_exit_inside_the_exchange_keeps_the_execution_reservation_unknown",
        ])
        .env(CHILD_ROOT, root.path())
        .status()
        .unwrap();
    assert!(status.success());
    let registration =
        serde_json::from_slice(&fs::read(root.path().join("registration.json")).unwrap()).unwrap();
    let mut reopened = Controller::reopen(root.path(), &registration, &binding()).unwrap();
    assert_eq!(reopened.state(Operation::Execute), Some(State::Unknown));
    assert_eq!(
        reopened
            .dispatch_initial(&initial()[2], |_| panic!("crashed dispatch cannot replay"))
            .unwrap_err()
            .code,
        ErrorCode::EffectUnknown
    );
}

#[test]
fn current_authority_interrupts_only_the_original_execution_after_a_durable_fence() {
    let root = root();
    let mut controller = Controller::register(root.path(), &binding(), 4096).unwrap();
    for request in &initial()[..2] {
        controller
            .dispatch_initial(request, |request| Ok(reply(request)))
            .unwrap();
    }
    let registration = controller.registration().clone();
    let path = controller.entry().join("journal.json");
    drop(controller);
    let mut controller = Controller::reopen(root.path(), &registration, &binding()).unwrap();
    let cancel = command(CommandBody::Interrupt(commands::Cancel {
        handle: binding().execution_id,
        authority_digest: "e".repeat(64),
    }));
    assert_eq!(
        controller
            .dispatch_interrupt(&cancel, &"f".repeat(64), |_| panic!("stale authority"))
            .unwrap_err()
            .code,
        ErrorCode::AuthorityDenied
    );
    controller
        .dispatch_interrupt(&cancel, &"e".repeat(64), |request| {
            let journal: serde_json::Value =
                serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
            assert!(journal["operations"]["interrupt"]["receipt"].is_null());
            assert!(journal["operations"]["interrupt"].is_object());
            Ok(reply(request))
        })
        .unwrap();
    assert_eq!(
        controller.state(Operation::Interrupt),
        Some(State::Observed)
    );
    assert_eq!(
        controller
            .dispatch_interrupt(&cancel, &"e".repeat(64), |_| panic!("replay"))
            .unwrap_err()
            .code,
        ErrorCode::EffectUnknown
    );
}
