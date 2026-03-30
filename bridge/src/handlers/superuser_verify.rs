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

async fn verify_password(_user: &str, password: &str) -> serde_json::Value {
    // Verify that the user can run commands via sudo.
    //
    // Previous approach used unix_chkpwd which only checks /etc/shadow.
    // That fails for FreeIPA/LDAP users whose passwords live in the
    // directory server, not in the local shadow database.
    //
    // Using `sudo -S -k true` goes through the full PAM/NSS stack
    // (including pam_sss for SSSD/FreeIPA), so it works for both
    // local and LDAP users.  As a bonus it also confirms the user
    // actually has sudo privileges — which is exactly what
    // "Administrative Access" requires.
    //
    // -S  read password from stdin
    // -k  invalidate cached credentials (force re-auth)

    let child = tokio::process::Command::new("sudo")
        .args(["-S", "-k", "true"])
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::null())
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
            let stderr = String::from_utf8_lossy(&out.stderr);
            // Distinguish wrong password from no-sudo-access
            if stderr.contains("incorrect password")
                || stderr.contains("Sorry, try again")
                || stderr.contains("Authentication failure")
            {
                serde_json::json!({ "ok": false, "error": "incorrect password" })
            } else {
                serde_json::json!({ "ok": false, "error": "sudo access denied" })
            }
        }
        Err(e) => serde_json::json!({ "ok": false, "error": e.to_string() }),
    }
}
