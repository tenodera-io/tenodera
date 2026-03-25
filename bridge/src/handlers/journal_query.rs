use tenodera_protocol::channel::ChannelOpenOptions;
use tenodera_protocol::message::Message;

use crate::handler::ChannelHandler;

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

        let entries = query_journal(lines, unit.as_deref(), priority.as_deref()).await;

        vec![
            Message::Ready {
                channel: channel.to_string(),
            },
            Message::Data {
                channel: channel.to_string(),
                data: entries,
            },
            Message::Close {
                channel: channel.to_string(),
                problem: None,
            },
        ]
    }
}

async fn query_journal(
    lines: u64,
    unit: Option<&str>,
    priority: Option<&str>,
) -> serde_json::Value {
    // Validate unit name if provided
    if let Some(u) = unit
        && (!u.chars().all(|c| c.is_alphanumeric() || ".@-_:".contains(c)) || u.len() > 256) {
            return serde_json::json!({ "error": "invalid unit name" });
        }
    // Validate priority (0-7 or named: emerg,alert,crit,err,warning,notice,info,debug)
    if let Some(p) = priority {
        let valid = matches!(
            p,
            "0" | "1" | "2" | "3" | "4" | "5" | "6" | "7"
                | "emerg" | "alert" | "crit" | "err" | "warning" | "notice" | "info" | "debug"
        );
        if !valid {
            return serde_json::json!({ "error": "invalid priority" });
        }
    }

    let mut cmd = tokio::process::Command::new("journalctl");
    cmd.args(["--output=json", "--no-pager"]);
    cmd.arg(format!("--lines={lines}"));

    if let Some(u) = unit {
        cmd.arg(format!("--unit={u}"));
    }
    if let Some(p) = priority {
        cmd.arg(format!("--priority={p}"));
    }

    let output = cmd.output().await;

    match output {
        Ok(out) if out.status.success() => {
            // journalctl --output=json outputs one JSON object per line
            let entries: Vec<serde_json::Value> = String::from_utf8_lossy(&out.stdout)
                .lines()
                .filter_map(|line| serde_json::from_str(line).ok())
                .collect();
            serde_json::json!({ "entries": entries })
        }
        Ok(out) => {
            let stderr = String::from_utf8_lossy(&out.stderr);
            tracing::warn!(%stderr, "journalctl error");
            serde_json::json!({ "entries": [], "error": stderr.to_string() })
        }
        Err(e) => {
            tracing::error!(error = %e, "failed to run journalctl");
            serde_json::json!({ "entries": [], "error": e.to_string() })
        }
    }
}
