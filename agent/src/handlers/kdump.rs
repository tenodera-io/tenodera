use tenodera_protocol::channel::ChannelOpenOptions;
use tenodera_protocol::message::Message;

use crate::handler::ChannelHandler;
use crate::util::{
    UserReadOutcome, is_valid_username, require_admin, run_cmd_as_user, sudo_as_user,
    sudo_stdin_write_as_user,
};

pub struct KdumpInfoHandler;

#[async_trait::async_trait]
impl ChannelHandler for KdumpInfoHandler {
    fn payload_type(&self) -> &str {
        "kdump.info"
    }

    // One-shot. With no `action` → full status/dumps info. With `action` (read_dump /
    // read_dmesg + path) → that dump's content. Dump CONTENT is kernel memory, so it is
    // brokered: read AS the logged-in user (or via `sudo` in superuser mode). The dump
    // listing itself (existence / filenames) stays at agent privilege — low-sensitivity
    // metadata. Handling actions here (not in `data()`) keeps every request one-shot.
    async fn open(&self, channel: &str, options: &ChannelOpenOptions) -> Vec<Message> {
        let user = options
            .extra
            .get("_user")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        let password = options
            .extra
            .get("password")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        let action = options.extra.get("action").and_then(|a| a.as_str());
        let path = options
            .extra
            .get("path")
            .and_then(|p| p.as_str())
            .unwrap_or("");

        let data = match action {
            Some("read_dump") => read_dump_details(path, user, password).await,
            Some("read_dmesg") => read_dmesg_log(path, user, password).await,
            // Write: change a kdump-tools setting (admin + superuser).
            Some("set_config") => {
                match require_admin(&serde_json::Value::Object(options.extra.clone())) {
                    Some(err) => err,
                    None => kdump_set_config(&options.extra, user, password).await,
                }
            }
            _ => {
                let status = collect_kdump_status().await;
                let dumps = list_crash_dumps().await;
                let config = read_kdump_config().await;
                let crashkernel = read_crashkernel_param().await;
                serde_json::json!({
                    "status": status,
                    "crashkernel": crashkernel,
                    "config": config,
                    "dumps": dumps,
                })
            }
        };

        vec![
            Message::Ready {
                channel: channel.into(),
            },
            Message::Data {
                channel: channel.into(),
                data,
            },
            Message::Close {
                channel: channel.into(),
                problem: None,
            },
        ]
    }
}

/// Read up to 64 KiB of a dump file brokered to `user`: `head -c` AS the user (their
/// own permissions decide), or via `sudo` as them in superuser mode. `None` = can't
/// read (no access / no such file).
async fn kdump_read_capped(user: &str, password: &str, path: &str) -> Option<String> {
    let args = ["head", "-c", "65536", "--", path];
    if !password.is_empty() {
        let res = sudo_as_user(user, password, &args).await;
        res.get("output")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
    } else if is_valid_username(user) {
        match run_cmd_as_user(user, &args).await {
            UserReadOutcome::Ran(out) if out.status.success() => {
                Some(String::from_utf8_lossy(&out.stdout).to_string())
            }
            _ => None,
        }
    } else {
        None
    }
}

async fn collect_kdump_status() -> serde_json::Value {
    let kdump_tools_installed = tokio::fs::metadata("/usr/sbin/kdump-config").await.is_ok();
    let kexec_tools_installed = tokio::fs::metadata("/usr/sbin/makedumpfile").await.is_ok()
        || tokio::fs::metadata("/usr/bin/makedumpfile").await.is_ok();

    let service_name = if kdump_tools_installed {
        "kdump-tools"
    } else {
        "kdump"
    };
    let service_active = check_service_active(service_name).await;
    let service_enabled = check_service_enabled(service_name).await;

    let crash_loaded = tokio::fs::read_to_string("/sys/kernel/kexec_crash_loaded")
        .await
        .ok()
        .map(|s| s.trim() == "1")
        .unwrap_or(false);

    let crash_size = tokio::fs::read_to_string("/sys/kernel/kexec_crash_size")
        .await
        .ok()
        .and_then(|s| s.trim().parse::<u64>().ok())
        .unwrap_or(0);

    let kernel_version = tokio::fs::read_to_string("/proc/version")
        .await
        .ok()
        .and_then(|s| s.split_whitespace().nth(2).map(String::from))
        .unwrap_or_default();

    serde_json::json!({
        "installed": kdump_tools_installed || kexec_tools_installed,
        "service_name": service_name,
        "service_active": service_active,
        "service_enabled": service_enabled,
        "crash_kernel_loaded": crash_loaded,
        "crash_kernel_reserved_bytes": crash_size,
        "kernel_version": kernel_version,
        "kdump_tools": kdump_tools_installed,
        "kexec_tools": kexec_tools_installed,
    })
}

async fn check_service_active(name: &str) -> String {
    tokio::process::Command::new("systemctl")
        .args(["is-active", name])
        .output()
        .await
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap_or_else(|_| "unknown".into())
}

async fn check_service_enabled(name: &str) -> String {
    tokio::process::Command::new("systemctl")
        .args(["is-enabled", name])
        .output()
        .await
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap_or_else(|_| "unknown".into())
}

async fn read_crashkernel_param() -> serde_json::Value {
    let cmdline = tokio::fs::read_to_string("/proc/cmdline")
        .await
        .unwrap_or_default();
    let param = cmdline
        .split_whitespace()
        .find(|s| s.starts_with("crashkernel="))
        .map(|s| s.strip_prefix("crashkernel=").unwrap_or(s))
        .unwrap_or("");

    serde_json::json!({
        "param": param,
        "configured": !param.is_empty(),
    })
}

/// The editable kdump config on this host: (path, conf_format, service).
/// - Debian `kdump-tools`: `/etc/default/kdump-tools`, shell `KEY=value`.
/// - Fedora/RHEL `kdump`: `/etc/kdump.conf`, space-separated `key value`.
async fn kdump_config_target() -> Option<(&'static str, bool, &'static str)> {
    if tokio::fs::metadata("/etc/default/kdump-tools")
        .await
        .is_ok()
    {
        Some(("/etc/default/kdump-tools", false, "kdump-tools"))
    } else if tokio::fs::metadata("/etc/kdump.conf").await.is_ok() {
        Some(("/etc/kdump.conf", true, "kdump"))
    } else {
        None
    }
}

async fn read_kdump_config() -> serde_json::Value {
    if let Some((path, conf_format, _)) = kdump_config_target().await
        && let Ok(content) = tokio::fs::read_to_string(path).await
    {
        return serde_json::json!({
            "path": path,
            "content": content,
            "settings": parse_kdump_settings(&content, conf_format),
            "editable": true,
        });
    }
    // Legacy read-only fallback (older RHEL layout).
    if let Ok(content) = tokio::fs::read_to_string("/etc/kdump/kdump.conf").await {
        return serde_json::json!({
            "path": "/etc/kdump/kdump.conf",
            "content": content,
            "settings": parse_kdump_settings(&content, true),
            "editable": false,
        });
    }
    serde_json::json!({ "path": null, "content": null, "settings": [], "editable": false })
}

/// Parse config lines into a settings list. `conf_format` = space-separated
/// `key value` (Fedora `/etc/kdump.conf`); otherwise shell `KEY=value` (Debian).
fn parse_kdump_settings(content: &str, conf_format: bool) -> Vec<serde_json::Value> {
    let mut out = Vec::new();
    for line in content.lines() {
        let t = line.trim();
        if t.is_empty() || t.starts_with('#') {
            continue;
        }
        let (key, value) = if conf_format {
            match t.split_once(char::is_whitespace) {
                Some((k, v)) => (k.trim(), v.trim()),
                None => (t, ""),
            }
        } else {
            match t.split_once('=') {
                Some((k, v)) => (k.trim(), v.trim().trim_matches('"')),
                None => continue,
            }
        };
        if is_kdump_key(key) {
            out.push(serde_json::json!({ "key": key, "value": value }));
        }
    }
    out
}

fn is_kdump_key(key: &str) -> bool {
    !key.is_empty() && key.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// Set one kdump-tools setting: upsert `KEY=value` in /etc/default/kdump-tools (written
/// via sudo as the user), validate with `kdump-config test`, and restart the service if
/// the test passes. Admin-gated in the dispatcher; superuser password required.
async fn kdump_set_config(
    extra: &serde_json::Map<String, serde_json::Value>,
    user: &str,
    password: &str,
) -> serde_json::Value {
    let key = extra.get("key").and_then(|v| v.as_str()).unwrap_or("");
    let value = extra.get("value").and_then(|v| v.as_str()).unwrap_or("");

    if !is_kdump_key(key) {
        return serde_json::json!({ "ok": false, "error": "invalid setting key" });
    }
    if value.contains('\n') {
        return serde_json::json!({ "ok": false, "error": "invalid value (newline)" });
    }
    if password.is_empty() {
        return serde_json::json!({ "ok": false, "error": "superuser password required" });
    }

    let Some((path, conf_format, service)) = kdump_config_target().await else {
        return serde_json::json!({ "ok": false, "error": "no editable kdump config found on this host" });
    };
    let current = tokio::fs::read_to_string(path).await.unwrap_or_default();
    if current.is_empty() {
        return serde_json::json!({ "ok": false, "error": "kdump config not found" });
    }

    let new_content = upsert_setting(&current, key, value, conf_format);
    let w = sudo_stdin_write_as_user(user, password, &["tee", path], &new_content).await;
    if w.get("ok").is_none() {
        return serde_json::json!({
            "ok": false,
            "error": w.get("error").and_then(|v| v.as_str()).unwrap_or("write failed")
        });
    }

    // Validate + apply, per distro.
    let (test_ok, test_output, restarted) = if conf_format {
        // Fedora/RHEL: `kdumpctl reload` applies the config and reloads the crash
        // kernel (fast). There is no strict config validator like Debian's.
        let r = sudo_as_user(user, password, &["kdumpctl", "reload"]).await;
        let ok = r.get("ok").is_some();
        let out = r
            .get("output")
            .or_else(|| r.get("error"))
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        (ok, out, ok)
    } else {
        // Debian: `kdump-config test` validates; restart only if it passes.
        let test = sudo_as_user(user, password, &["kdump-config", "test"]).await;
        let ok = test.get("ok").is_some();
        let out = test
            .get("output")
            .or_else(|| test.get("error"))
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let mut restarted = false;
        if ok {
            let r = sudo_as_user(user, password, &["systemctl", "restart", service]).await;
            restarted = r.get("ok").is_some();
        }
        (ok, out, restarted)
    };

    crate::audit::log(user, "kdump.set_config", key, test_ok, "");
    serde_json::json!({
        "ok": true,
        "key": key,
        "value": value,
        "test_ok": test_ok,
        "test_output": test_output,
        "restarted": restarted,
    })
}

/// Replace an existing `KEY=…` line (preserving position) or append the setting.
fn upsert_setting(content: &str, key: &str, value: &str, conf_format: bool) -> String {
    let fmt = |k: &str, v: &str| {
        if conf_format {
            format!("{k} {v}")
        } else {
            format!("{k}={v}")
        }
    };
    let mut found = false;
    let mut lines: Vec<String> = content
        .lines()
        .map(|line| {
            let t = line.trim_start();
            let this_key = if t.starts_with('#') {
                None
            } else if conf_format {
                t.split_whitespace().next()
            } else {
                t.split_once('=').map(|(k, _)| k.trim())
            };
            if this_key == Some(key) {
                found = true;
                return fmt(key, value);
            }
            line.to_string()
        })
        .collect();
    if !found {
        lines.push(fmt(key, value));
    }
    let mut s = lines.join("\n");
    if content.ends_with('\n') {
        s.push('\n');
    }
    s
}

async fn list_crash_dumps() -> serde_json::Value {
    let search_dirs = ["/var/crash", "/var/lib/kdump"];
    let mut dumps = Vec::new();

    for dir in &search_dirs {
        if let Ok(mut entries) = tokio::fs::read_dir(dir).await {
            while let Ok(Some(entry)) = entries.next_entry().await {
                let path = entry.path();
                let name = entry.file_name().to_string_lossy().to_string();

                if let Ok(meta) = entry.metadata().await {
                    if meta.is_dir() {
                        let dump = scan_crash_dir(&path).await;
                        dumps.push(serde_json::json!({
                            "name": name,
                            "path": path.to_string_lossy(),
                            "type": "directory",
                            "size_bytes": dump.total_size,
                            "files": dump.files,
                            "has_vmcore": dump.has_vmcore,
                            "has_dmesg": dump.has_dmesg,
                            "timestamp": file_timestamp(&meta),
                        }));
                    } else if name.ends_with(".crash")
                        || name.starts_with("vmcore")
                        || name.starts_with("dump.")
                        || name.ends_with(".dmesg")
                    {
                        dumps.push(serde_json::json!({
                            "name": name,
                            "path": path.to_string_lossy(),
                            "type": "file",
                            "size_bytes": meta.len(),
                            "has_vmcore": name.starts_with("vmcore"),
                            "has_dmesg": name.ends_with(".dmesg") || name.ends_with(".txt"),
                            "timestamp": file_timestamp(&meta),
                        }));
                    }
                }
            }
        }
    }

    dumps.sort_by(|a, b| {
        let ta = a.get("timestamp").and_then(|t| t.as_str()).unwrap_or("");
        let tb = b.get("timestamp").and_then(|t| t.as_str()).unwrap_or("");
        tb.cmp(ta)
    });

    serde_json::json!(dumps)
}

struct CrashDirInfo {
    files: Vec<serde_json::Value>,
    total_size: u64,
    has_vmcore: bool,
    has_dmesg: bool,
}

async fn scan_crash_dir(dir: &std::path::Path) -> CrashDirInfo {
    let mut info = CrashDirInfo {
        files: Vec::new(),
        total_size: 0,
        has_vmcore: false,
        has_dmesg: false,
    };

    if let Ok(mut entries) = tokio::fs::read_dir(dir).await {
        while let Ok(Some(entry)) = entries.next_entry().await {
            let name = entry.file_name().to_string_lossy().to_string();
            if let Ok(meta) = entry.metadata().await {
                let size = meta.len();
                info.total_size += size;

                if name.starts_with("vmcore") || name.ends_with(".core") {
                    info.has_vmcore = true;
                }
                if name.contains("dmesg") || name.ends_with(".txt") || name.ends_with(".log") {
                    info.has_dmesg = true;
                }

                info.files.push(serde_json::json!({
                    "name": name,
                    "path": entry.path().to_string_lossy(),
                    "size_bytes": size,
                    "timestamp": file_timestamp(&meta),
                }));
            }
        }
    }

    info
}

fn file_timestamp(meta: &std::fs::Metadata) -> String {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| {
            let secs = d.as_secs();
            chrono::DateTime::from_timestamp(secs as i64, 0)
                .map(|dt| dt.format("%Y-%m-%d %H:%M:%S UTC").to_string())
                .unwrap_or_else(|| secs.to_string())
        })
        .unwrap_or_default()
}

async fn read_dump_details(path: &str, user: &str, password: &str) -> serde_json::Value {
    if !is_valid_dump_path(path) {
        return serde_json::json!({ "ok": false, "error": "invalid path" });
    }

    let size = tokio::fs::metadata(path)
        .await
        .map(|m| m.len())
        .unwrap_or(0);

    // A raw vmcore is a binary kernel-memory image — don't stream it back.
    if path.contains("vmcore") {
        return serde_json::json!({
            "ok": true,
            "path": path,
            "size_bytes": size,
            "type": "vmcore",
            "note": "Use 'crash' tool for full analysis",
        });
    }

    // Text dump content is kernel-memory-derived → read AS the user (or sudo).
    match kdump_read_capped(user, password, path).await {
        Some(content) => serde_json::json!({
            "ok": true,
            "path": path,
            "size_bytes": size,
            "type": "text",
            "content": content,
        }),
        None => serde_json::json!({
            "ok": false,
            "restricted": true,
            "reason": "insufficient-perms",
            "error": "cannot read this crash dump — enable superuser mode",
        }),
    }
}

async fn read_dmesg_log(dir_path: &str, user: &str, password: &str) -> serde_json::Value {
    if !is_valid_dump_path(dir_path) {
        return serde_json::json!({ "ok": false, "error": "invalid path" });
    }
    let dir = dir_path.trim_end_matches('/');

    // Crash dmesg can contain kernel memory → read AS the user (or sudo). Try the
    // well-known fixed names first, then discover any `*dmesg*` file the dir actually
    // holds — Debian kdump-tools names it `dmesg.<timestamp>`, not `dmesg.txt`.
    let mut candidates: Vec<String> = ["dmesg.txt", "dmesg.log", "vmcore-dmesg.txt"]
        .iter()
        .map(|n| format!("{dir}/{n}"))
        .collect();
    for found in kdump_find_dmesg(user, password, dir).await {
        if !candidates.contains(&found) {
            candidates.push(found);
        }
    }

    for path in &candidates {
        if let Some(content) = kdump_read_capped(user, password, path).await
            && !content.is_empty()
        {
            return serde_json::json!({ "ok": true, "path": path, "content": content });
        }
    }

    serde_json::json!({ "ok": false, "error": "no readable dmesg log in dump directory (enable superuser mode if you lack access)" })
}

/// Discover `*dmesg*` files in a dump dir, brokered to the user (or sudo). Used
/// because dmesg filenames vary by distro (e.g. Debian's `dmesg.<timestamp>`).
async fn kdump_find_dmesg(user: &str, password: &str, dir: &str) -> Vec<String> {
    let args = [
        "find",
        dir,
        "-maxdepth",
        "1",
        "-type",
        "f",
        "-iname",
        "*dmesg*",
    ];
    let out = if !password.is_empty() {
        sudo_as_user(user, password, &args)
            .await
            .get("output")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string()
    } else if is_valid_username(user) {
        match run_cmd_as_user(user, &args).await {
            UserReadOutcome::Ran(o) if o.status.success() => {
                String::from_utf8_lossy(&o.stdout).to_string()
            }
            _ => String::new(),
        }
    } else {
        String::new()
    };
    out.lines()
        .filter(|l| !l.is_empty())
        .map(|l| l.to_string())
        .collect()
}

fn is_valid_dump_path(path: &str) -> bool {
    let p = std::path::Path::new(path);
    // Canonicalize resolves symlinks and ".." components, preventing
    // path traversal attacks that bypass the prefix check.
    let canonical = match p.canonicalize() {
        Ok(c) => c,
        Err(_) => return false, // non-existent or inaccessible path
    };
    let s = canonical.to_string_lossy();
    s.starts_with("/var/crash") || s.starts_with("/var/lib/kdump")
}
