use tenodera_protocol::channel::ChannelOpenOptions;
use tenodera_protocol::message::Message;

use crate::handler::ChannelHandler;

pub struct SystemInfoHandler;

#[async_trait::async_trait]
impl ChannelHandler for SystemInfoHandler {
    fn payload_type(&self) -> &str {
        "system.info"
    }

    async fn open(&self, channel: &str, _options: &ChannelOpenOptions) -> Vec<Message> {
        let hostname = get_hostname();
        let os_release = get_os_release();
        let (uptime_secs, boot_time) = get_uptime();

        let info = serde_json::json!({
            "hostname": hostname,
            "os": os_release,
            "uptime_secs": uptime_secs,
            "boot_time": boot_time,
        });

        vec![
            Message::Ready {
                channel: channel.to_string(),
            },
            Message::Data {
                channel: channel.to_string(),
                data: info,
            },
            Message::Close {
                channel: channel.to_string(),
                problem: None,
            },
        ]
    }
}

fn get_hostname() -> String {
    nix::unistd::gethostname()
        .ok()
        .and_then(|h: std::ffi::OsString| h.into_string().ok())
        .unwrap_or_else(|| "unknown".into())
}

fn get_uptime() -> (u64, String) {
    let uptime_secs = std::fs::read_to_string("/proc/uptime")
        .ok()
        .and_then(|s| s.split_whitespace().next().and_then(|v| v.parse::<f64>().ok()))
        .map(|f| f as u64)
        .unwrap_or(0);

    // Boot time = now - uptime
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let boot_epoch = now.saturating_sub(uptime_secs);

    // Format as ISO-ish local string via date command
    let boot_time = std::process::Command::new("date")
        .args(["-d", &format!("@{boot_epoch}"), "+%Y-%m-%d %H:%M:%S"])
        .output()
        .ok()
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .map(|s| s.trim().to_string())
        .unwrap_or_default();

    (uptime_secs, boot_time)
}

fn get_os_release() -> serde_json::Value {
    let content = std::fs::read_to_string("/etc/os-release").unwrap_or_default();
    let mut map = serde_json::Map::new();
    for line in content.lines() {
        if let Some((key, val)) = line.split_once('=') {
            let val = val.trim_matches('"');
            map.insert(key.to_lowercase().to_string(), serde_json::Value::String(val.to_string()));
        }
    }
    serde_json::Value::Object(map)
}
