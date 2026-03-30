use tenodera_protocol::channel::ChannelOpenOptions;
use tenodera_protocol::message::Message;

use crate::handler::ChannelHandler;

/// One-shot storage snapshot handler.
///
/// Reads /proc/diskstats twice with a 1-second sleep in between to compute
/// disk I/O rates.  Also runs `lsblk` once for block device info.
/// Returns Ready → Data → Close immediately.
pub struct StorageSnapshotHandler;

#[async_trait::async_trait]
impl ChannelHandler for StorageSnapshotHandler {
    fn payload_type(&self) -> &str {
        "storage.snapshot"
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
    let stats1 = read_diskstats().await;
    tokio::time::sleep(std::time::Duration::from_secs(1)).await;
    let stats2 = read_diskstats().await;

    let io = compute_io_rates(&stats1, &stats2, 1.0);
    let block_devices = get_block_devices().await;

    serde_json::json!({
        "timestamp": chrono::Utc::now().to_rfc3339(),
        "io": io,
        "block_devices": block_devices,
    })
}

// ── Disk stats ─────────────────────────────────────────────

#[derive(Clone)]
struct DiskStat {
    name: String,
    read_sectors: u64,
    write_sectors: u64,
}

async fn read_diskstats() -> Vec<DiskStat> {
    let content = match tokio::fs::read_to_string("/proc/diskstats").await {
        Ok(s) => s,
        Err(_) => return vec![],
    };

    let mut results = Vec::new();
    for line in content.lines() {
        let parts: Vec<&str> = line.split_whitespace().collect();
        if parts.len() < 14 {
            continue;
        }
        let name = parts[2].to_string();
        if name.starts_with("loop") || name.starts_with("dm-") || name.starts_with("ram") {
            continue;
        }

        let read_sectors = parts[5].parse::<u64>().unwrap_or(0);
        let write_sectors = parts[9].parse::<u64>().unwrap_or(0);
        results.push(DiskStat { name, read_sectors, write_sectors });
    }
    results
}

fn compute_io_rates(prev: &[DiskStat], curr: &[DiskStat], dt: f64) -> serde_json::Value {
    let mut total_read: u64 = 0;
    let mut total_write: u64 = 0;

    for c in curr {
        if let Some(p) = prev.iter().find(|p| p.name == c.name) {
            total_read += c.read_sectors.saturating_sub(p.read_sectors);
            total_write += c.write_sectors.saturating_sub(p.write_sectors);
        }
    }

    let read_bytes = (total_read * 512) as f64 / dt;
    let write_bytes = (total_write * 512) as f64 / dt;

    serde_json::json!({
        "read_bytes_sec": read_bytes.round() as u64,
        "write_bytes_sec": write_bytes.round() as u64,
    })
}

// ── Block devices via lsblk ────────────────────────────────

async fn get_block_devices() -> Vec<serde_json::Value> {
    // Try MOUNTPOINTS first (util-linux >= 2.37), fall back to MOUNTPOINT
    let (output, legacy) = match tokio::process::Command::new("lsblk")
        .args(["-J", "-b", "-o", "NAME,SIZE,TYPE,MOUNTPOINTS"])
        .output()
        .await
    {
        Ok(o) if o.status.success() => (o.stdout, false),
        _ => {
            match tokio::process::Command::new("lsblk")
                .args(["-J", "-b", "-o", "NAME,SIZE,TYPE,MOUNTPOINT"])
                .output()
                .await
            {
                Ok(o) if o.status.success() => (o.stdout, true),
                _ => return vec![],
            }
        }
    };

    let mut parsed: serde_json::Value = match serde_json::from_slice(&output) {
        Ok(v) => v,
        Err(_) => return vec![],
    };

    if legacy {
        normalize_mountpoints(&mut parsed);
    }

    let devices = match parsed.get("blockdevices").and_then(|v| v.as_array()) {
        Some(a) => a,
        None => return vec![],
    };

    devices.iter().map(enrich_device).collect()
}

/// Convert `"mountpoint": "..."` to `"mountpoints": [...]` recursively.
fn normalize_mountpoints(val: &mut serde_json::Value) {
    if let Some(obj) = val.as_object_mut() {
        if let Some(mp) = obj.remove("mountpoint") {
            let arr = match mp {
                serde_json::Value::String(s) if !s.is_empty() => serde_json::json!([s]),
                _ => serde_json::json!([]),
            };
            obj.insert("mountpoints".to_string(), arr);
        }
        if let Some(children) = obj.get_mut("children") {
            if let Some(arr) = children.as_array_mut() {
                for child in arr {
                    normalize_mountpoints(child);
                }
            }
        }
    }
    if let Some(arr) = val.get_mut("blockdevices").and_then(|v| v.as_array_mut()) {
        for dev in arr {
            normalize_mountpoints(dev);
        }
    }
}

fn enrich_device(dev: &serde_json::Value) -> serde_json::Value {
    let name = dev.get("name").and_then(|v| v.as_str()).unwrap_or("");
    let size = dev.get("size").and_then(|v| v.as_u64()).unwrap_or(0);
    let dtype = dev.get("type").and_then(|v| v.as_str()).unwrap_or("");
    let mountpoints: Vec<String> = dev
        .get("mountpoints")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|m| m.as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default();

    let (used, free, use_pct) = mountpoints
        .iter()
        .find(|m| !m.starts_with('['))
        .and_then(|mount| {
            let stat = unsafe {
                let mut buf: libc::statvfs = std::mem::zeroed();
                let path = std::ffi::CString::new(mount.as_str()).ok()?;
                if libc::statvfs(path.as_ptr(), &mut buf) != 0 {
                    return None;
                }
                buf
            };
            let bs = stat.f_frsize as u64;
            let total_fs = stat.f_blocks * bs;
            let free_fs = stat.f_bfree * bs;
            let used_fs = total_fs.saturating_sub(free_fs);
            let pct = if total_fs > 0 {
                ((used_fs as f64 / total_fs as f64) * 100.0).round() as u64
            } else {
                0
            };
            Some((used_fs, free_fs, pct))
        })
        .unwrap_or((0, 0, 0));

    let children = dev
        .get("children")
        .and_then(|v| v.as_array())
        .map(|arr| arr.iter().map(enrich_device).collect::<Vec<_>>());

    let mut obj = serde_json::json!({
        "name": name,
        "size": size,
        "type": dtype,
        "mountpoints": mountpoints,
        "used": used,
        "free": free,
        "use_pct": use_pct,
    });

    if let Some(ch) = children {
        obj.as_object_mut().unwrap().insert("children".to_string(), serde_json::json!(ch));
    }

    obj
}
