//! Transferred Toolbelt discovery tests; the wire and failure contract is unchanged.
use harbor_llm_protocol::{
    Body, Capability, ErrorCode, Message, SCHEMA_DIGEST, decode, encode, negotiate,
};

fn fixtures() -> serde_json::Value {
    serde_json::from_str(include_str!("../protocol/conformance.json")).unwrap()
}

fn locate<'a>(value: &'a mut serde_json::Value, path: &str) -> (&'a mut serde_json::Value, String) {
    let mut parts = path.rsplitn(2, '.');
    let field = parts.next().unwrap().to_owned();
    let parent = parts.next().unwrap_or("");
    let pointer = if parent.is_empty() {
        String::new()
    } else {
        format!("/{}", parent.replace('.', "/"))
    };
    (value.pointer_mut(&pointer).unwrap(), field)
}

#[test]
fn shared_wire_fixtures_have_exact_acceptance_and_roundtrip_bytes() {
    let fixtures = fixtures();
    for case in fixtures["cases"].as_array().unwrap() {
        let bytes = if let Some(raw) = case["raw"].as_str() {
            raw.as_bytes().to_vec()
        } else {
            let mut value = fixtures["messages"][case["base"].as_str().unwrap()].clone();
            if let Some(changes) = case["changes"].as_object() {
                for (path, replacement) in changes {
                    let (parent, field) = locate(&mut value, path);
                    parent[&field] = replacement.clone();
                }
            }
            if let Some(path) = case["remove"].as_str() {
                let (parent, field) = locate(&mut value, path);
                parent.as_object_mut().unwrap().remove(&field);
            }
            serde_json::to_vec(&value).unwrap()
        };
        let result = decode(&bytes);
        if !case["accepted"].as_bool().unwrap() {
            let code = case["code"]
                .as_str()
                .unwrap_or(fixtures["rejectionCodeDefault"].as_str().unwrap());
            let actual = serde_json::to_value(&result.as_ref().unwrap_err().code).unwrap();
            assert_eq!(actual.as_str().unwrap(), code, "{}", case["name"]);
        }
        assert_eq!(
            result.is_ok(),
            case["accepted"].as_bool().unwrap(),
            "{}: {result:?}",
            case["name"]
        );
        if let Ok(message) = result {
            assert_eq!(encode(&message).unwrap(), bytes, "{}", case["name"]);
        }
    }
}

fn describe() -> serde_json::Value {
    fixtures()["messages"]["describe"].clone()
}

#[test]
fn incompatible_wire_versions_reject_before_effects() {
    let mut message = describe();
    message["schemaVersion"] = 2.into();
    assert!(decode(&serde_json::to_vec(&message).unwrap()).is_err());
}

#[test]
fn blank_or_control_character_caller_ids_are_not_wire_identities() {
    for id in ["", "request\n1", "request\0"] {
        let mut message = describe();
        message["requestId"] = id.into();
        assert!(decode(&serde_json::to_vec(&message).unwrap()).is_err());
    }
}

#[test]
fn utf8_byte_limits_and_frame_bounds_apply_before_effects() {
    for id in ["x".repeat(257), "🧪".repeat(65)] {
        let mut value = describe();
        value["requestId"] = id.into();
        assert!(decode(&serde_json::to_vec(&value).unwrap()).is_err());
    }
    let mut value = describe();
    value["requestId"] = "🧪".repeat(64).into();
    assert!(decode(&serde_json::to_vec(&value).unwrap()).is_ok());
    assert!(decode(&vec![b' '; 65537]).is_err());
    assert!(decode(b"\xff").is_err());
    assert!(decode(&[b'['; 65536]).is_err());
}

fn message(name: &str) -> Message {
    let mut value = fixtures()["messages"][name].clone();
    match name {
        "describe" => {
            value["body"]["expectedImplementation"]["schemaDigest"] = SCHEMA_DIGEST.into()
        }
        "capabilities" => value["body"]["implementation"]["schemaDigest"] = SCHEMA_DIGEST.into(),
        _ => {}
    }
    decode(&serde_json::to_vec(&value).unwrap()).unwrap()
}

#[test]
fn discovery_requires_exact_correlation_implementation_profile_and_recovery() {
    let request = message("describe");
    let mut response = message("capabilities");
    negotiate(&request, &response, &[Capability::RetainedDelivery]).unwrap();
    response.request_id = "another-request".into();
    assert_eq!(
        negotiate(&request, &response, &[]).unwrap_err().code,
        ErrorCode::TransportFailed
    );
    response.request_id = request.request_id.clone();
    let mut wrong = request.clone();
    let Body::Describe(describe) = &mut wrong.body else {
        panic!()
    };
    describe.expected_implementation.engine_revision = "1".repeat(40);
    assert_eq!(
        negotiate(&wrong, &response, &[]).unwrap_err().code,
        ErrorCode::CustodyLost
    );
    let Body::Capabilities(capabilities) = &mut response.body else {
        panic!()
    };
    capabilities
        .capabilities
        .retain(|c| c != &Capability::ZeroEffectReopen);
    assert_eq!(
        negotiate(&request, &response, &[]).unwrap_err().code,
        ErrorCode::UnsupportedCapability
    );
}

#[test]
fn every_implementation_field_and_mandatory_guarantee_is_bound() {
    let request = message("describe");
    let response = message("capabilities");
    for field in [
        "engineRevision",
        "engineDigest",
        "bridgeDigest",
        "schemaDigest",
        "configurationDigest",
        "credentialReferenceDigest",
    ] {
        let mut value = serde_json::to_value(&response).unwrap();
        value["body"]["implementation"][field] = if field == "engineRevision" {
            "a".repeat(40).into()
        } else {
            "a".repeat(64).into()
        };
        let wrong: Message = serde_json::from_value(value).unwrap();
        assert_eq!(
            negotiate(&request, &wrong, &[]).unwrap_err().code,
            ErrorCode::CustodyLost,
            "{field}"
        );
    }
    let mut wrong_request = request.clone();
    let mut wrong_response = response.clone();
    let Body::Describe(describe) = &mut wrong_request.body else {
        panic!()
    };
    let Body::Capabilities(capabilities) = &mut wrong_response.body else {
        panic!()
    };
    describe.expected_implementation.schema_digest = "a".repeat(64);
    capabilities.implementation.schema_digest = "a".repeat(64);
    assert_eq!(
        negotiate(&wrong_request, &wrong_response, &[])
            .unwrap_err()
            .code,
        ErrorCode::CustodyLost
    );
    for missing in [
        Capability::AuthenticatedIpc,
        Capability::DurableIntents,
        Capability::ZeroEffectReopen,
        Capability::DescendantCleanup,
        Capability::RetainedDelivery,
    ] {
        let mut wrong = response.clone();
        let Body::Capabilities(capabilities) = &mut wrong.body else {
            panic!()
        };
        capabilities
            .capabilities
            .retain(|capability| capability != &missing);
        assert_eq!(
            negotiate(&request, &wrong, &[Capability::RetainedDelivery])
                .unwrap_err()
                .code,
            ErrorCode::UnsupportedCapability,
            "{missing:?}"
        );
    }
    let mut wrong = response.clone();
    let Body::Capabilities(capabilities) = &mut wrong.body else {
        panic!()
    };
    capabilities.profiles.clear();
    assert_eq!(
        negotiate(&request, &wrong, &[]).unwrap_err().code,
        ErrorCode::UnsupportedProfile
    );
}

#[test]
fn unsupported_macos_worker_cannot_be_enabled_by_advertising_it() {
    let mut request = message("describe");
    let mut response = message("capabilities");
    let Body::Describe(describe) = &mut request.body else {
        panic!()
    };
    describe.required_profile = harbor_llm_protocol::Profile::MacosUntrustedReview;
    let Body::Capabilities(capabilities) = &mut response.body else {
        panic!()
    };
    capabilities
        .profiles
        .push(describe.required_profile.clone());
    assert_eq!(
        negotiate(&request, &response, &[]).unwrap_err().code,
        ErrorCode::UnsupportedProfile
    );
}
