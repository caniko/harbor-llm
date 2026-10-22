//! Disposable private controller stores; no provider or original state is touched.
use harbor_llm_protocol::{Binding, ErrorCode};
use harbor_llm_runtime::{Controller, Operation, State};
use std::{fs, os::unix::fs::PermissionsExt};

fn binding() -> Binding {
    Binding {
        caller_authority: "fixture-controller".into(),
        caller_namespace: "fixture-app".into(),
        intent_id: "job-1".into(),
        execution_id: "execution-1".into(),
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

#[test]
fn reopen_does_not_grant_unreserved_start_or_submission() {
    for started in [false, true] {
        let root = root();
        let mut controller = Controller::register(root.path(), &binding(), 4096).unwrap();
        if started {
            controller
                .reserve(Operation::Start, &"d".repeat(64))
                .unwrap();
            controller
                .observe(Operation::Start, "observed-session")
                .unwrap();
        }
        let registration = controller.registration().clone();
        let before = fs::read(controller.entry().join("journal.json")).unwrap();
        drop(controller);
        let mut reopened = Controller::reopen(root.path(), &registration, &binding()).unwrap();
        let operation = if started {
            Operation::Submit
        } else {
            Operation::Start
        };
        assert_eq!(
            reopened
                .reserve(operation, &"e".repeat(64))
                .unwrap_err()
                .code,
            ErrorCode::EffectUnknown
        );
        assert_eq!(
            fs::read(reopened.entry().join("journal.json")).unwrap(),
            before
        );
    }
}

#[test]
fn execution_release_requires_observed_admission_and_the_same_input_digest() {
    let root = root();
    let mut controller = Controller::register(root.path(), &binding(), 4096).unwrap();
    controller
        .reserve(Operation::Start, &"d".repeat(64))
        .unwrap();
    controller
        .observe(Operation::Start, "observed-session")
        .unwrap();
    assert_eq!(
        controller
            .reserve(Operation::Execute, &"e".repeat(64))
            .unwrap_err()
            .code,
        ErrorCode::EffectUnknown
    );
    controller
        .reserve(Operation::Submit, &"e".repeat(64))
        .unwrap();
    assert_eq!(
        controller
            .reserve(Operation::Execute, &"e".repeat(64))
            .unwrap_err()
            .code,
        ErrorCode::EffectUnknown
    );
    controller
        .observe(Operation::Submit, "observed-inbox")
        .unwrap();
    assert_eq!(
        controller
            .reserve(Operation::Execute, &"f".repeat(64))
            .unwrap_err()
            .code,
        ErrorCode::InvalidFrame
    );
    controller
        .reserve(Operation::Execute, &"e".repeat(64))
        .unwrap();
    assert_eq!(controller.state(Operation::Execute), Some(State::Unknown));
    let journal: serde_json::Value =
        serde_json::from_slice(&fs::read(controller.entry().join("journal.json")).unwrap())
            .unwrap();
    assert_eq!(journal["operations"]["execute"]["digest"], "e".repeat(64));
    assert!(journal["operations"]["execute"]["receipt"].is_null());
    controller
        .observe(Operation::Execute, "observed-release")
        .unwrap();
    assert_eq!(
        controller
            .reserve(Operation::Execute, &"e".repeat(64))
            .unwrap_err()
            .code,
        ErrorCode::EffectUnknown
    );
}

#[test]
fn reopen_never_grants_execution_even_when_the_legacy_journal_has_no_release() {
    for released in [false, true] {
        let root = root();
        let mut controller = Controller::register(root.path(), &binding(), 4096).unwrap();
        controller
            .reserve(Operation::Start, &"d".repeat(64))
            .unwrap();
        controller
            .observe(Operation::Start, "observed-session")
            .unwrap();
        controller
            .reserve(Operation::Submit, &"e".repeat(64))
            .unwrap();
        controller
            .observe(Operation::Submit, "observed-inbox")
            .unwrap();
        if released {
            controller
                .reserve(Operation::Execute, &"e".repeat(64))
                .unwrap();
        }
        let registration = controller.registration().clone();
        let before = fs::read(controller.entry().join("journal.json")).unwrap();
        drop(controller);
        let mut reopened = Controller::reopen(root.path(), &registration, &binding()).unwrap();
        assert_eq!(
            reopened
                .reserve(Operation::Execute, &"e".repeat(64))
                .unwrap_err()
                .code,
            ErrorCode::EffectUnknown
        );
        assert_eq!(
            fs::read(reopened.entry().join("journal.json")).unwrap(),
            before
        );
        // The caller separately authenticates current interruption authority.
        reopened
            .reserve(Operation::Interrupt, &"f".repeat(64))
            .unwrap();
        assert_eq!(
            reopened
                .reserve(Operation::Interrupt, &"f".repeat(64))
                .unwrap_err()
                .code,
            ErrorCode::EffectUnknown
        );
    }
}

#[test]
fn crash_after_reservation_never_releases_the_effect_for_replay() {
    let root = root();
    let mut controller = Controller::register(root.path(), &binding(), 4096).unwrap();
    let registration = controller.registration().clone();
    controller
        .reserve(Operation::Start, &"d".repeat(64))
        .unwrap();
    drop(controller);
    let mut reopened = Controller::reopen(root.path(), &registration, &binding()).unwrap();
    assert_eq!(reopened.state(Operation::Start), Some(State::Unknown));
    assert_eq!(
        reopened
            .reserve(Operation::Start, &"d".repeat(64))
            .unwrap_err()
            .code,
        ErrorCode::EffectUnknown
    );
    assert_eq!(reopened.state(Operation::Submit), None);
}

#[test]
fn new_execution_generation_cannot_bypass_the_same_application_intent() {
    let root = root();
    let controller = Controller::register(root.path(), &binding(), 4096).unwrap();
    let registration = controller.registration().clone();
    drop(controller);
    let mut changed = binding();
    changed.execution_generation = "2".into();
    changed.execution_id = "replacement".into();
    assert!(Controller::register(root.path(), &changed, 4096).is_err());
    assert_eq!(
        Controller::reopen(root.path(), &registration, &changed)
            .err()
            .unwrap()
            .code,
        ErrorCode::CustodyLost
    );
}

#[test]
fn missing_or_replaced_state_and_lock_cannot_be_recreated_by_reopen() {
    let root = root();
    let controller = Controller::register(root.path(), &binding(), 4096).unwrap();
    let registration = controller.registration().clone();
    let entry = controller.entry().to_owned();
    drop(controller);
    fs::remove_file(entry.join("journal.json")).unwrap();
    assert_eq!(
        Controller::reopen(root.path(), &registration, &binding())
            .err()
            .unwrap()
            .code,
        ErrorCode::CustodyLost
    );
    assert!(!entry.join("journal.json").exists());
    assert!(Controller::register(root.path(), &binding(), 4096).is_err());
}

#[test]
fn retained_bytes_require_exact_binding_and_survive_read_only_reopen() {
    let root = root();
    let mut controller = Controller::register(root.path(), &binding(), 4096).unwrap();
    let registration = controller.registration().clone();
    assert!(controller.retain(b"no submit").is_err());
    controller
        .reserve(Operation::Start, &"d".repeat(64))
        .unwrap();
    controller
        .observe(Operation::Start, "observed-session")
        .unwrap();
    controller
        .reserve(Operation::Submit, &"e".repeat(64))
        .unwrap();
    let receipt = controller
        .retain(b"complete application-validated output\n")
        .unwrap();
    assert_eq!(receipt.output_bytes, "38");
    drop(controller);
    let mut reopened = Controller::reopen(root.path(), &registration, &binding()).unwrap();
    assert_eq!(
        reopened.deliver().unwrap(),
        b"complete application-validated output\n"
    );
    assert_eq!(
        reopened
            .reserve(Operation::Submit, &"e".repeat(64))
            .unwrap_err()
            .code,
        ErrorCode::EffectUnknown
    );
    fs::write(reopened.entry().join("output"), b"tampered").unwrap();
    assert_eq!(reopened.deliver().unwrap_err().code, ErrorCode::CustodyLost);
}

#[test]
fn original_writer_lock_and_private_modes_are_enforced() {
    let root = root();
    let controller = Controller::register(root.path(), &binding(), 4096).unwrap();
    let registration = controller.registration().clone();
    assert!(Controller::reopen(root.path(), &registration, &binding()).is_err());
    drop(controller);
    fs::set_permissions(root.path(), fs::Permissions::from_mode(0o755)).unwrap();
    assert_eq!(
        Controller::reopen(root.path(), &registration, &binding())
            .err()
            .unwrap()
            .code,
        ErrorCode::CustodyLost
    );
}

#[test]
fn deleting_the_journal_while_held_cannot_make_a_later_write_recreate_it() {
    let root = root();
    let mut controller = Controller::register(root.path(), &binding(), 4096).unwrap();
    fs::remove_file(controller.entry().join("journal.json")).unwrap();
    assert_eq!(
        controller
            .reserve(Operation::Start, &"d".repeat(64))
            .unwrap_err()
            .code,
        ErrorCode::CustodyLost
    );
    assert!(!controller.entry().join("journal.json").exists());
}

#[test]
fn cancellation_and_orphaned_output_never_manufacture_complete_delivery() {
    let root = root();
    let mut controller = Controller::register(root.path(), &binding(), 16).unwrap();
    controller
        .reserve(Operation::Start, &"d".repeat(64))
        .unwrap();
    controller
        .observe(Operation::Start, "observed-session")
        .unwrap();
    controller
        .reserve(Operation::Submit, &"e".repeat(64))
        .unwrap();
    assert_eq!(
        controller.retain(&[0; 17]).unwrap_err().code,
        ErrorCode::BudgetExhausted
    );
    fs::write(controller.entry().join("output"), b"orphan").unwrap();
    assert_eq!(
        controller.deliver().unwrap_err().code,
        ErrorCode::EffectUnknown
    );
    controller
        .reserve(Operation::Interrupt, &"f".repeat(64))
        .unwrap();
    assert_eq!(
        controller.retain(b"invalid").unwrap_err().code,
        ErrorCode::EffectUnknown
    );
}

#[test]
fn abrupt_process_exit_releases_the_kernel_lock_but_not_the_submission_fence() {
    let root = root();
    let output = std::process::Command::new(std::env::current_exe().unwrap())
        .args(["--exact", "abrupt_exit_child", "--nocapture"])
        .env("HARBOR_LIFECYCLE_TEST_ROOT", root.path())
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let registration =
        serde_json::from_slice(&fs::read(root.path().join("admission.json")).unwrap()).unwrap();
    let mut reopened = Controller::reopen(root.path(), &registration, &binding()).unwrap();
    assert_eq!(reopened.state(Operation::Submit), Some(State::Unknown));
    assert_eq!(
        reopened
            .reserve(Operation::Submit, &"e".repeat(64))
            .unwrap_err()
            .code,
        ErrorCode::EffectUnknown
    );
    assert_eq!(fs::read(root.path().join("effect")).unwrap(), b"one effect");
}

#[test]
fn abrupt_exit_after_execution_reservation_never_releases_it_again() {
    let root = root();
    let output = std::process::Command::new(std::env::current_exe().unwrap())
        .args(["--exact", "abrupt_exit_child", "--nocapture"])
        .env("HARBOR_LIFECYCLE_TEST_ROOT", root.path())
        .env("HARBOR_LIFECYCLE_TEST_EXECUTE", "1")
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let registration =
        serde_json::from_slice(&fs::read(root.path().join("admission.json")).unwrap()).unwrap();
    let mut reopened = Controller::reopen(root.path(), &registration, &binding()).unwrap();
    assert_eq!(reopened.state(Operation::Execute), Some(State::Unknown));
    assert_eq!(
        reopened
            .reserve(Operation::Execute, &"e".repeat(64))
            .unwrap_err()
            .code,
        ErrorCode::EffectUnknown
    );
    assert_eq!(fs::read(root.path().join("effect")).unwrap(), b"one effect");
}

#[test]
fn abrupt_exit_child() {
    let Some(root) = std::env::var_os("HARBOR_LIFECYCLE_TEST_ROOT") else {
        return;
    };
    let root = std::path::Path::new(&root);
    let mut controller = Controller::register(root, &binding(), 4096).unwrap();
    fs::write(
        root.join("admission.json"),
        serde_json::to_vec(controller.registration()).unwrap(),
    )
    .unwrap();
    controller
        .reserve(Operation::Start, &"d".repeat(64))
        .unwrap();
    controller
        .observe(Operation::Start, "observed-session")
        .unwrap();
    controller
        .reserve(Operation::Submit, &"e".repeat(64))
        .unwrap();
    if std::env::var_os("HARBOR_LIFECYCLE_TEST_EXECUTE").is_some() {
        controller
            .observe(Operation::Submit, "observed-inbox")
            .unwrap();
        controller
            .reserve(Operation::Execute, &"e".repeat(64))
            .unwrap();
    }
    fs::write(root.join("effect"), b"one effect").unwrap();
    // Bypass Rust drop exactly as a crash would; durable accounting is authoritative.
    std::process::exit(0);
}

#[test]
fn identical_bytes_on_a_replaced_inode_and_symbolic_lock_are_rejected() {
    let root = root();
    let mut controller = Controller::register(root.path(), &binding(), 4096).unwrap();
    let registration = controller.registration().clone();
    let entry = controller.entry().to_owned();
    let original = fs::read(entry.join("journal.json")).unwrap();
    let mut replacement = tempfile::NamedTempFile::new_in(&entry).unwrap();
    std::io::Write::write_all(&mut replacement, &original).unwrap();
    replacement.persist(entry.join("journal.json")).unwrap();
    assert_eq!(
        controller
            .reserve(Operation::Start, &"d".repeat(64))
            .unwrap_err()
            .code,
        ErrorCode::CustodyLost
    );
    drop(controller);
    fs::rename(entry.join("execution.lock"), entry.join("preserved.lock")).unwrap();
    std::os::unix::fs::symlink(entry.join("preserved.lock"), entry.join("execution.lock")).unwrap();
    assert_eq!(
        Controller::reopen(root.path(), &registration, &binding())
            .err()
            .unwrap()
            .code,
        ErrorCode::CustodyLost
    );
}

#[test]
fn output_orphaned_before_receipt_commit_is_preserved_and_cannot_be_delivered() {
    let root = root();
    let mut controller = Controller::register(root.path(), &binding(), 4096).unwrap();
    let registration = controller.registration().clone();
    controller
        .reserve(Operation::Start, &"d".repeat(64))
        .unwrap();
    controller
        .observe(Operation::Start, "observed-session")
        .unwrap();
    controller
        .reserve(Operation::Submit, &"e".repeat(64))
        .unwrap();
    fs::write(controller.entry().join("output"), b"orphaned result").unwrap();
    assert_eq!(
        controller.retain(b"replacement result").unwrap_err().code,
        ErrorCode::CustodyLost
    );
    assert_eq!(
        fs::read(controller.entry().join("output")).unwrap(),
        b"orphaned result"
    );
    drop(controller);
    let mut reopened = Controller::reopen(root.path(), &registration, &binding()).unwrap();
    assert_eq!(
        reopened.deliver().unwrap_err().code,
        ErrorCode::EffectUnknown
    );
    assert_eq!(
        reopened
            .reserve(Operation::Submit, &"e".repeat(64))
            .unwrap_err()
            .code,
        ErrorCode::EffectUnknown
    );
}
