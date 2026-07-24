//! Tenodera v2 control plane — Phase 1 skeleton.
//!
//! Unprivileged process. For now it only proves the data foundation is wired:
//! connect to PostgreSQL, apply migrations via sqlx (the source of truth for the
//! schema — ADR-0002), and expose `/health` that reads the DB. Everything else
//! (auth, sessions, RBAC, SSH connection manager, jobs, audit) lands in later
//! phases.

mod audit;
mod auth;
mod hosts;
mod oidc;
mod ops;
mod rbac;
mod signer;
mod ssh;

use axum::{
    extract::State,
    routing::{get, post},
    Json, Router,
};
use sqlx::postgres::PgPoolOptions;
use sqlx::PgPool;

#[derive(Clone)]
pub(crate) struct AppState {
    pub(crate) pool: PgPool,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "tenodera_server=info".into()),
        )
        .init();

    let db_url = std::env::var("DATABASE_URL")
        .unwrap_or_else(|_| "postgres://tenodera:devpass@localhost/tenodera_v2".into());

    let pool = PgPoolOptions::new()
        .max_connections(5)
        .connect(&db_url)
        .await?;

    // sqlx owns the schema: apply any pending migrations from ../../migrations.
    sqlx::migrate!("../../migrations").run(&pool).await?;
    tracing::info!("migrations applied");

    // Seed permissions, built-in roles, and dev accounts (ADR-0006).
    rbac::seed(&pool).await?;

    if std::env::var("TENODERA_DEV_AUTH").as_deref() == Ok("1") {
        tracing::warn!(
            "TENODERA_DEV_AUTH=1 — placeholder password login is ENABLED (not for production)"
        );
    }

    let state = AppState { pool };
    let app = Router::new()
        .route("/", get(index))
        .route("/health", get(health))
        .route("/api/auth/login", post(auth::login))
        .route("/api/auth/oidc", post(oidc::login_oidc))
        .route("/api/auth/logout", post(auth::logout))
        .route("/api/me", get(auth::me))
        .route("/api/hosts", get(hosts::list).post(hosts::create))
        .route("/api/hosts/{id}", axum::routing::delete(hosts::remove))
        .route("/api/hosts/{id}/enroll", post(hosts::enroll))
        .route("/api/hosts/{id}/service.status", post(ops::service_status))
        .route("/api/hosts/{id}/service.start", post(ops::service_start))
        .route("/api/hosts/{id}/service.stop", post(ops::service_stop))
        .route(
            "/api/hosts/{id}/service.restart",
            post(ops::service_restart),
        )
        .route("/api/audit/verify", get(audit::verify_handler))
        .with_state(state);

    let listener = tokio::net::TcpListener::bind("127.0.0.1:8080").await?;
    tracing::info!("tenodera-server (v2) listening on 127.0.0.1:8080");
    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await?;
    Ok(())
}

/// The single-page control panel (served same-origin so /api/* needs no CORS).
async fn index() -> axum::response::Html<&'static str> {
    axum::response::Html(include_str!("../web/index.html"))
}

/// Readiness + DB round-trip: reports the schema is applied and reachable.
async fn health(State(state): State<AppState>) -> Json<serde_json::Value> {
    let orgs: i64 = sqlx::query_scalar("SELECT count(*) FROM organizations")
        .fetch_one(&state.pool)
        .await
        .unwrap_or(-1);
    let tables: i64 =
        sqlx::query_scalar("SELECT count(*) FROM pg_tables WHERE schemaname = 'public'")
            .fetch_one(&state.pool)
            .await
            .unwrap_or(-1);
    Json(serde_json::json!({
        "status": "ok",
        "db": if orgs >= 0 { "connected" } else { "error" },
        "organizations": orgs,
        "tables": tables,
    }))
}

async fn shutdown_signal() {
    let _ = tokio::signal::ctrl_c().await;
}
