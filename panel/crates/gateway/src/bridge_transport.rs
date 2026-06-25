use std::process::Stdio;

use tenodera_protocol::message::{Message, PROTOCOL_VERSION};
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
    ///
    /// When `run_as` is Some(user), spawns via `sudo -n -u <user>` so the
    /// bridge process runs as the authenticated session user rather than as
    /// the gateway service account (tenodera-gw). This is required for the
    /// bridge to be able to call `sudo -S` for administrative operations.
    ///
    /// Requires a sudoers entry granting the gateway service account
    /// permission to run the bridge binary as any user without a password
    /// (installed by `make install` as /etc/sudoers.d/tenodera-gw).
    pub async fn spawn(bridge_bin: &str, run_as: Option<&str>) -> anyhow::Result<Self> {
        let cmd = if let Some(session_user) = run_as {
            let mut c = Command::new("sudo");
            c.args(["-n", "-u", session_user, bridge_bin]);
            c
        } else {
            Command::new(bridge_bin)
        };
        Self::spawn_command(cmd, None).await
    }

    /// Spawn tenodera-bridge on a remote host via SSH using the gateway's
    /// Ed25519 identity key (/etc/tenodera/id_ed25519).
    ///
    /// Password-based authentication (sshpass) is no longer used — the managed
    /// host must have the gateway's public key in the SSH user's authorized_keys.
    /// Run `make show-pubkey` on the gateway host to get the key to deploy.
    ///
    /// If `host_key` is provided, SSH will use StrictHostKeyChecking=yes
    /// with a temporary known_hosts file containing the verified key.
    /// If empty, falls back to accept-new (TOFU).
    pub async fn spawn_remote(
        ssh_user: &str,
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

        let key_path = std::env::var("TENODERA_SSH_KEY")
            .unwrap_or_else(|_| "/etc/tenodera/id_ed25519".to_string());

        let mut cmd = Command::new("ssh");
        cmd.args(["-i", &key_path, "-o", "PasswordAuthentication=no", "-o", "BatchMode=yes"]);

        let temp_known_hosts = if !host_key.is_empty() {
            let tmp = tempfile::NamedTempFile::new()
                .map_err(|e| anyhow::anyhow!("failed to create temp known_hosts: {e}"))?;
            std::fs::write(tmp.path(), format!("{host_key}\n"))
                .map_err(|e| anyhow::anyhow!("failed to write temp known_hosts: {e}"))?;
            cmd.args([
                "-o", "StrictHostKeyChecking=yes",
                "-o", &format!("UserKnownHostsFile={}", tmp.path().display()),
            ]);
            Some(tmp)
        } else {
            tracing::warn!(
                %address,
                "no host key on record — using accept-new (TOFU). \
                 Re-scan the host key in the Hosts page to enable strict verification."
            );
            cmd.args(["-o", "StrictHostKeyChecking=accept-new"]);
            None
        };

        cmd.args(["-p", &ssh_port.to_string(), &format!("{ssh_user}@{address}"), bridge_bin]);

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

        let mut stdin = child.stdin.take().expect("bridge stdin");
        let stdout = child.stdout.take().expect("bridge stdout");

        let mut reader = BufReader::new(stdout);

        // Protocol handshake: bridge sends Hello, gateway replies HelloAck.
        // We give the bridge 5 seconds to send its Hello before giving up.
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
                // Bridge is newer — we might be missing message types; still try
                tracing::warn!("{w}");
                Some(w)
            } else {
                // Bridge is older — hard fail to avoid silent data corruption
                anyhow::bail!("{w}");
            }
        } else {
            None
        };

        let ack = Message::HelloAck { version: PROTOCOL_VERSION, warning };
        let ack_json = serde_json::to_string(&ack).expect("ack serialize");
        stdin.write_all(format!("{ack_json}\n").as_bytes()).await?;
        stdin.flush().await?;

        tracing::debug!(bridge_version, "bridge Hello/HelloAck handshake complete");

        let (to_bridge_tx, mut to_bridge_rx) = mpsc::channel::<Message>(256);
        let (from_bridge_tx, from_bridge_rx) = mpsc::channel::<Message>(256);

        // Task: write messages to bridge stdin
        tokio::spawn(async move {
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

        // Task: read messages from bridge stdout (after Hello)
        tokio::spawn(async move {
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
