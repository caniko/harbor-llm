//! Durable, fail-closed controller accounting. This library performs no backend
//! operation. Callers authenticate admission and protect the store and its parent
//! directories from backend/daemon writers for the entire execution lifetime.
//! Persist the original registration in an independent application ledger before
//! dispatch. Missing state is never permission to register a replacement intent.

#[cfg(not(unix))]
compile_error!("harbor-llm-runtime requires Unix private files and kernel locks");

pub mod ipc;

#[cfg(target_os = "linux")]
pub mod artifact;

#[cfg(target_os = "linux")]
pub mod custodian;

#[cfg(target_os = "linux")]
pub mod standalone;

use fs2::FileExt;
use harbor_llm_protocol::commands::{
    self, CommandBody, Effect, EffectReceipt, EffectState, TransferPurpose,
};
use harbor_llm_protocol::{Binding, Body, ErrorCode, Message, OutputReceipt, encode};
use rustix::fs::{Mode, OFlags, open};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fmt,
    fs::{self, File},
    io::{Read, Write},
    os::unix::fs::{DirBuilderExt, MetadataExt},
    path::{Path, PathBuf},
};

const JOURNAL_BYTES: u64 = 16 * 1024;
const OUTPUT_CEILING: u64 = 16 * 1024 * 1024;

/// Redacted failure; filesystem paths, native errors and output are not attached.
#[derive(Debug, PartialEq, Eq)]
pub struct Error {
    /// Stable protocol failure class.
    pub code: ErrorCode,
}
impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "execution journal rejected: {:?}", self.code)
    }
}
impl std::error::Error for Error {}
type Result<T> = std::result::Result<T, Error>;
fn lost() -> Error {
    Error {
        code: ErrorCode::CustodyLost,
    }
}
fn unknown() -> Error {
    Error {
        code: ErrorCode::EffectUnknown,
    }
}

/// At most one reservation of each operation in this execution generation.
/// Multi-turn applications allocate independent admitted executions; a transport
/// correlation ID must never be used to manufacture a fresh application intent.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Operation {
    /// Create/launch the exact backend execution.
    Start,
    /// Admit the prompt exactly once; this does not release model execution.
    Submit,
    /// Release the observed admitted input once, using the same input digest.
    Execute,
    /// Request interruption exactly once; not proof of descendant cleanup.
    Interrupt,
}

/// Durable observation of one reserved effect. Neither state allows replay.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum State {
    /// Effects may have happened, even if no process was actually started.
    Unknown,
    /// The caller retained an authoritative bound receipt; not app completion.
    Observed,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Identity {
    device: u64,
    inode: u64,
}
fn identity(file: &File) -> Result<Identity> {
    let metadata = file.metadata().map_err(|_| lost())?;
    Ok(Identity {
        device: metadata.dev(),
        inode: metadata.ino(),
    })
}

/// Original store identity. Persist independently in the application's ledger.
/// This is a custody observation, not a grant of application execution authority.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Registration {
    version: u32,
    binding: Binding,
    output_limit: u64,
    root: Identity,
    directory: Identity,
    lock: Identity,
    lock_nonce: Vec<u8>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Intent {
    digest: String,
    receipt: Option<String>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Journal {
    registration: Registration,
    operations: BTreeMap<Operation, Intent>,
    retained: Option<OutputReceipt>,
}

fn private(path: &Path, directory: bool, writable: bool) -> Result<File> {
    let flags = if writable {
        OFlags::RDWR
    } else {
        OFlags::RDONLY
    } | OFlags::NOFOLLOW
        | OFlags::CLOEXEC
        | OFlags::NONBLOCK
        | if directory {
            OFlags::DIRECTORY
        } else {
            OFlags::empty()
        };
    let file = File::from(open(path, flags, Mode::empty()).map_err(|_| lost())?);
    let metadata = file.metadata().map_err(|_| lost())?;
    if metadata.uid() != rustix::process::geteuid().as_raw()
        || metadata.mode() & 0o077 != 0
        || (directory && !metadata.is_dir())
        || (!directory && (!metadata.is_file() || metadata.nlink() != 1))
    {
        return Err(lost());
    }
    Ok(file)
}
fn read(path: &Path, limit: u64) -> Result<Vec<u8>> {
    let file = private(path, false, false)?;
    if file.metadata().map_err(|_| lost())?.len() > limit {
        return Err(lost());
    }
    let mut bytes = Vec::new();
    file.take(limit + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| lost())?;
    if bytes.len() as u64 > limit {
        return Err(lost());
    }
    Ok(bytes)
}
fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn entry(root: &Path, binding: &Binding) -> Result<PathBuf> {
    let logical = (
        &binding.caller_authority,
        &binding.caller_namespace,
        &binding.intent_id,
    );
    let bytes = serde_json::to_vec(&logical).map_err(|_| lost())?;
    Ok(root.join(digest(&bytes)))
}
fn validate(binding: &Binding) -> Result<()> {
    let message = Message {
        schema_version: 1,
        request_id: "journal-validation".into(),
        body: Body::OutputReceipt(OutputReceipt {
            binding: binding.clone(),
            output_digest: "0".repeat(64),
            output_bytes: "0".into(),
        }),
    };
    encode(&message).map(|_| ()).map_err(|_| Error {
        code: ErrorCode::InvalidFrame,
    })
}

/// Exclusive controller handle. The kernel lock lives until drop; it is never
/// unlinked. Reopen reads only existing files and makes zero provider/tool calls.
pub struct Controller {
    root: PathBuf,
    entry: PathBuf,
    lock: File,
    journal: Journal,
    poisoned: bool,
    fresh: bool,
    durable: Option<(Identity, String)>,
}

impl Controller {
    /// Register a newly admitted intent. Caller must already hold original
    /// application admission; this does not implement or replace its ledger.
    /// An existing or partly initialized entry always fails closed.
    pub fn register(root: &Path, binding: &Binding, output_limit: u64) -> Result<Self> {
        validate(binding)?;
        if output_limit == 0 || output_limit > OUTPUT_CEILING {
            return Err(Error {
                code: ErrorCode::BudgetExhausted,
            });
        }
        let root_file = private(root, true, false)?;
        if !root.is_absolute() || root.canonicalize().map_err(|_| lost())? != root {
            return Err(lost());
        }
        let entry = entry(root, binding)?;
        fs::DirBuilder::new()
            .mode(0o700)
            .create(&entry)
            .map_err(|_| lost())?;
        root_file.sync_all().map_err(|_| lost())?;
        let directory = private(&entry, true, false)?;
        let lock = File::from(
            open(
                entry.join("execution.lock"),
                OFlags::RDWR | OFlags::CREATE | OFlags::EXCL | OFlags::NOFOLLOW | OFlags::CLOEXEC,
                Mode::RUSR | Mode::WUSR,
            )
            .map_err(|_| lost())?,
        );
        lock.try_lock_exclusive().map_err(|_| lost())?;
        let mut nonce = vec![0; 32];
        getrandom::fill(&mut nonce).map_err(|_| lost())?;
        (&lock).write_all(&nonce).map_err(|_| lost())?;
        lock.sync_all().map_err(|_| lost())?;
        directory.sync_all().map_err(|_| lost())?;
        let registration = Registration {
            version: 1,
            binding: binding.clone(),
            output_limit,
            root: identity(&root_file)?,
            directory: identity(&directory)?,
            lock: identity(&lock)?,
            lock_nonce: nonce,
        };
        let mut controller = Self {
            root: root.to_owned(),
            entry,
            lock,
            poisoned: false,
            fresh: true,
            durable: None,
            journal: Journal {
                registration,
                operations: BTreeMap::new(),
                retained: None,
            },
        };
        controller.save()?;
        Ok(controller)
    }

    /// Reopen only the original registered state under its original binding.
    /// Never creates state, observes a server or releases an execution effect.
    /// Missing operation entries do not grant fresh dispatch permission.
    pub fn reopen(root: &Path, registration: &Registration, binding: &Binding) -> Result<Self> {
        validate(binding)?;
        if registration.version != 1
            || &registration.binding != binding
            || registration.output_limit == 0
            || registration.output_limit > OUTPUT_CEILING
            || registration.lock_nonce.len() != 32
        {
            return Err(lost());
        }
        let entry = entry(root, binding)?;
        let lock = private(&entry.join("execution.lock"), false, true)?;
        lock.try_lock_exclusive().map_err(|_| lost())?;
        let bytes = read(&entry.join("journal.json"), JOURNAL_BYTES)?;
        let journal: Journal = serde_json::from_slice(&bytes).map_err(|_| lost())?;
        if &journal.registration != registration {
            return Err(lost());
        }
        let journal_identity = identity(&private(&entry.join("journal.json"), false, false)?)?;
        let controller = Self {
            root: root.to_owned(),
            entry,
            lock,
            journal,
            poisoned: false,
            fresh: false,
            durable: Some((journal_identity, digest(&bytes))),
        };
        controller.check()?;
        controller.validate_journal()?;
        Ok(controller)
    }

    /// Original registration, for the independent admission ledger.
    pub fn registration(&self) -> &Registration {
        &self.journal.registration
    }
    /// Controller-private entry path, for evidence inspection only.
    pub fn entry(&self) -> &Path {
        &self.entry
    }
    /// Last durable operation state. This observation never grants replay.
    pub fn state(&self, operation: Operation) -> Option<State> {
        self.journal.operations.get(&operation).map(|intent| {
            if intent.receipt.is_some() {
                State::Observed
            } else {
                State::Unknown
            }
        })
    }

    /// Original effect input digest and observed receipt, for read-only recovery.
    /// The caller verifies this evidence against the original application intent.
    pub fn receipt(&self, operation: Operation) -> Option<(&str, Option<&str>)> {
        self.journal
            .operations
            .get(&operation)
            .map(|intent| (intent.digest.as_str(), intent.receipt.as_deref()))
    }

    fn validate_journal(&self) -> Result<()> {
        for (operation, intent) in &self.journal.operations {
            if !valid_digest(&intent.digest)
                || intent
                    .receipt
                    .as_ref()
                    .is_some_and(|receipt| !valid_receipt(receipt))
            {
                return Err(lost());
            }
            if *operation != Operation::Start
                && self.state(Operation::Start) != Some(State::Observed)
            {
                return Err(lost());
            }
        }
        if self.journal.operations.contains_key(&Operation::Interrupt)
            && !self.journal.operations.contains_key(&Operation::Submit)
        {
            return Err(lost());
        }
        if let Some(execution) = self.journal.operations.get(&Operation::Execute) {
            if self.state(Operation::Submit) != Some(State::Observed)
                || self
                    .journal
                    .operations
                    .get(&Operation::Submit)
                    .map(|intent| &intent.digest)
                    != Some(&execution.digest)
            {
                return Err(lost());
            }
        }
        if let Some(receipt) = &self.journal.retained {
            if receipt.binding != self.journal.registration.binding
                || !valid_digest(&receipt.output_digest)
                || receipt
                    .output_bytes
                    .parse::<u64>()
                    .ok()
                    .is_none_or(|n| n == 0 || n > self.journal.registration.output_limit)
                || !self.journal.operations.contains_key(&Operation::Submit)
                || self.journal.operations.contains_key(&Operation::Interrupt)
            {
                return Err(lost());
            }
        }
        Ok(())
    }

    fn check(&self) -> Result<()> {
        if self.poisoned {
            return Err(lost());
        }
        let expected = &self.journal.registration;
        if !self.root.is_absolute()
            || self.root.canonicalize().map_err(|_| lost())? != self.root
            || identity(&private(&self.root, true, false)?)? != expected.root
            || identity(&private(&self.entry, true, false)?)? != expected.directory
            || identity(&private(&self.entry.join("execution.lock"), false, true)?)?
                != expected.lock
            || identity(&self.lock)? != expected.lock
            || read(&self.entry.join("execution.lock"), 32)? != expected.lock_nonce
        {
            return Err(lost());
        }
        if let Some((expected_identity, expected_digest)) = &self.durable {
            if identity(&private(&self.entry.join("journal.json"), false, false)?)?
                != *expected_identity
                || digest(&read(&self.entry.join("journal.json"), JOURNAL_BYTES)?)
                    != *expected_digest
            {
                return Err(lost());
            }
        }
        Ok(())
    }

    fn save(&mut self) -> Result<()> {
        let result = (|| {
            self.check()?;
            self.validate_journal()?;
            let bytes = serde_json::to_vec(&self.journal).map_err(|_| lost())?;
            if bytes.len() as u64 > JOURNAL_BYTES {
                return Err(Error {
                    code: ErrorCode::BudgetExhausted,
                });
            }
            let mut temporary = tempfile::NamedTempFile::new_in(&self.entry).map_err(|_| lost())?;
            temporary.write_all(&bytes).map_err(|_| lost())?;
            temporary.as_file().sync_all().map_err(|_| lost())?;
            if self.durable.is_some() {
                temporary
                    .persist(self.entry.join("journal.json"))
                    .map_err(|_| lost())?;
            } else {
                temporary
                    .persist_noclobber(self.entry.join("journal.json"))
                    .map_err(|_| lost())?;
            }
            private(&self.entry, true, false)?
                .sync_all()
                .map_err(|_| lost())?;
            self.durable = Some((
                identity(&private(&self.entry.join("journal.json"), false, false)?)?,
                digest(&bytes),
            ));
            self.check()
        })();
        if result.is_err() {
            self.poisoned = true;
        }
        result
    }

    /// Reserve and fsync one initial command before invoking its exchange exactly
    /// once. The callback must use the original private authenticated bridge and
    /// independently enforce its I/O deadline and process custody. This method
    /// neither launches nor reconnects anything. A lost, rejected or mismatched
    /// reply leaves UNKNOWN; reopening cannot dispatch an absent initial operation.
    /// Handles are the registered execution ID. Submit/execute bind the identical
    /// canonical `(handle, inbox ID, input-byte digest)` tuple, not correlation IDs.
    /// Cancellation/revocation/closure need separate current-authority integration.
    pub fn dispatch_initial(
        &mut self,
        command: &commands::Command,
        exchange: impl FnOnce(
            &commands::Command,
        ) -> std::result::Result<
            commands::Command,
            harbor_llm_protocol::ProtocolError,
        >,
    ) -> Result<EffectReceipt> {
        self.check()?;
        commands::encode(command).map_err(|error| Error { code: error.code })?;
        if command.binding != self.journal.registration.binding {
            return Err(Error {
                code: ErrorCode::AuthorityDenied,
            });
        }
        let target_digest = |handle: &str, inbox: &str, input: &str| -> Result<String> {
            if handle != command.binding.execution_id {
                return Err(Error {
                    code: ErrorCode::AuthorityDenied,
                });
            }
            Ok(digest(
                &serde_json::to_vec(&(handle, inbox, input)).map_err(|_| lost())?,
            ))
        };
        let (operation, effect, input_digest) = match &command.body {
            CommandBody::Create(create)
                if create.configuration.purpose == TransferPurpose::Configuration =>
            {
                (
                    Operation::Start,
                    Effect::Create,
                    create.configuration.digest.clone(),
                )
            }
            CommandBody::Submit(submit) if submit.input.purpose == TransferPurpose::Input => (
                Operation::Submit,
                Effect::Submit,
                target_digest(&submit.handle, &submit.inbox_id, &submit.input.digest)?,
            ),
            CommandBody::Execute(execute) => (
                Operation::Execute,
                Effect::Execute,
                target_digest(&execute.handle, &execute.inbox_id, &execute.input_digest)?,
            ),
            _ => {
                return Err(Error {
                    code: ErrorCode::UnsupportedCapability,
                });
            }
        };
        self.dispatch_effect(command, operation, effect, &input_digest, exchange)
    }

    /// Interrupt only the original execution after independently validating the
    /// current application's cancellation grant. `current_authority` is supplied
    /// by that authorizer, never reconstructed from the journal or a peer string.
    /// Reopened controllers may interrupt, but never replay initial effects. Lost
    /// replies remain UNKNOWN and this grant cannot be used to retry interruption.
    pub fn dispatch_interrupt(
        &mut self,
        command: &commands::Command,
        current_authority: &str,
        exchange: impl FnOnce(
            &commands::Command,
        ) -> std::result::Result<
            commands::Command,
            harbor_llm_protocol::ProtocolError,
        >,
    ) -> Result<EffectReceipt> {
        self.check()?;
        commands::encode(command).map_err(|error| Error { code: error.code })?;
        let CommandBody::Interrupt(cancel) = &command.body else {
            return Err(Error {
                code: ErrorCode::UnsupportedCapability,
            });
        };
        if command.binding != self.journal.registration.binding
            || cancel.handle != command.binding.execution_id
            || !valid_digest(current_authority)
            || cancel.authority_digest != current_authority
        {
            return Err(Error {
                code: ErrorCode::AuthorityDenied,
            });
        }
        let input_digest = digest(
            &serde_json::to_vec(&(cancel.handle.as_str(), current_authority))
                .map_err(|_| lost())?,
        );
        self.dispatch_effect(
            command,
            Operation::Interrupt,
            Effect::Interrupt,
            &input_digest,
            exchange,
        )
    }

    fn dispatch_effect(
        &mut self,
        command: &commands::Command,
        operation: Operation,
        effect: Effect,
        input_digest: &str,
        exchange: impl FnOnce(
            &commands::Command,
        ) -> std::result::Result<
            commands::Command,
            harbor_llm_protocol::ProtocolError,
        >,
    ) -> Result<EffectReceipt> {
        self.reserve(operation, input_digest)?;
        let reply = exchange(command).map_err(|_| unknown())?;
        if commands::encode(&reply).is_err()
            || reply.request_id != command.request_id
            || reply.binding != command.binding
        {
            return Err(unknown());
        }
        let CommandBody::Receipt(receipt) = reply.body else {
            return Err(unknown());
        };
        if receipt.operation != effect || receipt.state != EffectState::Observed {
            return Err(unknown());
        }
        self.observe(operation, &receipt.receipt_digest)?;
        Ok(receipt)
    }

    /// Commit UNKNOWN and fsync file/directory before the caller may release the
    /// exact operation. Any error forbids the effect; no state allows repetition.
    /// Reopened handles may reserve only caller-authorized interruption against
    /// the original execution, never fresh start/submission/execution work.
    pub fn reserve(&mut self, operation: Operation, input_digest: &str) -> Result<()> {
        self.check()?;
        if !valid_digest(input_digest) {
            return Err(Error {
                code: ErrorCode::InvalidFrame,
            });
        }
        if (!self.fresh && operation != Operation::Interrupt)
            || self.journal.operations.contains_key(&operation)
            || self.journal.retained.is_some()
            || self.journal.operations.contains_key(&Operation::Interrupt)
        {
            return Err(unknown());
        }
        if operation != Operation::Start && self.state(Operation::Start) != Some(State::Observed) {
            return Err(unknown());
        }
        if operation == Operation::Interrupt && self.state(Operation::Submit).is_none() {
            return Err(unknown());
        }
        if operation == Operation::Execute {
            if self.state(Operation::Submit) != Some(State::Observed) {
                return Err(unknown());
            }
            if self
                .journal
                .operations
                .get(&Operation::Submit)
                .map(|intent| intent.digest.as_str())
                != Some(input_digest)
            {
                return Err(Error {
                    code: ErrorCode::InvalidFrame,
                });
            }
        }
        self.journal.operations.insert(
            operation,
            Intent {
                digest: input_digest.into(),
                receipt: None,
            },
        );
        self.save()
    }

    /// Retain an authoritative caller-validated receipt, without making a backend
    /// call or authorizing replay. Its meaning and target identity are app policy.
    pub fn observe(&mut self, operation: Operation, receipt: &str) -> Result<()> {
        self.check()?;
        if !valid_receipt(receipt) {
            return Err(Error {
                code: ErrorCode::InvalidFrame,
            });
        }
        let intent = self
            .journal
            .operations
            .get_mut(&operation)
            .ok_or_else(unknown)?;
        if let Some(previous) = &intent.receipt {
            return if previous == receipt {
                Ok(())
            } else {
                Err(lost())
            };
        }
        intent.receipt = Some(receipt.into());
        self.save()
    }

    /// Atomically retain complete application-validated output before delivery.
    /// This never infers semantic success from idle, exit, tokens or an HTTP reply.
    /// Orphaned output after a crash is preserved and cannot be silently replaced.
    pub fn retain(&mut self, bytes: &[u8]) -> Result<OutputReceipt> {
        self.check()?;
        if bytes.is_empty() || bytes.len() as u64 > self.journal.registration.output_limit {
            return Err(Error {
                code: ErrorCode::BudgetExhausted,
            });
        }
        if self.state(Operation::Submit).is_none() || self.state(Operation::Interrupt).is_some() {
            return Err(unknown());
        }
        if let Some(receipt) = &self.journal.retained {
            return if self.deliver()? == bytes {
                Ok(receipt.clone())
            } else {
                Err(lost())
            };
        }
        let receipt = OutputReceipt {
            binding: self.journal.registration.binding.clone(),
            output_digest: digest(bytes),
            output_bytes: bytes.len().to_string(),
        };
        let result = (|| {
            let mut temporary = tempfile::NamedTempFile::new_in(&self.entry).map_err(|_| lost())?;
            temporary.write_all(bytes).map_err(|_| lost())?;
            temporary.as_file().sync_all().map_err(|_| lost())?;
            temporary
                .persist_noclobber(self.entry.join("output"))
                .map_err(|_| lost())?;
            private(&self.entry, true, false)?
                .sync_all()
                .map_err(|_| lost())?;
            self.journal.retained = Some(receipt.clone());
            self.save()?;
            Ok(receipt)
        })();
        if result.is_err() {
            self.poisoned = true;
        }
        result
    }

    /// Return identical retained bytes for the bound application job. Caller must
    /// independently authenticate the current invoking/delivery generation first.
    /// Exact binding is required; this layer implements no path-relocation policy.
    pub fn deliver(&self) -> Result<Vec<u8>> {
        self.check()?;
        let receipt = self.journal.retained.as_ref().ok_or_else(unknown)?;
        let bytes = read(
            &self.entry.join("output"),
            self.journal.registration.output_limit,
        )?;
        if receipt.output_digest != digest(&bytes)
            || receipt.output_bytes != bytes.len().to_string()
        {
            return Err(lost());
        }
        self.check()?;
        Ok(bytes)
    }
}

fn valid_digest(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}
fn valid_receipt(value: &str) -> bool {
    !value.is_empty() && value.len() <= 256 && !value.chars().any(char::is_control)
}
