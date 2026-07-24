//! Grant signer (ADR-0004/0005).
//!
//! Loads the Ed25519 key the control plane uses to sign [`ExecutionGrant`]s. For
//! now the key lives beside the server (env `TENODERA_GRANT_KEY` → a hex seed
//! file). This module is the seam for the planned split into a **separate signer
//! process** so the main server never holds the key in memory — callers only ever
//! go through `issue_grant`, which can become an IPC call without touching them.

use tenodera_protocol as proto;

/// Grant lifetime — short, per ADR-0004.
pub const GRANT_TTL_SECS: i64 = 120;

fn signing_key() -> Option<proto::SigningKey> {
    let path = std::env::var("TENODERA_GRANT_KEY").ok()?;
    let hex = std::fs::read_to_string(path).ok()?;
    proto::signing_key_from_hex(&hex)
}

/// Issue a signed grant for `operation` on `host_id`, or None if signing is
/// unavailable (mutating operations then fail closed).
#[allow(clippy::too_many_arguments)]
pub fn issue_grant(
    job_id: uuid::Uuid,
    actor: &str,
    host_id: uuid::Uuid,
    operation: &proto::Operation,
    level: proto::AuthenticationLevel,
    now: i64,
) -> Option<proto::ExecutionGrant> {
    let key = signing_key()?;
    Some(proto::ExecutionGrant::issue(
        &key,
        job_id,
        actor,
        host_id,
        operation,
        level,
        now,
        GRANT_TTL_SECS,
    ))
}
