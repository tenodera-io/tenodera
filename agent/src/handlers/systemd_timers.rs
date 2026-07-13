use crate::handler::ChannelHandler;
use serde_json::{Value, json};
use tenodera_protocol::channel::ChannelOpenOptions;
use tenodera_protocol::message::Message;

pub struct SystemdTimersHandler;

#[async_trait::async_trait]
impl ChannelHandler for SystemdTimersHandler {
    fn payload_type(&self) -> &str {
        "systemd.timers"
    }

    async fn open(&self, channel: &str, _options: &ChannelOpenOptions) -> Vec<Message> {
        let data = list_timers().await;
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

async fn list_timers() -> Value {
    // Step 1: get timer unit names
    let names_out = tokio::process::Command::new("systemctl")
        .args([
            "list-units",
            "--type=timer",
            "--all",
            "--plain",
            "--no-legend",
            "--no-pager",
        ])
        .output()
        .await;

    let names: Vec<String> = match names_out {
        Ok(o) if o.status.success() => String::from_utf8_lossy(&o.stdout)
            .lines()
            .filter_map(|l| l.split_whitespace().next().map(|s| s.to_string()))
            .filter(|s| s.ends_with(".timer"))
            .collect(),
        _ => return json!([]),
    };

    if names.is_empty() {
        return json!([]);
    }

    // Step 2: get details for all timers at once via systemctl show
    // Note: NextElapseUSecRealtime and LastTriggerUSec are returned as human-readable strings
    // by systemctl show (e.g. "Sat 2026-06-27 00:00:00 UTC"), not raw microseconds.
    let mut cmd = tokio::process::Command::new("systemctl");
    cmd.arg("show")
       .arg("--property=Id,ActiveState,SubState,Description,NextElapseUSecRealtime,LastTriggerUSec,UnitFileState,Triggers");
    for name in &names {
        cmd.arg(name);
    }

    let details_out = cmd.output().await;
    let details_str = match details_out {
        Ok(o) => String::from_utf8_lossy(&o.stdout).to_string(),
        Err(_) => return json!([]),
    };

    let timers: Vec<Value> = details_str
        .split("\n\n")
        .filter(|block| !block.trim().is_empty())
        .map(parse_timer_block)
        .filter(|v| !v["unit"].as_str().unwrap_or("").is_empty())
        .collect();

    json!(timers)
}

fn parse_timer_block(block: &str) -> Value {
    let mut id = String::new();
    let mut active = String::new();
    let mut sub = String::new();
    let mut description = String::new();
    let mut next = String::new();
    let mut last = String::new();
    let mut enabled = String::new();
    let mut triggers = String::new();

    for line in block.lines() {
        if let Some((k, v)) = line.split_once('=') {
            match k {
                "Id" => id = v.to_string(),
                "ActiveState" => active = v.to_string(),
                "SubState" => sub = v.to_string(),
                "Description" => description = v.to_string(),
                "NextElapseUSecRealtime" => next = normalise_ts(v),
                "LastTriggerUSec" => last = normalise_ts(v),
                "UnitFileState" => enabled = v.to_string(),
                "Triggers" => triggers = v.to_string(),
                _ => {}
            }
        }
    }

    json!({
        "unit":        id,
        "active":      active,
        "sub":         sub,
        "description": description,
        "next":        next,
        "last":        last,
        "enabled":     enabled,
        "triggers":    triggers,
    })
}

/// systemctl show returns timestamps as "Day YYYY-MM-DD HH:MM:SS TZ" or empty.
/// Normalise empty / "n/a" to "n/a"; strip the weekday prefix otherwise.
fn normalise_ts(raw: &str) -> String {
    let s = raw.trim();
    if s.is_empty() || s == "n/a" {
        return "n/a".to_string();
    }
    // Strip leading weekday token if present: "Sat 2026-06-27 …" → "2026-06-27 …"
    let parts: Vec<&str> = s.splitn(2, ' ').collect();
    if parts.len() == 2 && parts[0].len() == 3 && parts[0].chars().all(|c| c.is_ascii_alphabetic())
    {
        parts[1].to_string()
    } else {
        s.to_string()
    }
}
