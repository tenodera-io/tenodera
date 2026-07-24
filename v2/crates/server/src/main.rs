//! Tenodera v2 control plane — Phase 1 skeleton.
//!
//! Unprivileged process. For now it only proves the data foundation is wired:
//! connect to PostgreSQL, apply migrations via sqlx (the source of truth for the
//! schema — ADR-0002), and expose `/health` that reads the DB. Everything else
//! (auth, sessions, RBAC, SSH connection manager, jobs, audit) lands in later
//! phases.

use axum::{extract::State, routing::get, Json, Router};
use sqlx::postgres::PgPoolOptions;
use sqlx::PgPool;

#[derive(Clone)]
struct AppState {
    pool: PgPool,
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

    let state = AppState { pool };
    let app = Router::new()
        .route("/health", get(health))
        .with_state(state);

    let listener = tokio::net::TcpListener::bind("127.0.0.1:8080").await?;
    tracing::info!("tenodera-server (v2) listening on 127.0.0.1:8080");
    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await?;
    Ok(())
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
