use std::net::{IpAddr, SocketAddr};
use std::sync::Arc;

use axum::extract::ConnectInfo;
use axum::http::{HeaderMap, StatusCode};
use axum::{Json, extract::State};
use serde::{Deserialize, Serialize};

use crate::AppState;
use crate::pam;
use crate::session::{Role, Session};

/// Bearer token from the `Authorization` header, if present and well-formed.
fn bearer_token(headers: &HeaderMap) -> Option<String> {
    headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .map(str::to_owned)
}

/// Extractor requiring **any valid (non-expired) session**. Rejects with 401.
///
/// Using this in a handler signature makes authentication impossible to forget —
/// the request cannot reach the handler body without a live session.
pub struct Auth(pub Session);

impl axum::extract::FromRequestParts<Arc<AppState>> for Auth {
    type Rejection = StatusCode;

    async fn from_request_parts(
        parts: &mut axum::http::request::Parts,
        state: &Arc<AppState>,
    ) -> Result<Self, Self::Rejection> {
        let token = bearer_token(&parts.headers).ok_or(StatusCode::UNAUTHORIZED)?;
        let session = state
            .sessions
            .get_valid(&token)
            .await
            .ok_or(StatusCode::UNAUTHORIZED)?;
        Ok(Self(session))
    }
}

/// Extractor requiring a valid session **with the `Admin` role**. Rejects with
/// 401 when unauthenticated, 403 when authenticated but not an admin.
pub struct AdminAuth(pub Session);

impl axum::extract::FromRequestParts<Arc<AppState>> for AdminAuth {
    type Rejection = StatusCode;

    async fn from_request_parts(
        parts: &mut axum::http::request::Parts,
        state: &Arc<AppState>,
    ) -> Result<Self, Self::Rejection> {
        let Auth(session) = Auth::from_request_parts(parts, state).await?;
        if session.role != Role::Admin {
            return Err(StatusCode::FORBIDDEN);
        }
        Ok(Self(session))
    }
}

/// Resolve the real client IP behind a trusted local reverse proxy.
///
/// The gateway binds loopback by default and is fronted by a reverse proxy
/// (Caddy), so the socket peer of every browser/agent connection is `127.0.0.1`.
/// When the peer is loopback, honour the proxy's `X-Forwarded-For` / `X-Real-IP`
/// to recover the original client IP. Forwarded headers are trusted **only** from
/// a loopback peer, so a client connecting directly cannot spoof them.
pub(crate) fn real_client_ip(peer: IpAddr, headers: &HeaderMap) -> IpAddr {
    if !peer.is_loopback() {
        return peer;
    }
    // `X-Forwarded-For: client, proxy1, ...` — the leftmost is the origin client.
    if let Some(xff) = headers.get("x-forwarded-for").and_then(|h| h.to_str().ok())
        && let Some(first) = xff.split(',').next()
        && let Ok(ip) = first.trim().parse::<IpAddr>()
    {
        return ip;
    }
    if let Some(xri) = headers.get("x-real-ip").and_then(|h| h.to_str().ok())
        && let Ok(ip) = xri.trim().parse::<IpAddr>()
    {
        return ip;
    }
    peer
}

/// Best-effort IP the browser actually used to reach the panel, taken from the
/// request `Host` (or `X-Forwarded-Host`) header.
///
/// The gateway binds loopback and is fronted by a reverse proxy, so it cannot
/// tell which of its several local IPs the operator browses to (routing/`hostname`
/// heuristics pick the default-route interface, which is often the wrong one on a
/// multi-homed host). The Host header is exactly the address the operator typed,
/// so we use it to label the local panel host in the UI. Returns `None` for a
/// non-IP host (a domain) or a loopback address, so callers fall back to the
/// stored IP.
pub(crate) fn host_header_ip(headers: &HeaderMap) -> Option<IpAddr> {
    for name in ["host", "x-forwarded-host"] {
        let Some(raw) = headers.get(name).and_then(|h| h.to_str().ok()) else {
            continue;
        };
        let v = raw.split(',').next().unwrap_or(raw).trim();
        let ip = v
            .parse::<SocketAddr>()
            .map(|s| s.ip())
            .ok()
            .or_else(|| v.parse::<IpAddr>().ok())
            .or_else(|| {
                v.rsplit_once(':')
                    .and_then(|(a, _)| a.parse::<IpAddr>().ok())
            });
        if let Some(ip) = ip
            && !ip.is_loopback()
        {
            return Some(ip);
        }
    }
    None
}

/// Extract the client IP, resolving `X-Forwarded-For` behind a loopback proxy
/// (see [`real_client_ip`]). Works in both plaintext mode (native `ConnectInfo`)
/// and TLS mode (our accept loop injects it via `axum::Extension`).
pub(crate) struct ClientAddr(pub(crate) IpAddr);

impl<S: Send + Sync> axum::extract::FromRequestParts<S> for ClientAddr {
    type Rejection = StatusCode;

    async fn from_request_parts(
        parts: &mut axum::http::request::Parts,
        state: &S,
    ) -> Result<Self, Self::Rejection> {
        // Try native ConnectInfo (plaintext mode), then Extension (TLS mode).
        let peer = if let Ok(ConnectInfo(addr)) =
            ConnectInfo::<SocketAddr>::from_request_parts(parts, state).await
        {
            addr
        } else if let Ok(axum::Extension(ConnectInfo(addr))) =
            axum::Extension::<ConnectInfo<SocketAddr>>::from_request_parts(parts, state).await
        {
            addr
        } else {
            tracing::error!("could not extract client address from request");
            return Err(StatusCode::INTERNAL_SERVER_ERROR);
        };
        Ok(Self(real_client_ip(peer.ip(), &parts.headers)))
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
    pub role: Role,
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
            tracing::warn!("logout rejected: missing or mismatched Authorization header");
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
    tracing::info!(user = %user, "session destroyed via logout");
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
    let client_ip = addr;

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
                error: result
                    .error
                    .unwrap_or_else(|| "authentication failed".into()),
            }),
        ));
    }

    // Determine role: admin if user is in sudo/wheel/admin group, readonly otherwise.
    // Non-admin users can still log in but write operations will be rejected by the agent.
    let role = match pam::verify_sudo(&req.user).await {
        Ok(()) => Role::Admin,
        Err(e) => {
            tracing::info!(user = %req.user, reason = %e, "user logged in as readonly (no sudo)");
            Role::Readonly
        }
    };

    let session = state.sessions.create(req.user.clone(), role).await;
    crate::audit::log(
        &session.user,
        "login",
        "",
        true,
        &format!("role={}", role.as_str()),
    );

    Ok(Json(LoginResponse {
        session_id: session.id.clone(),
        user: session.user.clone(),
        role: session.role,
    }))
}
