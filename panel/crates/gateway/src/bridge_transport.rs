use std::process::Stdio;

use tenodera_protocol::message::Message;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::mpsc;

/// Handle to a running tenodera-bridge subprocess.
/// Manages stdin/stdout communication with the bridge process.
pub struct BridgeProcess {
    /// Keep alive — child is killed on drop.
    pub child: Child,
    /// Send messages TO the bridge (gateway -> bridge stdin)
    pub to_bridge: mpsc::Sender<Message>,
    /// Receive messages FROM the bridge (bridge stdout -> gateway)
    pub from_bridge: mpsc::Receiver<Message>,
}

impl BridgeProcess {
    /// Spawn a local tenodera-bridge process.
    pub async fn spawn(bridge_bin: &str) -> anyhow::Result<Self> {
        let cmd = Command::new(bridge_bin);
        Self::spawn_command(cmd).await
    }

    /// Spawn tenodera-bridge on a remote host via SSH.
    /// Uses sshpass to pass the session password securely via the SSHPASS
    /// environment variable. The bridge communicates over SSH stdin/stdout
    /// using the same newline-delimited JSON protocol as a local bridge.
    pub async fn spawn_remote(
        ssh_user: &str,
        password: &str,
        address: &str,
        ssh_port: u16,
        bridge_bin: &str,
    ) -> anyhow::Result<Self> {
        tracing::info!(
            %ssh_user, %address, %ssh_port, %bridge_bin,
            "spawning remote bridge via SSH"
        );

        let mut cmd = Command::new("sshpass");
        cmd.env("SSHPASS", password)
            .args([
                "-e",
                "ssh",
                "-o", "StrictHostKeyChecking=accept-new",
                "-o", "BatchMode=no",
                "-p", &ssh_port.to_string(),
                &format!("{ssh_user}@{address}"),
                bridge_bin,
            ]);

        Self::spawn_command(cmd).await.map_err(|e| {
            anyhow::anyhow!("failed to spawn remote bridge on {address}: {e}")
        })
    }

    async fn spawn_command(mut cmd: Command) -> anyhow::Result<Self> {
        let mut child = cmd
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .kill_on_drop(true)
            .spawn()?;

        let stdin = child.stdin.take().expect("bridge stdin");
        let stdout = child.stdout.take().expect("bridge stdout");

        let (to_bridge_tx, mut to_bridge_rx) = mpsc::channel::<Message>(256);
        let (from_bridge_tx, from_bridge_rx) = mpsc::channel::<Message>(256);

        // Task: write messages to bridge stdin
        tokio::spawn(async move {
            let mut stdin = stdin;
            while let Some(msg) = to_bridge_rx.recv().await {
                match serde_json::to_string(&msg) {
                    Ok(json) => {
                        let line = format!("{json}\n");
                        if stdin.write_all(line.as_bytes()).await.is_err() {
                            break;
                        }
                        let _ = stdin.flush().await;
                    }
                    Err(e) => {
                        tracing::error!(error = %e, "failed to serialize message to bridge");
                    }
                }
            }
        });

        // Task: read messages from bridge stdout
        tokio::spawn(async move {
            let reader = BufReader::new(stdout);
            let mut lines = reader.lines();

            while let Ok(Some(line)) = lines.next_line().await {
                if line.is_empty() {
                    continue;
                }
                match serde_json::from_str::<Message>(&line) {
                    Ok(msg) => {
                        if from_bridge_tx.send(msg).await.is_err() {
                            break;
                        }
                    }
                    Err(e) => {
                        tracing::warn!(error = %e, raw = %line, "invalid message from bridge");
                    }
                }
            }
            tracing::debug!("bridge stdout reader ended");
        });

        Ok(Self {
            child,
            to_bridge: to_bridge_tx,
            from_bridge: from_bridge_rx,
        })
    }
}
