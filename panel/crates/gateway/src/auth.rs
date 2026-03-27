use std::net::SocketAddr;
use std::sync::Arc;

use axum::{Json, extract::State};
use axum::extract::ConnectInfo;
use axum::http::{HeaderMap, StatusCode};
use serde::{Deserialize, Serialize};

use crate::AppState;
use crate::pam;

#[derive(Deserialize)]
pub struct LoginRequest {
    pub user: String,
    pub password: String,
}

#[derive(Serialize)]
pub struct LoginResponse {
    pub session_id: String,
    pub user: String,
}

#[derive(Serialize)]
pub struct LoginError {
    pub error: String,
}

#[derive(Deserialize)]
pub struct LogoutRequest {
    pub session_id: String,
}

/// POST /api/auth/logout
///
/// Destroys the server-side session so credentials are no longer held in memory.
/// Requires `Authorization: Bearer <session_id>` header matching the body
/// `session_id` to prevent unauthenticated session destruction.
pub async fn logout(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(req): Json<LogoutRequest>,
) -> StatusCode {
    // Extract Bearer token from Authorization header
    let token = headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "));

    // The caller must prove they own the session
    match token {
        Some(t) if t == req.session_id => {}
        _ => {
            tracing::warn!(session_id = %req.session_id, "logout rejected: missing or mismatched Authorization header");
            return StatusCode::UNAUTHORIZED;
        }
    }

    let user = state
        .sessions
        .get(&req.session_id)
        .await
        .map(|s| s.user.clone())
        .unwrap_or_default();
    state.sessions.remove(&req.session_id).await;
    crate::audit::log(&user, "logout", "", true, "");
    tracing::info!(session_id = %req.session_id, "session destroyed via logout");
    StatusCode::OK
}

/// POST /api/auth/login
///
/// Authenticates via PAM (unix_chkpwd). Creates session on success.
/// Rate-limited per client IP: max_startups failed attempts per 5-minute window.
pub async fn login(
    State(state): State<Arc<AppState>>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    Json(req): Json<LoginRequest>,
) -> Result<Json<LoginResponse>, (StatusCode, Json<LoginError>)> {
    let client_ip = addr.ip();

    // Check rate limit before doing any work
    if state.login_limiter.is_limited(client_ip).await {
        tracing::warn!(user = %req.user, ip = %client_ip, "login rate-limited");
        crate::audit::log(&req.user, "login", "", false, "rate-limited");
        return Err((
            StatusCode::TOO_MANY_REQUESTS,
            Json(LoginError {
                error: "too many failed attempts, try again later".into(),
            }),
        ));
    }

    if req.user.is_empty() || req.password.is_empty() {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(LoginError {
                error: "user and password required".into(),
            }),
        ));
    }

    tracing::info!(user = %req.user, ip = %client_ip, "login attempt");

    let result = pam::authenticate(&req.user, &req.password).await;

    if !result.success {
        tracing::warn!(user = %req.user, ip = %client_ip, "authentication failed");
        crate::audit::log(&req.user, "login", "", false, "authentication failed");
        state.login_limiter.record_failure(client_ip).await;
        return Err((
            StatusCode::UNAUTHORIZED,
            Json(LoginError {
                error: result.error.unwrap_or_else(|| "authentication failed".into()),
            }),
        ));
    }

    // Clear rate limit on successful login
    state.login_limiter.clear(client_ip).await;

    let session = state.sessions.create(req.user.clone(), req.password).await;
    crate::audit::log(&session.user, "login", "", true, "");

    Ok(Json(LoginResponse {
        session_id: session.id.clone(),
        user: session.user.clone(),
    }))
}
