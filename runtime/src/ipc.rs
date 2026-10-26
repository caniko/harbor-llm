//! Single-owner private Unix command exchange. The host supervisor supplies the
//! original socket, peer/executable custody and fresh authenticated channel.
//! This module never connects, launches, reconnects, retries or grants admission.
use harbor_llm_protocol::{
    Binding, ErrorCode, ProtocolError,
    commands::{self, AuthenticatedChannel, Command, CommandBody},
};
use std::{
    io::{ErrorKind, Read, Write},
    net::Shutdown,
    os::unix::net::UnixStream,
    sync::OnceLock,
    time::{Duration, Instant},
};

type Result<T> = std::result::Result<T, ProtocolError>;
fn reject(code: ErrorCode) -> ProtocolError {
    ProtocolError { code }
}
fn io_error(_: std::io::Error) -> ProtocolError {
    reject(ErrorCode::TransportFailed)
}
/// Apple kernels reject SO_RCVTIMEO/SO_SNDTIMEO with EINVAL once the peer has
/// shut down, even with a reply still buffered. The following read or write
/// then reports those bytes, EOF or a broken pipe, which is classified as usual.
fn timeout_set(result: std::io::Result<()>) -> Result<()> {
    match result {
        Err(error) if cfg!(target_vendor = "apple") && error.kind() == ErrorKind::InvalidInput => {
            Ok(())
        }
        other => other.map_err(io_error),
    }
}

struct Ceilings {
    record: usize,
    overhead: usize,
    records: u32,
    timeout: Duration,
}
fn ceilings() -> &'static Ceilings {
    static CEILINGS: OnceLock<Ceilings> = OnceLock::new();
    CEILINGS.get_or_init(|| {
        let command: serde_json::Value =
            serde_json::from_str(commands::SCHEMA).expect("checked-in command policy");
        let channel: serde_json::Value = serde_json::from_str(harbor_llm_protocol::channel::SCHEMA)
            .expect("checked-in channel policy");
        let transport: serde_json::Value =
            serde_json::from_str(harbor_llm_protocol::TRANSPORT_POLICY)
                .expect("checked-in transport policy");
        let overhead = (channel["sequenceBytes"].as_u64().unwrap()
            + channel["lengthBytes"].as_u64().unwrap()
            + channel["tagBytes"].as_u64().unwrap()) as usize;
        Ceilings {
            record: command["maxFrameBytes"].as_u64().unwrap() as usize + overhead,
            overhead,
            // ponytail: one configuration and one input transfer plus three
            // commands/receipts; multi-turn sessions need a new explicit budget.
            records: command["maxChunks"].as_u64().unwrap() as u32 * 2 + 10,
            timeout: Duration::from_millis(transport["maxTimeoutMs"].as_u64().unwrap()),
        }
    })
}

/// Required whole-channel limits. Counts include both directions; bytes include
/// each outer u32 length and authenticated record. Consumers may only tighten.
#[derive(Clone, Copy)]
pub struct Limits {
    /// Total elapsed time from construction, never refreshed by partial progress.
    pub timeout: Duration,
    /// Total incoming and outgoing records, including transfers and receipts.
    pub records: u32,
    /// Total incoming and outgoing wire bytes, not just decoded content.
    pub bytes: u64,
}

/// One original socket/channel for one binding. Not cloneable. Every failure
/// shuts down the socket and zeroizes retained keys; no partial reply escapes.
/// Caller-protected endpoint custody is required for the entire lifetime. Do not
/// retain socket clones or share its descriptor with backend/daemon writers.
pub struct Exchange {
    wire: Wire,
    channel: AuthenticatedChannel,
    binding: Binding,
}

// The custodian control socket and command endpoint share the same original
// descriptor, deadline, allocation and cumulative-wire budget implementation.
pub(crate) struct Wire {
    stream: UnixStream,
    limits: Limits,
    deadline: Instant,
    records: u32,
    bytes: u64,
    closed: bool,
}
impl Exchange {
    // Only the Linux standalone supervisor hands over an established wire.
    #[cfg(target_os = "linux")]
    pub(crate) fn from_wire(wire: Wire, channel: AuthenticatedChannel, binding: Binding) -> Self {
        Self {
            wire,
            channel,
            binding,
        }
    }
    /// Take ownership of a supervisor-established private channel. Construction
    /// performs no peer I/O. Channel credentials must be fresh and bound to this
    /// exact registration by the launcher; strings alone are not peer authority.
    pub fn new(
        stream: UnixStream,
        channel: AuthenticatedChannel,
        binding: Binding,
        limits: Limits,
    ) -> Result<Self> {
        commands::encode(&Command {
            schema_version: 2,
            command_schema_digest: commands::SCHEMA_DIGEST.into(),
            request_id: "ipc-binding".into(),
            binding: binding.clone(),
            body: CommandBody::Reopen(commands::Target {
                handle: binding.execution_id.clone(),
            }),
        })?;
        Ok(Self {
            wire: Wire::new(stream, limits)?,
            channel,
            binding,
        })
    }
    fn send(&mut self, command: &Command) -> Result<()> {
        self.wire.remaining()?;
        if command.binding != self.binding {
            return Err(reject(ErrorCode::AuthorityDenied));
        }
        let bytes = self.channel.seal(command)?;
        self.wire.send(&bytes)
    }
    fn receive(&mut self, request: &Command) -> Result<Command> {
        let bytes = self
            .wire
            .receive(ceilings().record)?
            .ok_or_else(|| reject(ErrorCode::TransportFailed))?;
        if bytes.len() <= ceilings().overhead {
            return Err(reject(ErrorCode::InvalidFrame));
        }
        let reply = self.channel.open(&bytes)?;
        if reply.binding != self.binding {
            return Err(reject(ErrorCode::AuthorityDenied));
        }
        if reply.request_id != request.request_id {
            return Err(reject(ErrorCode::TransportFailed));
        }
        Ok(reply)
    }
    /// Send one transfer record without a response. Effectful commands cannot use
    /// this path. The dispatcher checks transfer sequence, purpose and contents.
    pub fn send_transfer(&mut self, command: &Command) -> Result<()> {
        let result = (|| {
            self.wire.remaining()?;
            if !matches!(
                command.body,
                CommandBody::TransferBegin(_)
                    | CommandBody::TransferChunk(_)
                    | CommandBody::TransferEnd(_)
            ) {
                return Err(reject(ErrorCode::UnsupportedCapability));
            }
            self.send(command)
        })();
        if result.is_err() {
            self.close();
        }
        result
    }
    /// Exchange exactly one effect command/reply. Invoke only inside the
    /// controller's matching dispatch callback, after its fsynced
    /// reservation. Reply meaning remains the controller/application's policy.
    pub fn request(&mut self, command: &Command) -> Result<Command> {
        let result = (|| {
            self.wire.remaining()?;
            if !matches!(
                command.body,
                CommandBody::Create(_)
                    | CommandBody::Submit(_)
                    | CommandBody::Execute(_)
                    | CommandBody::Interrupt(_)
            ) {
                return Err(reject(ErrorCode::UnsupportedCapability));
            }
            self.send(command)?;
            self.receive(command)
        })();
        if result.is_err() {
            self.close();
        }
        result
    }
    /// Read a bounded complete observation transfer for the original execution.
    /// Reopen/reconcile are observational; this never creates or resumes a server.
    /// The returned snapshot always needs application validation and gap handling.
    pub fn reconcile(&mut self, command: &Command, maximum_bytes: u64) -> Result<Vec<u8>> {
        let result = (|| {
            let target = match &command.body {
                CommandBody::Reopen(target) | CommandBody::Reconcile(target) => target,
                _ => return Err(reject(ErrorCode::UnsupportedCapability)),
            };
            if target.handle != self.binding.execution_id {
                return Err(reject(ErrorCode::AuthorityDenied));
            }
            self.send(command)?;
            let CommandBody::TransferBegin(begin) = self.receive(command)?.body else {
                return Err(reject(ErrorCode::InvalidFrame));
            };
            if begin.reference.purpose != commands::TransferPurpose::Observation {
                return Err(reject(ErrorCode::CustodyLost));
            }
            let reference = begin.reference;
            let mut receiver = commands::TransferReceiver::new(
                reference.clone(),
                maximum_bytes,
                self.wire.remaining()?,
            )?;
            let bytes = loop {
                match self.receive(command)?.body {
                    CommandBody::TransferChunk(chunk) => receiver.push(&chunk)?,
                    CommandBody::TransferEnd(end) => break receiver.finish(&end.transfer_id)?,
                    _ => return Err(reject(ErrorCode::InvalidFrame)),
                }
            };
            let CommandBody::OutputReceipt(receipt) = self.receive(command)?.body else {
                return Err(reject(ErrorCode::InvalidFrame));
            };
            if receipt.binding != self.binding
                || receipt.output_digest != reference.digest
                || receipt.output_bytes != reference.bytes
            {
                return Err(reject(ErrorCode::CustodyLost));
            }
            Ok(bytes)
        })();
        if result.is_err() {
            self.close();
        }
        result
    }
    /// Terminal socket shutdown and key disposal. This does not revoke provider
    /// authority, stop a supervised process or establish descendant cleanup.
    pub fn close(&mut self) {
        self.channel.close();
        self.wire.close();
    }
}
impl Drop for Exchange {
    fn drop(&mut self) {
        self.close();
    }
}

impl Wire {
    pub(crate) fn new(stream: UnixStream, limits: Limits) -> Result<Self> {
        let ceiling = ceilings();
        if limits.timeout.is_zero()
            || limits.timeout > ceiling.timeout
            || limits.records == 0
            || limits.records > ceiling.records
            || limits.bytes == 0
            || limits.bytes > u64::from(ceiling.records) * (ceiling.record as u64 + 4)
        {
            return Err(reject(ErrorCode::BudgetExhausted));
        }
        stream.set_nonblocking(false).map_err(io_error)?;
        Ok(Self {
            stream,
            limits,
            deadline: Instant::now() + limits.timeout,
            records: 0,
            bytes: 0,
            closed: false,
        })
    }
    pub(crate) fn remaining(&self) -> Result<Duration> {
        if self.closed {
            return Err(reject(ErrorCode::TransportFailed));
        }
        let remaining = self.deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err(reject(ErrorCode::BudgetExhausted));
        }
        Ok(remaining)
    }
    fn count_record(&mut self) -> Result<()> {
        self.remaining()?;
        if self.records >= self.limits.records {
            return Err(reject(ErrorCode::BudgetExhausted));
        }
        self.records += 1;
        Ok(())
    }
    fn count_bytes(&mut self, count: usize) -> Result<()> {
        if count as u64 > self.limits.bytes - self.bytes {
            return Err(reject(ErrorCode::BudgetExhausted));
        }
        self.bytes += count as u64;
        Ok(())
    }
    fn write_all(&mut self, mut bytes: &[u8]) -> Result<()> {
        while !bytes.is_empty() {
            timeout_set(self.stream.set_write_timeout(Some(self.remaining()?)))?;
            match self.stream.write(bytes) {
                Ok(0) => return Err(reject(ErrorCode::TransportFailed)),
                Ok(count) => bytes = &bytes[count..],
                Err(error) if error.kind() == ErrorKind::Interrupted => continue,
                Err(_) => {
                    self.remaining()?;
                    return Err(reject(ErrorCode::TransportFailed));
                }
            }
        }
        self.remaining()?;
        Ok(())
    }
    fn read_exact(&mut self, mut bytes: &mut [u8]) -> Result<()> {
        while !bytes.is_empty() {
            timeout_set(self.stream.set_read_timeout(Some(self.remaining()?)))?;
            match self.stream.read(bytes) {
                Ok(0) => return Err(reject(ErrorCode::TransportFailed)),
                Ok(count) => bytes = &mut bytes[count..],
                Err(error) if error.kind() == ErrorKind::Interrupted => continue,
                Err(_) => {
                    self.remaining()?;
                    return Err(reject(ErrorCode::TransportFailed));
                }
            }
        }
        self.remaining()?;
        Ok(())
    }
    pub(crate) fn send(&mut self, bytes: &[u8]) -> Result<()> {
        if bytes.is_empty() || bytes.len() > ceilings().record {
            return Err(reject(ErrorCode::InvalidFrame));
        }
        self.count_record()?;
        self.count_bytes(4 + bytes.len())?;
        self.write_all(&(bytes.len() as u32).to_be_bytes())?;
        self.write_all(bytes)
    }
    pub(crate) fn receive(&mut self, maximum: usize) -> Result<Option<Vec<u8>>> {
        self.count_record()?;
        self.count_bytes(4)?;
        let mut header = [0; 4];
        loop {
            timeout_set(self.stream.set_read_timeout(Some(self.remaining()?)))?;
            match self.stream.read(&mut header[..1]) {
                Ok(0) => return Ok(None),
                Ok(_) => break,
                Err(error) if error.kind() == ErrorKind::Interrupted => continue,
                Err(_) => {
                    self.remaining()?;
                    return Err(reject(ErrorCode::TransportFailed));
                }
            }
        }
        self.read_exact(&mut header[1..])?;
        let length = u32::from_be_bytes(header) as usize;
        if length == 0 || length > maximum.min(ceilings().record) {
            return Err(reject(ErrorCode::InvalidFrame));
        }
        self.count_bytes(length)?;
        let mut bytes = vec![0; length];
        self.read_exact(&mut bytes)?;
        Ok(Some(bytes))
    }
    fn close(&mut self) {
        self.closed = true;
        let _ = self.stream.shutdown(Shutdown::Both);
    }
}
impl Drop for Wire {
    fn drop(&mut self) {
        self.close();
    }
}
