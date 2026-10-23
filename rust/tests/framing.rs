//! Bounded framing and truncated-channel failures.
use harbor_llm_protocol::{
    Body, ErrorCode, Failure, Message,
    framing::{read_frame, write_frame},
};
use std::io::Cursor;

fn message() -> Message {
    Message {
        schema_version: 1,
        request_id: "frame-🧪".into(),
        body: Body::Error(Failure {
            code: ErrorCode::EffectUnknown,
        }),
    }
}

#[test]
fn length_prefix_rejects_oversize_before_reading_payload() {
    for length in [0u32, 65537, u32::MAX] {
        let mut input = Cursor::new(length.to_be_bytes());
        assert!(read_frame(&mut input).is_err());
        assert_eq!(input.position(), 4);
    }
}

#[test]
fn framed_messages_roundtrip_and_eof_is_distinct_from_truncation() {
    let mut bytes = Vec::new();
    write_frame(&mut bytes, &message()).unwrap();
    write_frame(&mut bytes, &message()).unwrap();
    let mut input = Cursor::new(&bytes);
    assert_eq!(read_frame(&mut input).unwrap(), Some(message()));
    assert_eq!(read_frame(&mut input).unwrap(), Some(message()));
    assert_eq!(read_frame(&mut input).unwrap(), None);
    for end in 1..bytes.len() / 2 {
        assert!(read_frame(&mut Cursor::new(&bytes[..end])).is_err());
    }
}
