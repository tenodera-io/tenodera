//! Operation endpoints (Phase 2) — the API surface that drives host operations
//! through the SSH connection manager and the bridge.
//!
//! Flow: RBAC gate → resolve host + the operator's local principal → sign a
//! short-lived cert and run the typed operation over SSH → return the bridge's
//! result. Durable job/result rows and per-operation audit land in the next
//! sub-step; this proves the transport path end to end.

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::Json;
use serde_json::json;
use sqlx::Row;

use crate::auth::{Auth, DEFAULT_ORG};
use crate::{ssh, AppState};

/// POST /api/hosts/{id}/service.status — requires `service.view`.
pub async fn service_status(
    auth: Auth,
    State(state): State<AppState>,
    Path(host_id): Path<String>,
    Json(body): Json<serde_json::Value>,
) -> impl IntoResponse {
    if auth.require("service.view").is_err() {
        return (StatusCode::FORBIDDEN, Json(json!({ "error": "forbidden" })));
    }
    let unit = body.get("unit").and_then(|v| v.as_str()).unwrap_or("");
    if unit.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "unit required" })),
        );
    }

    // Host must exist in this org.
    let row = sqlx::query(
        "SELECT hostname, port FROM hosts
          WHERE organization_id = ($1)::uuid AND id = ($2)::uuid",
    )
    .bind(DEFAULT_ORG)
    .bind(&host_id)
    .fetch_optional(&state.pool)
    .await;
    let row = match row {
        Ok(Some(r)) => r,
        Ok(None) => {
            return (
                StatusCode::NOT_FOUND,
                Json(json!({ "error": "host not found" })),
            )
        }
        Err(_) => {
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
    match ssh::run_operation(&hostname, port, &principal, &op).await {
        Ok(result) => (StatusCode::OK, Json(result)),
        Err(e) => (StatusCode::BAD_GATEWAY, Json(json!({ "error": e }))),
    }
}
