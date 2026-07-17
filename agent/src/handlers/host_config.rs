use async_trait::async_trait;
use serde_json::{Value, json};
use tokio::fs;

use crate::handler::ChannelHandler;
use crate::util::{require_admin, sudo_as_user, sudo_stdin_write_as_user};
use tenodera_protocol::channel::ChannelOpenOptions;
use tenodera_protocol::message::Message;

// ── host.config ────────────────────────────────────────────────────────────────

pub struct HostConfigHandler;

#[async_trait]
impl ChannelHandler for HostConfigHandler {
    fn payload_type(&self) -> &str {
        "host.config"
    }

    async fn open(&self, channel: &str, _options: &ChannelOpenOptions) -> Vec<Message> {
        let data = read_host_config().await;
        vec![
            Message::Ready {
                channel: channel.into(),
            },
            Message::Data {
                channel: channel.into(),
                data,
            },
            Message::Close {
                channel: channel.into(),
                problem: None,
            },
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

    let env_path = "/etc/tenodera/agent.cnf";
    let content = match fs::read_to_string(env_path).await {
        Ok(c) => c,
        Err(_) => return json!({ "roles": [], "hostname": hostname, "uptime_secs": uptime_secs }),
    };

    let mut roles: Vec<String> = content
        .lines()
        .filter_map(|line| {
            let line = line.trim();
            if line.starts_with('#') || line.is_empty() {
                return None;
            }
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
    fn payload_type(&self) -> &str {
        "host.action"
    }

    async fn open(&self, channel: &str, options: &ChannelOpenOptions) -> Vec<Message> {
        let extra = Value::Object(options.extra.clone());

        if let Some(err) = require_admin(&extra) {
            return vec![
                Message::Ready {
                    channel: channel.into(),
                },
                Message::Data {
                    channel: channel.into(),
                    data: err,
                },
                Message::Close {
                    channel: channel.into(),
                    problem: None,
                },
            ];
        }

        let action = options
            .extra
            .get("action")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        let password = options
            .extra
            .get("password")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        // Gateway-injected identity — privileged ops run as this user via sudo.
        let user = options
            .extra
            .get("_user")
            .and_then(|v| v.as_str())
            .unwrap_or("");

        // Optional scheduling: minutes to delay a power action (0 = immediate).
        let delay_mins = options
            .extra
            .get("delay_mins")
            .and_then(|v| v.as_u64())
            .unwrap_or(0);

        let result = match action {
            "set_role" => set_role(&extra, user, password).await,
            "restart" => restart_host(user, password, delay_mins).await,
            "poweroff" => poweroff_host(user, password, delay_mins).await,
            "cancel_shutdown" => cancel_shutdown(user, password).await,
            other => json!({ "error": format!("unknown action: {other}") }),
        };

        vec![
            Message::Ready {
                channel: channel.into(),
            },
            Message::Data {
                channel: channel.into(),
                data: result,
            },
            Message::Close {
                channel: channel.into(),
                problem: None,
            },
        ]
    }
}

async fn set_role(data: &Value, user: &str, password: &str) -> Value {
    let role = data
        .get("role")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();

    let env_path = "/etc/tenodera/agent.cnf";
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
    sudo_stdin_write_as_user(user, password, &["tee", env_path], &new_content).await
}

async fn restart_host(user: &str, password: &str, delay_mins: u64) -> Value {
    if delay_mins > 0 {
        // Scheduled: `shutdown -r +N` returns immediately after arming the timer.
        let when = format!("+{delay_mins}");
        let r = sudo_as_user(user, password, &["shutdown", "-r", &when]).await;
        crate::audit::log(
            user,
            "system.reboot",
            &when,
            r.get("error").is_none(),
            "scheduled",
        );
        return if r.get("error").is_some() {
            r
        } else {
            json!({ "ok": true, "msg": format!("Reboot scheduled in {delay_mins} min") })
        };
    }
    // Immediate: the machine dies before the sudo call returns, so audit intent now
    // and spawn so the response flushes before `reboot` tears the connection down.
    crate::audit::log(user, "system.reboot", "", true, "");
    let pw = password.to_string();
    let user = user.to_string();
    tokio::spawn(async move {
        tokio::time::sleep(tokio::time::Duration::from_millis(400)).await;
        sudo_as_user(&user, &pw, &["reboot"]).await;
    });
    json!({ "ok": true, "msg": "Reboot initiated" })
}

async fn poweroff_host(user: &str, password: &str, delay_mins: u64) -> Value {
    if delay_mins > 0 {
        // Scheduled: `shutdown -h +N` returns immediately after arming the timer.
        let when = format!("+{delay_mins}");
        let r = sudo_as_user(user, password, &["shutdown", "-h", &when]).await;
        crate::audit::log(
            user,
            "system.poweroff",
            &when,
            r.get("error").is_none(),
            "scheduled",
        );
        return if r.get("error").is_some() {
            r
        } else {
            json!({ "ok": true, "msg": format!("Shutdown scheduled in {delay_mins} min") })
        };
    }
    // Immediate: the machine dies before the sudo call returns, so audit intent now
    // and spawn so the response flushes before `poweroff` tears the connection down.
    crate::audit::log(user, "system.poweroff", "", true, "");
    let pw = password.to_string();
    let user = user.to_string();
    tokio::spawn(async move {
        tokio::time::sleep(tokio::time::Duration::from_millis(400)).await;
        sudo_as_user(&user, &pw, &["poweroff"]).await;
    });
    json!({ "ok": true, "msg": "Shutdown initiated" })
}

async fn cancel_shutdown(user: &str, password: &str) -> Value {
    let r = sudo_as_user(user, password, &["shutdown", "-c"]).await;
    crate::audit::log(
        user,
        "system.cancel_shutdown",
        "",
        r.get("error").is_none(),
        "",
    );
    if r.get("error").is_some() {
        r
    } else {
        json!({ "ok": true, "msg": "Scheduled power action cancelled" })
    }
}
