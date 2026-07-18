use tenodera_protocol::channel::ChannelOpenOptions;
use tenodera_protocol::message::Message;

use crate::handler::ChannelHandler;
use crate::util::{UserReadOutcome, is_valid_username, run_cmd_as_user, sudo_as_user};

pub struct JournalQueryHandler;

#[async_trait::async_trait]
impl ChannelHandler for JournalQueryHandler {
    fn payload_type(&self) -> &str {
        "journal.query"
    }

    fn is_streaming(&self) -> bool {
        // journal.query with "follow" becomes streaming
        false
    }

    async fn open(&self, channel: &str, options: &ChannelOpenOptions) -> Vec<Message> {
        let lines = options
            .extra
            .get("lines")
            .and_then(|v| v.as_u64())
            .unwrap_or(100);

        let unit = options
            .extra
            .get("unit")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());

        let priority = options
            .extra
            .get("priority")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());

        // The journal is a privileged read, always brokered per-user. Default: run
        // journalctl AS the logged-in user so the host's own group ACLs (`adm` /
        // `systemd-journal`) decide what they may see — no sudo, no password. If the UI
        // is in superuser mode it also sends `password`: then we run `sudo -S journalctl`
        // AS that user, so the host's sudoers decides — a user who may `sudo journalctl`
        // (but isn't in the journal groups) sees everything, exactly as in their own
        // shell session. The gateway injects `_user` on every open.
        let user = options
            .extra
            .get("_user")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        let password = options
            .extra
            .get("password")
            .and_then(|v| v.as_str())
            .unwrap_or("");

        let entries =
            query_journal(lines, unit.as_deref(), priority.as_deref(), user, password).await;

        vec![
            Message::Ready {
                channel: channel.into(),
            },
            Message::Data {
                channel: channel.into(),
                data: entries,
            },
            Message::Close {
                channel: channel.into(),
                problem: None,
            },
        ]
    }
}

async fn query_journal(
    lines: u64,
    unit: Option<&str>,
    priority: Option<&str>,
    user: &str,
    password: &str,
) -> serde_json::Value {
    // Validate unit name if provided
    if let Some(u) = unit
        && (!u
            .chars()
            .all(|c| c.is_alphanumeric() || ".@-_:".contains(c))
            || u.len() > 256)
    {
        return serde_json::json!({ "error": "invalid unit name" });
    }
    // Validate priority (0-7 or named: emerg,alert,crit,err,warning,notice,info,debug)
    if let Some(p) = priority {
        let valid = matches!(
            p,
            "0" | "1"
                | "2"
                | "3"
                | "4"
                | "5"
                | "6"
                | "7"
                | "emerg"
                | "alert"
                | "crit"
                | "err"
                | "warning"
                | "notice"
                | "info"
                | "debug"
        );
        if !valid {
            return serde_json::json!({ "error": "invalid priority" });
        }
    }

    // Defence-in-depth: the gateway injects `_user`, but never trust it blindly.
    if !is_valid_username(user) {
        return serde_json::json!({ "error": "no session user" });
    }

    let mut args: Vec<String> = vec![
        "journalctl".to_string(),
        "--output=json".to_string(),
        "--no-pager".to_string(),
        format!("--lines={lines}"),
    ];
    if let Some(u) = unit {
        args.push(format!("--unit={u}"));
    }
    if let Some(p) = priority {
        args.push(format!("--priority={p}"));
    }
    let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();

    // Superuser mode: escalate via `sudo -S journalctl` AS the user — the host's
    // sudoers decides. A user who may sudo (but lacks the journal groups) sees all.
    if !password.is_empty() {
        let res = sudo_as_user(user, password, &arg_refs).await;
        return match res.get("output").and_then(|v| v.as_str()) {
            Some(out) => serde_json::json!({ "entries": parse_entries(out) }),
            // Wrong password / sudo denied — surface it so the UI can prompt again.
            None => serde_json::json!({
                "entries": [],
                "error": res.get("error").and_then(|v| v.as_str()).unwrap_or("command failed")
            }),
        };
    }

    // Default: read AS the user, no sudo. The host's own permissions decide.
    match run_cmd_as_user(user, &arg_refs).await {
        // No account on this host → only baseline data is theirs to see.
        UserReadOutcome::NoAccount => {
            serde_json::json!({ "entries": [], "restricted": true, "reason": "no-account" })
        }
        UserReadOutcome::SpawnFailed(e) => {
            tracing::error!(error = %e, "failed to run journalctl as user");
            serde_json::json!({ "entries": [], "error": e })
        }
        UserReadOutcome::Ran(out) => {
            let stdout = String::from_utf8_lossy(&out.stdout);
            let entries = parse_entries(&stdout);
            let stderr = String::from_utf8_lossy(&out.stderr);

            // A user outside adm/systemd-journal can't open the system journal. Depending
            // on version journalctl either exits non-zero ("No journal files were opened
            // due to insufficient permissions") or exits 0 with a hint ("not seeing
            // messages from other users"). Both mean the same thing: it's not an error,
            // it's the host limiting them — show the calm banner, not a red error.
            let insufficient = stderr.contains("insufficient permissions")
                || stderr.contains("No journal files were opened")
                || stderr.contains("not seeing messages from other users");

            if insufficient {
                serde_json::json!({
                    "entries": entries,
                    "restricted": true,
                    "reason": "insufficient-group"
                })
            } else if out.status.success() {
                serde_json::json!({ "entries": entries })
            } else {
                tracing::warn!(stderr = %stderr, "journalctl error");
                serde_json::json!({ "entries": entries, "error": stderr.trim() })
            }
        }
    }
}

/// Parse journalctl `--output=json` (one JSON object per line) into an array.
fn parse_entries(stdout: &str) -> Vec<serde_json::Value> {
    stdout
        .lines()
        .filter_map(|line| serde_json::from_str(line).ok())
        .collect()
}
