//! Operation endpoints (Phase 2) — the API surface that drives host operations
//! through the SSH connection manager and the bridge.
//!
//! Every operation is a **durable job**: we record a `jobs` row (who, host, op,
//! args, args_hash — the grant-binding fingerprint from ADR-0004/0005) before
//! running it, a `job_results` row when it finishes, and an entry in the
//! hash-chain audit log (ADR-0007). So an operation is an accountable, replayable
//! event — not a transient request. RBAC is the narrowing gate on top of the
//! host's own sudo/HBAC authority: reads need `service.view`, mutations need
//! `service.manage` (and on the host go through the root op-helper).

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::Json;
use serde_json::json;
use sha2::{Digest, Sha256};
use sqlx::Row;

use crate::auth::{Auth, DEFAULT_ORG};
use crate::{audit, ssh, AppState};

type Reply = (StatusCode, Json<serde_json::Value>);

/// Grant-binding fingerprint: SHA-256 over canonical (operation, args). serde_json
/// key-sorts maps, so this is stable for equal argument sets (ADR-0004/0005).
fn args_hash(operation: &str, args: &serde_json::Value) -> Vec<u8> {
    let canon = json!([operation, args]).to_string();
    Sha256::digest(canon.as_bytes()).to_vec()
}

fn unit_of(body: &serde_json::Value) -> String {
    body.get("unit")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string()
}

fn reauth_of(body: &serde_json::Value) -> Option<String> {
    body.get("reauth")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

/// High-risk (disruptive) operations require fresh step-up re-authentication,
/// independent of the standing sudo grant (ADR-0004 Mode B).
fn requires_step_up(operation: &str) -> bool {
    matches!(operation, "service.stop" | "service.restart")
}

// POST /api/hosts/{id}/service.{status,start,stop,restart}
pub async fn service_status(a: Auth, s: State<AppState>, h: Path<String>, b: Json<serde_json::Value>) -> Reply {
    run_op(a, s, h, "service.status", "service.view", &unit_of(&b), None).await
}
pub async fn service_start(a: Auth, s: State<AppState>, h: Path<String>, b: Json<serde_json::Value>) -> Reply {
    let (unit, reauth) = (unit_of(&b), reauth_of(&b));
    run_op(a, s, h, "service.start", "service.manage", &unit, reauth.as_deref()).await
}
pub async fn service_stop(a: Auth, s: State<AppState>, h: Path<String>, b: Json<serde_json::Value>) -> Reply {
    let (unit, reauth) = (unit_of(&b), reauth_of(&b));
    run_op(a, s, h, "service.stop", "service.manage", &unit, reauth.as_deref()).await
}
pub async fn service_restart(a: Auth, s: State<AppState>, h: Path<String>, b: Json<serde_json::Value>) -> Reply {
    let (unit, reauth) = (unit_of(&b), reauth_of(&b));
    run_op(a, s, h, "service.restart", "service.manage", &unit, reauth.as_deref()).await
}

/// Shared pipeline: RBAC gate → resolve host + principal → durable job → run over
/// SSH+bridge → persist result → hash-chain audit → reply.
async fn run_op(
    auth: Auth,
    State(state): State<AppState>,
    Path(host_id): Path<String>,
    operation: &str,
    required: &str,
    unit: &str,
    reauth: Option<&str>,
) -> Reply {
    if auth.require(required).is_err() {
        audit::record(
            &state.pool,
            operation,
            Some(&auth.user_id),
            None,
            unit,
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

    // Step-up re-auth for high-risk operations (ADR-0004 Mode B): a fresh PAM
    // check of the operator's own password, independent of the standing grant.
    if requires_step_up(operation) {
        let passed = match reauth {
            Some(pw) => crate::auth::pam_authenticate(&principal, pw).await,
            None => false,
        };
        if !passed {
            audit::record(
                &state.pool,
                operation,
                Some(&auth.user_id),
                Some(&host_id),
                unit,
                "denied",
                "failed",
                json!({ "reason": "step_up_required" }),
            )
            .await;
            return (
                StatusCode::UNAUTHORIZED,
                Json(json!({ "error": "step-up authentication required", "step_up": true })),
            );
        }
    }

    // Pinned host keys (ADR-0003). No trusted key = host not enrolled; refuse to
    // connect rather than trust-on-first-use silently during an operation.
    let pinned: Vec<String> = sqlx::query_scalar(
        "SELECT public_key FROM ssh_host_keys
          WHERE host_id = ($1)::uuid AND trusted_at IS NOT NULL AND revoked_at IS NULL",
    )
    .bind(&host_id)
    .fetch_all(&state.pool)
    .await
    .unwrap_or_default();
    if pinned.is_empty() {
        return (
            StatusCode::CONFLICT,
            Json(json!({ "error": "host not enrolled (no trusted host key)" })),
        );
    }
    let token = ssh::known_hosts_token(&hostname, port);
    let known_hosts = pinned
        .iter()
        .map(|pk| format!("{token} {pk}"))
        .collect::<Vec<_>>()
        .join("\n");

    let op = json!({ "v": 1, "op": operation, "args": { "unit": unit } });
    let ah = args_hash(operation, &op["args"]);

    // Durable job row (state=running) before we touch the host.
    let job_id: Option<String> = sqlx::query_scalar(
        "INSERT INTO jobs
            (id, organization_id, actor_user_id, host_id, operation, args, args_hash, state)
         VALUES
            (gen_random_uuid(), ($1)::uuid, ($2)::uuid, ($3)::uuid,
             $4, ($5)::jsonb, $6, 'running')
         RETURNING id::text",
    )
    .bind(DEFAULT_ORG)
    .bind(&auth.user_id)
    .bind(&host_id)
    .bind(operation)
    .bind(op["args"].to_string())
    .bind(&ah)
    .fetch_optional(&state.pool)
    .await
    .ok()
    .flatten();

    // Run it over SSH+bridge and classify the outcome.
    let (state_name, success, response, error_code): (&str, bool, serde_json::Value, Option<String>) =
        match ssh::run_operation(&hostname, port, &principal, &op, &known_hosts).await {
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
        operation,
        Some(&auth.user_id),
        Some(&host_id),
        unit,
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
