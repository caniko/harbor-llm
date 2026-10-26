//! Exact owner-schema identity across the ownership transfer.
use harbor_llm_protocol::{SCHEMA, SCHEMA_DIGEST};
use sha2::{Digest, Sha256};

#[test]
fn owner_schema_and_historical_contract_have_the_same_digest() {
    assert_eq!(
        format!("{:x}", Sha256::digest(SCHEMA.as_bytes())),
        SCHEMA_DIGEST
    );
    assert_eq!(
        SCHEMA_DIGEST,
        "dfaae881ef6cab2981ff63a3d478af684b49ec691192e3bd8981fe77a61e72a3"
    );
}
