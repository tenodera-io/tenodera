use serde_json::{Value, json};

use crate::handler::ChannelHandler;
use crate::util::require_admin;
use tenodera_protocol::channel::ChannelOpenOptions;
use tenodera_protocol::message::Message;

// ── audit.query ────────────────────────────────────────────────────────────────
// Read and parse this host's audit log (/var/log/tenodera_audit.log) into
// structured entries for the panel. Admin-gated; the agent (root) reads the file.

const AUDIT_LOG: &str = "/var/log/tenodera_audit.log";

pub struct AuditQueryHandler;

#[async_trait::async_trait]
impl ChannelHandler for AuditQueryHandler {
    fn payload_type(&self) -> &str {
        "audit.query"
    }

    async fn open(&self, channel: &str, options: &ChannelOpenOptions) -> Vec<Message> {
        let extra = Value::Object(options.extra.clone());
        let data = if let Some(err) = require_admin(&extra) {
            err
        } else {
            let limit = options
                .extra
                .get("limit")
                .and_then(|v| v.as_u64())
                .unwrap_or(500)
                .min(5000) as usize;
            read_audit(limit)
        };

        vec![
            Message::Ready {
                channel: channel.into(),
            },
            Message::Data {
                channel: channel.into(),
                data,
            },
            Message::Close {
                channel: channel.into(),
                problem: None,
            },
        ]
    }
}

fn read_audit(limit: usize) -> Value {
    let content = std::fs::read_to_string(AUDIT_LOG).unwrap_or_default();
    let total = content.lines().filter(|l| !l.trim().is_empty()).count();
    // Newest first, capped at `limit`.
    let entries: Vec<Value> = content
        .lines()
        .rev()
        .filter_map(parse_line)
        .take(limit)
        .collect();
    json!({ "entries": entries, "total": total, "path": AUDIT_LOG })
}

/// Parse `[ts] user=U action=A target=T result=R details=D` into fields.
fn parse_line(line: &str) -> Option<Value> {
    let line = line.trim();
    if !line.starts_with('[') {
        return None;
    }
    let close = line.find(']')?;
    let ts = line[1..close].to_string();
    let rest = &line[close + 1..];

    let i_user = rest.find("user=")?;
    let i_action = rest.find(" action=")?;
    let i_target = rest.find(" target=")?;
    let i_result = rest.find(" result=")?;
    let i_details = rest.find(" details=")?;

    Some(json!({
        "ts": ts,
        "user": rest[i_user + 5..i_action].to_string(),
        "action": rest[i_action + 8..i_target].to_string(),
        "target": rest[i_target + 8..i_result].to_string(),
        "result": rest[i_result + 8..i_details].to_string(),
        "details": rest[i_details + 9..].to_string(),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_audit_line() {
        let line = "[2026-07-17T19:14:00Z] user=ulther action=pkg.install target=nginx,curl result=ok details=apt";
        let v = parse_line(line).unwrap();
        assert_eq!(v["ts"], "2026-07-17T19:14:00Z");
        assert_eq!(v["user"], "ulther");
        assert_eq!(v["action"], "pkg.install");
        assert_eq!(v["target"], "nginx,curl");
        assert_eq!(v["result"], "ok");
        assert_eq!(v["details"], "apt");
    }

    #[test]
    fn rejects_non_audit_line() {
        assert!(parse_line("garbage line").is_none());
        assert!(parse_line("").is_none());
    }
}
