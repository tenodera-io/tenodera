use tenodera_protocol::channel::ChannelOpenOptions;
use tenodera_protocol::message::Message;

use crate::handler::ChannelHandler;

pub struct NetworkStatsHandler;

#[async_trait::async_trait]
impl ChannelHandler for NetworkStatsHandler {
    fn payload_type(&self) -> &str {
        "network.stats"
    }

    async fn open(&self, channel: &str, _options: &ChannelOpenOptions) -> Vec<Message> {
        let interfaces = get_network_stats();

        vec![
            Message::Ready {
                channel: channel.to_string(),
            },
            Message::Data {
                channel: channel.to_string(),
                data: serde_json::json!({ "interfaces": interfaces }),
            },
            Message::Close {
                channel: channel.to_string(),
                problem: None,
            },
        ]
    }
}

fn get_network_stats() -> Vec<serde_json::Value> {
    // Parse /proc/net/dev
    let content = match std::fs::read_to_string("/proc/net/dev") {
        Ok(s) => s,
        Err(_) => return vec![],
    };

    let mut results = Vec::new();

    for line in content.lines().skip(2) {
        // Format: "  iface: rx_bytes rx_packets ... tx_bytes tx_packets ..."
        let line = line.trim();
        let Some((iface, rest)) = line.split_once(':') else {
            continue;
        };

        let iface = iface.trim();

        // Skip loopback
        if iface == "lo" {
            continue;
        }

        let values: Vec<u64> = rest
            .split_whitespace()
            .filter_map(|v| v.parse().ok())
            .collect();

        if values.len() < 10 {
            continue;
        }

        // /proc/net/dev columns:
        // RX: bytes packets errs drop fifo frame compressed multicast
        // TX: bytes packets errs drop fifo colls carrier compressed
        let rx_bytes = values[0];
        let rx_packets = values[1];
        let rx_errors = values[2];
        let tx_bytes = values[8];
        let tx_packets = values[9];
        let tx_errors = values[10];

        // Try to get interface state from /sys/class/net/<iface>/operstate
        let state = std::fs::read_to_string(format!("/sys/class/net/{iface}/operstate"))
            .map(|s| s.trim().to_string())
            .unwrap_or_else(|_| "unknown".to_string());

        // Try to get MAC address
        let mac = std::fs::read_to_string(format!("/sys/class/net/{iface}/address"))
            .map(|s| s.trim().to_string())
            .unwrap_or_default();

        // Try to get speed (Mbps)
        let speed: Option<u64> =
            std::fs::read_to_string(format!("/sys/class/net/{iface}/speed"))
                .ok()
                .and_then(|s| s.trim().parse().ok());

        // Get IP addresses via `ip -j addr show <iface>`
        let (ipv4_addrs, ipv6_addrs) = get_ip_addresses(iface);

        results.push(serde_json::json!({
            "name": iface,
            "state": state,
            "mac": mac,
            "speed_mbps": speed,
            "ipv4": ipv4_addrs,
            "ipv6": ipv6_addrs,
            "rx_bytes": rx_bytes,
            "rx_packets": rx_packets,
            "rx_errors": rx_errors,
            "tx_bytes": tx_bytes,
            "tx_packets": tx_packets,
            "tx_errors": tx_errors,
        }));
    }

    results
}

/// Parse `ip -j addr show <iface>` to extract IPv4 and IPv6 addresses with prefix length.
fn get_ip_addresses(iface: &str) -> (Vec<String>, Vec<String>) {
    let output = match std::process::Command::new("ip")
        .args(["-j", "addr", "show", iface])
        .output()
    {
        Ok(o) if o.status.success() => o.stdout,
        _ => return (vec![], vec![]),
    };

    let parsed: Vec<serde_json::Value> = match serde_json::from_slice(&output) {
        Ok(v) => v,
        Err(_) => return (vec![], vec![]),
    };

    let mut ipv4 = Vec::new();
    let mut ipv6 = Vec::new();

    for entry in &parsed {
        let Some(addrs) = entry.get("addr_info").and_then(|a| a.as_array()) else {
            continue;
        };
        for ai in addrs {
            let family = ai.get("family").and_then(|f| f.as_str()).unwrap_or("");
            let local = ai.get("local").and_then(|l| l.as_str()).unwrap_or("");
            let prefix = ai.get("prefixlen").and_then(|p| p.as_u64()).unwrap_or(0);
            if local.is_empty() {
                continue;
            }
            let addr_str = format!("{local}/{prefix}");
            match family {
                "inet" => ipv4.push(addr_str),
                "inet6" => ipv6.push(addr_str),
                _ => {}
            }
        }
    }

    (ipv4, ipv6)
}
