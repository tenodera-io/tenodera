use std::net::SocketAddr;
use std::sync::Arc;

use axum::{Json, extract::State};
use axum::extract::ConnectInfo;
use axum::http::{HeaderMap, StatusCode};
use serde::{Deserialize, Serialize};

use crate::AppState;
use crate::pam;

/// Extract client `SocketAddr` regardless of how it was injected.
///
/// - **Plaintext mode** — `axum::serve` with `into_make_service_with_connect_info`
///   populates `ConnectInfo<SocketAddr>` natively.
/// - **TLS mode** — our accept loop injects it via `axum::Extension(ConnectInfo(addr))`.
///
/// This extractor tries the native path first, then falls back to Extension.
pub(crate) struct ClientAddr(SocketAddr);

impl<S: Send + Sync> axum::extract::FromRequestParts<S> for ClientAddr {
    type Rejection = StatusCode;

    async fn from_request_parts(
        parts: &mut axum::http::request::Parts,
        state: &S,
    ) -> Result<Self, Self::Rejection> {
        // Try native ConnectInfo (plaintext mode)
        if let Ok(ConnectInfo(addr)) = ConnectInfo::<SocketAddr>::from_request_parts(parts, state).await {
            return Ok(Self(addr));
        }
        // Fallback: Extension (TLS mode)
        if let Ok(axum::Extension(ConnectInfo(addr))) =
            axum::Extension::<ConnectInfo<SocketAddr>>::from_request_parts(parts, state).await
        {
            return Ok(Self(addr));
        }
        tracing::error!("could not extract client address from request");
        Err(StatusCode::INTERNAL_SERVER_ERROR)
    }
}

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
/// Authenticates via PAM (tenodera-pam-helper subprocess). Creates session on success.
/// Rate-limited per client IP: max_startups failed attempts per 5-minute window.
pub async fn login(
    State(state): State<Arc<AppState>>,
    ClientAddr(addr): ClientAddr,
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
        // Atomic check-and-record: eliminates TOCTOU race between
        // is_limited() and record_failure() that existed when they
        // were separate calls with independent lock acquisitions.
        state.login_limiter.check_and_record(client_ip).await;
        return Err((
            StatusCode::UNAUTHORIZED,
            Json(LoginError {
                error: result.error.unwrap_or_else(|| "authentication failed".into()),
            }),
        ));
    }

    // Verify the user has sudo privileges — privileged operations
    // (package management, firewall, systemd) all require sudo.
    // Reject login early rather than failing cryptically later.
    if let Err(e) = pam::verify_sudo(&req.user).await {
        tracing::warn!(user = %req.user, ip = %client_ip, error = %e, "sudo verification failed");
        crate::audit::log(&req.user, "login", "", false, "no sudo privileges");
        return Err((
            StatusCode::FORBIDDEN,
            Json(LoginError {
                error: e,
            }),
        ));
    }

    let session = state.sessions.create(req.user.clone(), req.password).await;
    crate::audit::log(&session.user, "login", "", true, "");

    Ok(Json(LoginResponse {
        session_id: session.id.clone(),
        user: session.user.clone(),
    }))
}
