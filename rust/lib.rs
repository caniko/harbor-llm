//! Provider-free execution contracts. Structural validation grants no authority.
//! Harbor owns the wire definition; applications retain admission and persistence.

#![doc = include_str!("README.md")]

mod types;
pub use types::*;

pub mod channel;
pub mod commands;
pub mod framing;

use serde_json::Value;
use std::{fmt, sync::OnceLock};

/// Exact canonical schema bytes, preserved from the qualified Toolbelt contract.
pub const SCHEMA: &str = include_str!("../protocol/execution.json");

/// Shared non-raiseable byte, execution and cleanup ceilings for native bridges.
pub const TRANSPORT_POLICY: &str = include_str!("../protocol/transport.json");

/// Redacted structural validation failure.
#[derive(Debug, Eq, PartialEq)]
pub struct ProtocolError {
    /// Machine-readable failure class.
    pub code: ErrorCode,
}

impl fmt::Display for ProtocolError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "execution protocol rejected: {:?}", self.code)
    }
}

impl std::error::Error for ProtocolError {}

fn rejected(code: ErrorCode) -> ProtocolError {
    ProtocolError { code }
}

fn schema() -> &'static Value {
    static SCHEMA_VALUE: OnceLock<Value> = OnceLock::new();
    SCHEMA_VALUE.get_or_init(|| serde_json::from_str(SCHEMA).expect("checked-in execution schema"))
}

fn canonical(value: &Value) -> Value {
    match value {
        Value::Object(fields) => {
            let mut entries: Vec<_> = fields.iter().collect();
            entries.sort_unstable_by(|a, b| a.0.cmp(b.0));
            Value::Object(
                entries
                    .into_iter()
                    .map(|(key, value)| (key.clone(), canonical(value)))
                    .collect(),
            )
        }
        Value::Array(items) => Value::Array(items.iter().map(canonical).collect()),
        _ => value.clone(),
    }
}

fn canonical_numbers(value: &Value, owner: &Value) -> bool {
    match value {
        Value::Number(number) => number
            .as_u64()
            .is_some_and(|n| n <= owner["maxJsonInteger"].as_u64().unwrap()),
        Value::Object(fields) => fields.values().all(|value| canonical_numbers(value, owner)),
        Value::Array(items) => items.iter().all(|value| canonical_numbers(value, owner)),
        _ => true,
    }
}

fn matches(value: &Value, definition: &Value, owner: &Value) -> bool {
    if let Some(name) = definition.as_str() {
        return if name == "bool" {
            value.is_boolean()
        } else {
            owner["definitions"]
                .get(name)
                .is_some_and(|definition| matches(value, definition, owner))
        };
    }
    if let Some(constant) = definition.get("const") {
        return value == constant;
    }
    if definition["type"] == "string" {
        return value
            .as_str()
            .is_some_and(|text| match definition["format"].as_str() {
                Some("opaque") => {
                    !text.is_empty()
                        && text.len() <= definition["maxBytes"].as_u64().unwrap() as usize
                        && !text.chars().any(char::is_control)
                }
                Some("sha256") | Some("git-revision") => {
                    text.len()
                        == if definition["format"] == "sha256" {
                            64
                        } else {
                            40
                        }
                        && text
                            .bytes()
                            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
                }
                Some("uint64") | Some("generation") => text.parse::<u64>().is_ok_and(|n| {
                    n.to_string() == text && (definition["format"] != "generation" || n > 0)
                }),
                Some("hex") => {
                    !text.is_empty()
                        && text.len() % 2 == 0
                        && text.len() <= definition["maxBytes"].as_u64().unwrap() as usize
                        && text
                            .bytes()
                            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
                }
                _ => false,
            });
    }
    if let Some(choices) = definition["enum"].as_array() {
        return choices.contains(value);
    }
    if let Some(fields) = definition["fields"].as_object() {
        return value.as_object().is_some_and(|object| {
            object.len() == fields.len()
                && fields.iter().all(|(name, field)| {
                    object
                        .get(name)
                        .is_some_and(|value| matches(value, field, owner))
                })
        });
    }
    if let Some(variants) = definition["variants"].as_object() {
        let Some(tag) = definition["tag"].as_str() else {
            return false;
        };
        let Some(mut fields) = value.as_object().cloned() else {
            return false;
        };
        let Some(kind) = fields.remove(tag) else {
            return false;
        };
        return kind
            .as_str()
            .and_then(|kind| variants.get(kind))
            .is_some_and(|variant| matches(&Value::Object(fields), variant, owner));
    }
    if let Some(item) = definition.get("items") {
        return value.as_array().is_some_and(|items| {
            items.len() <= definition["maxItems"].as_u64().unwrap() as usize
                && items.iter().all(|value| matches(value, item, owner))
                && (definition["unique"] != true
                    || items
                        .iter()
                        .enumerate()
                        .all(|(index, value)| !items[..index].contains(value)))
        });
    }
    false
}

fn validate(value: &Value, owner: &Value) -> Result<(), ProtocolError> {
    if value.get("schemaVersion") != Some(&owner["version"]) {
        return Err(rejected(ErrorCode::IncompatibleVersion));
    }
    if !matches(value, &owner["root"], owner) {
        return Err(rejected(ErrorCode::InvalidFrame));
    }
    Ok(())
}

/// Decode canonical bounded JSON. Transport must bound reads before allocating.
pub fn decode(bytes: &[u8]) -> Result<Message, ProtocolError> {
    serde_json::from_value(decode_value(bytes, schema())?)
        .map_err(|_| rejected(ErrorCode::InvalidFrame))
}

fn decode_value(bytes: &[u8], owner: &Value) -> Result<Value, ProtocolError> {
    if bytes.len() > owner["maxFrameBytes"].as_u64().unwrap() as usize {
        return Err(rejected(ErrorCode::InvalidFrame));
    }
    let value: Value =
        serde_json::from_slice(bytes).map_err(|_| rejected(ErrorCode::InvalidFrame))?;
    if !canonical_numbers(&value, owner)
        || serde_json::to_vec(&canonical(&value)).map_err(|_| rejected(ErrorCode::InvalidFrame))?
            != bytes
    {
        return Err(rejected(ErrorCode::InvalidFrame));
    }
    validate(&value, owner)?;
    Ok(value)
}

/// Validate and encode a canonical bounded message.
pub fn encode(message: &Message) -> Result<Vec<u8>, ProtocolError> {
    let value = serde_json::to_value(message).map_err(|_| rejected(ErrorCode::InvalidFrame))?;
    encode_value(&value, schema())
}

fn encode_value(value: &Value, owner: &Value) -> Result<Vec<u8>, ProtocolError> {
    validate(value, owner)?;
    let bytes =
        serde_json::to_vec(&canonical(value)).map_err(|_| rejected(ErrorCode::InvalidFrame))?;
    if bytes.len() > owner["maxFrameBytes"].as_u64().unwrap() as usize {
        return Err(rejected(ErrorCode::InvalidFrame));
    }
    Ok(bytes)
}

/// Match discovery to the exact implementation and required guarantees.
/// Authentication and custodian observation remain separate prerequisites.
pub fn negotiate(
    request: &Message,
    response: &Message,
    required: &[Capability],
) -> Result<(), ProtocolError> {
    encode(request)?;
    encode(response)?;
    let (Body::Describe(describe), Body::Capabilities(capabilities)) =
        (&request.body, &response.body)
    else {
        return Err(rejected(ErrorCode::InvalidFrame));
    };
    if request.request_id != response.request_id {
        return Err(rejected(ErrorCode::TransportFailed));
    }
    if capabilities.implementation != describe.expected_implementation
        || describe.expected_implementation.schema_digest != SCHEMA_DIGEST
    {
        return Err(rejected(ErrorCode::CustodyLost));
    }
    if describe.required_profile == Profile::MacosUntrustedReview
        || !capabilities.profiles.contains(&describe.required_profile)
    {
        return Err(rejected(ErrorCode::UnsupportedProfile));
    }
    let mandatory = [
        Capability::AuthenticatedIpc,
        Capability::DurableIntents,
        Capability::ZeroEffectReopen,
        Capability::DescendantCleanup,
    ];
    if mandatory
        .iter()
        .chain(required)
        .any(|capability| !capabilities.capabilities.contains(capability))
    {
        return Err(rejected(ErrorCode::UnsupportedCapability));
    }
    Ok(())
}
