use tenodera_protocol::channel::ChannelOpenOptions;
use tenodera_protocol::message::Message;

use crate::handler::ChannelHandler;

/// One-shot metrics snapshot handler.
///
/// Reads /proc twice with a 1-second sleep in between to compute
/// instantaneous CPU%, disk I/O rate, and network I/O rate.
/// Returns Ready → Data → Close immediately.
pub struct MetricsSnapshotHandler;

#[async_trait::async_trait]
impl ChannelHandler for MetricsSnapshotHandler {
    fn payload_type(&self) -> &str {
        "metrics.snapshot"
    }

    async fn open(&self, channel: &str, _options: &ChannelOpenOptions) -> Vec<Message> {
        let snapshot = collect_snapshot().await;

        vec![
            Message::Ready {
                channel: channel.to_string(),
            },
            Message::Data {
                channel: channel.to_string(),
                data: snapshot,
            },
            Message::Close {
                channel: channel.to_string(),
                problem: None,
            },
        ]
    }
}

async fn collect_snapshot() -> serde_json::Value {
    // ── First read ──
    let cpu1 = read_cpu_jiffies().await;
    let cores1 = read_core_jiffies().await;
    let disk1 = read_disk_sectors().await;
    let net1 = read_net_bytes().await;

    // ── Sleep 1 second ──
    tokio::time::sleep(std::time::Duration::from_secs(1)).await;

    // ── Second read ──
    let cpu2 = read_cpu_jiffies().await;
    let cores2 = read_core_jiffies().await;
    let disk2 = read_disk_sectors().await;
    let net2 = read_net_bytes().await;

    // ── Compute deltas ──
    let cpu = compute_cpu_pct(&cpu1, &cpu2);
    let cpu_cores = compute_cores_pct(&cores1, &cores2);
    let memory = read_memory_info().await;
    let swap = read_swap_info().await;
    let loadavg = read_loadavg().await;
    let disk_io = compute_disk_rate(&disk1, &disk2, 1.0);
    let net_io = compute_net_rate(&net1, &net2, 1.0);

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

// ── CPU aggregate ──────────────────────────────────────────

struct CpuJiffies {
    user: u64,
    nice: u64,
    system: u64,
    idle: u64,
}

async fn read_cpu_jiffies() -> CpuJiffies {
    let content = tokio::fs::read_to_string("/proc/stat").await.unwrap_or_default();
    if let Some(line) = content.lines().next() {
        let parts: Vec<&str> = line.split_whitespace().collect();
        if parts.len() >= 5 {
            return CpuJiffies {
                user: parts[1].parse().unwrap_or(0),
                nice: parts[2].parse().unwrap_or(0),
                system: parts[3].parse().unwrap_or(0),
                idle: parts[4].parse().unwrap_or(0),
            };
        }
    }
    CpuJiffies { user: 0, nice: 0, system: 0, idle: 0 }
}

fn compute_cpu_pct(a: &CpuJiffies, b: &CpuJiffies) -> serde_json::Value {
    let d_user = b.user.saturating_sub(a.user) + b.nice.saturating_sub(a.nice);
    let d_sys = b.system.saturating_sub(a.system);
    let d_idle = b.idle.saturating_sub(a.idle);
    let total = d_user + d_sys + d_idle;
    if total == 0 {
        return serde_json::json!({ "user_pct": 0, "system_pct": 0, "idle_pct": 100 });
    }
    serde_json::json!({
        "user_pct": ((d_user as f64 / total as f64) * 100.0).round() as u64,
        "system_pct": ((d_sys as f64 / total as f64) * 100.0).round() as u64,
        "idle_pct": ((d_idle as f64 / total as f64) * 100.0).round() as u64,
    })
}

// ── Per-core CPU ───────────────────────────────────────────

struct CoreJiffies {
    core: String,
    user: u64,
    system: u64,
    idle: u64,
}

async fn read_core_jiffies() -> Vec<CoreJiffies> {
    let content = tokio::fs::read_to_string("/proc/stat").await.unwrap_or_default();
    let mut cores = Vec::new();
    for line in content.lines() {
        if line.starts_with("cpu") && line.as_bytes().get(3).is_some_and(|b| b.is_ascii_digit()) {
            let parts: Vec<&str> = line.split_whitespace().collect();
            if parts.len() >= 5 {
                cores.push(CoreJiffies {
                    core: parts[0].to_string(),
                    user: parts[1].parse().unwrap_or(0),
                    system: parts[3].parse().unwrap_or(0),
                    idle: parts[4].parse().unwrap_or(0),
                });
            }
        }
    }
    cores
}

fn compute_cores_pct(a: &[CoreJiffies], b: &[CoreJiffies]) -> serde_json::Value {
    let mut results = Vec::new();
    for bc in b {
        if let Some(ac) = a.iter().find(|c| c.core == bc.core) {
            let du = bc.user.saturating_sub(ac.user);
            let ds = bc.system.saturating_sub(ac.system);
            let di = bc.idle.saturating_sub(ac.idle);
            let t = du + ds + di;
            let usage = if t > 0 { ((du + ds) as f64 / t as f64 * 100.0).round() as u64 } else { 0 };
            results.push(serde_json::json!({
                "core": bc.core,
                "usage_pct": usage,
            }));
        }
    }
    serde_json::json!(results)
}

// ── Memory ─────────────────────────────────────────────────

async fn read_memory_info() -> serde_json::Value {
    let content = tokio::fs::read_to_string("/proc/meminfo").await.unwrap_or_default();
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

// ── Swap ───────────────────────────────────────────────────

async fn read_swap_info() -> serde_json::Value {
    let content = tokio::fs::read_to_string("/proc/meminfo").await.unwrap_or_default();
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

// ── Load Average ───────────────────────────────────────────

async fn read_loadavg() -> serde_json::Value {
    let content = tokio::fs::read_to_string("/proc/loadavg").await.unwrap_or_default();
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

// ── Disk I/O ───────────────────────────────────────────────

struct DiskSectors {
    read: u64,
    write: u64,
}

async fn read_disk_sectors() -> DiskSectors {
    let content = tokio::fs::read_to_string("/proc/diskstats").await.unwrap_or_default();
    let mut read_sectors: u64 = 0;
    let mut write_sectors: u64 = 0;
    for line in content.lines() {
        let parts: Vec<&str> = line.split_whitespace().collect();
        if parts.len() < 14 { continue; }
        let name = parts[2];
        let is_disk = (name.starts_with("sd") && name.len() == 3)
            || (name.starts_with("nvme") && name.contains('n') && !name.contains('p'))
            || (name.starts_with("vd") && name.len() == 3);
        if !is_disk { continue; }
        read_sectors += parts[5].parse::<u64>().unwrap_or(0);
        write_sectors += parts[9].parse::<u64>().unwrap_or(0);
    }
    DiskSectors { read: read_sectors, write: write_sectors }
}

fn compute_disk_rate(a: &DiskSectors, b: &DiskSectors, dt: f64) -> serde_json::Value {
    let read_bytes = (b.read.saturating_sub(a.read) * 512) as f64 / dt;
    let write_bytes = (b.write.saturating_sub(a.write) * 512) as f64 / dt;
    serde_json::json!({
        "read_bytes_sec": read_bytes.round() as u64,
        "write_bytes_sec": write_bytes.round() as u64,
    })
}

// ── Network I/O ────────────────────────────────────────────

struct NetBytes {
    rx: u64,
    tx: u64,
}

async fn read_net_bytes() -> NetBytes {
    let content = tokio::fs::read_to_string("/proc/net/dev").await.unwrap_or_default();
    let mut rx: u64 = 0;
    let mut tx: u64 = 0;
    for line in content.lines().skip(2) {
        let line = line.trim();
        let Some((iface, rest)) = line.split_once(':') else { continue };
        let iface = iface.trim();
        if iface == "lo" { continue; }
        let vals: Vec<u64> = rest.split_whitespace()
            .filter_map(|v| v.parse().ok())
            .collect();
        if vals.len() >= 10 {
            rx += vals[0];
            tx += vals[8];
        }
    }
    NetBytes { rx, tx }
}

fn compute_net_rate(a: &NetBytes, b: &NetBytes, dt: f64) -> serde_json::Value {
    let rx_rate = b.rx.saturating_sub(a.rx) as f64 / dt;
    let tx_rate = b.tx.saturating_sub(a.tx) as f64 / dt;
    serde_json::json!({
        "rx_bytes_sec": rx_rate.round() as u64,
        "tx_bytes_sec": tx_rate.round() as u64,
    })
}
