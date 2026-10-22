//! Length-prefixed canonical protocol frames. Callers own authenticated channels,
//! I/O deadlines and total budgets. Discard a stream after any framing failure.
use crate::{ErrorCode, Message, ProtocolError, decode, encode, rejected, schema};
use std::io::{Read, Write};

/// Read one bounded frame, rejecting the declared size before allocation.
/// Clean EOF returns `None`; partial headers/payloads are transport failures.
pub fn read_frame(input: &mut impl Read) -> Result<Option<Message>, ProtocolError> {
    let mut header = [0; 4];
    loop {
        match input.read(&mut header[..1]) {
            Ok(0) => return Ok(None),
            Ok(_) => break,
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(_) => return Err(rejected(ErrorCode::TransportFailed)),
        }
    }
    input
        .read_exact(&mut header[1..])
        .map_err(|_| rejected(ErrorCode::TransportFailed))?;
    let length = u32::from_be_bytes(header) as usize;
    if length == 0 || length > schema()["maxFrameBytes"].as_u64().unwrap() as usize {
        return Err(rejected(ErrorCode::InvalidFrame));
    }
    let mut bytes = vec![0; length];
    input
        .read_exact(&mut bytes)
        .map_err(|_| rejected(ErrorCode::TransportFailed))?;
    decode(&bytes).map(Some)
}

/// Write and flush exactly one validated frame. No application retry occurs.
pub fn write_frame(output: &mut impl Write, message: &Message) -> Result<(), ProtocolError> {
    let bytes = encode(message)?;
    output
        .write_all(&(bytes.len() as u32).to_be_bytes())
        .and_then(|_| output.write_all(&bytes))
        .and_then(|_| output.flush())
        .map_err(|_| rejected(ErrorCode::TransportFailed))
}
