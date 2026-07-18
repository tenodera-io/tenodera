use tenodera_protocol::channel::ChannelOpenOptions;
use tenodera_protocol::message::Message;

use crate::handler::ChannelHandler;
use crate::util::{UserReadOutcome, is_valid_username, run_cmd_as_user, sudo_as_user};

pub struct TopProcessesHandler;

/// `ps` fields we surface. Run AS the logged-in user so `hidepid` on /proc (when the
/// host sets it) hides other users' processes — same as their own shell session.
const PS_ARGS: &[&str] = &[
    "ps",
    "--no-headers",
    "-eo",
    "pid,user,%cpu,%mem,rss,comm",
    "--sort=-%cpu",
];

#[async_trait::async_trait]
impl ChannelHandler for TopProcessesHandler {
    fn payload_type(&self) -> &str {
        "top.processes"
    }

    async fn open(&self, channel: &str, options: &ChannelOpenOptions) -> Vec<Message> {
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

        let data = get_top_processes(user, password).await;

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

async fn get_top_processes(user: &str, password: &str) -> serde_json::Value {
    if !is_valid_username(user) {
        return serde_json::json!({ "processes": [], "error": "no session user" });
    }

    // Superuser mode: `sudo ps` AS the user (host sudoers decides) → sees everything.
    if !password.is_empty() {
        let res = sudo_as_user(user, password, PS_ARGS).await;
        return match res.get("output").and_then(|v| v.as_str()) {
            Some(out) => serde_json::json!({ "processes": parse_ps(out) }),
            None => serde_json::json!({
                "processes": [],
                "error": res.get("error").and_then(|v| v.as_str()).unwrap_or("command failed")
            }),
        };
    }

    // Default: run `ps` AS the user — the host (hidepid) decides what they see.
    match run_cmd_as_user(user, PS_ARGS).await {
        UserReadOutcome::NoAccount => {
            serde_json::json!({ "processes": [], "restricted": true, "reason": "no-account" })
        }
        UserReadOutcome::SpawnFailed(e) => {
            tracing::error!(error = %e, "failed to run ps as user");
            serde_json::json!({ "processes": [], "error": e })
        }
        UserReadOutcome::Ran(out) => {
            let stdout = String::from_utf8_lossy(&out.stdout);
            let procs = parse_ps(&stdout);
            if out.status.success() {
                serde_json::json!({ "processes": procs })
            } else {
                let stderr = String::from_utf8_lossy(&out.stderr);
                tracing::warn!(stderr = %stderr, "ps error");
                serde_json::json!({ "processes": procs, "error": stderr.trim() })
            }
        }
    }
}

/// Parse `ps --no-headers -eo pid,user,%cpu,%mem,rss,comm` output (top 15 rows).
fn parse_ps(stdout: &str) -> Vec<serde_json::Value> {
    let mut procs: Vec<serde_json::Value> = Vec::new();

    for line in stdout.lines().take(15) {
        let parts: Vec<&str> = line.split_whitespace().collect();
        if parts.len() < 6 {
            continue;
        }

        let pid = parts[0].parse::<u32>().unwrap_or(0);
        let user = parts[1];
        let cpu_pct = parts[2].parse::<f64>().unwrap_or(0.0);
        let mem_pct = parts[3].parse::<f64>().unwrap_or(0.0);
        let rss_kb = parts[4].parse::<u64>().unwrap_or(0);
        // Command might contain spaces — join remaining parts
        let comm = parts[5..].join(" ");

        procs.push(serde_json::json!({
            "pid": pid,
            "user": user,
            "cpu_pct": cpu_pct,
            "mem_pct": mem_pct,
            "rss_kb": rss_kb,
            "command": comm,
        }));
    }

    procs
}
