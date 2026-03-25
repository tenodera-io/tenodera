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
            channel: channel.to_string(),
        }]
    }

    async fn data(&self, channel: &str, data: &Value) -> Vec<Message> {
        let action = data.get("action").and_then(|a| a.as_str()).unwrap_or("");
        let user = data.get("_user").and_then(|u| u.as_str()).unwrap_or("");

        let result = match action {
            "list" => action_list(),
            "add" => {
                let name = data.get("name").and_then(|v| v.as_str()).unwrap_or("");
                let address = data.get("address").and_then(|v| v.as_str()).unwrap_or("");
                let user_field = data.get("user").and_then(|v| v.as_str()).unwrap_or("");
                let ssh_port = data
                    .get("ssh_port")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(22) as u16;
                let r = action_add(name, address, user_field, ssh_port);
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
                let r = action_edit(id, name, address, user_field, ssh_port);
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
            channel: channel.to_string(),
            data: result,
        }]
    }
}

// ── Action implementations ──────────────────────────────────────

fn action_list() -> Value {
    let config = load_config();
    json!({ "action": "list", "hosts": config.hosts })
}

fn action_add(name: &str, address: &str, user: &str, ssh_port: u16) -> Value {
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
    };
    let id = entry.id.clone();
    config.hosts.push(entry);

    match save_config(&config) {
        Ok(()) => json!({ "action": "add", "ok": true, "id": id }),
        Err(e) => json!({ "action": "add", "ok": false, "error": e }),
    }
}

fn action_edit(id: &str, name: &str, address: &str, user: &str, ssh_port: u16) -> Value {
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
