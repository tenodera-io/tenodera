use async_trait::async_trait;
use serde_json::{json, Value};
use tokio::fs;

use crate::handler::ChannelHandler;
use tenodera_protocol::channel::ChannelOpenOptions;
use tenodera_protocol::message::Message;

pub struct HostConfigHandler;

#[async_trait]
impl ChannelHandler for HostConfigHandler {
    fn payload_type(&self) -> &str { "host.config" }

    async fn open(&self, channel: &str, _options: &ChannelOpenOptions) -> Vec<Message> {
        let data = read_host_config().await;
        vec![
            Message::Ready  { channel: channel.into() },
            Message::Data   { channel: channel.into(), data },
            Message::Close  { channel: channel.into(), problem: None },
        ]
    }
}

async fn read_host_config() -> Value {
    let hostname = fs::read_to_string("/etc/hostname")
        .await
        .unwrap_or_default()
        .trim()
        .to_string();

    let env_path = "/etc/tenodera/bridge.env";
    let content = match fs::read_to_string(env_path).await {
        Ok(c) => c,
        Err(_) => return json!({ "roles": [], "hostname": hostname }),
    };

    // Collect all `role=` values (supports multiple lines and comma/space separation)
    let mut roles: Vec<String> = content
        .lines()
        .filter_map(|line| {
            let line = line.trim();
            if line.starts_with('#') || line.is_empty() { return None; }
            let (key, val) = line.split_once('=')?;
            if key.trim().eq_ignore_ascii_case("role") {
                Some(val.trim().to_string())
            } else {
                None
            }
        })
        .flat_map(|val| {
            val.split([',', ' '])
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .collect::<Vec<_>>()
        })
        .collect();

    roles.dedup();

    json!({ "roles": roles, "hostname": hostname })
}
