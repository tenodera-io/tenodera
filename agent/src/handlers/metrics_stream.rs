use tenodera_protocol::channel::{ChannelId, ChannelOpenOptions};
use tenodera_protocol::message::Message;
use tokio::sync::{mpsc, watch};

use crate::handler::ChannelHandler;

pub struct MetricsStreamHandler;

#[async_trait::async_trait]
impl ChannelHandler for MetricsStreamHandler {
    fn payload_type(&self) -> &str {
        "metrics.stream"
    }

    fn is_streaming(&self) -> bool {
        true
    }

    async fn open(&self, channel: &str, _options: &ChannelOpenOptions) -> Vec<Message> {
        vec![Message::Ready {
            channel: channel.into(),
        }]
    }

    async fn stream(
        &self,
        channel: &str,
        options: &ChannelOpenOptions,
        tx: mpsc::Sender<Message>,
        mut shutdown: watch::Receiver<bool>,
    ) {
        let interval_ms = options
            .extra
            .get("interval")
            .and_then(|v| v.as_u64())
            .unwrap_or(1000)
            .max(500);

        let channel: ChannelId = channel.into();
        let mut ticker = tokio::time::interval(std::time::Duration::from_millis(interval_ms));

        loop {
            tokio::select! {
                _ = ticker.tick() => {
                    let metrics = collect_metrics().await;
                    if tx.send(Message::Data {
                        channel: channel.clone(),
                        data: metrics,
                    }).await.is_err() {
                        break;
                    }
                }
                _ = shutdown.changed() => {
                    if *shutdown.borrow() {
                        break;
                    }
                }
            }
        }

        let _ = tx
            .send(Message::Close {
                channel,
                problem: None,
            })
            .await;
    }
}

async fn collect_metrics() -> serde_json::Value {
    let cpu = read_cpu_usage().await;
    let cpu_cores = read_cpu_cores().await;
    let memory = read_memory_info().await;
    let swap = read_swap_info().await;
    let loadavg = read_loadavg().await;
    let disk_io = read_disk_io().await;
    let net_io = read_net_io().await;

    serde_json::json!({
        "timestamp": chrono::Utc::now().to_rfc3339(),
        "cpu": cpu,
        "cpu_cores": cpu_cores,
        "memory": memory,
        "swap": swap,
        "loadavg": loadavg,
        "disk_io": disk_io,
        "net_io": net_io,
    })
}

async fn read_cpu_usage() -> serde_json::Value {
    match tokio::fs::read_to_string("/proc/stat").await {
        Ok(content) => {
            if let Some(line) = content.lines().next() {
                let parts: Vec<&str> = line.split_whitespace().collect();
                if parts.len() >= 5 {
                    return serde_json::json!({
                        "user": parts[1].parse::<u64>().unwrap_or(0),
                        "nice": parts[2].parse::<u64>().unwrap_or(0),
                        "system": parts[3].parse::<u64>().unwrap_or(0),
                        "idle": parts[4].parse::<u64>().unwrap_or(0),
                    });
                }
            }
            serde_json::Value::Null
        }
        Err(_) => serde_json::Value::Null,
    }
}

async fn read_memory_info() -> serde_json::Value {
    match tokio::fs::read_to_string("/proc/meminfo").await {
        Ok(content) => {
            let mut map = serde_json::Map::new();
            for line in content.lines().take(5) {
                if let Some((key, val)) = line.split_once(':') {
                    let val = val.trim().replace(" kB", "");
                    if let Ok(num) = val.parse::<u64>() {
                        map.insert(
                            key.trim().to_lowercase().replace(' ', "_"),
                            serde_json::json!(num),
                        );
                    }
                }
            }
            serde_json::Value::Object(map)
        }
        Err(_) => serde_json::Value::Null,
    }
}

async fn read_loadavg() -> serde_json::Value {
    match tokio::fs::read_to_string("/proc/loadavg").await {
        Ok(content) => {
            let parts: Vec<&str> = content.split_whitespace().collect();
            if parts.len() >= 3 {
                serde_json::json!({
                    "1min": parts[0].parse::<f64>().unwrap_or(0.0),
                    "5min": parts[1].parse::<f64>().unwrap_or(0.0),
                    "15min": parts[2].parse::<f64>().unwrap_or(0.0),
                })
            } else {
                serde_json::Value::Null
            }
        }
        Err(_) => serde_json::Value::Null,
    }
}

/// Read per-core CPU jiffies from /proc/stat (cpu0, cpu1, …)
async fn read_cpu_cores() -> serde_json::Value {
    match tokio::fs::read_to_string("/proc/stat").await {
        Ok(content) => {
            let mut cores = Vec::new();
            for line in content.lines() {
                // Match "cpu0 …", "cpu1 …", etc but not the aggregate "cpu " line
                if line.starts_with("cpu") && line.as_bytes().get(3).is_some_and(|b| b.is_ascii_digit()) {
                    let parts: Vec<&str> = line.split_whitespace().collect();
                    if parts.len() >= 5 {
                        cores.push(serde_json::json!({
                            "core": parts[0],
                            "user": parts[1].parse::<u64>().unwrap_or(0),
                            "system": parts[3].parse::<u64>().unwrap_or(0),
                            "idle": parts[4].parse::<u64>().unwrap_or(0),
                        }));
                    }
                }
            }
            serde_json::json!(cores)
        }
        Err(_) => serde_json::Value::Null,
    }
}

/// Read swap info from /proc/meminfo
async fn read_swap_info() -> serde_json::Value {
    match tokio::fs::read_to_string("/proc/meminfo").await {
        Ok(content) => {
            let mut total: u64 = 0;
            let mut free: u64 = 0;
            for line in content.lines() {
                if let Some(rest) = line.strip_prefix("SwapTotal:") {
                    total = rest.trim().replace(" kB", "").parse().unwrap_or(0);
                } else if let Some(rest) = line.strip_prefix("SwapFree:") {
                    free = rest.trim().replace(" kB", "").parse().unwrap_or(0);
                }
            }
            serde_json::json!({
                "total": total,
                "free": free,
                "used": total.saturating_sub(free),
            })
        }
        Err(_) => serde_json::Value::Null,
    }
}

/// Read cumulative disk I/O from /proc/diskstats
async fn read_disk_io() -> serde_json::Value {
    match tokio::fs::read_to_string("/proc/diskstats").await {
        Ok(content) => {
            let mut read_sectors: u64 = 0;
            let mut write_sectors: u64 = 0;
            for line in content.lines() {
                let parts: Vec<&str> = line.split_whitespace().collect();
                if parts.len() < 14 { continue; }
                let name = parts[2];
                // Only count whole-disk devices (sdX, nvmeXnY, vdX), skip partitions
                let is_disk = (name.starts_with("sd") && name.len() == 3)
                    || (name.starts_with("nvme") && name.contains('n') && !name.contains('p'))
                    || (name.starts_with("vd") && name.len() == 3);
                if !is_disk { continue; }
                // Field 6 = sectors read, field 10 = sectors written (0-indexed from name)
                read_sectors += parts[5].parse::<u64>().unwrap_or(0);
                write_sectors += parts[9].parse::<u64>().unwrap_or(0);
            }
            // Sectors are typically 512 bytes
            serde_json::json!({
                "read_bytes": read_sectors * 512,
                "write_bytes": write_sectors * 512,
            })
        }
        Err(_) => serde_json::Value::Null,
    }
}

/// Read cumulative network I/O from /proc/net/dev (all non-lo interfaces)
async fn read_net_io() -> serde_json::Value {
    match tokio::fs::read_to_string("/proc/net/dev").await {
        Ok(content) => {
            let mut rx_bytes: u64 = 0;
            let mut tx_bytes: u64 = 0;
            for line in content.lines().skip(2) {
                let line = line.trim();
                let Some((iface, rest)) = line.split_once(':') else { continue };
                let iface = iface.trim();
                if iface == "lo" { continue; }
                let vals: Vec<u64> = rest.split_whitespace()
                    .filter_map(|v| v.parse().ok())
                    .collect();
                if vals.len() >= 10 {
                    rx_bytes += vals[0];
                    tx_bytes += vals[8];
                }
            }
            serde_json::json!({
                "rx_bytes": rx_bytes,
                "tx_bytes": tx_bytes,
            })
        }
        Err(_) => serde_json::Value::Null,
    }
}
