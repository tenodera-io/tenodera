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
                channel: channel.to_string(),
            },
            Message::Data {
                channel: channel.to_string(),
                data: units,
            },
            Message::Close {
                channel: channel.to_string(),
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
            channel: channel.to_string(),
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
            channel: channel.to_string(),
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
        && name.chars().all(|c| c.is_alphanumeric() || ".@-_:".contains(c))
}

async fn systemctl_action(action: &str, unit: &str, user: &str, password: &str) -> serde_json::Value {
    use tokio::io::AsyncWriteExt;

    // Verify the user's password first via unix_chkpwd.
    // The bridge may run as root (via systemd), so sudo would not
    // actually verify the *user's* password — unix_chkpwd does.
    if !user.is_empty() {
        let chkpwd = match crate::util::unix_chkpwd_path() {
            Some(p) => p,
            None => return serde_json::json!({ "ok": false, "error": "unix_chkpwd not found" }),
        };

        let chk = tokio::process::Command::new(chkpwd)
            .args([user, "nullok"])
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn();

        match chk {
            Ok(mut child) => {
                if let Some(mut stdin) = child.stdin.take() {
                    let _ = stdin.write_all(format!("{password}\0").as_bytes()).await;
                    drop(stdin);
                }
                match child.wait().await {
                    Ok(status) if !status.success() => {
                        return serde_json::json!({ "ok": false, "error": "incorrect password" });
                    }
                    Err(e) => {
                        return serde_json::json!({ "ok": false, "error": e.to_string() });
                    }
                    _ => {} // password verified
                }
            }
            Err(e) => {
                return serde_json::json!({ "ok": false, "error": format!("unix_chkpwd: {e}") });
            }
        }
    }

    // Use sudo for systemctl — the bridge may run as a regular user when
    // spawned via SSH on a remote host.  Password was already verified above
    // via unix_chkpwd, and we pass it again to sudo -S.
    let child = tokio::process::Command::new("sudo")
        .args(["-S", "systemctl", action, unit])
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn();

    let mut child = match child {
        Ok(c) => c,
        Err(e) => return serde_json::json!({ "ok": false, "error": e.to_string() }),
    };

    if let Some(mut stdin) = child.stdin.take() {
        let _ = stdin.write_all(format!("{password}\n").as_bytes()).await;
        drop(stdin);
    }

    match child.wait_with_output().await {
        Ok(out) if out.status.success() => {
            serde_json::json!({ "ok": true })
        }
        Ok(out) => {
            let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
            // Filter out sudo password prompt noise
            let clean = stderr
                .lines()
                .filter(|l| !l.contains("[sudo]") && !l.contains("password for"))
                .collect::<Vec<_>>()
                .join("\n");
            let msg = if clean.is_empty() { "command failed".to_string() } else { clean };
            serde_json::json!({ "ok": false, "error": msg })
        }
        Err(e) => serde_json::json!({ "ok": false, "error": e.to_string() }),
    }
}

async fn unit_status(unit: &str) -> serde_json::Value {
    let is_active = tokio::process::Command::new("systemctl")
        .args(["is-active", unit])
        .output()
        .await
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap_or_else(|_| "unknown".into());

    let is_enabled = tokio::process::Command::new("systemctl")
        .args(["is-enabled", unit])
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
        .args(["list-units", "--type=service", "--all", "--output=json", "--no-pager"])
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
