use async_trait::async_trait;
use serde_json::{json, Value};
use tokio::fs;

use crate::handler::ChannelHandler;
use crate::util::{require_admin, sudo_action, sudo_stdin_write};
use tenodera_protocol::channel::ChannelOpenOptions;
use tenodera_protocol::message::Message;

// ── host.config ────────────────────────────────────────────────────────────────

pub struct HostConfigHandler;

#[async_trait]
impl ChannelHandler for HostConfigHandler {
    fn payload_type(&self) -> &str { "host.config" }

    async fn open(&self, channel: &str, _options: &ChannelOpenOptions) -> Vec<Message> {
        let data = read_host_config().await;
        vec![
            Message::Ready  { channel: channel.into() },
            Message::Data   { channel: channel.into(), data },
            Message::Close  { channel: channel.into(), problem: None },
        ]
    }
}

async fn read_host_config() -> Value {
    let hostname = fs::read_to_string("/etc/hostname")
        .await
        .unwrap_or_default()
        .trim()
        .to_string();

    let uptime_secs: u64 = fs::read_to_string("/proc/uptime")
        .await
        .unwrap_or_default()
        .split_whitespace()
        .next()
        .and_then(|v| v.parse::<f64>().ok())
        .map(|f| f as u64)
        .unwrap_or(0);

    let env_path = "/etc/tenodera/bridge.env";
    let content = match fs::read_to_string(env_path).await {
        Ok(c) => c,
        Err(_) => return json!({ "roles": [], "hostname": hostname, "uptime_secs": uptime_secs }),
    };

    let mut roles: Vec<String> = content
        .lines()
        .filter_map(|line| {
            let line = line.trim();
            if line.starts_with('#') || line.is_empty() { return None; }
            let (key, val) = line.split_once('=')?;
            if key.trim().eq_ignore_ascii_case("role") {
                Some(val.trim().to_string())
            } else {
                None
            }
        })
        .flat_map(|val| {
            val.split([',', ' '])
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .collect::<Vec<_>>()
        })
        .collect();

    roles.dedup();

    json!({ "roles": roles, "hostname": hostname, "uptime_secs": uptime_secs })
}

// ── host.action ────────────────────────────────────────────────────────────────
// Uses open-time options (not a subsequent data message) because transport.ts
// request() never sends a Data frame after Ready — it only opens and waits.

pub struct HostActionHandler;

#[async_trait]
impl ChannelHandler for HostActionHandler {
    fn payload_type(&self) -> &str { "host.action" }

    async fn open(&self, channel: &str, options: &ChannelOpenOptions) -> Vec<Message> {
        let extra = Value::Object(options.extra.clone());

        if let Some(err) = require_admin(&extra) {
            return vec![
                Message::Ready { channel: channel.into() },
                Message::Data  { channel: channel.into(), data: err },
                Message::Close { channel: channel.into(), problem: None },
            ];
        }

        let action   = options.extra.get("action").and_then(|v| v.as_str()).unwrap_or("");
        let password = options.extra.get("password").and_then(|v| v.as_str()).unwrap_or("");

        let result = match action {
            "set_role" => set_role(&extra, password).await,
            "restart"  => restart_host(password).await,
            other      => json!({ "error": format!("unknown action: {other}") }),
        };

        vec![
            Message::Ready { channel: channel.into() },
            Message::Data  { channel: channel.into(), data: result },
            Message::Close { channel: channel.into(), problem: None },
        ]
    }
}

async fn set_role(data: &Value, password: &str) -> Value {
    let role = data.get("role").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();

    let env_path = "/etc/tenodera/bridge.env";
    let content = fs::read_to_string(env_path).await.unwrap_or_default();

    let mut lines: Vec<String> = content
        .lines()
        .filter(|l| !l.trim().to_lowercase().starts_with("role="))
        .map(|l| l.to_string())
        .collect();

    if !role.is_empty() {
        lines.push(format!("role={role}"));
    }

    let new_content = lines.join("\n") + "\n";
    sudo_stdin_write(password, &["tee", env_path], &new_content).await
}

async fn restart_host(password: &str) -> Value {
    let pw = password.to_string();
    tokio::spawn(async move {
        tokio::time::sleep(tokio::time::Duration::from_millis(400)).await;
        sudo_action(&pw, &["reboot"]).await;
    });
    json!({ "ok": true, "msg": "Reboot initiated" })
}
