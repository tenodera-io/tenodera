mod audit;
mod auth;
mod bridge_transport;
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
    Router,
    routing::get,
};
use tower_http::trace::TraceLayer;
use tracing_subscriber::EnvFilter;

use crate::config::GatewayConfig;
use crate::rate_limit::LoginRateLimiter;
use crate::session::SessionStore;

/// Shared application state passed to all handlers.
pub struct AppState {
    pub config: GatewayConfig,
    pub sessions: SessionStore,
    pub login_limiter: LoginRateLimiter,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // Logging
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::from_default_env().add_directive("tenodera_gateway=debug".parse()?))
        .init();

    let config = GatewayConfig::default();
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
    });

    // Build TLS acceptor before moving state into router
    let allow_unencrypted = state.config.allow_unencrypted;
    let tls_acceptor = tls::build_acceptor(&state.config)?;

    let app = Router::new()
        .route("/api/auth/login", axum::routing::post(auth::login))
        .route("/api/auth/logout", axum::routing::post(auth::logout))
        .route("/api/ws", get(ws::ws_upgrade))
        .route("/api/health", get(health))
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
        .layer(axum::middleware::from_fn(security_headers::security_headers))
        .layer(TraceLayer::new_for_http())
        .with_state(state);

    let listener = tokio::net::TcpListener::bind(bind_addr).await?;

    // Check if TLS is configured
    match tls_acceptor {
        Some(acceptor) => {
            tracing::info!("tenodera-gateway listening on {} (TLS)", bind_addr);
            tls::serve_tls(listener, acceptor, app).await?;
        }
        None => {
            if !allow_unencrypted {
                anyhow::bail!("TLS not configured and TENODERA_ALLOW_UNENCRYPTED is not set. \
                    Set TENODERA_TLS_CERT and TENODERA_TLS_KEY, or set TENODERA_ALLOW_UNENCRYPTED=1 for dev.");
            }
            tracing::info!("tenodera-gateway listening on {} (plaintext)", bind_addr);
            axum::serve(
                listener,
                app.into_make_service_with_connect_info::<SocketAddr>(),
            ).await?;
        }
    }

    Ok(())
}

async fn health() -> &'static str {
    "ok"
}
