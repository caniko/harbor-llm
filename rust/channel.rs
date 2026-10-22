//! Authenticated canonical messages on private local channels.
//!
//! Trusted launch supplies a fresh random nonce, secret key and exact binding.
//! Never reuse the tuple, including after restart. This layer grants no admission
//! and provides integrity, not confidentiality. I/O deadlines belong to transport.
use crate::{ErrorCode, Message, ProtocolError, SCHEMA_DIGEST, decode, encode, rejected, schema};
use hmac::{Hmac, Mac};
use sha2::Sha256;
use zeroize::Zeroizing;

type HmacSha256 = Hmac<Sha256>;

/// Fixed authenticated-record layout and domain, independent of command data.
pub const SCHEMA: &str = include_str!("../protocol/channel.json");

/// Local endpoint direction. Directional keys prevent reflected replies.
#[derive(Clone, Copy)]
pub enum Role {
    /// Application-side execution controller.
    Controller,
    /// Harbor-side bridge endpoint.
    Bridge,
}

impl Role {
    fn label(self) -> &'static [u8] {
        match self {
            Self::Controller => b"controller",
            Self::Bridge => b"bridge",
        }
    }
    fn opposite(self) -> Self {
        match self {
            Self::Controller => Self::Bridge,
            Self::Bridge => Self::Controller,
        }
    }
}

/// Private directional keys and monotonic sequence numbers. Not cloneable.
/// Every failed operation closes the channel and zeroizes retained keys.
pub(crate) struct Records {
    keys: Option<DirectionalKeys>,
    sent: u64,
    received: u64,
}

struct DirectionalKeys {
    send: Zeroizing<[u8; 32]>,
    receive: Zeroizing<[u8; 32]>,
}

fn derive(
    key: &[u8; 32],
    nonce: &[u8; 32],
    binding: &[u8; 32],
    role: Role,
    domain: &str,
    digest: &str,
) -> Zeroizing<[u8; 32]> {
    let mut mac = HmacSha256::new_from_slice(key).expect("HMAC accepts 32-byte keys");
    mac.update(domain.as_bytes());
    mac.update(&[0]);
    let schema_digest: Vec<_> = digest
        .as_bytes()
        .chunks_exact(2)
        .map(|bytes| u8::from_str_radix(std::str::from_utf8(bytes).unwrap(), 16).unwrap())
        .collect();
    mac.update(&schema_digest);
    mac.update(nonce);
    mac.update(binding);
    mac.update(role.label());
    Zeroizing::new(mac.finalize().into_bytes().into())
}

impl Records {
    pub(crate) fn ready(&self) -> Result<(), ProtocolError> {
        if self.keys.is_none() {
            return Err(rejected(ErrorCode::TransportFailed));
        }
        Ok(())
    }
    /// Derive per-direction keys. The caller owns nonce freshness, secret delivery,
    /// private channel custody and disposal of its original secret buffer.
    pub(crate) fn new(
        key: &[u8; 32],
        nonce: &[u8; 32],
        binding: &[u8; 32],
        role: Role,
        domain: &str,
        digest: &str,
    ) -> Self {
        Self {
            keys: Some(DirectionalKeys {
                send: derive(key, nonce, binding, role, domain, digest),
                receive: derive(key, nonce, binding, role.opposite(), domain, digest),
            }),
            sent: 0,
            received: 0,
        }
    }

    /// Authenticate one outgoing canonical message, with no application retry.
    pub(crate) fn seal(&mut self, payload: &[u8]) -> Result<Vec<u8>, ProtocolError> {
        let result = self.seal_inner(payload);
        if result.is_err() {
            self.close();
        }
        result
    }

    fn seal_inner(&mut self, payload: &[u8]) -> Result<Vec<u8>, ProtocolError> {
        let keys = self
            .keys
            .as_ref()
            .ok_or_else(|| rejected(ErrorCode::TransportFailed))?;
        let sequence = self
            .sent
            .checked_add(1)
            .ok_or_else(|| rejected(ErrorCode::AuthorityDenied))?;
        if payload.is_empty()
            || payload.len() > schema()["maxFrameBytes"].as_u64().unwrap() as usize
        {
            return Err(rejected(ErrorCode::InvalidFrame));
        }
        let mut record = Vec::with_capacity(payload.len() + 44);
        record.extend_from_slice(&sequence.to_be_bytes());
        record.extend_from_slice(&(payload.len() as u32).to_be_bytes());
        record.extend_from_slice(payload);
        let mut mac = HmacSha256::new_from_slice(keys.send.as_ref()).expect("fixed key length");
        mac.update(&record);
        record.extend_from_slice(&mac.finalize().into_bytes());
        self.sent = sequence;
        Ok(record)
    }

    /// Authenticate before decoding; reject tampering, replays and reordering.
    pub(crate) fn open(&mut self, record: &[u8]) -> Result<Vec<u8>, ProtocolError> {
        let result = self.open_inner(record);
        if result.is_err() {
            self.close();
        }
        result
    }

    fn open_inner(&mut self, record: &[u8]) -> Result<Vec<u8>, ProtocolError> {
        let keys = self
            .keys
            .as_ref()
            .ok_or_else(|| rejected(ErrorCode::TransportFailed))?;
        let maximum = schema()["maxFrameBytes"].as_u64().unwrap() as usize;
        if record.len() < 45 || record.len() > maximum + 44 {
            return Err(rejected(ErrorCode::InvalidFrame));
        }
        let length = u32::from_be_bytes(record[8..12].try_into().unwrap()) as usize;
        if length == 0 || length > maximum || record.len() != length + 44 {
            return Err(rejected(ErrorCode::InvalidFrame));
        }
        let mut mac = HmacSha256::new_from_slice(keys.receive.as_ref()).expect("fixed key length");
        mac.update(&record[..record.len() - 32]);
        mac.verify_slice(&record[record.len() - 32..])
            .map_err(|_| rejected(ErrorCode::AuthorityDenied))?;
        let expected = self
            .received
            .checked_add(1)
            .ok_or_else(|| rejected(ErrorCode::AuthorityDenied))?;
        if u64::from_be_bytes(record[..8].try_into().unwrap()) != expected {
            return Err(rejected(ErrorCode::AuthorityDenied));
        }
        let value = record[12..record.len() - 32].to_vec();
        self.received = expected;
        Ok(value)
    }

    /// Terminal close, zeroizing retained directional keys. Idempotent.
    pub(crate) fn close(&mut self) {
        self.keys = None;
    }
}

/// Private directional v1 message channel. Every error closes it and zeroizes keys.
pub struct AuthenticatedChannel {
    records: Records,
}
impl AuthenticatedChannel {
    /// Derive fixed v1 directional keys; callers own nonce freshness and custody.
    pub fn new(key: &[u8; 32], nonce: &[u8; 32], binding: &[u8; 32], role: Role) -> Self {
        let contract: serde_json::Value =
            serde_json::from_str(SCHEMA).expect("checked-in channel contract");
        Self {
            records: Records::new(
                key,
                nonce,
                binding,
                role,
                contract["domain"].as_str().unwrap(),
                SCHEMA_DIGEST,
            ),
        }
    }
    /// Authenticate one canonical v1 message. Never retries an operation.
    pub fn seal(&mut self, message: &Message) -> Result<Vec<u8>, ProtocolError> {
        let result = self
            .records
            .ready()
            .and_then(|()| encode(message))
            .and_then(|bytes| self.records.seal(&bytes));
        if result.is_err() {
            self.close();
        }
        result
    }
    /// Authenticate before decoding. Tamper, replay and reorder are terminal.
    pub fn open(&mut self, record: &[u8]) -> Result<Message, ProtocolError> {
        let result = self.records.open(record).and_then(|bytes| decode(&bytes));
        if result.is_err() {
            self.close();
        }
        result
    }
    /// Terminal close, zeroizing retained directional keys. Idempotent.
    pub fn close(&mut self) {
        self.records.close();
    }
}
