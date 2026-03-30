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
    /// Keep temp known_hosts file alive for the lifetime of the SSH process.
    /// The file is deleted automatically when BridgeProcess is dropped
    /// (i.e., when the SSH connection ends). This prevents a race condition
    /// where the temp file could be deleted before SSH reads it.
    pub _temp_known_hosts: Option<tempfile::NamedTempFile>,
}

impl BridgeProcess {
    /// Spawn a local tenodera-bridge process.
    pub async fn spawn(bridge_bin: &str) -> anyhow::Result<Self> {
        let cmd = Command::new(bridge_bin);
        Self::spawn_command(cmd, None).await
    }

    /// Spawn tenodera-bridge on a remote host via SSH.
    /// Uses sshpass to pass the session password securely via the SSHPASS
    /// environment variable. The bridge communicates over SSH stdin/stdout
    /// using the same newline-delimited JSON protocol as a local bridge.
    ///
    /// If `host_key` is provided, SSH will use StrictHostKeyChecking=yes
    /// with a temporary known_hosts file containing the verified key.
    /// If empty, falls back to accept-new (TOFU).
    pub async fn spawn_remote(
        ssh_user: &str,
        password: &str,
        address: &str,
        ssh_port: u16,
        bridge_bin: &str,
        host_key: &str,
    ) -> anyhow::Result<Self> {
        tracing::info!(
            %ssh_user, %address, %ssh_port, %bridge_bin,
            host_key_present = !host_key.is_empty(),
            "spawning remote bridge via SSH"
        );

        let mut cmd = Command::new("sshpass");
        cmd.env("SSHPASS", password);

        // Build a temporary known_hosts file if we have a verified host key.
        // This enables StrictHostKeyChecking=yes instead of TOFU accept-new.
        let temp_known_hosts = if !host_key.is_empty() {
            let tmp = tempfile::NamedTempFile::new()
                .map_err(|e| anyhow::anyhow!("failed to create temp known_hosts: {e}"))?;
            std::fs::write(tmp.path(), format!("{host_key}\n"))
                .map_err(|e| anyhow::anyhow!("failed to write temp known_hosts: {e}"))?;
            cmd.args([
                "-e",
                "ssh",
                "-o", "StrictHostKeyChecking=yes",
                "-o", &format!("UserKnownHostsFile={}", tmp.path().display()),
                "-o", "PubkeyAuthentication=no",
                "-o", "BatchMode=no",
                "-p", &ssh_port.to_string(),
                &format!("{ssh_user}@{address}"),
                bridge_bin,
            ]);
            Some(tmp)
        } else {
            // No host key stored — fall back to TOFU (accept-new)
            tracing::warn!(
                %address,
                "no host key on record — using accept-new (TOFU). \
                 Re-scan the host key in the Hosts page to enable strict verification."
            );
            cmd.args([
                "-e",
                "ssh",
                "-o", "StrictHostKeyChecking=accept-new",
                "-o", "PubkeyAuthentication=no",
                "-o", "BatchMode=no",
                "-p", &ssh_port.to_string(),
                &format!("{ssh_user}@{address}"),
                bridge_bin,
            ]);
            None
        };

        Self::spawn_command(cmd, temp_known_hosts).await.map_err(|e| {
            anyhow::anyhow!("failed to spawn remote bridge on {address}: {e}")
        })
    }

    async fn spawn_command(
        mut cmd: Command,
        temp_known_hosts: Option<tempfile::NamedTempFile>,
    ) -> anyhow::Result<Self> {
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
            _temp_known_hosts: temp_known_hosts,
        })
    }
}
