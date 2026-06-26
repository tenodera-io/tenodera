use crate::handler::ChannelHandler;
use crate::util::{require_admin, run_cmd, sudo_action};
use serde_json::{json, Value};
use tenodera_protocol::channel::ChannelOpenOptions;
use tenodera_protocol::message::Message;

// ── Info handler ──────────────────────────────────────────────────────────────

pub struct TimeInfoHandler;

#[async_trait::async_trait]
impl ChannelHandler for TimeInfoHandler {
    fn payload_type(&self) -> &str { "time.info" }

    async fn open(&self, channel: &str, _options: &ChannelOpenOptions) -> Vec<Message> {
        let data = get_time_info().await;
        vec![
            Message::Ready { channel: channel.into() },
            Message::Data { channel: channel.into(), data },
            Message::Close { channel: channel.into(), problem: None },
        ]
    }
}

// ── Manage handler (set timezone, sync NTP) ────────────────────────────────────

pub struct TimeManageHandler;

#[async_trait::async_trait]
impl ChannelHandler for TimeManageHandler {
    fn payload_type(&self) -> &str { "time.manage" }

    async fn open(&self, channel: &str, options: &ChannelOpenOptions) -> Vec<Message> {
        let data = Value::Object(options.extra.clone());
        let result = if let Some(err) = require_admin(&data) {
            err
        } else {
            let action = data.get("action").and_then(|v| v.as_str()).unwrap_or("");
            let password = data.get("password").and_then(|v| v.as_str()).unwrap_or("");

            match action {
                "set_timezone" => {
                    let tz = data.get("timezone").and_then(|v| v.as_str()).unwrap_or("");
                    if !is_safe_timezone(tz) {
                        json!({ "ok": false, "error": "invalid timezone" })
                    } else {
                        let r = sudo_action(password, &["timedatectl", "set-timezone", tz]).await;
                        if r.get("ok").and_then(|v| v.as_bool()).unwrap_or(false) {
                            json!({ "ok": true })
                        } else {
                            json!({ "ok": false, "error": r.get("error").and_then(|v| v.as_str()).unwrap_or("failed") })
                        }
                    }
                }
                "sync_now" => {
                    // Try chronyc first, fall back to restarting systemd-timesyncd
                    let r = sudo_action(password, &["chronyc", "makestep"]).await;
                    if r.get("ok").and_then(|v| v.as_bool()).unwrap_or(false) {
                        json!({ "ok": true })
                    } else {
                        let r2 = sudo_action(password, &["systemctl", "try-restart", "systemd-timesyncd"]).await;
                        if r2.get("ok").and_then(|v| v.as_bool()).unwrap_or(false) {
                            json!({ "ok": true })
                        } else {
                            json!({ "ok": false, "error": "no NTP daemon found (tried chronyc, systemd-timesyncd)" })
                        }
                    }
                }
                _ => json!({ "ok": false, "error": format!("unknown action: {action}") }),
            }
        };

        vec![
            Message::Ready { channel: channel.into() },
            Message::Data { channel: channel.into(), data: result },
            Message::Close { channel: channel.into(), problem: None },
        ]
    }
}

// ── Helpers ────────────────────────────────────────────────────────────────────

async fn get_time_info() -> Value {
    let mut timezone = String::from("UTC");
    let mut ntp = false;
    let mut ntp_synchronized = false;

    // Parse timedatectl show (machine-readable key=value)
    let out = tokio::process::Command::new("timedatectl")
        .arg("show")
        .output()
        .await;

    if let Ok(out) = out {
        for line in String::from_utf8_lossy(&out.stdout).lines() {
            if let Some((k, v)) = line.split_once('=') {
                match k.trim() {
                    "Timezone"        => timezone = v.trim().to_string(),
                    "NTP"             => ntp = v.trim() == "yes",
                    "NTPSynchronized" => ntp_synchronized = v.trim() == "yes",
                    _ => {}
                }
            }
        }
    }

    // Current local time as ISO 8601
    let local_time = run_cmd(&["date", "-Iseconds"]).await;

    // Timezone list for the picker
    let zones = get_timezone_list().await;

    json!({
        "timezone": timezone,
        "ntp": ntp,
        "ntp_synchronized": ntp_synchronized,
        "local_time": local_time.trim(),
        "zones": zones,
    })
}

async fn get_timezone_list() -> Vec<String> {
    let out = tokio::process::Command::new("timedatectl")
        .arg("list-timezones")
        .output()
        .await;

    match out {
        Ok(o) if o.status.success() => String::from_utf8_lossy(&o.stdout)
            .lines()
            .filter(|l| !l.is_empty())
            .map(|l| l.to_string())
            .collect(),
        _ => vec![],
    }
}

fn is_safe_timezone(tz: &str) -> bool {
    !tz.is_empty()
        && tz.len() <= 64
        && tz.chars().all(|c| c.is_ascii_alphanumeric() || "/_+-".contains(c))
}
