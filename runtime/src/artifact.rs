//! Linux sealed launch images. This pins artifact bytes, not caller admission,
//! process identity, dynamic dependencies, source provenance or worker custody.
use harbor_llm_protocol::{ErrorCode, ProtocolError};
use rustix::fs::{
    MemfdFlags, Mode, OFlags, SealFlags, fchmod, fcntl_add_seals, fcntl_get_seals, memfd_create,
    open,
};
use sha2::{Digest, Sha256};
use std::{
    fs::File,
    io::{Read, Seek, Write},
    os::fd::{AsFd, AsRawFd, BorrowedFd},
    path::Path,
    time::{Duration, Instant},
};

// The selected native engine is larger than a wire payload. Consumers may
// tighten this independent artifact ceiling; it cannot raise message budgets.
const MAX_BYTES: u64 = 512 * 1024 * 1024;
fn lost() -> ProtocolError {
    ProtocolError {
        code: ErrorCode::CustodyLost,
    }
}
fn budget() -> ProtocolError {
    ProtocolError {
        code: ErrorCode::BudgetExhausted,
    }
}
fn descriptor(file: &File) -> String {
    format!("/proc/self/fd/{}", file.as_raw_fd())
}
fn remaining(deadline: Instant) -> Result<(), ProtocolError> {
    if Instant::now() >= deadline {
        Err(budget())
    } else {
        Ok(())
    }
}

/// An exact digest-verified anonymous Linux image with kernel-enforced write,
/// size, seal and execution-mode immutability. The descriptor is close-on-exec.
/// Keep this owner alive through launch and the supervised execution lifetime.
/// No pathname is reopened after capture to recover artifact authority.
pub struct Snapshot {
    file: File,
    digest: [u8; 32],
    bytes: u64,
}
impl Snapshot {
    /// Capture one nonempty regular artifact, then seal and independently hash
    /// the resulting image before returning it. Never executes its contents.
    /// Requires Linux memfd execution seals (6.3+); no mutable-file fallback.
    ///
    /// `expected` must come from trusted application/artifact qualification, not
    /// from the potentially replaced path. The host custodian must run capture
    /// inside its killable setup phase: cooperative deadlines cannot interrupt
    /// a kernel-blocked source read. ELF dependencies and a bridge's transitive
    /// imports require their own retained immutable closure custody.
    pub fn capture(
        path: &Path,
        expected: &[u8; 32],
        maximum_bytes: u64,
        timeout: Duration,
    ) -> Result<Self, ProtocolError> {
        let policy: serde_json::Value = serde_json::from_str(harbor_llm_protocol::TRANSPORT_POLICY)
            .expect("checked-in transport policy");
        if maximum_bytes == 0
            || maximum_bytes > MAX_BYTES
            || timeout.is_zero()
            || timeout > Duration::from_millis(policy["maxTimeoutMs"].as_u64().unwrap())
        {
            return Err(budget());
        }
        let deadline = Instant::now() + timeout;
        if !path.is_absolute() {
            return Err(lost());
        }
        // O_PATH never opens a device or waits for a FIFO writer. Inspect that
        // pinned object before obtaining a readable descriptor for the same inode.
        let anchor = File::from(
            open(
                path,
                OFlags::PATH | OFlags::NOFOLLOW | OFlags::CLOEXEC,
                Mode::empty(),
            )
            .map_err(|_| lost())?,
        );
        let metadata = anchor.metadata().map_err(|_| lost())?;
        if !metadata.is_file() || metadata.len() == 0 {
            return Err(lost());
        }
        if metadata.len() > maximum_bytes {
            return Err(budget());
        }
        let mut source = File::open(descriptor(&anchor)).map_err(|_| lost())?;
        let mut image = File::from(
            memfd_create(
                "harbor-llm-artifact",
                MemfdFlags::CLOEXEC | MemfdFlags::ALLOW_SEALING | MemfdFlags::EXEC,
            )
            .map_err(|_| ProtocolError {
                code: ErrorCode::UnsupportedCapability,
            })?,
        );
        fchmod(&image, Mode::RUSR | Mode::WUSR).map_err(|_| lost())?;
        let mut buffer = [0; 65536];
        let mut bytes = 0;
        loop {
            remaining(deadline)?;
            let count = source.read(&mut buffer).map_err(|_| lost())?;
            if count == 0 {
                break;
            }
            bytes += count as u64;
            if bytes > maximum_bytes {
                return Err(budget());
            }
            image.write_all(&buffer[..count]).map_err(|_| lost())?;
        }
        if bytes != metadata.len() {
            return Err(lost());
        }
        fchmod(&image, Mode::RUSR | Mode::XUSR).map_err(|_| lost())?;
        let seals = SealFlags::WRITE
            | SealFlags::GROW
            | SealFlags::SHRINK
            | SealFlags::SEAL
            | SealFlags::EXEC;
        fcntl_add_seals(&image, seals).map_err(|_| lost())?;
        if !fcntl_get_seals(&image).map_err(|_| lost())?.contains(seals) {
            return Err(lost());
        }
        let mut file = File::open(descriptor(&image)).map_err(|_| lost())?;
        drop(image);
        if file.metadata().map_err(|_| lost())?.len() != bytes {
            return Err(lost());
        }
        // Hash the sealed image, not just the source stream copied into it.
        let mut hash = Sha256::new();
        loop {
            remaining(deadline)?;
            let count = file.read(&mut buffer).map_err(|_| lost())?;
            if count == 0 {
                break;
            }
            hash.update(&buffer[..count]);
        }
        let digest: [u8; 32] = hash.finalize().into();
        if digest != *expected {
            return Err(lost());
        }
        file.rewind().map_err(|_| lost())?;
        remaining(deadline)?;
        Ok(Self {
            file,
            digest,
            bytes,
        })
    }
    /// SHA-256 of the immutable image, independently read back after sealing.
    pub fn digest(&self) -> [u8; 32] {
        self.digest
    }
    /// Exact complete image length, independent of mutable source metadata.
    pub fn bytes(&self) -> u64 {
        self.bytes
    }
}
impl AsFd for Snapshot {
    fn as_fd(&self) -> BorrowedFd<'_> {
        self.file.as_fd()
    }
}
