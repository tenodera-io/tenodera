mod audit;
mod auth;
mod agent_registry;
mod agent_ws;
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

    let state = Arc::new(AppState {
        config,
        sessions,
        login_limiter,
        agent_registry: AgentRegistry::new(),
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
