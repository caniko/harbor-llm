//! Separately versioned command data. Decoding grants no execution authority.
use crate::{
    Binding, Counter, Digest, ErrorCode, Failure, Id, OutputReceipt, ProtocolError, rejected,
};
use serde_json::Value;
use sha2::{Digest as _, Sha256};
use std::{
    sync::OnceLock,
    time::{Duration, Instant},
};

#[path = "command_types.rs"]
mod types;
pub use types::*;

/// Exact command definition, including the pinned v1 schema dependency.
pub const SCHEMA: &str = include_str!("../protocol/commands.json");

pub(crate) fn schema() -> &'static Value {
    static OWNER: OnceLock<Value> = OnceLock::new();
    OWNER.get_or_init(|| {
        let mut schema: Value = serde_json::from_str(SCHEMA).expect("checked-in command schema");
        assert_eq!(schema["executionSchemaDigest"], crate::SCHEMA_DIGEST);
        let mut definitions = crate::schema()["definitions"].as_object().unwrap().clone();
        definitions.extend(schema["definitions"].as_object().unwrap().clone());
        schema["definitions"] = Value::Object(definitions);
        schema
    })
}
fn identity(command: &Command) -> Result<(), ProtocolError> {
    if command.command_schema_digest != SCHEMA_DIGEST {
        return Err(rejected(ErrorCode::CustodyLost));
    }
    Ok(())
}

/// Encode a schema-bound command without granting authority to dispatch it.
pub fn encode(command: &Command) -> Result<Vec<u8>, ProtocolError> {
    identity(command)?;
    let value = serde_json::to_value(command).map_err(|_| rejected(ErrorCode::InvalidFrame))?;
    crate::encode_value(&value, schema())
}
/// Decode exactly one canonical bounded command; unknown fields fail closed.
pub fn decode(bytes: &[u8]) -> Result<Command, ProtocolError> {
    let command = serde_json::from_value(crate::decode_value(bytes, schema())?)
        .map_err(|_| rejected(ErrorCode::InvalidFrame))?;
    identity(&command)?;
    Ok(command)
}

/// Authenticated command channel, domain-separated from the v1 observation wire.
/// Fixed schema identity is part of key derivation; decoding grants no admission.
pub struct AuthenticatedChannel {
    records: crate::channel::Records,
}
impl AuthenticatedChannel {
    /// Trusted launch supplies fresh credentials and exact binding as for v1.
    pub fn new(
        key: &[u8; 32],
        nonce: &[u8; 32],
        binding: &[u8; 32],
        role: crate::channel::Role,
    ) -> Self {
        Self {
            records: crate::channel::Records::new(
                key,
                nonce,
                binding,
                role,
                schema()["channelDomain"].as_str().unwrap(),
                SCHEMA_DIGEST,
            ),
        }
    }
    /// Authenticate one canonical command. No retry or admission is implied.
    pub fn seal(&mut self, command: &Command) -> Result<Vec<u8>, ProtocolError> {
        let result = self
            .records
            .ready()
            .and_then(|()| encode(command))
            .and_then(|bytes| self.records.seal(&bytes));
        if result.is_err() {
            self.close();
        }
        result
    }
    /// Authenticate before decoding; failed operations terminally close the codec.
    pub fn open(&mut self, record: &[u8]) -> Result<Command, ProtocolError> {
        let result = self.records.open(record).and_then(|bytes| decode(&bytes));
        if result.is_err() {
            self.close();
        }
        result
    }
    /// Terminal close, zeroizing directional keys without authorizing any effect.
    pub fn close(&mut self) {
        self.records.close();
    }
}

/// Bounded single-use transfer assembly. No partial bytes are returned. The
/// dispatcher must also bound total transfers, live buffers and channel lifetime.
pub struct TransferReceiver {
    reference: TransferReference,
    bytes: Vec<u8>,
    chunks: u64,
    deadline: Instant,
    active: bool,
}
impl TransferReceiver {
    /// Start with stricter caller byte/time budgets, within shared ceilings.
    /// Allocation grows only as chunks arrive; counters preserve u64 precision.
    pub fn new(
        reference: TransferReference,
        maximum_bytes: u64,
        timeout: Duration,
    ) -> Result<Self, ProtocolError> {
        let value =
            serde_json::to_value(&reference).map_err(|_| rejected(ErrorCode::InvalidFrame))?;
        if !crate::matches(&value, &Value::String("TransferReference".into()), schema()) {
            return Err(rejected(ErrorCode::InvalidFrame));
        }
        let ceiling = schema()[if reference.purpose == TransferPurpose::Input {
            "maxInputBytes"
        } else {
            "maxOutputBytes"
        }]
        .as_u64()
        .unwrap();
        let transport: Value = serde_json::from_str(include_str!("../protocol/transport.json"))
            .expect("checked-in transport policy");
        if maximum_bytes == 0
            || maximum_bytes > ceiling
            || reference.bytes.parse::<u64>().unwrap() > maximum_bytes
            || timeout.is_zero()
            || timeout > Duration::from_millis(transport["maxTimeoutMs"].as_u64().unwrap())
        {
            return Err(rejected(ErrorCode::BudgetExhausted));
        }
        Ok(Self {
            reference,
            bytes: Vec::new(),
            chunks: 0,
            deadline: Instant::now() + timeout,
            active: true,
        })
    }
    fn ready(&self) -> Result<(), ProtocolError> {
        if !self.active {
            return Err(rejected(ErrorCode::TransportFailed));
        }
        if Instant::now() >= self.deadline {
            return Err(rejected(ErrorCode::BudgetExhausted));
        }
        Ok(())
    }
    /// Accept exactly the next lowercase-hex chunk. Any error closes the transfer.
    pub fn push(&mut self, chunk: &TransferChunk) -> Result<(), ProtocolError> {
        let result = (|| {
            self.ready()?;
            let value =
                serde_json::to_value(chunk).map_err(|_| rejected(ErrorCode::InvalidFrame))?;
            if !crate::matches(&value, &Value::String("TransferChunk".into()), schema())
                || chunk.transfer_id != self.reference.transfer_id
                || chunk.offset != self.bytes.len().to_string()
            {
                return Err(rejected(ErrorCode::InvalidFrame));
            }
            if self.chunks >= schema()["maxChunks"].as_u64().unwrap()
                || (self.bytes.len() + chunk.data.len() / 2) as u64
                    > self.reference.bytes.parse::<u64>().unwrap()
            {
                return Err(rejected(ErrorCode::BudgetExhausted));
            }
            for pair in chunk.data.as_bytes().chunks_exact(2) {
                let nibble = |b: u8| {
                    if b.is_ascii_digit() {
                        b - b'0'
                    } else {
                        b - b'a' + 10
                    }
                };
                self.bytes.push(nibble(pair[0]) * 16 + nibble(pair[1]));
            }
            self.chunks += 1;
            Ok(())
        })();
        if result.is_err() {
            self.close();
        }
        result
    }
    /// Return only complete bytes belonging to the exact transfer and digest.
    pub fn finish(&mut self, transfer_id: &str) -> Result<Vec<u8>, ProtocolError> {
        let result = (|| {
            self.ready()?;
            if transfer_id != self.reference.transfer_id
                || self.bytes.len().to_string() != self.reference.bytes
            {
                return Err(rejected(ErrorCode::InvalidFrame));
            }
            if format!("{:x}", Sha256::digest(&self.bytes)) != self.reference.digest {
                return Err(rejected(ErrorCode::CustodyLost));
            }
            Ok(std::mem::take(&mut self.bytes))
        })();
        self.close();
        result
    }
    /// Abort without exposing partial content. Closing releases no operation.
    pub fn close(&mut self) {
        self.active = false;
        self.bytes.clear();
    }
}
