//! Root-owned, preparation-only Linux custodian control endpoint. The peer may
//! name only an independently provisioned admission, never supply authority,
//! artifact paths, credentials or launch arguments. This endpoint cannot launch.
use crate::{
    Controller, Registration,
    artifact::Snapshot,
    ipc::{Limits, Wire},
};
use harbor_llm_protocol::{Binding, ErrorCode, ProtocolError};
use rustix::fs::{Mode, OFlags, RenameFlags, open, openat, renameat_with};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use std::{
    fs::File,
    io::{Read, Write},
    os::{
        fd::AsRawFd,
        unix::{fs::MetadataExt, net::UnixStream},
    },
    path::{Component, Path, PathBuf},
    time::{Duration, Instant},
};

const MAX_FRAME: usize = 16 * 1024;
const MAX_TIMEOUT_MS: u64 = 60_000;
const MAX_ARTIFACT_BYTES: u64 = 512 * 1024 * 1024;
type Result<T, E = ProtocolError> = std::result::Result<T, E>;
fn reject(code: ErrorCode) -> ProtocolError {
    ProtocolError { code }
}
fn lost() -> ProtocolError {
    reject(ErrorCode::CustodyLost)
}
fn journal(error: crate::Error) -> ProtocolError {
    reject(error.code)
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Config {
    version: u32,
    state_directory: PathBuf,
    admission_directory: PathBuf,
    maximum_artifact_bytes: u64,
    timeout_ms: u64,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Admission {
    version: u32,
    controller_uid: u32,
    binding: Binding,
    engine: PathBuf,
    engine_digest: String,
    output_bytes: u64,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Envelope {
    version: u32,
    request_id: String,
    body: Request,
}
#[derive(Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case", deny_unknown_fields)]
enum Request {
    Describe,
    Prepare { admission: String },
    Reopen { admission: String },
    Launch { admission: String },
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Response {
    version: u32,
    request_id: String,
    body: Reply,
}
#[derive(Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
enum Reply {
    Capabilities {
        prepare: bool,
        launch: bool,
    },
    Prepared {
        registration: Registration,
        artifact_digest: String,
        artifact_bytes: u64,
    },
    Reopened {
        registration: Registration,
    },
    Error {
        code: ErrorCode,
    },
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Receipt {
    admission_digest: String,
    registration: Registration,
}

/// Stable admission filename key for the original authority/namespace/intent.
/// Generations, correlations and artifact changes cannot create retry authority.
/// Only the independently provisioned root-owned file grants preparation.
pub fn admission_id(binding: &Binding) -> Result<String> {
    crate::validate(binding).map_err(journal)?;
    let key = crate::entry(Path::new(""), binding).map_err(journal)?;
    key.to_str().map(str::to_owned).ok_or_else(lost)
}

fn parse<T: DeserializeOwned>(bytes: &[u8]) -> Result<T> {
    // Only bound nesting here; serde owns syntax, duplicates, types and fields.
    let (mut depth, mut string, mut escape) = (0u32, false, false);
    for byte in bytes {
        if string {
            if escape {
                escape = false;
            } else if *byte == b'\\' {
                escape = true;
            } else if *byte == b'"' {
                string = false;
            }
        } else {
            match byte {
                b'"' => string = true,
                b'{' | b'[' => {
                    depth += 1;
                    if depth > 64 {
                        return Err(reject(ErrorCode::InvalidFrame));
                    }
                }
                b'}' | b']' => {
                    depth = depth
                        .checked_sub(1)
                        .ok_or_else(|| reject(ErrorCode::InvalidFrame))?
                }
                _ => (),
            }
        }
    }
    serde_json::from_slice(bytes).map_err(|_| reject(ErrorCode::InvalidFrame))
}

fn safe_directory(path: &Path, owner: u32, private: bool) -> Result<File> {
    if !path.is_absolute() || path.as_os_str().len() > 4096 {
        return Err(lost());
    }
    let mut directory = File::from(
        open(
            "/",
            OFlags::RDONLY | OFlags::DIRECTORY | OFlags::CLOEXEC,
            Mode::empty(),
        )
        .map_err(|_| lost())?,
    );
    for component in path.components() {
        match component {
            Component::RootDir => (),
            Component::Normal(name) => {
                let metadata = directory.metadata().map_err(|_| lost())?;
                // A trusted-owner sticky parent (notably /nix/store) protects
                // existing trusted-owner children from other writers' renames.
                if (metadata.uid() != 0 && metadata.uid() != owner)
                    || (metadata.mode() & 0o022 != 0 && metadata.mode() & 0o1000 == 0)
                {
                    return Err(lost());
                }
                directory = File::from(
                    openat(
                        &directory,
                        name,
                        OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
                        Mode::empty(),
                    )
                    .map_err(|_| lost())?,
                );
            }
            _ => return Err(lost()),
        }
    }
    let metadata = directory.metadata().map_err(|_| lost())?;
    if metadata.uid() != owner
        || (if private {
            metadata.mode() & 0o077 != 0
        } else {
            metadata.mode() & 0o022 != 0 && metadata.mode() & 0o1000 == 0
        })
        || path.canonicalize().map_err(|_| lost())?.as_os_str() != path.as_os_str()
    {
        return Err(lost());
    }
    Ok(directory)
}
fn read_owned(
    directory: &File,
    name: &std::ffi::OsStr,
    owner: u32,
    record: bool,
) -> Result<(Vec<u8>, File)> {
    let anchor = File::from(
        openat(
            directory,
            name,
            OFlags::PATH | OFlags::NOFOLLOW | OFlags::CLOEXEC,
            Mode::empty(),
        )
        .map_err(|_| lost())?,
    );
    let metadata = anchor.metadata().map_err(|_| lost())?;
    if !metadata.is_file()
        // Nix optimizes immutable configuration files through readonly
        // hardlinks. Mutable admission/registration records are always unique.
        || (metadata.nlink() != 1 && (record || metadata.mode() & 0o222 != 0))
        || metadata.uid() != owner
        || metadata.mode() & 0o022 != 0
        || metadata.len() == 0
        || metadata.len() > MAX_FRAME as u64
    {
        return Err(lost());
    }
    let mut file =
        File::open(format!("/proc/self/fd/{}", anchor.as_raw_fd())).map_err(|_| lost())?;
    let mut bytes = Vec::new();
    (&mut file)
        .take(MAX_FRAME as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| lost())?;
    if bytes.len() as u64 != metadata.len() {
        return Err(lost());
    }
    Ok((bytes, file))
}
fn connection_limits(timeout_ms: u64) -> Limits {
    Limits {
        timeout: Duration::from_millis(timeout_ms),
        records: 16,
        bytes: 128 * 1024,
    }
}
fn validate_admission(bytes: &[u8], id: &str, peer_uid: u32) -> Result<Admission> {
    let admission: Admission = parse(bytes)?;
    if admission.version != 1
        || admission_id(&admission.binding)? != id
        || !crate::valid_digest(&admission.engine_digest)
        || !admission.engine.is_absolute()
        || admission.engine.as_os_str().len() > 4096
        || admission.output_bytes == 0
        || admission.output_bytes > crate::OUTPUT_CEILING
    {
        return Err(lost());
    }
    if admission.controller_uid != peer_uid {
        return Err(reject(ErrorCode::AuthorityDenied));
    }
    Ok(admission)
}
fn write_receipt(path: &Path, receipt: &Receipt) -> Result<()> {
    let bytes = serde_json::to_vec(receipt).map_err(|_| lost())?;
    if bytes.len() > MAX_FRAME {
        return Err(reject(ErrorCode::BudgetExhausted));
    }
    let mut temporary =
        tempfile::NamedTempFile::new_in(path.parent().ok_or_else(lost)?).map_err(|_| lost())?;
    temporary.write_all(&bytes).map_err(|_| lost())?;
    temporary.as_file().sync_all().map_err(|_| lost())?;
    temporary.persist_noclobber(path).map_err(|_| lost())?;
    Ok(())
}

struct Held {
    _controller: Controller,
    _image: Snapshot,
}
struct Store {
    config: Config,
    pending: File,
    consumed: File,
    owner: u32,
    peer_uid: u32,
}
impl Store {
    fn prepare(&self, id: &str, timeout: Duration) -> Result<(Held, Reply)> {
        let deadline = Instant::now() + timeout;
        if !crate::valid_digest(id) {
            return Err(reject(ErrorCode::InvalidFrame));
        }
        let name = format!("{id}.json");
        // Any consumed entry, including incomplete state, permanently fences the
        // logical intent. Never recover freshness from a missing runtime store.
        match openat(
            &self.consumed,
            &name,
            OFlags::PATH | OFlags::NOFOLLOW | OFlags::CLOEXEC,
            Mode::empty(),
        ) {
            Ok(_) => return Err(reject(ErrorCode::EffectUnknown)),
            Err(rustix::io::Errno::NOENT) => (),
            Err(_) => return Err(lost()),
        }
        let (bytes, original) = read_owned(&self.pending, name.as_ref(), self.owner, true)?;
        let admission = validate_admission(&bytes, id, self.peer_uid)?;
        original.sync_all().map_err(|_| lost())?;
        renameat_with(
            &self.pending,
            &name,
            &self.consumed,
            &name,
            RenameFlags::NOREPLACE,
        )
        .map_err(|error| {
            if error == rustix::io::Errno::EXIST {
                reject(ErrorCode::EffectUnknown)
            } else {
                lost()
            }
        })?;
        self.pending.sync_all().map_err(|_| lost())?;
        self.consumed.sync_all().map_err(|_| lost())?;
        let (consumed, pinned) = read_owned(&self.consumed, name.as_ref(), self.owner, true)?;
        let before = original.metadata().map_err(|_| lost())?;
        let after = pinned.metadata().map_err(|_| lost())?;
        if consumed != bytes || (before.dev(), before.ino()) != (after.dev(), after.ino()) {
            return Err(lost());
        }
        let controller = Controller::register(
            &self.config.state_directory,
            &admission.binding,
            admission.output_bytes,
        )
        .map_err(journal)?;
        let registration = controller.registration().clone();
        write_receipt(
            &self
                .config
                .admission_directory
                .join("consumed")
                .join(format!("{id}.registration.json")),
            &Receipt {
                admission_digest: crate::digest(&bytes),
                registration: registration.clone(),
            },
        )?;
        self.consumed.sync_all().map_err(|_| lost())?;
        let expected: [u8; 32] = std::array::from_fn(|index| {
            u8::from_str_radix(&admission.engine_digest[index * 2..index * 2 + 2], 16)
                .expect("validated digest")
        });
        let image = Snapshot::capture(
            &admission.engine,
            &expected,
            self.config.maximum_artifact_bytes,
            deadline.saturating_duration_since(Instant::now()),
        )?;
        let reply = Reply::Prepared {
            registration,
            artifact_digest: admission.engine_digest,
            artifact_bytes: image.bytes(),
        };
        Ok((
            Held {
                _controller: controller,
                _image: image,
            },
            reply,
        ))
    }
    fn reopen(&self, id: &str) -> Result<Reply> {
        if !crate::valid_digest(id) {
            return Err(reject(ErrorCode::InvalidFrame));
        }
        let (bytes, _) = read_owned(
            &self.consumed,
            format!("{id}.json").as_ref(),
            self.owner,
            true,
        )?;
        let admission = validate_admission(&bytes, id, self.peer_uid)?;
        let (bytes_receipt, _) = read_owned(
            &self.consumed,
            format!("{id}.registration.json").as_ref(),
            self.owner,
            true,
        )?;
        let receipt: Receipt = parse(&bytes_receipt)?;
        if receipt.admission_digest != crate::digest(&bytes) {
            return Err(lost());
        }
        let controller = Controller::reopen(
            &self.config.state_directory,
            &receipt.registration,
            &admission.binding,
        )
        .map_err(journal)?;
        Ok(Reply::Reopened {
            registration: controller.registration().clone(),
        })
    }
}

/// Serve one systemd-accepted private Unix connection as root. The configuration
/// and every admission/state ancestor must be root-owned with protected children
/// (non-writable or sticky). Ledger/state leaves remain private. Admission files
/// are an independent root-provisioned ledger;
/// kernel peer credentials select their controller UID but never grant admission.
///
/// This endpoint supports preparation and journal observations only. It does not
/// authenticate specialist worker custody, launch a backend or broker secrets.
/// Run it in the module's time/memory-bounded service, not an unbounded daemon:
/// filesystem setup needs an independently killable process boundary.
pub fn serve(configuration: &Path, stream: UnixStream) -> Result<()> {
    if !rustix::process::geteuid().is_root() {
        return Err(reject(ErrorCode::AuthorityDenied));
    }
    let directory = safe_directory(configuration.parent().ok_or_else(lost)?, 0, false)?;
    let (bytes, _) = read_owned(
        &directory,
        configuration.file_name().ok_or_else(lost)?,
        0,
        false,
    )?;
    serve_owned(parse(&bytes)?, stream, 0)
}
fn serve_owned(config: Config, stream: UnixStream, owner: u32) -> Result<()> {
    if config.version != 1
        || config.timeout_ms == 0
        || config.timeout_ms > MAX_TIMEOUT_MS
        || config.maximum_artifact_bytes == 0
        || config.maximum_artifact_bytes > MAX_ARTIFACT_BYTES
    {
        return Err(reject(ErrorCode::BudgetExhausted));
    }
    if config
        .state_directory
        .starts_with(&config.admission_directory)
        || config
            .admission_directory
            .starts_with(&config.state_directory)
    {
        return Err(lost());
    }
    safe_directory(&config.state_directory, owner, true)?;
    safe_directory(&config.admission_directory, owner, true)?;
    let pending = safe_directory(&config.admission_directory.join("pending"), owner, true)?;
    let consumed = safe_directory(&config.admission_directory.join("consumed"), owner, true)?;
    let peer_uid = rustix::net::sockopt::socket_peercred(&stream)
        .map_err(|_| reject(ErrorCode::AuthorityDenied))?
        .uid
        .as_raw();
    let limits = connection_limits(config.timeout_ms);
    let store = Store {
        config,
        pending,
        consumed,
        owner,
        peer_uid,
    };
    let mut wire = Wire::new(stream, limits)?;
    let mut held = None;
    while let Some(bytes) = wire.receive(MAX_FRAME)? {
        let request: Envelope = parse(&bytes)?;
        if request.version != 1 || !crate::valid_receipt(&request.request_id) {
            return Err(reject(ErrorCode::InvalidFrame));
        }
        let reply = match request.body {
            Request::Describe => Ok(Reply::Capabilities {
                prepare: true,
                launch: false,
            }),
            Request::Prepare { admission } => {
                if held.is_some() {
                    Err(reject(ErrorCode::EffectUnknown))
                } else {
                    store
                        .prepare(&admission, wire.remaining()?)
                        .map(|(custody, reply)| {
                            held = Some(custody);
                            reply
                        })
                }
            }
            Request::Reopen { admission } => store.reopen(&admission),
            Request::Launch { .. } => Err(reject(ErrorCode::UnsupportedCapability)),
        };
        let failed = reply.is_err();
        let response = Response {
            version: 1,
            request_id: request.request_id,
            body: reply.unwrap_or_else(|error| Reply::Error { code: error.code }),
        };
        let bytes = serde_json::to_vec(&response).map_err(|_| lost())?;
        if bytes.len() > MAX_FRAME {
            return Err(reject(ErrorCode::BudgetExhausted));
        }
        wire.send(&bytes)?;
        if failed {
            return Ok(());
        }
    }
    Ok(())
}

#[cfg(test)]
#[path = "custodian_tests.rs"]
mod tests;

#[cfg(all(test, feature = "native-conformance"))]
#[path = "native_tests.rs"]
mod native_tests;
