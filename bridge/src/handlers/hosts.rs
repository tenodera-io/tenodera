use std::path::PathBuf;

use tenodera_protocol::channel::ChannelOpenOptions;
use tenodera_protocol::message::Message;
use serde_json::{json, Value};

use crate::handler::ChannelHandler;

// ── Types ───────────────────────────────────────────────────────

#[derive(serde::Serialize, serde::Deserialize, Clone)]
struct HostEntry {
    id: String,
    name: String,
    address: String,
    /// SSH user override. Empty = use the logged-in session user.
    #[serde(default)]
    user: String,
    #[serde(default = "default_ssh_port")]
    ssh_port: u16,
    added_at: String,
    /// Full SSH host key line (e.g. "192.168.56.11 ssh-ed25519 AAAA...").
    /// Used by the gateway for StrictHostKeyChecking against a known key.
    #[serde(default)]
    host_key: String,
}

fn default_ssh_port() -> u16 {
    22
}

#[derive(serde::Serialize, serde::Deserialize, Default)]
struct HostsConfig {
    hosts: Vec<HostEntry>,
}

// ── Config persistence ──────────────────────────────────────────

fn config_path() -> PathBuf {
    PathBuf::from("/etc/tenodera/hosts.json")
}

fn load_config() -> HostsConfig {
    std::fs::read_to_string(config_path())
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn save_config(config: &HostsConfig) -> Result<(), String> {
    let path = config_path();
    let json = serde_json::to_string_pretty(config).map_err(|e| e.to_string())?;
    std::fs::write(&path, json).map_err(|e| e.to_string())?;

    // Enforce restrictive permissions — hosts.json may contain sensitive
    // host information and should only be readable by root.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let perms = std::fs::Permissions::from_mode(0o600);
        std::fs::set_permissions(&path, perms).map_err(|e| e.to_string())?;
    }

    Ok(())
}

// ── Handler ─────────────────────────────────────────────────────

pub struct HostsManageHandler;

#[async_trait::async_trait]
impl ChannelHandler for HostsManageHandler {
    fn payload_type(&self) -> &str {
        "hosts.manage"
    }

    async fn open(&self, channel: &str, _options: &ChannelOpenOptions) -> Vec<Message> {
        vec![Message::Ready {
            channel: channel.into(),
        }]
    }

    async fn data(&self, channel: &str, data: &Value) -> Vec<Message> {
        let action = data.get("action").and_then(|a| a.as_str()).unwrap_or("");
        let user = data.get("_user").and_then(|u| u.as_str()).unwrap_or("");

        let result = match action {
            "list" => action_list(),
            "keyscan" => {
                let address = data.get("address").and_then(|v| v.as_str()).unwrap_or("");
                let ssh_port = data
                    .get("ssh_port")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(22) as u16;
                action_keyscan(address, ssh_port).await
            }
            "add" => {
                let name = data.get("name").and_then(|v| v.as_str()).unwrap_or("");
                let address = data.get("address").and_then(|v| v.as_str()).unwrap_or("");
                let user_field = data.get("user").and_then(|v| v.as_str()).unwrap_or("");
                let ssh_port = data
                    .get("ssh_port")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(22) as u16;
                let host_key = data.get("host_key").and_then(|v| v.as_str()).unwrap_or("");
                let r = action_add(name, address, user_field, ssh_port, host_key);
                let ok = r.get("ok").and_then(|v| v.as_bool()).unwrap_or(false);
                crate::audit::log(user, "host.add", address, ok, name);
                r
            }
            "edit" => {
                let id = data.get("id").and_then(|v| v.as_str()).unwrap_or("");
                let name = data.get("name").and_then(|v| v.as_str()).unwrap_or("");
                let address = data.get("address").and_then(|v| v.as_str()).unwrap_or("");
                let user_field = data.get("user").and_then(|v| v.as_str()).unwrap_or("");
                let ssh_port = data
                    .get("ssh_port")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(22) as u16;
                let host_key = data.get("host_key").and_then(|v| v.as_str()).unwrap_or("");
                let r = action_edit(id, name, address, user_field, ssh_port, host_key);
                let ok = r.get("ok").and_then(|v| v.as_bool()).unwrap_or(false);
                crate::audit::log(user, "host.edit", address, ok, name);
                r
            }
            "remove" => {
                let id = data.get("id").and_then(|v| v.as_str()).unwrap_or("");
                let r = action_remove(id);
                let ok = r.get("ok").and_then(|v| v.as_bool()).unwrap_or(false);
                crate::audit::log(user, "host.remove", id, ok, "");
                r
            }
            _ => json!({ "action": action, "error": "unknown action" }),
        };

        vec![Message::Data {
            channel: channel.into(),
            data: result,
        }]
    }
}

// ── Action implementations ──────────────────────────────────────

fn action_list() -> Value {
    let config = load_config();
    json!({ "action": "list", "hosts": config.hosts })
}

fn action_add(name: &str, address: &str, user: &str, ssh_port: u16, host_key: &str) -> Value {
    if name.is_empty() || address.is_empty() {
        return json!({ "action": "add", "ok": false, "error": "name and address are required" });
    }

    let mut config = load_config();
    let entry = HostEntry {
        id: uuid::Uuid::new_v4().to_string(),
        name: name.to_string(),
        address: address.to_string(),
        user: user.to_string(),
        ssh_port,
        added_at: chrono::Utc::now().to_rfc3339(),
        host_key: host_key.to_string(),
    };
    let id = entry.id.clone();
    config.hosts.push(entry);

    match save_config(&config) {
        Ok(()) => json!({ "action": "add", "ok": true, "id": id }),
        Err(e) => json!({ "action": "add", "ok": false, "error": e }),
    }
}

fn action_edit(id: &str, name: &str, address: &str, user: &str, ssh_port: u16, host_key: &str) -> Value {
    if id.is_empty() || name.is_empty() || address.is_empty() {
        return json!({ "action": "edit", "ok": false, "error": "id, name and address are required" });
    }

    let mut config = load_config();
    let Some(entry) = config.hosts.iter_mut().find(|h| h.id == id) else {
        return json!({ "action": "edit", "ok": false, "error": "host not found" });
    };

    entry.name = name.to_string();
    entry.address = address.to_string();
    entry.user = user.to_string();
    entry.ssh_port = ssh_port;
    if !host_key.is_empty() {
        entry.host_key = host_key.to_string();
    }

    match save_config(&config) {
        Ok(()) => json!({ "action": "edit", "ok": true }),
        Err(e) => json!({ "action": "edit", "ok": false, "error": e }),
    }
}

fn action_remove(id: &str) -> Value {
    let mut config = load_config();
    let before = config.hosts.len();
    config.hosts.retain(|h| h.id != id);

    if config.hosts.len() == before {
        return json!({ "action": "remove", "ok": false, "error": "host not found" });
    }

    match save_config(&config) {
        Ok(()) => json!({ "action": "remove", "ok": true }),
        Err(e) => json!({ "action": "remove", "ok": false, "error": e }),
    }
}

// ── SSH keyscan ─────────────────────────────────────────────────

/// Run `ssh-keyscan` against a host and return the host key line + fingerprint.
/// The host key line is stored in hosts.json for later verification by the gateway.
/// The fingerprint (human-readable) is shown to the admin for confirmation.
async fn action_keyscan(address: &str, ssh_port: u16) -> Value {
    if address.is_empty() {
        return json!({ "action": "keyscan", "ok": false, "error": "address is required" });
    }

    // Validate address: only allow alphanumeric, dots, hyphens, colons (IPv6), brackets
    if !address.chars().all(|c| c.is_alphanumeric() || ".-:[]:".contains(c)) {
        return json!({ "action": "keyscan", "ok": false, "error": "invalid address" });
    }

    // Run ssh-keyscan to get the host's public key
    let output = tokio::process::Command::new("ssh-keyscan")
        .args(["-p", &ssh_port.to_string(), "-T", "5", "--", address])
        .output()
        .await;

    let output = match output {
        Ok(o) => o,
        Err(e) => {
            return json!({ "action": "keyscan", "ok": false, "error": format!("ssh-keyscan failed: {e}") });
        }
    };

    let stdout = String::from_utf8_lossy(&output.stdout);
    let lines: Vec<&str> = stdout.lines()
        .filter(|l| !l.starts_with('#') && !l.is_empty())
        .collect();

    if lines.is_empty() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return json!({
            "action": "keyscan", "ok": false,
            "error": format!("no host keys found (is SSH running on {address}:{ssh_port}?): {stderr}")
        });
    }

    // Prefer ed25519 > ecdsa > rsa
    let preferred = ["ssh-ed25519", "ecdsa-sha2-nistp256", "ssh-rsa"];
    let host_key_line = preferred.iter()
        .find_map(|alg| lines.iter().find(|l| l.contains(alg)))
        .unwrap_or(&lines[0]);

    // Get human-readable fingerprint via ssh-keygen
    let fp_output = tokio::process::Command::new("ssh-keygen")
        .args(["-l", "-f", "-"])
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn();

    let fingerprint = match fp_output {
        Ok(mut child) => {
            if let Some(ref mut stdin) = child.stdin {
                use tokio::io::AsyncWriteExt;
                let _ = stdin.write_all(host_key_line.as_bytes()).await;
                let _ = stdin.write_all(b"\n").await;
            }
            // Close stdin by dropping it
            child.stdin.take();
            match child.wait_with_output().await {
                Ok(o) => String::from_utf8_lossy(&o.stdout).trim().to_string(),
                Err(_) => String::new(),
            }
        }
        Err(_) => String::new(),
    };

    json!({
        "action": "keyscan",
        "ok": true,
        "host_key": host_key_line.to_string(),
        "fingerprint": fingerprint,
    })
}
