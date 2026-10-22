//! Kernel seals preserve exact launch bytes after source replacement.
#![cfg(target_os = "linux")]
use harbor_llm_protocol::ErrorCode;
use harbor_llm_runtime::artifact::Snapshot;
use rustix::fs::{SealFlags, fcntl_get_seals};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::{Read, Write},
    os::{
        fd::{AsFd, AsRawFd},
        unix::fs::symlink,
    },
    path::{Path, PathBuf},
    process::Command,
    time::{Duration, Instant},
};

fn digest(bytes: &[u8]) -> [u8; 32] {
    Sha256::digest(bytes).into()
}
fn root() -> tempfile::TempDir {
    tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap()
}
fn descriptor(snapshot: &Snapshot) -> PathBuf {
    PathBuf::from(format!("/proc/self/fd/{}", snapshot.as_fd().as_raw_fd()))
}
fn capture(
    path: &Path,
    expected: &[u8; 32],
    maximum_bytes: u64,
) -> Result<Snapshot, harbor_llm_protocol::ProtocolError> {
    Snapshot::capture(path, expected, maximum_bytes, Duration::from_secs(2))
}

#[test]
fn source_replacement_and_in_place_changes_cannot_change_the_sealed_snapshot() {
    let root = root();
    let path = root.path().join("artifact");
    fs::write(&path, b"original exact bytes").unwrap();
    let snapshot = capture(&path, &digest(b"original exact bytes"), 1024).unwrap();
    fs::write(&path, b"changed inode contents").unwrap();
    fs::remove_file(&path).unwrap();
    fs::write(&path, b"replacement inode").unwrap();
    assert_eq!(
        fs::read(descriptor(&snapshot)).unwrap(),
        b"original exact bytes"
    );
    assert_eq!(snapshot.digest(), digest(b"original exact bytes"));
    assert_eq!(snapshot.bytes(), 20);
    assert!(fcntl_get_seals(&snapshot).unwrap().contains(
        SealFlags::WRITE | SealFlags::GROW | SealFlags::SHRINK | SealFlags::SEAL | SealFlags::EXEC
    ));
    assert!(
        rustix::io::fcntl_getfd(&snapshot)
            .unwrap()
            .contains(rustix::io::FdFlags::CLOEXEC)
    );
    // Write permission alone cannot bypass F_SEAL_WRITE, while F_SEAL_EXEC
    // protects the executable bits rather than all chmod permission changes.
    rustix::fs::fchmod(
        &snapshot,
        rustix::fs::Mode::RUSR | rustix::fs::Mode::WUSR | rustix::fs::Mode::XUSR,
    )
    .unwrap();
    let mut writable = fs::OpenOptions::new()
        .write(true)
        .open(descriptor(&snapshot))
        .unwrap();
    assert!(writable.write_all(b"replacement").is_err());
    assert!(writable.set_len(1).is_err());
    assert!(
        rustix::fs::fchmod(&snapshot, rustix::fs::Mode::RUSR | rustix::fs::Mode::WUSR).is_err()
    );
    let mut duplicate = fs::File::from(rustix::io::dup(&snapshot).unwrap());
    let mut bytes = Vec::new();
    duplicate.read_to_end(&mut bytes).unwrap();
    assert_eq!(
        bytes, b"original exact bytes",
        "captured descriptor starts at byte zero"
    );
}

#[test]
fn invalid_bounds_changed_bytes_and_nonregular_sources_never_return_a_snapshot() {
    let root = root();
    let path = root.path().join("artifact");
    fs::write(&path, b"original").unwrap();
    assert!(
        matches!(capture(&path, &digest(b"other"), 100), Err(error) if error.code == ErrorCode::CustodyLost)
    );
    for maximum in [0, 7, 512 * 1024 * 1024 + 1] {
        assert!(
            matches!(capture(&path, &digest(b"original"), maximum), Err(error) if error.code == ErrorCode::BudgetExhausted)
        );
    }
    for timeout in [Duration::ZERO, Duration::from_secs(3601)] {
        assert!(Snapshot::capture(&path, &digest(b"original"), 100, timeout).is_err());
    }
    let link = root.path().join("link");
    symlink(&path, &link).unwrap();
    let fifo = root.path().join("fifo");
    rustix::fs::mkfifoat(
        rustix::fs::CWD,
        &fifo,
        rustix::fs::Mode::RUSR | rustix::fs::Mode::WUSR,
    )
    .unwrap();
    let empty = root.path().join("empty");
    fs::write(&empty, b"").unwrap();
    let started = Instant::now();
    for invalid in [&link, &fifo, &empty, root.path(), Path::new("relative")] {
        assert!(
            matches!(capture(invalid, &digest(b"original"), 100), Err(error) if error.code == ErrorCode::CustodyLost)
        );
    }
    assert!(
        started.elapsed() < Duration::from_secs(1),
        "opening a FIFO must not wait for a writer"
    );
}

#[test]
fn the_sealed_native_image_executes_after_its_original_path_is_removed() {
    let root = root();
    let path = root.path().join("native");
    let bytes = fs::read(std::env::current_exe().unwrap()).unwrap();
    fs::write(&path, &bytes).unwrap();
    let snapshot = Snapshot::capture(
        &path,
        &digest(&bytes),
        512 * 1024 * 1024,
        Duration::from_secs(10),
    )
    .unwrap();
    fs::remove_file(&path).unwrap();
    // The custodian retains the descriptor throughout launch/execution. This
    // test executes only this test binary, never arbitrary fixture contents.
    let executable = format!(
        "/proc/{}/fd/{}",
        std::process::id(),
        snapshot.as_fd().as_raw_fd()
    );
    let mut child = Command::new(executable)
        .args(["--exact", "native_image_child", "--nocapture"])
        .env_clear()
        .env("HARBOR_ARTIFACT_CHILD", "1")
        .stdout(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    let started = Instant::now();
    while child.try_wait().unwrap().is_none() {
        if started.elapsed() > Duration::from_secs(2) {
            child.kill().unwrap();
            child.wait().unwrap();
            panic!("native snapshot child stalled");
        }
        std::thread::sleep(Duration::from_millis(5));
    }
    let mut output = String::new();
    child
        .stdout
        .take()
        .unwrap()
        .take(4096)
        .read_to_string(&mut output)
        .unwrap();
    assert!(child.wait().unwrap().success());
    assert!(output.contains("exact-snapshot-child"));
}

#[test]
fn native_image_child() {
    if std::env::var_os("HARBOR_ARTIFACT_CHILD").is_some() {
        println!("exact-snapshot-child");
    }
}
