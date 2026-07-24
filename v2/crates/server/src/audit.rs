//! Tamper-evident audit log (ADR-0007).
//!
//! Every appended event is hash-chained: `event_hash = SHA-256(previous_hash ||
//! canonical(event))`, per organization. Appends are serialized with a per-org
//! advisory lock so "the previous event" is unambiguous. `verify()` recomputes the
//! chain with the same canonical function, so any altered field or broken link is
//! detected. (Signed off-DB checkpoints — the second half of ADR-0007 — come later.)

use axum::extract::State;
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::Json;
use sha2::{Digest, Sha256};
use sqlx::{PgPool, Row};

use crate::auth::{Auth, DEFAULT_ORG};
use crate::AppState;

/// Deterministic serialization of the hashed fields (fixed order; serde_json maps
/// are key-sorted by default, so `metadata` is stable).
fn canonical(
    action: &str,
    actor: Option<&str>,
    host: Option<&str>,
    resource: &str,
    decision: &str,
    result: &str,
    metadata: &serde_json::Value,
) -> Vec<u8> {
    serde_json::json!([
        action,
        actor.unwrap_or(""),
        host.unwrap_or(""),
        resource,
        decision,
        result,
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
    let canon = canonical(action, actor, host, resource, decision, result, metadata);
    let mut tx = pool.begin().await?;

    // Serialize appends for this org so the chain has a single tail.
    sqlx::query("SELECT pg_advisory_xact_lock(hashtext($1)::bigint)")
        .bind(DEFAULT_ORG)
        .execute(&mut *tx)
        .await?;

    let prev: Option<Vec<u8>> = sqlx::query_scalar(
        "SELECT event_hash FROM audit_events
          WHERE organization_id = ($1)::uuid ORDER BY seq DESC LIMIT 1",
    )
    .bind(DEFAULT_ORG)
    .fetch_optional(&mut *tx)
    .await?;

    let mut hasher = Sha256::new();
    if let Some(p) = &prev {
        hasher.update(p);
    }
    hasher.update(&canon);
    let event_hash = hasher.finalize().to_vec();

    sqlx::query(
        "INSERT INTO audit_events
            (event_id, organization_id, actor_user_id, host_id, action, resource,
             decision, result, request_id, metadata, previous_hash, event_hash)
         VALUES
            (gen_random_uuid(), ($1)::uuid, ($2)::uuid, ($3)::uuid, $4, $5,
             $6, $7, gen_random_uuid(), ($8)::jsonb, $9, $10)",
    )
    .bind(DEFAULT_ORG)
    .bind(actor)
    .bind(host)
    .bind(action)
    .bind(resource)
    .bind(decision)
    .bind(result)
    .bind(metadata.to_string())
    .bind(prev)
    .bind(event_hash)
    .execute(&mut *tx)
    .await?;

    tx.commit().await?;
    Ok(())
}

/// Recompute the chain and confirm every stored hash + link. Returns (ok, count).
async fn verify(pool: &PgPool) -> anyhow::Result<(bool, i64)> {
    let rows = sqlx::query(
        "SELECT action, actor_user_id::text AS actor, host_id::text AS host, resource,
                decision, result, metadata::text AS metadata, previous_hash, event_hash
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
            &r.get::<String, _>("action"),
            r.get::<Option<String>, _>("actor").as_deref(),
            r.get::<Option<String>, _>("host").as_deref(),
            &r.get::<String, _>("resource"),
            &r.get::<String, _>("decision"),
            &r.get::<String, _>("result"),
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
