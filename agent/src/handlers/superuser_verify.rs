use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};
use std::time::Instant;

use tenodera_protocol::channel::ChannelOpenOptions;
use tenodera_protocol::message::Message;

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
    let Ok(mut map) = RATE_LIMITER.lock() else {
        return false;
    };
    if let Some((count, since)) = map.get(user) {
        if since.elapsed().as_secs() > LOCKOUT_WINDOW_SECS {
            map.remove(user); // clean up expired entry
            return false;
        }
        return *count >= MAX_ATTEMPTS;
    }
    false
}

/// Record a failed attempt.  Returns `true` if the user is now locked out.
fn record_failure(user: &str) -> bool {
    let Ok(mut map) = RATE_LIMITER.lock() else {
        return false;
    };
    let entry = map.entry(user.to_string()).or_insert((0, Instant::now()));
    // Reset window if it expired
    if entry.1.elapsed().as_secs() > LOCKOUT_WINDOW_SECS {
        *entry = (0, Instant::now());
    }
    entry.0 += 1;
    let locked = entry.0 >= MAX_ATTEMPTS;

    // Prune expired entries to prevent unbounded growth.
    // Only runs when the map exceeds a reasonable threshold.
    if map.len() > 50 {
        map.retain(|_, (_, since)| since.elapsed().as_secs() <= LOCKOUT_WINDOW_SECS);
    }

    locked
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
                    tracing::warn!(
                        user,
                        "superuser verify lockout triggered after {MAX_ATTEMPTS} failures"
                    );
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

pub(crate) async fn verify_password(user: &str, password: &str) -> serde_json::Value {
    // Validate the password AND that the user actually has sudo on THIS host, by
    // running `sudo -v` **as the user** (util::sudo_as_user drops to the user first).
    //
    // This goes through the full PAM/NSS stack (pam_sss for SSSD/FreeIPA), so it works
    // for local and directory users. Running the check as root (the agent's identity)
    // would be a no-op — root is sudo-exempt, so any password would "pass".
    let res = crate::util::sudo_as_user(user, password, &["-v"]).await;
    if res.get("ok").is_some() {
        return serde_json::json!({ "ok": true });
    }
    let err = res.get("error").and_then(|v| v.as_str()).unwrap_or("");
    if err.contains("incorrect password")
        || err.contains("Sorry, try again")
        || err.contains("Authentication failure")
    {
        serde_json::json!({ "ok": false, "error": "incorrect password" })
    } else {
        serde_json::json!({ "ok": false, "error": "sudo access denied" })
    }
}
