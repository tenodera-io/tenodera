//! Operation endpoints (Phase 2) — the API surface that drives host operations
//! through the SSH connection manager and the bridge.
//!
//! Every operation is a **durable job**: we record a `jobs` row (who, host, op,
//! args, args_hash — the grant-binding fingerprint from ADR-0004/0005) before
//! running it, a `job_results` row when it finishes, and an entry in the
//! hash-chain audit log (ADR-0007). So an operation is an accountable, replayable
//! event — not a transient request. RBAC is the narrowing gate on top of the
//! host's own sudo/HBAC authority.

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::Json;
use serde_json::json;
use sha2::{Digest, Sha256};
use sqlx::Row;

use crate::auth::{Auth, DEFAULT_ORG};
use crate::{audit, ssh, AppState};

/// Grant-binding fingerprint: SHA-256 over canonical (operation, args). serde_json
/// key-sorts maps, so this is stable for equal argument sets (ADR-0004/0005).
fn args_hash(operation: &str, args: &serde_json::Value) -> Vec<u8> {
    let canon = json!([operation, args]).to_string();
    Sha256::digest(canon.as_bytes()).to_vec()
}

/// POST /api/hosts/{id}/service.status — requires `service.view`.
pub async fn service_status(
    auth: Auth,
    State(state): State<AppState>,
    Path(host_id): Path<String>,
    Json(body): Json<serde_json::Value>,
) -> impl IntoResponse {
    let unit = body
        .get("unit")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();

    if auth.require("service.view").is_err() {
        audit::record(
            &state.pool,
            "service.status",
            Some(&auth.user_id),
            None,
            &unit,
            "denied",
            "failed",
            json!({ "host_id": host_id }),
        )
        .await;
        return (StatusCode::FORBIDDEN, Json(json!({ "error": "forbidden" })));
    }
    if unit.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "unit required" })),
        );
    }

    // Host must exist in this org.
    let row = match sqlx::query(
        "SELECT hostname, port FROM hosts
          WHERE organization_id = ($1)::uuid AND id = ($2)::uuid",
    )
    .bind(DEFAULT_ORG)
    .bind(&host_id)
    .fetch_optional(&state.pool)
    .await
    {
        Ok(Some(r)) => r,
        _ => {
            return (
                StatusCode::NOT_FOUND,
                Json(json!({ "error": "host not found" })),
            )
        }
    };
    let hostname: String = row.get("hostname");
    let port: i32 = row.get("port");

    // The operator's local principal = the SSH certificate principal (ADR-0003).
    let principal: Option<String> =
        sqlx::query_scalar("SELECT local_principal FROM users WHERE id = ($1)::uuid")
            .bind(&auth.user_id)
            .fetch_optional(&state.pool)
            .await
            .ok()
            .flatten();
    let Some(principal) = principal else {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": "principal lookup failed" })),
        );
    };

    let op = json!({ "v": 1, "op": "service.status", "args": { "unit": unit } });
    let ah = args_hash("service.status", &op["args"]);

    // Durable job row (state=running) before we touch the host.
    let job_id: Option<String> = sqlx::query_scalar(
        "INSERT INTO jobs
            (id, organization_id, actor_user_id, host_id, operation, args, args_hash, state)
         VALUES
            (gen_random_uuid(), ($1)::uuid, ($2)::uuid, ($3)::uuid,
             'service.status', ($4)::jsonb, $5, 'running')
         RETURNING id::text",
    )
    .bind(DEFAULT_ORG)
    .bind(&auth.user_id)
    .bind(&host_id)
    .bind(op["args"].to_string())
    .bind(&ah)
    .fetch_optional(&state.pool)
    .await
    .ok()
    .flatten();

    // Run it over SSH+bridge and classify the outcome.
    let (state_name, success, response, error_code): (
        &str,
        bool,
        serde_json::Value,
        Option<String>,
    ) = match ssh::run_operation(&hostname, port, &principal, &op).await {
        Ok(res) => {
            if res.get("ok").and_then(|v| v.as_bool()).unwrap_or(false) {
                ("succeeded", true, res, None)
            } else {
                let ec = res
                    .get("error")
                    .and_then(|v| v.as_str())
                    .map(str::to_string)
                    .or(Some("operation_failed".into()));
                ("failed", false, res, ec)
            }
        }
        Err(e) => (
            "failed",
            false,
            json!({ "ok": false, "error": e }),
            Some("transport".into()),
        ),
    };

    // Finalize the job + record its result (best-effort — never mask the outcome).
    if let Some(ref jid) = job_id {
        let _ = sqlx::query("UPDATE jobs SET state = $2 WHERE id = ($1)::uuid")
            .bind(jid)
            .bind(state_name)
            .execute(&state.pool)
            .await;
        let _ = sqlx::query(
            "INSERT INTO job_results
                (id, job_id, exit_code, success, started_at, finished_at, error_code, response)
             VALUES
                (gen_random_uuid(), ($1)::uuid, $2, $3,
                 (SELECT created_at FROM jobs WHERE id = ($1)::uuid), now(), $4, ($5)::jsonb)",
        )
        .bind(jid)
        .bind(if success { Some(0) } else { None::<i32> })
        .bind(success)
        .bind(&error_code)
        .bind(response.to_string())
        .execute(&state.pool)
        .await;
    }

    audit::record(
        &state.pool,
        "service.status",
        Some(&auth.user_id),
        Some(&host_id),
        &unit,
        "allowed",
        if success { "succeeded" } else { "failed" },
        json!({ "job_id": job_id, "state": state_name }),
    )
    .await;

    let code = if error_code.as_deref() == Some("transport") {
        StatusCode::BAD_GATEWAY
    } else {
        StatusCode::OK
    };
    let mut out = response;
    if let Some(obj) = out.as_object_mut() {
        obj.insert("job_id".into(), json!(job_id));
    }
    (code, Json(out))
}
