mod agent_auth;
mod agent_registry;
mod agent_ws;
mod audit;
mod auth;
mod config;
mod hosts_config;
mod pam;
mod rate_limit;
mod security_headers;
mod session;
mod tls;
mod ws;

use std::net::SocketAddr;
use std::sync::Arc;

use axum::{
    Json, Router,
    extract::State,
    http::{HeaderMap, StatusCode},
    routing::get,
};
use serde::{Deserialize, Serialize};
use tower_http::trace::TraceLayer;
use tracing_subscriber::EnvFilter;

use axum::response::IntoResponse;

use crate::agent_auth::{BootstrapRegistry, PendingRegistry};
use crate::agent_registry::AgentRegistry;
use crate::config::GatewayConfig;
use crate::rate_limit::LoginRateLimiter;
use crate::session::SessionStore;

/// Drop privileges from root to the tenodera-gw system account.
///
/// Called after TLS cert/key files are read and the TCP socket is bound —
/// the two operations that may require root access. After this point the
/// process runs as the unprivileged tenodera-gw user for the rest of its
/// lifetime.  A no-op when already running as a non-root user (e.g. during
/// development or when systemd's User= is still set).
#[cfg(target_os = "linux")]
fn drop_privileges() -> anyhow::Result<()> {
    if unsafe { libc::geteuid() } != 0 {
        return Ok(());
    }

    let username = std::ffi::CString::new("tenodera-gw").unwrap();
    let pw = unsafe { libc::getpwnam(username.as_ptr()) };
    if pw.is_null() {
        anyhow::bail!(
            "user 'tenodera-gw' not found — create it before starting the service \
             (useradd -r -s /sbin/nologin -M tenodera-gw)"
        );
    }

    let uid = unsafe { (*pw).pw_uid };
    let gid = unsafe { (*pw).pw_gid };

    // setgid before setuid; then clear supplementary groups.
    if unsafe { libc::setgid(gid) } != 0 {
        anyhow::bail!("setgid({gid}) failed: {}", std::io::Error::last_os_error());
    }
    if unsafe { libc::setgroups(0, std::ptr::null()) } != 0 {
        anyhow::bail!("setgroups() failed: {}", std::io::Error::last_os_error());
    }
    if unsafe { libc::setuid(uid) } != 0 {
        anyhow::bail!("setuid({uid}) failed: {}", std::io::Error::last_os_error());
    }

    tracing::info!(uid, gid, "dropped privileges to tenodera-gw");
    Ok(())
}

#[cfg(not(target_os = "linux"))]
fn drop_privileges() -> anyhow::Result<()> {
    Ok(())
}

/// Shared application state passed to all handlers.
pub struct AppState {
    pub config: GatewayConfig,
    pub sessions: SessionStore,
    pub login_limiter: LoginRateLimiter,
    pub agent_registry: AgentRegistry,
    pub pending_registry: PendingRegistry,
    pub bootstrap_registry: BootstrapRegistry,
    /// Stable UUID identifying this gateway instance (bilateral TOFU with agents).
    pub gateway_id: String,
    pub started_at: std::time::Instant,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // Logging
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::from_default_env().add_directive("tenodera_gateway=debug".parse()?))
        .with_ansi(false)
        .init();

    let config = GatewayConfig::default();
    config.validate()?;
    let bind_addr = config.bind_addr;
    let gateway_id = hosts_config::load_or_create_gateway_id().await?;

    // Disable core dumps so FreeIPA passwords from sessions cannot
    // leak via /proc/<pid>/mem or crash dumps.
    #[cfg(target_os = "linux")]
    unsafe {
        libc::prctl(libc::PR_SET_DUMPABLE, 0);
    }

    let sessions = SessionStore::new(config.idle_timeout_secs);
    sessions.clone().spawn_reaper();

    // Rate limiter: max_startups failed attempts per 5-minute window
    let login_limiter = LoginRateLimiter::new(config.max_startups, 300);
    {
        let limiter = login_limiter.clone();
        tokio::spawn(async move {
            let mut tick = tokio::time::interval(std::time::Duration::from_secs(60));
            loop {
                tick.tick().await;
                limiter.cleanup().await;
            }
        });
    }

    let bootstrap_registry = BootstrapRegistry::new();
    {
        let br = bootstrap_registry.clone();
        tokio::spawn(async move {
            let mut tick = tokio::time::interval(std::time::Duration::from_secs(300));
            loop { tick.tick().await; br.cleanup().await; }
        });
    }

    let state = Arc::new(AppState {
        config,
        sessions,
        login_limiter,
        agent_registry: AgentRegistry::new(),
        pending_registry: PendingRegistry::new(),
        bootstrap_registry,
        gateway_id,
        started_at: std::time::Instant::now(),
    });

    // Build TLS acceptor before moving state into router
    let allow_unencrypted = state.config.allow_unencrypted;
    let tls_acceptor = tls::build_acceptor(&state.config)?;

    let app = Router::new()
        .route("/api/auth/login", axum::routing::post(auth::login))
        .route("/api/auth/logout", axum::routing::post(auth::logout))
        .route("/api/ws", get(ws::ws_upgrade))
        .route("/api/agent", get(agent_ws::agent_ws_upgrade))
        .route("/api/hosts", axum::routing::get(hosts_list))
        .route("/api/hosts/{id}", axum::routing::delete(hosts_remove).patch(hosts_patch))
        .route("/api/agent/tokens", axum::routing::get(token_list).post(token_create))
        .route("/api/agent/tokens/{id}", axum::routing::delete(token_revoke))
        .route("/api/agent/pending", axum::routing::get(pending_list))
        .route("/api/agent/pending/{fingerprint}/approve", axum::routing::post(pending_approve))
        .route("/api/health", get(health))
        .route("/api/health/ready", get(health_ready))
        // Serve built frontend from ui/dist (production)
        .fallback_service(
            tower_http::services::ServeDir::new(
                std::env::var("TENODERA_UI_DIR").unwrap_or_else(|_| "ui/dist".to_string()),
            )
            .fallback(tower_http::services::ServeFile::new(
                format!(
                    "{}/index.html",
                    std::env::var("TENODERA_UI_DIR").unwrap_or_else(|_| "ui/dist".to_string())
                ),
            )),
        )
        .layer(axum::extract::DefaultBodyLimit::max(1024 * 16)) // 16 KiB max request body
        .layer(axum::middleware::from_fn_with_state(state.clone(), security_headers::security_headers))
        .layer(TraceLayer::new_for_http())
        .with_state(state);

    let listener = tokio::net::TcpListener::bind(bind_addr).await?;

    // TLS cert/key read and socket bound — safe to drop root now.
    drop_privileges()?;

    // Check if TLS is configured
    match tls_acceptor {
        Some(acceptor) => {
            tracing::info!("tenodera-gateway listening on {} (TLS)", bind_addr);
            // Graceful shutdown on SIGTERM (systemd stop) or SIGINT (Ctrl-C).
            // tokio::signal::ctrl_c covers SIGINT; we add SIGTERM explicitly.
            let shutdown = async {
                let ctrl_c = tokio::signal::ctrl_c();
                #[cfg(unix)]
                {
                    let mut sigterm = tokio::signal::unix::signal(
                        tokio::signal::unix::SignalKind::terminate(),
                    ).expect("failed to register SIGTERM handler");
                    tokio::select! {
                        _ = ctrl_c => tracing::info!("received SIGINT, shutting down"),
                        _ = sigterm.recv() => tracing::info!("received SIGTERM, shutting down"),
                    }
                }
                #[cfg(not(unix))]
                {
                    ctrl_c.await.ok();
                    tracing::info!("received SIGINT, shutting down");
                }
            };
            // TLS server runs until shutdown signal
            tokio::select! {
                result = tls::serve_tls(listener, acceptor, app) => {
                    if let Err(e) = result {
                        tracing::error!(error = %e, "TLS server error");
                    }
                }
                _ = shutdown => {}
            }
        }
        None => {
            if !allow_unencrypted {
                anyhow::bail!("TLS not configured and TENODERA_ALLOW_UNENCRYPTED is not set. \
                    Set TENODERA_TLS_CERT and TENODERA_TLS_KEY, or set TENODERA_ALLOW_UNENCRYPTED=1 for dev.");
            }
            tracing::info!("tenodera-gateway listening on {} (plaintext)", bind_addr);
            let shutdown = async {
                let ctrl_c = tokio::signal::ctrl_c();
                #[cfg(unix)]
                {
                    let mut sigterm = tokio::signal::unix::signal(
                        tokio::signal::unix::SignalKind::terminate(),
                    ).expect("failed to register SIGTERM handler");
                    tokio::select! {
                        _ = ctrl_c => tracing::info!("received SIGINT, shutting down"),
                        _ = sigterm.recv() => tracing::info!("received SIGTERM, shutting down"),
                    }
                }
                #[cfg(not(unix))]
                {
                    ctrl_c.await.ok();
                    tracing::info!("received SIGINT, shutting down");
                }
            };
            axum::serve(
                listener,
                app.into_make_service_with_connect_info::<SocketAddr>(),
            )
            .with_graceful_shutdown(shutdown)
            .await?;
        }
    }

    tracing::info!("tenodera-gateway stopped");
    Ok(())
}

#[derive(Serialize)]
struct HealthResponse {
    status: &'static str,
    sessions: usize,
    uptime_secs: u64,
    version: &'static str,
}

async fn health(State(state): State<Arc<AppState>>) -> Json<HealthResponse> {
    let sessions = state.sessions.count().await;
    let uptime_secs = state.started_at.elapsed().as_secs();
    Json(HealthResponse {
        status: "ok",
        sessions,
        uptime_secs,
        version: env!("CARGO_PKG_VERSION"),
    })
}

#[derive(Serialize)]
struct ReadyResponse {
    ready: bool,
    agent_bin: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

async fn health_ready(
    State(state): State<Arc<AppState>>,
) -> (StatusCode, Json<ReadyResponse>) {
    let bin = state.config.agent_bin.clone();
    let (ready, error) = match tokio::fs::metadata(&bin).await {
        Ok(m) if {
            use std::os::unix::fs::PermissionsExt;
            m.permissions().mode() & 0o111 != 0
        } => (true, None),
        Ok(_) => (false, Some(format!("{bin} is not executable"))),
        Err(e) => (false, Some(format!("{bin}: {e}"))),
    };
    let code = if ready { StatusCode::OK } else { StatusCode::SERVICE_UNAVAILABLE };
    (code, Json(ReadyResponse { ready, agent_bin: bin, error }))
}

// ── Bootstrap token endpoints ────────────────────────────────────────────────

#[derive(Deserialize)]
struct CreateTokenRequest {
    #[serde(default = "default_ttl")]
    ttl_secs: u64,
    #[serde(default = "default_true")]
    single_use: bool,
    #[serde(default)]
    max_uses: Option<u32>,
    #[serde(default)]
    bound_hostname: Option<String>,
    #[serde(default)]
    re_enroll: bool,
}

fn default_ttl() -> u64 { 3600 }
fn default_true() -> bool { true }

async fn token_create(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<CreateTokenRequest>,
) -> impl axum::response::IntoResponse {
    let Some(bearer) = extract_bearer_token(&headers) else {
        return (StatusCode::UNAUTHORIZED, Json(serde_json::json!({"error": "unauthorized"}))).into_response();
    };
    let Some(session) = state.sessions.get(&bearer).await else {
        return (StatusCode::UNAUTHORIZED, Json(serde_json::json!({"error": "unauthorized"}))).into_response();
    };
    if session.role != crate::session::Role::Admin {
        return (StatusCode::FORBIDDEN, Json(serde_json::json!({"error": "admin required"}))).into_response();
    }

    let ttl = std::time::Duration::from_secs(body.ttl_secs.clamp(60, 86_400 * 30));
    let (id, value) = state
        .bootstrap_registry
        .create(ttl, body.single_use, body.max_uses, body.bound_hostname, body.re_enroll)
        .await;

    let gateway_url = state.config.external_url.clone()
        .unwrap_or_else(|| format!("https://{}", state.config.bind_addr));

    Json(serde_json::json!({
        "id": id,
        "token": value,
        "ttl_secs": body.ttl_secs,
        "install_cmd": format!(
            "curl -sSL {gateway_url}/tenodera-agent.sh | sudo bash -s -- --gateway {gateway_url} --token {value}"
        ),
    }))
    .into_response()
}

async fn token_list(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> impl axum::response::IntoResponse {
    if require_admin(&state, &headers).await.is_err() {
        return (StatusCode::UNAUTHORIZED, Json(serde_json::json!({"error": "unauthorized"}))).into_response();
    }
    Json(serde_json::json!({ "tokens": state.bootstrap_registry.list().await })).into_response()
}

async fn token_revoke(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    axum::extract::Path(id): axum::extract::Path<String>,
) -> StatusCode {
    if require_admin(&state, &headers).await.is_err() {
        return StatusCode::UNAUTHORIZED;
    }
    if state.bootstrap_registry.revoke(&id).await {
        StatusCode::NO_CONTENT
    } else {
        StatusCode::NOT_FOUND
    }
}

// ── Pending agent endpoints ───────────────────────────────────────────────────

async fn pending_list(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> impl axum::response::IntoResponse {
    if require_admin(&state, &headers).await.is_err() {
        return (StatusCode::UNAUTHORIZED, Json(serde_json::json!({"error": "unauthorized"}))).into_response();
    }
    Json(serde_json::json!({ "pending": state.pending_registry.list().await })).into_response()
}

#[derive(Deserialize, Default)]
struct ApproveRequest {
    #[serde(default)]
    display_name: Option<String>,
}

async fn pending_approve(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    axum::extract::Path(fingerprint_hex): axum::extract::Path<String>,
    body: Option<Json<ApproveRequest>>,
) -> impl axum::response::IntoResponse {
    let Some(bearer) = extract_bearer_token(&headers) else {
        return (StatusCode::UNAUTHORIZED, Json(serde_json::json!({"error": "unauthorized"}))).into_response();
    };
    let Some(session) = state.sessions.get(&bearer).await else {
        return (StatusCode::UNAUTHORIZED, Json(serde_json::json!({"error": "unauthorized"}))).into_response();
    };
    if session.role != crate::session::Role::Admin {
        return (StatusCode::FORBIDDEN, Json(serde_json::json!({"error": "admin required"}))).into_response();
    }

    let display_name = body.and_then(|b| b.0.display_name);

    let (Some(hostname), Some(pubkey_b64)) = (
        state.pending_registry.hostname_for_fingerprint(&fingerprint_hex).await,
        state.pending_registry.pubkey_for_fingerprint(&fingerprint_hex).await,
    ) else {
        return (StatusCode::NOT_FOUND, Json(serde_json::json!({"error": "pending agent not found"}))).into_response();
    };

    let host = match hosts_config::find_by_hostname(&hostname).await {
        Some(existing) => {
            // Hostname already enrolled — update the public key and optional display_name
            match hosts_config::replace_pubkey(&existing.id, &pubkey_b64).await {
                Ok(mut updated) => {
                    if display_name.is_some() {
                        updated.display_name = display_name;
                        if let Err(e) = save_display_name(&updated.id, updated.display_name.clone()).await {
                            tracing::error!(error = %e, "failed to save display_name");
                        }
                    }
                    updated
                }
                Err(e) => {
                    tracing::error!(error = %e, "failed to update pubkey during approval");
                    return (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": "registration failed"}))).into_response();
                }
            }
        }
        None => {
            // New host — register with its public key
            match hosts_config::register_host(&hostname, &pubkey_b64, false, display_name).await {
                Ok(h) => h,
                Err(e) => {
                    tracing::error!(error = %e, "failed to register host during approval");
                    return (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": "registration failed"}))).into_response();
                }
            }
        }
    };

    if state.pending_registry.approve(&fingerprint_hex, host.clone()).await {
        tracing::info!(hostname, host_id = %host.id, "admin approved pending agent");
        Json(serde_json::json!({ "approved": true, "host_id": host.id })).into_response()
    } else {
        (StatusCode::NOT_FOUND, Json(serde_json::json!({"error": "pending agent not found or already approved"}))).into_response()
    }
}

async fn save_display_name(host_id: &str, display_name: Option<String>) -> anyhow::Result<()> {
    let mut config = hosts_config::load().await;
    if let Some(h) = config.hosts.iter_mut().find(|h| h.id == host_id) {
        h.display_name = display_name;
        hosts_config::save(&config).await?;
    }
    Ok(())
}

async fn require_admin(state: &AppState, headers: &HeaderMap) -> Result<(), ()> {
    let bearer = extract_bearer_token(headers).ok_or(())?;
    let session = state.sessions.get(&bearer).await.ok_or(())?;
    if session.role != crate::session::Role::Admin { return Err(()); }
    Ok(())
}

fn extract_bearer_token(headers: &HeaderMap) -> Option<String> {
    headers
        .get("Authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .map(|s| s.to_string())
}

// ── Hosts REST API ──────────────────────────────────────────────────────────

#[derive(Serialize)]
struct HostListEntry {
    id: String,
    name: String,
    hostname: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    display_name: Option<String>,
    added_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    last_seen: Option<String>,
    online: bool,
    is_local: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    remote_ip: Option<String>,
}

async fn hosts_list(
    State(state): State<Arc<AppState>>,
) -> Json<serde_json::Value> {
    let config = hosts_config::load().await;
    let online = state.agent_registry.online_host_ids().await;
    let mut hosts = Vec::with_capacity(config.hosts.len());
    for h in &config.hosts {
        let is_online = online.contains(&h.id);
        let remote_ip = if is_online {
            state.agent_registry.get_remote_ip(&h.id).await
        } else {
            None
        };
        hosts.push(HostListEntry {
            id: h.id.clone(),
            name: h.name.clone(),
            hostname: h.hostname.clone(),
            display_name: h.display_name.clone(),
            added_at: h.added_at.clone(),
            last_seen: h.last_seen.clone(),
            online: is_online,
            is_local: h.is_local,
            remote_ip,
        });
    }
    hosts.sort_by_key(|h| !h.is_local);
    Json(serde_json::json!({ "hosts": hosts }))
}

async fn hosts_remove(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    axum::extract::Path(id): axum::extract::Path<String>,
) -> StatusCode {
    let token = match extract_bearer_token(&headers) {
        Some(t) => t,
        None => return StatusCode::UNAUTHORIZED,
    };
    if state.sessions.get(&token).await.is_none() {
        return StatusCode::UNAUTHORIZED;
    }

    let mut config = hosts_config::load().await;
    let before = config.hosts.len();
    config.hosts.retain(|h| h.id != id);
    if config.hosts.len() == before {
        return StatusCode::NOT_FOUND;
    }

    match hosts_config::save(&config).await {
        Ok(()) => {
            tracing::info!(host_id = %id, "host removed");
            StatusCode::NO_CONTENT
        }
        Err(e) => {
            tracing::error!(error = %e, "failed to save hosts.json");
            StatusCode::INTERNAL_SERVER_ERROR
        }
    }
}

#[derive(Deserialize)]
struct PatchHostRequest {
    display_name: Option<String>,
}

async fn hosts_patch(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    axum::extract::Path(id): axum::extract::Path<String>,
    Json(body): Json<PatchHostRequest>,
) -> StatusCode {
    let token = match extract_bearer_token(&headers) {
        Some(t) => t,
        None => return StatusCode::UNAUTHORIZED,
    };
    if state.sessions.get(&token).await.is_none() {
        return StatusCode::UNAUTHORIZED;
    }

    let mut config = hosts_config::load().await;
    let Some(host) = config.hosts.iter_mut().find(|h| h.id == id) else {
        return StatusCode::NOT_FOUND;
    };

    host.display_name = body.display_name.and_then(|n| {
        let t = n.trim().to_string();
        if t.is_empty() { None } else { Some(t) }
    });

    match hosts_config::save(&config).await {
        Ok(()) => StatusCode::NO_CONTENT,
        Err(e) => {
            tracing::error!(error = %e, "failed to save hosts.json");
            StatusCode::INTERNAL_SERVER_ERROR
        }
    }
}
