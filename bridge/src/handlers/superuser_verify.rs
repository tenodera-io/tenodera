use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};
use std::time::Instant;

use tenodera_protocol::channel::ChannelOpenOptions;
use tenodera_protocol::message::Message;
use tokio::io::AsyncWriteExt;

use crate::handler::ChannelHandler;

// ── Rate limiting for superuser verification ──────────────────
// Block a user after MAX_ATTEMPTS failed password checks within
// LOCKOUT_WINDOW seconds.  The counter resets on successful verify
// or after the window expires.

const MAX_ATTEMPTS: u32 = 6;
const LOCKOUT_WINDOW_SECS: u64 = 15 * 60; // 15 minutes

/// Per-user failure counter: (attempts, first_failure_time).
static RATE_LIMITER: LazyLock<Mutex<HashMap<String, (u32, Instant)>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// Check whether the user is currently locked out.
fn is_locked_out(user: &str) -> bool {
    let Ok(map) = RATE_LIMITER.lock() else { return false };
    if let Some((count, since)) = map.get(user) {
        if since.elapsed().as_secs() > LOCKOUT_WINDOW_SECS {
            return false; // window expired
        }
        return *count >= MAX_ATTEMPTS;
    }
    false
}

/// Record a failed attempt.  Returns `true` if the user is now locked out.
fn record_failure(user: &str) -> bool {
    let Ok(mut map) = RATE_LIMITER.lock() else { return false };
    let entry = map.entry(user.to_string()).or_insert((0, Instant::now()));
    // Reset window if it expired
    if entry.1.elapsed().as_secs() > LOCKOUT_WINDOW_SECS {
        *entry = (0, Instant::now());
    }
    entry.0 += 1;
    entry.0 >= MAX_ATTEMPTS
}

/// Clear the failure counter on success.
fn clear_failures(user: &str) {
    if let Ok(mut map) = RATE_LIMITER.lock() {
        map.remove(user);
    }
}

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
        } else if is_locked_out(user) {
            tracing::warn!(user, "superuser verify blocked — too many failed attempts");
            serde_json::json!({ "ok": false, "error": "too many failed attempts, try again later" })
        } else {
            let r = verify_password(user, password).await;
            let ok = r.get("ok").and_then(|v| v.as_bool()).unwrap_or(false);
            if ok {
                clear_failures(user);
            } else {
                let locked = record_failure(user);
                if locked {
                    tracing::warn!(user, "superuser verify lockout triggered after {MAX_ATTEMPTS} failures");
                }
            }
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
