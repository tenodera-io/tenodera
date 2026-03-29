pub mod audit;
mod handler;
mod handlers;
mod router;

use std::io;

use tenodera_protocol::message::Message;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::mpsc;
use tracing_subscriber::EnvFilter;

use crate::router::Router;

/// Bridge reads JSON messages from stdin, routes them to handlers,
/// and writes responses to stdout — matching Tenodera's bridge model.
/// Now fully async with tokio for streaming channels (PTY, metrics, journal follow).
#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::from_default_env().add_directive("tenodera_bridge=debug".parse()?),
        )
        .with_ansi(false)
        .with_writer(io::stderr)
        .init();

    tracing::info!("tenodera-bridge started (async)");

    // Channel for outgoing messages (handlers → stdout writer)
    let (out_tx, mut out_rx) = mpsc::channel::<Message>(256);

    let mut router = Router::new(out_tx.clone());
    router.register_defaults();

    // Spawn stdout writer task
    let writer_handle = tokio::spawn(async move {
        let mut stdout = tokio::io::stdout();
        while let Some(msg) = out_rx.recv().await {
            match serde_json::to_string(&msg) {
                Ok(json) => {
                    let line = format!("{json}\n");
                    if stdout.write_all(line.as_bytes()).await.is_err() {
                        break;
                    }
                    let _ = stdout.flush().await;
                }
                Err(e) => {
                    tracing::error!(error = %e, "failed to serialize outgoing message");
                }
            }
        }
    });

    // Read stdin line by line
    let stdin = BufReader::new(tokio::io::stdin());
    let mut lines = stdin.lines();

    while let Ok(Some(line)) = lines.next_line().await {
        if line.is_empty() {
            continue;
        }

        let msg: Message = match serde_json::from_str(&line) {
            Ok(m) => m,
            Err(e) => {
                tracing::warn!(error = %e, raw = %line, "invalid message on stdin");
                continue;
            }
        };

        let responses = router.handle(msg).await;

        // Send immediate responses through the out channel
        for resp in responses {
            if out_tx.send(resp).await.is_err() {
                tracing::error!("output channel closed");
                break;
            }
        }
    }

    tracing::info!("tenodera-bridge exiting (stdin closed)");
    drop(out_tx);
    let _ = writer_handle.await;
    Ok(())
}
