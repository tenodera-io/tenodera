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

    let migrator = sqlx::migrate!("../../migrations");

    // `tenodera-server migrate` applies pending migrations, then exits. Migrations
    // are an explicit operator step (ADR-0002) — the serving process never applies
    // schema changes to a live database on its own.
    if std::env::args().nth(1).as_deref() == Some("migrate") {
        migrator.run(&pool).await?;
        tracing::info!("migrations applied");
        return Ok(());
    }

    // Serve mode: refuse to start against a schema that isn't fully migrated.
    let expected: Vec<i64> = migrator.iter().map(|m| m.version).collect();
    let applied: Vec<i64> =
        sqlx::query_scalar("SELECT version FROM _sqlx_migrations ORDER BY version")
            .fetch_all(&pool)
            .await
            .unwrap_or_default();
    let pending: Vec<i64> = expected
        .into_iter()
        .filter(|v| !applied.contains(v))
        .collect();
    if !pending.is_empty() {
        tracing::error!(
            ?pending,
            "schema is not up to date — run `tenodera-server migrate` first; refusing to start"
        );
        anyhow::bail!("pending migrations: {pending:?}");
    }

    // Seed the permission/role catalog (idempotent app data, not schema; ADR-0006).
    rbac::seed(&pool).await?;

    #[cfg(feature = "dev-auth")]
    if std::env::var("TENODERA_DEV_AUTH").as_deref() == Ok("1") {
        tracing::warn!(
            "dev-auth build + TENODERA_DEV_AUTH=1 — password shortcut ENABLED (never in release)"
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
        .layer(axum::middleware::from_fn(security_headers))
        .with_state(state);

    let listener = tokio::net::TcpListener::bind("127.0.0.1:8080").await?;
    tracing::info!("tenodera-server (v2) listening on 127.0.0.1:8080");
    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await?;
    Ok(())
}

/// Attach conservative security headers and a per-request id to every response.
async fn security_headers(
    req: axum::extract::Request,
    next: axum::middleware::Next,
) -> axum::response::Response {
    use axum::http::HeaderValue;
    let request_id = uuid::Uuid::new_v4().to_string();
    let mut res = next.run(req).await;
    let h = res.headers_mut();
    h.insert(
        "x-content-type-options",
        HeaderValue::from_static("nosniff"),
    );
    h.insert("x-frame-options", HeaderValue::from_static("DENY"));
    h.insert("referrer-policy", HeaderValue::from_static("no-referrer"));
    h.insert(
        "cross-origin-opener-policy",
        HeaderValue::from_static("same-origin"),
    );
    if let Ok(v) = HeaderValue::from_str(&request_id) {
        h.insert("x-request-id", v);
    }
    res
}

/// The single-page control panel (served same-origin so /api/* needs no CORS).
async fn index() -> axum::response::Html<&'static str> {
    axum::response::Html(include_str!("../web/index.html"))
}

/// Readiness: a real DB round-trip. Returns 503 when the database is unreachable
/// so a load balancer / orchestrator stops routing to a control plane that can't
/// serve (and can't fail closed on jobs/audit).
async fn health(
    State(state): State<AppState>,
) -> (axum::http::StatusCode, Json<serde_json::Value>) {
    match sqlx::query_scalar::<_, i64>("SELECT count(*) FROM organizations")
        .fetch_one(&state.pool)
        .await
    {
        Ok(orgs) => (
            axum::http::StatusCode::OK,
            Json(serde_json::json!({ "status": "ok", "db": "connected", "organizations": orgs })),
        ),
        Err(_) => (
            axum::http::StatusCode::SERVICE_UNAVAILABLE,
            Json(serde_json::json!({ "status": "degraded", "db": "unreachable" })),
        ),
    }
}

async fn shutdown_signal() {
    let _ = tokio::signal::ctrl_c().await;
}
