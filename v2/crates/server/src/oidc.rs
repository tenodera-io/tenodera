//! OIDC login (ADR-0004).
//!
//! Verifies an OIDC **ID token** (RS256, signature checked against the configured
//! JWKS; issuer / audience / expiry validated) and maps the token's `(issuer,
//! subject)` to a local user through an **explicit** `external_identities` row.
//! There is deliberately no auto-provisioning and no mapping from email or display
//! name — an unmapped identity is rejected, per ADR-0004. Session issuance and
//! policy are shared with password login (`auth::issue_session`).

use axum::extract::State;
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::Json;
use jsonwebtoken::jwk::JwkSet;
use jsonwebtoken::{decode, decode_header, Algorithm, DecodingKey, Validation};
use serde_json::json;
use sqlx::Row;

use crate::auth::{issue_session, DEFAULT_ORG};
use crate::AppState;

/// OIDC is enabled only when issuer, audience, and JWKS are all configured.
fn oidc_config() -> Option<(String, String, String)> {
    Some((
        std::env::var("TENODERA_OIDC_ISSUER").ok()?,
        std::env::var("TENODERA_OIDC_AUDIENCE").ok()?,
        std::env::var("TENODERA_OIDC_JWKS").ok()?,
    ))
}

/// Verify signature + iss/aud/exp; return the token `sub`. Any failure = rejected.
fn verify_id_token(
    token: &str,
    issuer: &str,
    audience: &str,
    jwks_json: &str,
) -> Result<String, String> {
    let jwks: JwkSet = serde_json::from_str(jwks_json).map_err(|e| format!("bad jwks: {e}"))?;
    let header = decode_header(token).map_err(|e| format!("bad token header: {e}"))?;
    let kid = header.kid.ok_or("token has no kid")?;
    let jwk = jwks.find(&kid).ok_or("no jwk for kid")?;
    let key = DecodingKey::from_jwk(jwk).map_err(|e| format!("bad jwk: {e}"))?;

    let mut validation = Validation::new(Algorithm::RS256);
    validation.set_issuer(&[issuer]);
    validation.set_audience(&[audience]);
    let data = decode::<serde_json::Value>(token, &key, &validation).map_err(|e| e.to_string())?;

    data.claims
        .get("sub")
        .and_then(|s| s.as_str())
        .map(str::to_string)
        .ok_or_else(|| "token has no sub".into())
}

/// POST /api/auth/oidc — body `{ "id_token": "<jwt>" }`.
pub async fn login_oidc(
    State(state): State<AppState>,
    Json(req): Json<serde_json::Value>,
) -> impl IntoResponse {
    let token = req.get("id_token").and_then(|v| v.as_str()).unwrap_or("");
    if token.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "id_token required" })),
        );
    }
    let Some((issuer, audience, jwks)) = oidc_config() else {
        return (
            StatusCode::NOT_IMPLEMENTED,
            Json(json!({ "error": "oidc not configured" })),
        );
    };

    let sub = match verify_id_token(token, &issuer, &audience, &jwks) {
        Ok(s) => s,
        Err(e) => {
            tracing::warn!(error = %e, "oidc token rejected");
            crate::audit::record(
                &state.pool, "login", None, None, "oidc", "denied", "failed",
                json!({ "reason": "invalid_token", "method": "oidc" }),
            )
            .await;
            return (
                StatusCode::UNAUTHORIZED,
                Json(json!({ "error": "invalid token" })),
            );
        }
    };

    // Explicit mapping only — (issuer, subject) -> user; no auto-provisioning.
    let row = sqlx::query(
        "SELECT u.id::text AS id, u.username AS username
           FROM external_identities ei
           JOIN users u ON u.id = ei.user_id
          WHERE ei.issuer = $1 AND ei.subject = $2
            AND u.organization_id = ($3)::uuid AND u.status = 'active'",
    )
    .bind(&issuer)
    .bind(&sub)
    .bind(DEFAULT_ORG)
    .fetch_optional(&state.pool)
    .await;
    let (user_id, username): (String, String) = match row {
        Ok(Some(r)) => (r.get("id"), r.get("username")),
        Ok(None) => {
            crate::audit::record(
                &state.pool, "login", None, None, &sub, "denied", "failed",
                json!({ "reason": "unmapped_identity", "method": "oidc", "issuer": issuer }),
            )
            .await;
            return (
                StatusCode::UNAUTHORIZED,
                Json(json!({ "error": "identity not provisioned" })),
            );
        }
        Err(_) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": "database error" })),
            )
        }
    };

    match issue_session(&state.pool, &user_id).await {
        Some(token) => {
            crate::audit::record(
                &state.pool, "login", Some(&user_id), None, &username, "allowed", "succeeded",
                json!({ "method": "oidc" }),
            )
            .await;
            (
                StatusCode::OK,
                Json(json!({ "token": token, "user": username })),
            )
        }
        None => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": "could not create session" })),
        ),
    }
}
