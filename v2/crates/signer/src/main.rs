//! Tenodera v2 grant signer (ADR-0004/0005, external-review step 3).
//!
//! Holds the Ed25519 grant-signing key and nothing else — no HTTP, no user input,
//! no SSH. The server never sees the key; it asks this process, over a private Unix
//! socket, to sign a grant. Crucially the signer signs **only for a real job**: it
//! confirms in PostgreSQL that a matching `running` job was just recorded (same
//! actor/host/operation/args_hash), so a compromised server cannot mint grants for
//! operations it did not durably record and audit. The key can later move behind a
//! TPM/HSM/KMS here without touching the server.

use std::os::unix::fs::PermissionsExt;

use sqlx::postgres::PgPoolOptions;
use sqlx::PgPool;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::{UnixListener, UnixStream};

use tenodera_protocol as proto;

const DEFAULT_ORG: &str = "00000000-0000-0000-0000-000000000001";
const DEFAULT_SOCK: &str = "/run/tenodera/signer.sock";
const GRANT_TTL_SECS: i64 = 120;
/// A job may be signed for only within this window of its creation.
const JOB_FRESHNESS: &str = "30 seconds";

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "tenodera_signer=info".into()),
        )
        .init();

    let key_path = std::env::var("TENODERA_GRANT_KEY")
        .map_err(|_| anyhow::anyhow!("TENODERA_GRANT_KEY not set"))?;
    let key_hex = std::fs::read_to_string(&key_path)?;
    let signing_key =
        proto::signing_key_from_hex(&key_hex).ok_or_else(|| anyhow::anyhow!("bad grant key"))?;

    let db = std::env::var("DATABASE_URL")
        .unwrap_or_else(|_| "postgres://tenodera:devpass@localhost/tenodera_v2".into());
    let pool = PgPoolOptions::new().max_connections(4).connect(&db).await?;

    let sock = std::env::var("TENODERA_SIGNER_SOCK").unwrap_or_else(|_| DEFAULT_SOCK.into());
    let _ = std::fs::remove_file(&sock);
    let listener = UnixListener::bind(&sock)?;
    std::fs::set_permissions(&sock, std::fs::Permissions::from_mode(0o600))?;
    tracing::info!(sock = %sock, "tenodera-signer listening");

    loop {
        let (stream, _) = listener.accept().await?;
        let key = signing_key.clone();
        let pool = pool.clone();
        tokio::spawn(async move {
            if let Err(e) = handle(stream, key, pool).await {
                tracing::warn!(error = %e, "signer request failed");
            }
        });
    }
}

async fn handle(stream: UnixStream, key: proto::SigningKey, pool: PgPool) -> anyhow::Result<()> {
    let (rd, mut wr) = stream.into_split();
    let mut reader = BufReader::new(rd.take(proto::MAX_FRAME_BYTES as u64));
    let mut line = String::new();
    reader.read_line(&mut line).await?;

    let req: serde_json::Value =
        serde_json::from_str(line.trim()).unwrap_or(serde_json::Value::Null);
    let resp = match issue(&req, &key, &pool).await {
        Ok(grant) => serde_json::to_string(&grant)?,
        Err(msg) => serde_json::json!({ "error": msg }).to_string(),
    };
    wr.write_all(resp.as_bytes()).await?;
    wr.write_all(b"\n").await?;
    Ok(())
}

async fn issue(
    req: &serde_json::Value,
    key: &proto::SigningKey,
    pool: &PgPool,
) -> Result<proto::ExecutionGrant, String> {
    let job_id = req
        .get("job_id")
        .and_then(|v| v.as_str())
        .ok_or("missing job_id")?;
    let actor = req
        .get("actor")
        .and_then(|v| v.as_str())
        .ok_or("missing actor")?;
    let host_id = req
        .get("host_id")
        .and_then(|v| v.as_str())
        .ok_or("missing host_id")?;
    let op_key = req
        .pointer("/operation/key")
        .and_then(|v| v.as_str())
        .ok_or("missing operation.key")?;
    let unit = req
        .pointer("/operation/unit")
        .and_then(|v| v.as_str())
        .ok_or("missing operation.unit")?;
    let level = if req.get("level").and_then(|v| v.as_str()) == Some("step_up") {
        proto::AuthenticationLevel::StepUp
    } else {
        proto::AuthenticationLevel::Standard
    };
    let operation = proto::Operation::from_key(op_key, unit).ok_or("unknown operation")?;
    operation.validate().map_err(|e| e.to_string())?;

    // Sign only for a REAL, recent, running job that matches this request exactly.
    let matches: bool = sqlx::query_scalar(
        "SELECT count(*) > 0 FROM jobs j
          WHERE j.id = ($1)::uuid AND j.organization_id = ($2)::uuid
            AND j.state = 'running' AND j.host_id = ($3)::uuid
            AND j.operation = $4 AND j.args_hash = $5
            AND j.created_at > now() - ($6)::interval
            AND j.actor_user_id = (
                SELECT id FROM users
                 WHERE organization_id = ($2)::uuid AND local_principal = $7 LIMIT 1)",
    )
    .bind(job_id)
    .bind(DEFAULT_ORG)
    .bind(host_id)
    .bind(op_key)
    .bind(operation.hash().to_vec())
    .bind(JOB_FRESHNESS)
    .bind(actor)
    .fetch_one(pool)
    .await
    .map_err(|e| e.to_string())?;
    if !matches {
        return Err("no matching running job".into());
    }

    let job_uuid = uuid::Uuid::parse_str(job_id).map_err(|_| "bad job_id")?;
    let host_uuid = uuid::Uuid::parse_str(host_id).map_err(|_| "bad host_id")?;
    let now = unix_now();
    let grant = proto::ExecutionGrant::issue(
        key,
        job_uuid,
        actor,
        host_uuid,
        &operation,
        level,
        now,
        GRANT_TTL_SECS,
    );
    tracing::info!(job_id, actor, op = op_key, "issued grant");
    Ok(grant)
}

fn unix_now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}
