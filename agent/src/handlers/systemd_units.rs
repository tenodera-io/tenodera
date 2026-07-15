use tenodera_protocol::channel::ChannelOpenOptions;
use tenodera_protocol::message::Message;

use crate::handler::ChannelHandler;

pub struct SystemdUnitsHandler;

#[async_trait::async_trait]
impl ChannelHandler for SystemdUnitsHandler {
    fn payload_type(&self) -> &str {
        "systemd.units"
    }

    async fn open(&self, channel: &str, _options: &ChannelOpenOptions) -> Vec<Message> {
        let units = list_units().await;

        vec![
            Message::Ready {
                channel: channel.into(),
            },
            Message::Data {
                channel: channel.into(),
                data: units,
            },
            Message::Close {
                channel: channel.into(),
                problem: None,
            },
        ]
    }
}

pub struct SystemdManageHandler;

#[async_trait::async_trait]
impl ChannelHandler for SystemdManageHandler {
    fn payload_type(&self) -> &str {
        "systemd.manage"
    }

    async fn open(&self, channel: &str, _options: &ChannelOpenOptions) -> Vec<Message> {
        vec![Message::Ready {
            channel: channel.into(),
        }]
        // Keep channel open for bidirectional commands
    }

    async fn data(&self, channel: &str, data: &serde_json::Value) -> Vec<Message> {
        let action = data.get("action").and_then(|a| a.as_str()).unwrap_or("");
        let unit = data.get("unit").and_then(|u| u.as_str()).unwrap_or("");
        let password = data.get("password").and_then(|p| p.as_str()).unwrap_or("");
        let user = data.get("_user").and_then(|u| u.as_str()).unwrap_or("");

        let result = match action {
            "start" | "stop" | "restart" | "enable" | "disable" | "reload" => {
                if let Some(err) = crate::util::require_admin(data) {
                    return vec![Message::Data {
                        channel: channel.into(),
                        data: serde_json::json!({ "type": "response", "action": action, "unit": unit, "data": err }),
                    }];
                }
                if unit.is_empty() {
                    serde_json::json!({ "ok": false, "error": "no unit specified" })
                } else if !is_valid_unit_name(unit) {
                    serde_json::json!({ "ok": false, "error": "invalid unit name" })
                } else if password.is_empty() {
                    serde_json::json!({ "ok": false, "error": "password required" })
                } else {
                    let r = systemctl_action(action, unit, user, password).await;
                    let ok = r.get("ok").and_then(|v| v.as_bool()).unwrap_or(false);
                    crate::audit::log(user, action, unit, ok, "");
                    r
                }
            }
            "status" => {
                if unit.is_empty() {
                    serde_json::json!({ "ok": false, "error": "no unit specified" })
                } else if !is_valid_unit_name(unit) {
                    serde_json::json!({ "ok": false, "error": "invalid unit name" })
                } else {
                    unit_status(unit).await
                }
            }
            "list" => {
                let units = list_units().await;
                serde_json::json!({ "type": "list", "data": units })
            }
            _ => serde_json::json!({ "ok": false, "error": format!("unknown action: {action}") }),
        };

        vec![Message::Data {
            channel: channel.into(),
            data: serde_json::json!({ "type": "response", "action": action, "unit": unit, "data": result }),
        }]
    }
}

/// Validate systemd unit name: alphanumeric, dots, hyphens, underscores, @ sign.
/// Must not contain path separators or other special characters.
fn is_valid_unit_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 256
        && !name.contains('/')
        && !name.contains('\\')
        && !name.contains("..")
        && name
            .chars()
            .all(|c| c.is_alphanumeric() || ".@-_:".contains(c))
}

async fn systemctl_action(
    action: &str,
    unit: &str,
    user: &str,
    password: &str,
) -> serde_json::Value {
    // Run systemctl AS THE USER via sudo, so the host's own rules (local sudoers or
    // FreeIPA sudo via SSSD) decide whether this user may manage services — see
    // util::sudo_as_user. Works for local and directory (FreeIPA/LDAP) users.
    let res = crate::util::sudo_as_user(user, password, &["systemctl", action, "--", unit]).await;
    if res.get("ok").is_some() {
        serde_json::json!({ "ok": true })
    } else {
        let err = res
            .get("error")
            .and_then(|v| v.as_str())
            .unwrap_or("command failed");
        serde_json::json!({ "ok": false, "error": err })
    }
}

async fn unit_status(unit: &str) -> serde_json::Value {
    let is_active = tokio::process::Command::new("systemctl")
        .args(["is-active", "--", unit])
        .output()
        .await
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap_or_else(|_| "unknown".into());

    let is_enabled = tokio::process::Command::new("systemctl")
        .args(["is-enabled", "--", unit])
        .output()
        .await
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap_or_else(|_| "unknown".into());

    serde_json::json!({
        "active": is_active,
        "enabled": is_enabled,
    })
}

async fn list_units() -> serde_json::Value {
    let output = tokio::process::Command::new("systemctl")
        .args([
            "list-units",
            "--type=service",
            "--all",
            "--output=json",
            "--no-pager",
        ])
        .output()
        .await;

    match output {
        Ok(out) if out.status.success() => {
            serde_json::from_slice(&out.stdout).unwrap_or(serde_json::Value::Array(vec![]))
        }
        Ok(out) => {
            tracing::warn!(
                stderr = %String::from_utf8_lossy(&out.stderr),
                "systemctl exited with error"
            );
            serde_json::Value::Array(vec![])
        }
        Err(e) => {
            tracing::error!(error = %e, "failed to run systemctl");
            serde_json::Value::Array(vec![])
        }
    }
}
