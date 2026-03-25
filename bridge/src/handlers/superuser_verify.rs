use tenodera_protocol::channel::ChannelOpenOptions;
use tenodera_protocol::message::Message;
use tokio::io::AsyncWriteExt;

use crate::handler::ChannelHandler;

pub struct SuperuserVerifyHandler;

#[async_trait::async_trait]
impl ChannelHandler for SuperuserVerifyHandler {
    fn payload_type(&self) -> &str {
        "superuser.verify"
    }

    async fn open(&self, channel: &str, options: &ChannelOpenOptions) -> Vec<Message> {
        let password = options
            .extra
            .get("password")
            .and_then(|v| v.as_str())
            .unwrap_or("");

        let user = options
            .extra
            .get("_user")
            .and_then(|v| v.as_str())
            .unwrap_or("");

        let result = if password.is_empty() {
            serde_json::json!({ "ok": false, "error": "password required" })
        } else if user.is_empty() {
            serde_json::json!({ "ok": false, "error": "no user context" })
        } else {
            let r = verify_password(user, password).await;
            let ok = r.get("ok").and_then(|v| v.as_bool()).unwrap_or(false);
            crate::audit::log(user, "superuser.verify", "", ok, "");
            r
        };

        vec![
            Message::Ready {
                channel: channel.to_string(),
            },
            Message::Data {
                channel: channel.to_string(),
                data: result,
            },
            Message::Close {
                channel: channel.to_string(),
                problem: None,
            },
        ]
    }
}

async fn verify_password(user: &str, password: &str) -> serde_json::Value {
    // Use unix_chkpwd to verify password (same as gateway login).
    // This avoids sudo which requires setuid/NoNewPrivileges.
    let chkpwd = match crate::util::unix_chkpwd_path() {
        Some(p) => p,
        None => return serde_json::json!({ "ok": false, "error": "unix_chkpwd not found" }),
    };

    let child = tokio::process::Command::new(chkpwd)
        .args([user, "nullok"])
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped())
        .spawn();

    let mut child = match child {
        Ok(c) => c,
        Err(e) => return serde_json::json!({ "ok": false, "error": e.to_string() }),
    };

    if let Some(mut stdin) = child.stdin.take() {
        let _ = stdin.write_all(format!("{password}\0").as_bytes()).await;
        drop(stdin);
    }

    match child.wait().await {
        Ok(status) if status.success() => {
            serde_json::json!({ "ok": true })
        }
        Ok(_) => {
            serde_json::json!({ "ok": false, "error": "incorrect password" })
        }
        Err(e) => serde_json::json!({ "ok": false, "error": e.to_string() }),
    }
}
