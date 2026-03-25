use tenodera_protocol::channel::ChannelOpenOptions;
use tenodera_protocol::message::Message;

use crate::handler::ChannelHandler;

pub struct DiskUsageHandler;

#[async_trait::async_trait]
impl ChannelHandler for DiskUsageHandler {
    fn payload_type(&self) -> &str {
        "disk.usage"
    }

    async fn open(&self, channel: &str, _options: &ChannelOpenOptions) -> Vec<Message> {
        let partitions = get_disk_usage();

        vec![
            Message::Ready {
                channel: channel.to_string(),
            },
            Message::Data {
                channel: channel.to_string(),
                data: serde_json::json!({ "partitions": partitions }),
            },
            Message::Close {
                channel: channel.to_string(),
                problem: None,
            },
        ]
    }
}

fn get_disk_usage() -> Vec<serde_json::Value> {
    // Read /proc/mounts and statvfs each mount point
    let mounts = match std::fs::read_to_string("/proc/mounts") {
        Ok(s) => s,
        Err(_) => return vec![],
    };

    let mut seen = std::collections::HashSet::new();
    let mut results = Vec::new();

    for line in mounts.lines() {
        let fields: Vec<&str> = line.split_whitespace().collect();
        if fields.len() < 3 {
            continue;
        }

        let device = fields[0];
        let mount = fields[1];
        let fstype = fields[2];

        // Skip pseudo/virtual filesystems
        if !device.starts_with('/') {
            continue;
        }
        // Skip duplicates (same device mounted multiple times)
        if !seen.insert(device.to_string()) {
            continue;
        }
        // Skip snap/loop mounts
        if device.contains("/loop") || mount.starts_with("/snap/") {
            continue;
        }

        let stat = unsafe {
            let mut buf: libc::statvfs = std::mem::zeroed();
            let path = std::ffi::CString::new(mount).unwrap_or_default();
            if libc::statvfs(path.as_ptr(), &mut buf) != 0 {
                continue;
            }
            buf
        };

        let block_size = stat.f_frsize as u64;
        let total = stat.f_blocks * block_size;
        let free = stat.f_bfree * block_size;
        let avail = stat.f_bavail * block_size;
        let used = total.saturating_sub(free);

        if total == 0 {
            continue;
        }

        results.push(serde_json::json!({
            "device": device,
            "mount": mount,
            "fstype": fstype,
            "total": total,
            "used": used,
            "free": free,
            "avail": avail,
            "use_pct": ((used as f64 / total as f64) * 100.0).round() as u64,
        }));
    }

    results
}
