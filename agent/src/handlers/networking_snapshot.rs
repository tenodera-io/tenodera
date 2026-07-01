use tenodera_protocol::channel::ChannelOpenOptions;
use tenodera_protocol::message::Message;

use crate::handler::ChannelHandler;

/// One-shot networking snapshot handler.
///
/// Reads /proc/net/dev twice with a 1-second sleep in between to compute
/// per-interface TX/RX rates (bytes/sec).
/// Returns Ready → Data → Close immediately.
pub struct NetworkingSnapshotHandler;

#[async_trait::async_trait]
impl ChannelHandler for NetworkingSnapshotHandler {
    fn payload_type(&self) -> &str {
        "networking.snapshot"
    }

    async fn open(&self, channel: &str, _options: &ChannelOpenOptions) -> Vec<Message> {
        let snapshot = collect_snapshot().await;

        vec![
            Message::Ready {
                channel: channel.into(),
            },
            Message::Data {
                channel: channel.into(),
                data: snapshot,
            },
            Message::Close {
                channel: channel.into(),
                problem: None,
            },
        ]
    }
}

async fn collect_snapshot() -> serde_json::Value {
    let prev = read_proc_net_dev().await;
    tokio::time::sleep(std::time::Duration::from_secs(1)).await;
    let cur = read_proc_net_dev().await;

    let mut ifaces = Vec::new();
    for (name, (rx, tx)) in &cur {
        if let Some((prx, ptx)) = prev.get(name) {
            let rx_rate = rx.saturating_sub(*prx) as f64;
            let tx_rate = tx.saturating_sub(*ptx) as f64;
            ifaces.push(serde_json::json!({
                "name": name,
                "rx_bps": rx_rate,
                "tx_bps": tx_rate,
            }));
        }
    }

    serde_json::json!({
        "timestamp": chrono::Utc::now().to_rfc3339(),
        "interfaces": ifaces,
    })
}

async fn read_proc_net_dev() -> std::collections::HashMap<String, (u64, u64)> {
    let mut map = std::collections::HashMap::new();
    let Ok(content) = tokio::fs::read_to_string("/proc/net/dev").await else {
        return map;
    };
    for line in content.lines().skip(2) {
        let line = line.trim();
        let Some((iface, rest)) = line.split_once(':') else { continue };
        let iface = iface.trim();
        if iface == "lo" {
            continue;
        }
        let vals: Vec<u64> = rest.split_whitespace().filter_map(|v| v.parse().ok()).collect();
        if vals.len() >= 10 {
            map.insert(iface.to_string(), (vals[0], vals[8]));
        }
    }
    map
}
