//! Tamper-evident audit log (ADR-0007).
//!
//! Every appended event is hash-chained: `event_hash = SHA-256(previous_hash ||
//! canonical(event))`, per organization. The canonical form covers the **full
//! envelope** — schema version, seq, event_id, organization, timestamp,
//! request_id, and the event fields — so altering any of them (not just the
//! payload) breaks the chain. `seq` is assigned by the app under a per-org advisory
//! lock (so it is known before hashing and monotonic), and `created_at` is stored
//! at whole-second precision so verification reproduces the hashed value exactly.
//!
//! Deployment hardening (ADR-0007, not enforced from code): the application should
//! connect with an INSERT/SELECT-only role on `audit_events` (no UPDATE/DELETE),
//! and periodic checkpoints should be signed and exported off-DB. Writes here are
//! best-effort — the durable fail-closed intent is the `jobs` row (external-review
//! step 2), so a transient audit failure never blocks the audited operation.

use axum::extract::State;
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::Json;
use sha2::{Digest, Sha256};
use sqlx::{PgPool, Row};
use uuid::Uuid;

use crate::auth::{Auth, DEFAULT_ORG};
use crate::AppState;

/// Bump if the canonical envelope layout changes.
const AUDIT_SCHEMA_VERSION: i64 = 1;

fn unix_now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// Deterministic serialization of the FULL event envelope (fixed order). Every
/// field that identifies or orders the event — schema version, seq, event_id,
/// organization, timestamp, request_id — is inside the hash, so none can be altered
/// without breaking the chain. serde_json key-sorts maps, so `metadata` is stable.
#[allow(clippy::too_many_arguments)]
fn canonical(
    seq: i64,
    event_id: &str,
    ts: i64,
    action: &str,
    actor: Option<&str>,
    host: Option<&str>,
    resource: &str,
    decision: &str,
    result: &str,
    request_id: &str,
    metadata: &serde_json::Value,
) -> Vec<u8> {
    serde_json::json!([
        AUDIT_SCHEMA_VERSION,
        seq,
        event_id,
        DEFAULT_ORG,
        ts,
        action,
        actor.unwrap_or(""),
        host.unwrap_or(""),
        resource,
        decision,
        result,
        request_id,
        metadata,
    ])
    .to_string()
    .into_bytes()
}

/// Append one audit event to the per-org hash chain. Best-effort: a failure here
/// must never take down the operation being audited — callers log and continue.
#[allow(clippy::too_many_arguments)]
pub async fn record(
    pool: &PgPool,
    action: &str,
    actor: Option<&str>,
    host: Option<&str>,
    resource: &str,
    decision: &str,
    result: &str,
    metadata: serde_json::Value,
) {
    if let Err(e) = try_record(
        pool, action, actor, host, resource, decision, result, &metadata,
    )
    .await
    {
        tracing::error!(error = %e, action, "failed to write audit event");
    }
}

#[allow(clippy::too_many_arguments)]
async fn try_record(
    pool: &PgPool,
    action: &str,
    actor: Option<&str>,
    host: Option<&str>,
    resource: &str,
    decision: &str,
    result: &str,
    metadata: &serde_json::Value,
) -> anyhow::Result<()> {
    let mut tx = pool.begin().await?;

    // Serialize appends for this org so the chain has a single tail + monotonic seq.
    sqlx::query("SELECT pg_advisory_xact_lock(hashtext($1)::bigint)")
        .bind(DEFAULT_ORG)
        .execute(&mut *tx)
        .await?;

    // Previous hash + next sequence, both read under the lock.
    let tail = sqlx::query(
        "SELECT event_hash, seq FROM audit_events
          WHERE organization_id = ($1)::uuid ORDER BY seq DESC LIMIT 1",
    )
    .bind(DEFAULT_ORG)
    .fetch_optional(&mut *tx)
    .await?;
    let (prev, seq): (Option<Vec<u8>>, i64) = match tail {
        Some(r) => (Some(r.get("event_hash")), r.get::<i64, _>("seq") + 1),
        None => (None, 1),
    };

    // App-assigned so they are known before hashing and are covered by the hash.
    let event_id = Uuid::new_v4().to_string();
    let request_id = Uuid::new_v4().to_string();
    let ts = unix_now();
    let canon = canonical(
        seq,
        &event_id,
        ts,
        action,
        actor,
        host,
        resource,
        decision,
        result,
        &request_id,
        metadata,
    );

    let mut hasher = Sha256::new();
    if let Some(p) = &prev {
        hasher.update(p);
    }
    hasher.update(&canon);
    let event_hash = hasher.finalize().to_vec();

    sqlx::query(
        "INSERT INTO audit_events
            (event_id, organization_id, actor_user_id, host_id, action, resource,
             decision, result, request_id, metadata, previous_hash, event_hash, seq, ts)
         VALUES
            (($1)::uuid, ($2)::uuid, ($3)::uuid, ($4)::uuid, $5, $6,
             $7, $8, ($9)::uuid, ($10)::jsonb, $11, $12, $13, to_timestamp($14))",
    )
    .bind(&event_id)
    .bind(DEFAULT_ORG)
    .bind(actor)
    .bind(host)
    .bind(action)
    .bind(resource)
    .bind(decision)
    .bind(result)
    .bind(&request_id)
    .bind(metadata.to_string())
    .bind(prev)
    .bind(event_hash)
    .bind(seq)
    .bind(ts)
    .execute(&mut *tx)
    .await?;

    tx.commit().await?;
    Ok(())
}

/// Recompute the chain and confirm every stored hash + link. Returns (ok, count).
async fn verify(pool: &PgPool) -> anyhow::Result<(bool, i64)> {
    let rows = sqlx::query(
        "SELECT seq, event_id::text AS event_id,
                extract(epoch FROM ts)::bigint AS tsec,
                action, actor_user_id::text AS actor, host_id::text AS host, resource,
                decision, result, request_id::text AS request_id,
                metadata::text AS metadata, previous_hash, event_hash
           FROM audit_events
          WHERE organization_id = ($1)::uuid ORDER BY seq ASC",
    )
    .bind(DEFAULT_ORG)
    .fetch_all(pool)
    .await?;

    let mut prev: Option<Vec<u8>> = None;
    for r in &rows {
        let stored_prev: Option<Vec<u8>> = r.get("previous_hash");
        if stored_prev != prev {
            return Ok((false, rows.len() as i64)); // broken link
        }
        let metadata: serde_json::Value = serde_json::from_str(&r.get::<String, _>("metadata"))
            .unwrap_or(serde_json::Value::Null);
        let canon = canonical(
            r.get::<i64, _>("seq"),
            &r.get::<String, _>("event_id"),
            r.get::<i64, _>("tsec"),
            &r.get::<String, _>("action"),
            r.get::<Option<String>, _>("actor").as_deref(),
            r.get::<Option<String>, _>("host").as_deref(),
            &r.get::<String, _>("resource"),
            &r.get::<String, _>("decision"),
            &r.get::<String, _>("result"),
            &r.get::<String, _>("request_id"),
            &metadata,
        );
        let mut hasher = Sha256::new();
        if let Some(p) = &prev {
            hasher.update(p);
        }
        hasher.update(&canon);
        let computed = hasher.finalize().to_vec();
        let stored: Vec<u8> = r.get("event_hash");
        if computed != stored {
            return Ok((false, rows.len() as i64)); // altered event
        }
        prev = Some(stored);
    }
    Ok((true, rows.len() as i64))
}

/// GET /api/audit/verify — recompute the chain (requires `audit.view`).
pub async fn verify_handler(auth: Auth, State(state): State<AppState>) -> impl IntoResponse {
    if auth.require("audit.view").is_err() {
        return (
            StatusCode::FORBIDDEN,
            Json(serde_json::json!({ "error": "forbidden" })),
        );
    }
    match verify(&state.pool).await {
        Ok((ok, n)) => (
            StatusCode::OK,
            Json(serde_json::json!({ "chain_valid": ok, "events": n })),
        ),
        Err(_) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": "verify failed" })),
        ),
    }
}
