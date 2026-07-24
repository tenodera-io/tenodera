//! Host registry (Phase 1) — list / register / remove managed hosts.
//!
//! Every route requires a valid session (`Auth`). RBAC gating (ADR-0006) is **not
//! yet** applied — that lands next; today any authenticated user may manage hosts,
//! the same incremental order v0.x followed before role extractors existed.
//! SSH host-key scanning + approval (ADR-0003) comes with the connection manager.

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::Json;
use sqlx::Row;

use crate::auth::{Auth, DEFAULT_ORG};
use crate::{ssh, AppState};

const MAX_NAME_LEN: usize = 128;

/// GET /api/hosts — list hosts in the organization.
pub async fn list(auth: Auth, State(state): State<AppState>) -> impl IntoResponse {
    if auth.require("host.view").is_err() {
        return (
            StatusCode::FORBIDDEN,
            Json(serde_json::json!({ "error": "forbidden" })),
        )
            .into_response();
    }
    let rows = sqlx::query(
        "SELECT id::text AS id, display_name, hostname, port, enabled, status, tags::text AS tags
           FROM hosts
          WHERE organization_id = ($1)::uuid
          ORDER BY display_name",
    )
    .bind(DEFAULT_ORG)
    .fetch_all(&state.pool)
    .await;

    match rows {
        Ok(rows) => {
            let hosts: Vec<serde_json::Value> = rows
                .iter()
                .map(|r| {
                    let tags: serde_json::Value = serde_json::from_str(&r.get::<String, _>("tags"))
                        .unwrap_or_else(|_| serde_json::json!({}));
                    serde_json::json!({
                        "id": r.get::<String, _>("id"),
                        "display_name": r.get::<String, _>("display_name"),
                        "hostname": r.get::<String, _>("hostname"),
                        "port": r.get::<i32, _>("port"),
                        "enabled": r.get::<bool, _>("enabled"),
                        "status": r.get::<String, _>("status"),
                        "tags": tags,
                    })
                })
                .collect();
            (StatusCode::OK, Json(serde_json::json!({ "hosts": hosts }))).into_response()
        }
        Err(_) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": "database error" })),
        )
            .into_response(),
    }
}

/// POST /api/hosts — register a host.
pub async fn create(
    auth: Auth,
    State(state): State<AppState>,
    Json(body): Json<serde_json::Value>,
) -> impl IntoResponse {
    if auth.require("host.manage").is_err() {
        crate::audit::record(
            &state.pool,
            "host.create",
            Some(&auth.user_id),
            None,
            "",
            "denied",
            "failed",
            serde_json::json!({ "permission": "host.manage" }),
        )
        .await;
        return (
            StatusCode::FORBIDDEN,
            Json(serde_json::json!({ "error": "forbidden" })),
        );
    }
    let display_name = body
        .get("display_name")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim();
    let hostname = body
        .get("hostname")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim();
    let port = body.get("port").and_then(|v| v.as_i64()).unwrap_or(22);
    let tags = body
        .get("tags")
        .cloned()
        .unwrap_or_else(|| serde_json::json!({}));

    if display_name.is_empty() || hostname.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": "display_name and hostname are required" })),
        );
    }
    if display_name.chars().count() > MAX_NAME_LEN || hostname.chars().count() > MAX_NAME_LEN {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": "display_name/hostname too long" })),
        );
    }
    if !(1..=65535).contains(&port) {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": "port out of range" })),
        );
    }
    if !tags.is_object() {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": "tags must be an object" })),
        );
    }

    let row = sqlx::query(
        "INSERT INTO hosts (id, organization_id, display_name, hostname, port, tags)
         VALUES (gen_random_uuid(), ($1)::uuid, $2, $3, $4, ($5)::jsonb)
         RETURNING id::text AS id",
    )
    .bind(DEFAULT_ORG)
    .bind(display_name)
    .bind(hostname)
    .bind(port as i32)
    .bind(tags.to_string())
    .fetch_one(&state.pool)
    .await;

    match row {
        Ok(r) => {
            let id: String = r.get("id");
            crate::audit::record(
                &state.pool,
                "host.create",
                Some(&auth.user_id),
                Some(&id),
                display_name,
                "allowed",
                "succeeded",
                serde_json::json!({}),
            )
            .await;
            (StatusCode::CREATED, Json(serde_json::json!({ "id": id })))
        }
        Err(_) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": "could not create host" })),
        ),
    }
}

/// POST /api/hosts/{id}/enroll — scan the host's SSH keys and pin them as trusted
/// (ADR-0003). This is the explicit, recorded trust-on-first-use; afterwards every
/// operation connects with `StrictHostKeyChecking=yes` against these keys.
pub async fn enroll(
    auth: Auth,
    State(state): State<AppState>,
    Path(id): Path<String>,
    body: axum::body::Bytes,
) -> impl IntoResponse {
    if auth.require("host.manage").is_err() {
        return (
            StatusCode::FORBIDDEN,
            Json(serde_json::json!({ "error": "forbidden" })),
        );
    }
    // Tolerant body parse: first enroll needs none; re-enroll carries { reauth }.
    let body: serde_json::Value =
        serde_json::from_slice(&body).unwrap_or_else(|_| serde_json::json!({}));

    // Host + how many keys are currently pinned (to detect a re-enroll).
    let row = sqlx::query(
        "SELECT hostname, port,
                (SELECT count(*) FROM ssh_host_keys k
                  WHERE k.host_id = h.id AND k.trusted_at IS NOT NULL AND k.revoked_at IS NULL)
                AS trusted
           FROM hosts h
          WHERE h.organization_id = ($1)::uuid AND h.id = ($2)::uuid",
    )
    .bind(DEFAULT_ORG)
    .bind(&id)
    .fetch_optional(&state.pool)
    .await;
    let row = match row {
        Ok(Some(r)) => r,
        _ => {
            return (
                StatusCode::NOT_FOUND,
                Json(serde_json::json!({ "error": "host not found" })),
            )
        }
    };
    let hostname: String = row.get("hostname");
    let port: i32 = row.get("port");
    let already_trusted: i64 = row.get("trusted");

    // Replacing a host's already-pinned identity is high-risk — require fresh
    // step-up so a hijacked live session can't silently swap the host key.
    if already_trusted > 0 {
        let principal: Option<String> =
            sqlx::query_scalar("SELECT local_principal FROM users WHERE id = ($1)::uuid")
                .bind(&auth.user_id)
                .fetch_optional(&state.pool)
                .await
                .ok()
                .flatten();
        let reauth = body.get("reauth").and_then(|v| v.as_str());
        let ok = match (principal, reauth) {
            (Some(p), Some(pw)) if !pw.is_empty() => crate::auth::pam_authenticate(&p, pw).await,
            _ => false,
        };
        if !ok {
            crate::audit::record(
                &state.pool,
                "host.enroll",
                Some(&auth.user_id),
                Some(&id),
                &hostname,
                "denied",
                "failed",
                serde_json::json!({ "reason": "step_up_required" }),
            )
            .await;
            return (
                StatusCode::UNAUTHORIZED,
                Json(serde_json::json!({
                    "error": "step-up authentication required to re-enroll", "step_up": true
                })),
            );
        }
    }

    let keys = match ssh::scan_host_keys(&hostname, port).await {
        Ok(k) => k,
        Err(e) => {
            return (
                StatusCode::BAD_GATEWAY,
                Json(serde_json::json!({ "error": e })),
            )
        }
    };

    // Transactional swap: revoke the old set (kept as history), pin the new set,
    // and mark the host enrolled — all or nothing. A partial write can never be
    // reported as success.
    let mut tx = match state.pool.begin().await {
        Ok(t) => t,
        Err(_) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({ "error": "database error" })),
            )
        }
    };
    let db_err = || {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": "enrollment failed" })),
        )
    };
    if sqlx::query(
        "UPDATE ssh_host_keys SET revoked_at = now()
          WHERE host_id = ($1)::uuid AND revoked_at IS NULL",
    )
    .bind(&id)
    .execute(&mut *tx)
    .await
    .is_err()
    {
        return db_err();
    }
    for (algorithm, public_key, fingerprint) in &keys {
        if sqlx::query(
            "INSERT INTO ssh_host_keys
                (id, host_id, algorithm, fingerprint_sha256, public_key, trusted_at, trusted_by)
             VALUES (gen_random_uuid(), ($1)::uuid, $2, $3, $4, now(), ($5)::uuid)",
        )
        .bind(&id)
        .bind(algorithm)
        .bind(fingerprint)
        .bind(public_key)
        .bind(&auth.user_id)
        .execute(&mut *tx)
        .await
        .is_err()
        {
            return db_err();
        }
    }
    if sqlx::query("UPDATE hosts SET status = 'enrolled', updated_at = now() WHERE id = ($1)::uuid")
        .bind(&id)
        .execute(&mut *tx)
        .await
        .is_err()
    {
        return db_err();
    }
    if tx.commit().await.is_err() {
        return db_err();
    }

    let listed: Vec<serde_json::Value> = keys
        .iter()
        .map(|(algo, _, fp)| serde_json::json!({ "algorithm": algo, "fingerprint": fp }))
        .collect();
    crate::audit::record(
        &state.pool,
        "host.enroll",
        Some(&auth.user_id),
        Some(&id),
        &hostname,
        "allowed",
        "succeeded",
        serde_json::json!({ "keys": listed.len(), "re_enroll": already_trusted > 0 }),
    )
    .await;
    (
        StatusCode::OK,
        Json(serde_json::json!({ "enrolled": keys.len(), "keys": listed })),
    )
}

/// DELETE /api/hosts/{id} — remove a host.
pub async fn remove(
    auth: Auth,
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> StatusCode {
    if let Err(code) = auth.require("host.manage") {
        return code;
    }
    // Invalid UUID → the cast errors → treat as not found.
    let res =
        sqlx::query("DELETE FROM hosts WHERE organization_id = ($1)::uuid AND id = ($2)::uuid")
            .bind(DEFAULT_ORG)
            .bind(&id)
            .execute(&state.pool)
            .await;

    match res {
        Ok(r) if r.rows_affected() > 0 => StatusCode::NO_CONTENT,
        Ok(_) => StatusCode::NOT_FOUND,
        Err(_) => StatusCode::NOT_FOUND,
    }
}
