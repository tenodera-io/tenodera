use std::process::Stdio;

use tenodera_protocol::message::{Message, PROTOCOL_VERSION};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::mpsc;

/// Handle to a locally-spawned tenodera-bridge subprocess.
pub struct BridgeProcess {
    pub child: Child,
    pub to_bridge: mpsc::Sender<Message>,
    pub from_bridge: mpsc::Receiver<Message>,
}

impl BridgeProcess {
    /// Spawn a local tenodera-bridge process.
    ///
    /// When `run_as` is `Some(user)`, spawns via `sudo -n -u <user>` so the
    /// bridge runs as the authenticated session user. This allows `sudo -S`
    /// for administrative operations.
    pub async fn spawn(bridge_bin: &str, run_as: Option<&str>) -> anyhow::Result<Self> {
        let mut cmd = if let Some(session_user) = run_as {
            let mut c = Command::new("sudo");
            c.args(["-n", "-u", session_user, bridge_bin]);
            c
        } else {
            Command::new(bridge_bin)
        };

        cmd.stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .kill_on_drop(true);

        let mut child = cmd.spawn()?;
        let mut stdin = child.stdin.take().expect("bridge stdin");
        let stdout = child.stdout.take().expect("bridge stdout");
        let mut reader = BufReader::new(stdout);

        // Protocol handshake: bridge sends Hello, gateway replies HelloAck.
        let hello_timeout = tokio::time::Duration::from_secs(5);
        let mut hello_line = String::new();
        tokio::time::timeout(hello_timeout, reader.read_line(&mut hello_line))
            .await
            .map_err(|_| anyhow::anyhow!("bridge did not send Hello within 5 seconds"))?
            .map_err(|e| anyhow::anyhow!("bridge stdout read error: {e}"))?;

        let bridge_version = match serde_json::from_str::<Message>(hello_line.trim()) {
            Ok(Message::Hello { version }) => version,
            Ok(other) => anyhow::bail!("expected Hello, got {:?}", other),
            Err(e) => anyhow::bail!("could not parse Hello: {e} (raw: {hello_line:?})"),
        };

        let warning = if bridge_version != PROTOCOL_VERSION {
            let w = format!(
                "protocol version mismatch: gateway={PROTOCOL_VERSION}, bridge={bridge_version}"
            );
            if bridge_version > PROTOCOL_VERSION {
                tracing::warn!("{w}");
                Some(w)
            } else {
                anyhow::bail!("{w}");
            }
        } else {
            None
        };

        let ack = Message::HelloAck { version: PROTOCOL_VERSION, warning };
        let ack_json = serde_json::to_string(&ack)?;
        stdin.write_all(format!("{ack_json}\n").as_bytes()).await?;
        stdin.flush().await?;

        tracing::debug!(bridge_version, "local bridge Hello/HelloAck handshake complete");

        let (to_bridge_tx, mut to_bridge_rx) = mpsc::channel::<Message>(256);
        let (from_bridge_tx, from_bridge_rx) = mpsc::channel::<Message>(256);

        tokio::spawn(async move {
            while let Some(msg) = to_bridge_rx.recv().await {
                if let Ok(json) = serde_json::to_string(&msg) {
                    let line = format!("{json}\n");
                    if stdin.write_all(line.as_bytes()).await.is_err() {
                        break;
                    }
                    let _ = stdin.flush().await;
                }
            }
        });

        tokio::spawn(async move {
            let mut lines = reader.lines();
            while let Ok(Some(line)) = lines.next_line().await {
                if line.is_empty() { continue; }
                if let Ok(msg) = serde_json::from_str::<Message>(&line) {
                    if from_bridge_tx.send(msg).await.is_err() {
                        break;
                    }
                }
            }
        });

        Ok(Self { child, to_bridge: to_bridge_tx, from_bridge: from_bridge_rx })
    }
}
