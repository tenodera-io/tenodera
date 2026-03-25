use tenodera_protocol::channel::ChannelOpenOptions;
use tenodera_protocol::message::Message;

use crate::handler::ChannelHandler;

pub struct TopProcessesHandler;

#[async_trait::async_trait]
impl ChannelHandler for TopProcessesHandler {
    fn payload_type(&self) -> &str {
        "top.processes"
    }

    async fn open(&self, channel: &str, _options: &ChannelOpenOptions) -> Vec<Message> {
        let procs = get_top_processes();

        vec![
            Message::Ready { channel: channel.to_string() },
            Message::Data {
                channel: channel.to_string(),
                data: serde_json::json!({ "processes": procs }),
            },
            Message::Close { channel: channel.to_string(), problem: None },
        ]
    }
}

fn get_top_processes() -> Vec<serde_json::Value> {
    // Use ps to get top processes sorted by CPU, then enrich with memory-sorted ones
    let output = std::process::Command::new("ps")
        .args(["--no-headers", "-eo", "pid,user,%cpu,%mem,rss,comm", "--sort=-%cpu"])
        .output();

    let Ok(output) = output else { return vec![] };
    if !output.status.success() { return vec![]; }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut procs: Vec<serde_json::Value> = Vec::new();

    for line in stdout.lines().take(15) {
        let parts: Vec<&str> = line.split_whitespace().collect();
        if parts.len() < 6 { continue; }

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
