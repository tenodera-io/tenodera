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

        let password = options
            .extra
            .get("password")
            .and_then(|v| v.as_str())
            .unwrap_or("");

        let entries = query_journal(lines, unit.as_deref(), priority.as_deref(), password).await;

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
    password: &str,
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

    let am_root = unsafe { libc::geteuid() } == 0;
    let use_sudo = !am_root && !password.is_empty();

    let mut args: Vec<String> = Vec::new();
    args.push("--output=json".to_string());
    args.push("--no-pager".to_string());
    args.push(format!("--lines={lines}"));
    if let Some(u) = unit {
        args.push(format!("--unit={u}"));
    }
    if let Some(p) = priority {
        args.push(format!("--priority={p}"));
    }

    let (program, cmd_args) = if use_sudo {
        let mut sa = vec!["-S".to_string(), "journalctl".to_string()];
        sa.extend(args);
        ("sudo".to_string(), sa)
    } else {
        ("journalctl".to_string(), args)
    };

    let child = tokio::process::Command::new(&program)
        .args(&cmd_args)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn();

    let mut child = match child {
        Ok(c) => c,
        Err(e) => {
            tracing::error!(error = %e, "failed to spawn journalctl");
            return serde_json::json!({ "entries": [], "error": e.to_string() });
        }
    };

    if use_sudo {
        if let Some(mut stdin) = child.stdin.take() {
            use tokio::io::AsyncWriteExt;
            let _ = stdin.write_all(format!("{password}\n").as_bytes()).await;
            drop(stdin);
        }
    } else {
        drop(child.stdin.take());
    }

    match child.wait_with_output().await {
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
            let filtered: String = stderr
                .lines()
                .filter(|l| !l.contains("[sudo]") && !l.contains("password for"))
                .collect::<Vec<_>>()
                .join("\n");
            tracing::warn!(stderr = %filtered, "journalctl error");
            serde_json::json!({ "entries": [], "error": filtered })
        }
        Err(e) => {
            tracing::error!(error = %e, "failed to run journalctl");
            serde_json::json!({ "entries": [], "error": e.to_string() })
        }
    }
}
