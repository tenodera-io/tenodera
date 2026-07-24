//! Grant signer client (ADR-0004/0005).
//!
//! The server does **not** hold the grant-signing key. It asks the separate
//! `tenodera-signer` process (over a private Unix socket) to sign a grant; the
//! signer only signs for a job it can confirm in PostgreSQL. So a compromise of
//! this HTTP/SSH-facing process cannot exfiltrate the key or forge grants for
//! operations it never durably recorded.

use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::UnixStream;

use tenodera_protocol as proto;

const DEFAULT_SOCK: &str = "/run/tenodera/signer.sock";

fn socket_path() -> String {
    std::env::var("TENODERA_SIGNER_SOCK").unwrap_or_else(|_| DEFAULT_SOCK.into())
}

/// Ask the signer for a grant authorizing `operation` on `host_id` for this job.
/// None on any error (mutating operations then fail closed).
pub async fn issue_grant(
    job_id: uuid::Uuid,
    actor: &str,
    host_id: uuid::Uuid,
    operation: &proto::Operation,
    level: proto::AuthenticationLevel,
) -> Option<proto::ExecutionGrant> {
    let level_str = match level {
        proto::AuthenticationLevel::StepUp => "step_up",
        proto::AuthenticationLevel::Standard => "standard",
    };
    let req = serde_json::json!({
        "job_id": job_id.to_string(),
        "actor": actor,
        "host_id": host_id.to_string(),
        "operation": { "key": operation.key(), "unit": operation.unit() },
        "level": level_str,
    });

    let mut stream = UnixStream::connect(socket_path()).await.ok()?;
    stream.write_all(req.to_string().as_bytes()).await.ok()?;
    stream.write_all(b"\n").await.ok()?;

    let (rd, _wr) = stream.into_split();
    let mut reader = BufReader::new(rd.take(proto::MAX_FRAME_BYTES as u64));
    let mut line = String::new();
    reader.read_line(&mut line).await.ok()?;
    serde_json::from_str::<proto::ExecutionGrant>(line.trim()).ok()
}
