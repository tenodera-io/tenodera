//! Sessions & authentication (Phase 1).
//!
//! Sessions are DB-backed (ADR-0002): only a SHA-256 of the bearer token is
//! stored, with idle + absolute expiry and server-side revocation. The credential
//! check here is a **development placeholder** — real authentication is PAM /
//! LDAP / SSSD / FreeIPA (and later OIDC), which per ADR-0004 needs its own helper
//! and lands as a separate subsystem. The placeholder is inert unless
//! `TENODERA_DEV_AUTH=1` is set, so it can never silently ship as a way in.

use axum::extract::{FromRequestParts, State};
use axum::http::request::Parts;
use axum::http::{HeaderMap, StatusCode};
use axum::response::IntoResponse;
use axum::{Json, RequestPartsExt};
use sha2::{Digest, Sha256};
use sqlx::Row;

use crate::AppState;

/// The single default organization until multi-tenant (ADR-0002).
pub(crate) const DEFAULT_ORG: &str = "00000000-0000-0000-0000-000000000001";
const IDLE_TIMEOUT: &str = "15 minutes";
const ABSOLUTE_LIFETIME: &str = "4 hours";

fn digest(token: &str) -> Vec<u8> {
    Sha256::digest(token.as_bytes()).to_vec()
}

/// Generate a random bearer token (hex) and return `(token, sha256(token))`.
fn new_token() -> (String, Vec<u8>) {
    let mut raw = [0u8; 32];
    getrandom::fill(&mut raw).expect("OS RNG unavailable");
    let token: String = raw.iter().map(|b| format!("{b:02x}")).collect();
    let d = digest(&token);
    (token, d)
}

fn bearer(headers: &HeaderMap) -> Option<String> {
    headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .map(str::to_owned)
}

/// An authenticated session (validated inline: not expired, not revoked; touched),
/// carrying the user's effective RBAC permissions (ADR-0006).
pub struct Auth {
    pub user_id: String,
    pub username: String,
    pub permissions: std::collections::HashSet<String>,
}

impl Auth {
    /// Gate a handler on a permission. `Err(FORBIDDEN)` when the user lacks it.
    /// (Scope filtering — per host/group/tag — is deferred; this is the global set.)
    pub fn require(&self, permission: &str) -> Result<(), StatusCode> {
        if self.permissions.contains(permission) {
            Ok(())
        } else {
            Err(StatusCode::FORBIDDEN)
        }
    }
}

impl FromRequestParts<AppState> for Auth {
    type Rejection = StatusCode;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> Result<Self, Self::Rejection> {
        let headers = parts.extract::<HeaderMap>().await.unwrap_or_default();
        let token = bearer(&headers).ok_or(StatusCode::UNAUTHORIZED)?;
        // Validate + touch atomically: only rows still within both TTLs and not
        // revoked are returned; touching extends the idle window.
        let row = sqlx::query(
            "UPDATE sessions s
                SET last_seen_at = now(),
                    idle_expires_at = now() + ($2)::interval
              FROM users u
             WHERE u.id = s.user_id
               AND s.token_sha256 = $1
               AND s.revoked_at IS NULL
               AND s.idle_expires_at > now()
               AND s.absolute_expires_at > now()
         RETURNING u.id::text AS user_id, u.username AS username",
        )
        .bind(digest(&token))
        .bind(IDLE_TIMEOUT)
        .fetch_optional(&state.pool)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .ok_or(StatusCode::UNAUTHORIZED)?;

        let user_id: String = row.get("user_id");

        // Effective permissions = union across the user's role grants (scope-agnostic
        // for now; ADR-0006 scope filtering lands with the operation router).
        let perm_rows = sqlx::query(
            "SELECT DISTINCT rp.permission
               FROM user_roles ur
               JOIN role_permissions rp ON rp.role_id = ur.role_id
              WHERE ur.user_id = ($1)::uuid",
        )
        .bind(&user_id)
        .fetch_all(&state.pool)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
        let permissions = perm_rows
            .iter()
            .map(|r| r.get::<String, _>("permission"))
            .collect();

        Ok(Auth {
            user_id,
            username: row.get("username"),
            permissions,
        })
    }
}

/// POST /api/auth/login — DEV placeholder credential check (see module docs).
pub async fn login(
    State(state): State<AppState>,
    Json(req): Json<serde_json::Value>,
) -> impl IntoResponse {
    let username = req.get("username").and_then(|v| v.as_str()).unwrap_or("");
    let password = req.get("password").and_then(|v| v.as_str()).unwrap_or("");
    if username.is_empty() || password.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": "username and password required" })),
        );
    }

    // ── PLACEHOLDER credential verification (replace with PAM, ADR-0004) ──────
    let dev_auth = std::env::var("TENODERA_DEV_AUTH").as_deref() == Ok("1");
    let dev_password = std::env::var("DEV_LOGIN_PASSWORD").unwrap_or_else(|_| "devpass".into());
    if !dev_auth || password != dev_password {
        return (
            StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({ "error": "invalid credentials" })),
        );
    }

    let user = sqlx::query(
        "SELECT id::text AS id FROM users
          WHERE organization_id = ($1)::uuid AND username = $2 AND status = 'active'",
    )
    .bind(DEFAULT_ORG)
    .bind(username)
    .fetch_optional(&state.pool)
    .await;

    let user_id: String = match user {
        Ok(Some(r)) => r.get("id"),
        Ok(None) => {
            return (
                StatusCode::UNAUTHORIZED,
                Json(serde_json::json!({ "error": "invalid credentials" })),
            );
        }
        Err(_) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({ "error": "database error" })),
            );
        }
    };

    let (token, token_digest) = new_token();
    let inserted = sqlx::query(
        "INSERT INTO sessions
            (id, organization_id, user_id, token_sha256, idle_expires_at, absolute_expires_at)
         VALUES
            (gen_random_uuid(), ($1)::uuid, ($2)::uuid, $3,
             now() + ($4)::interval, now() + ($5)::interval)",
    )
    .bind(DEFAULT_ORG)
    .bind(&user_id)
    .bind(&token_digest)
    .bind(IDLE_TIMEOUT)
    .bind(ABSOLUTE_LIFETIME)
    .execute(&state.pool)
    .await;

    match inserted {
        Ok(_) => (
            StatusCode::OK,
            Json(serde_json::json!({ "token": token, "user": username })),
        ),
        Err(_) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": "could not create session" })),
        ),
    }
}

/// POST /api/auth/logout — revoke the presented session.
pub async fn logout(State(state): State<AppState>, headers: HeaderMap) -> StatusCode {
    let Some(token) = bearer(&headers) else {
        return StatusCode::UNAUTHORIZED;
    };
    let _ = sqlx::query(
        "UPDATE sessions SET revoked_at = now(), revocation_reason = 'logout'
          WHERE token_sha256 = $1 AND revoked_at IS NULL",
    )
    .bind(digest(&token))
    .execute(&state.pool)
    .await;
    StatusCode::NO_CONTENT
}

/// GET /api/me — protected; proves the `Auth` extractor end to end.
pub async fn me(auth: Auth) -> Json<serde_json::Value> {
    Json(serde_json::json!({ "user_id": auth.user_id, "username": auth.username }))
}
