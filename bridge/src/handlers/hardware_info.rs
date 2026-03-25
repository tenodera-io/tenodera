use tenodera_protocol::channel::ChannelOpenOptions;
use tenodera_protocol::message::Message;

use crate::handler::ChannelHandler;

pub struct HardwareInfoHandler;

#[async_trait::async_trait]
impl ChannelHandler for HardwareInfoHandler {
    fn payload_type(&self) -> &str {
        "hardware.info"
    }

    async fn open(&self, channel: &str, _options: &ChannelOpenOptions) -> Vec<Message> {
        let cpu = get_cpu_info();
        let kernel = get_kernel_info();
        let temps = get_temperatures();

        let info = serde_json::json!({
            "cpu_model": cpu.0,
            "cpu_cores": cpu.1,
            "cpu_threads": cpu.2,
            "cpu_mhz": cpu.3,
            "architecture": kernel.0,
            "kernel": kernel.1,
            "temperatures": temps,
        });

        vec![
            Message::Ready { channel: channel.to_string() },
            Message::Data { channel: channel.to_string(), data: info },
            Message::Close { channel: channel.to_string(), problem: None },
        ]
    }
}

/// Returns (model_name, physical_cores, logical_threads, max_mhz)
fn get_cpu_info() -> (String, u32, u32, f64) {
    let content = std::fs::read_to_string("/proc/cpuinfo").unwrap_or_default();

    let mut model = String::new();
    let mut max_mhz: f64 = 0.0;
    let mut logical_count: u32 = 0;
    let mut physical_ids = std::collections::HashSet::new();
    let mut core_ids = std::collections::HashSet::new();

    let mut cur_physical_id = String::new();

    for line in content.lines() {
        if let Some((key, val)) = line.split_once(':') {
            let key = key.trim();
            let val = val.trim();
            match key {
                "model name" => {
                    if model.is_empty() {
                        model = val.to_string();
                    }
                }
                "cpu MHz" => {
                    if let Ok(mhz) = val.parse::<f64>()
                        && mhz > max_mhz { max_mhz = mhz; }
                }
                "processor" => {
                    logical_count += 1;
                }
                "physical id" => {
                    cur_physical_id = val.to_string();
                    physical_ids.insert(val.to_string());
                }
                "core id" => {
                    core_ids.insert(format!("{}:{}", cur_physical_id, val));
                }
                _ => {}
            }
        }
    }

    let physical_cores = if core_ids.is_empty() { logical_count } else { core_ids.len() as u32 };

    (model, physical_cores, logical_count, max_mhz)
}

/// Returns (architecture, kernel_version)
fn get_kernel_info() -> (String, String) {
    let uname = nix::sys::utsname::uname();
    match uname {
        Ok(u) => (
            u.machine().to_string_lossy().to_string(),
            u.release().to_string_lossy().to_string(),
        ),
        Err(_) => ("unknown".into(), "unknown".into()),
    }
}

/// Read temperature sensors from /sys/class/hwmon/
fn get_temperatures() -> Vec<serde_json::Value> {
    let mut temps = Vec::new();
    let Ok(entries) = std::fs::read_dir("/sys/class/hwmon") else { return temps };

    for entry in entries.flatten() {
        let hwmon = entry.path();
        let name = std::fs::read_to_string(hwmon.join("name"))
            .map(|s| s.trim().to_string())
            .unwrap_or_default();

        // Look for temp*_input files
        for i in 1..=20 {
            let input_path = hwmon.join(format!("temp{i}_input"));
            let Ok(raw) = std::fs::read_to_string(&input_path) else { continue };
            let Ok(millideg) = raw.trim().parse::<i64>() else { continue };
            let temp_c = millideg as f64 / 1000.0;

            let label = std::fs::read_to_string(hwmon.join(format!("temp{i}_label")))
                .map(|s| s.trim().to_string())
                .unwrap_or_else(|_| format!("{name} #{i}"));

            let crit = std::fs::read_to_string(hwmon.join(format!("temp{i}_crit")))
                .ok()
                .and_then(|s| s.trim().parse::<i64>().ok())
                .map(|m| m as f64 / 1000.0);

            temps.push(serde_json::json!({
                "label": label,
                "sensor": name,
                "temp_c": temp_c,
                "crit_c": crit,
            }));
        }
    }

    temps
}
