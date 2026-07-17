use serde_json::{Value, json};

use crate::handler::ChannelHandler;
use crate::util::{require_admin, run_cmd, sudo_as_user, sudo_stdin_write_as_user};
use tenodera_protocol::channel::ChannelOpenOptions;
use tenodera_protocol::message::Message;

// ── storage.manage ────────────────────────────────────────────────────────────
// Block-device listing, mount/unmount and /etc/fstab editing.
// Reads are open; mutations are admin-gated and run via sudo as the calling user.

pub struct StorageManageHandler;

#[async_trait::async_trait]
impl ChannelHandler for StorageManageHandler {
    fn payload_type(&self) -> &str {
        "storage.manage"
    }

    // Uses open-time options (not a Data frame) so the frontend's one-shot
    // request() works: params arrive as channel-open options.
    async fn open(&self, channel: &str, options: &ChannelOpenOptions) -> Vec<Message> {
        let extra = Value::Object(options.extra.clone());
        let action = options
            .extra
            .get("action")
            .and_then(|a| a.as_str())
            .unwrap_or("");
        let password = options
            .extra
            .get("password")
            .and_then(|p| p.as_str())
            .unwrap_or("");
        let user = options
            .extra
            .get("_user")
            .and_then(|u| u.as_str())
            .unwrap_or("");

        let data = if matches!(action, "list_block" | "read_fstab") {
            match action {
                "list_block" => list_block().await,
                _ => read_fstab(),
            }
        } else if let Some(err) = require_admin(&extra) {
            err
        } else {
            match action {
                "mount" => mount_device(&extra, user, password).await,
                "unmount" => unmount_device(&extra, user, password).await,
                "write_fstab" => write_fstab(&extra, user, password).await,
                _ => json!({ "error": format!("unknown action: {action}") }),
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

// ── Read: block devices ────────────────────────────────────────────────────────

async fn list_block() -> Value {
    let out = run_cmd(&[
        "lsblk",
        "-J",
        "-b",
        "-o",
        "NAME,PATH,FSTYPE,SIZE,MOUNTPOINTS,UUID,LABEL,TYPE,RO",
    ])
    .await;
    let parsed: Value = serde_json::from_str(&out).unwrap_or_else(|_| json!({}));
    let mut rows: Vec<Value> = Vec::new();
    if let Some(devs) = parsed.get("blockdevices").and_then(|v| v.as_array()) {
        flatten(devs, &mut rows);
    }
    json!({ "devices": rows })
}

fn flatten(devs: &[Value], out: &mut Vec<Value>) {
    for d in devs {
        let mps: Vec<String> = d
            .get("mountpoints")
            .and_then(|v| v.as_array())
            .map(|a| {
                a.iter()
                    .filter_map(|m| m.as_str())
                    .map(String::from)
                    .collect()
            })
            .unwrap_or_default();
        let mounted = mps.iter().find(|m| !m.is_empty()).cloned();
        out.push(json!({
            "name": d.get("name").and_then(|v| v.as_str()).unwrap_or(""),
            "path": d.get("path").and_then(|v| v.as_str()).unwrap_or(""),
            "fstype": d.get("fstype").and_then(|v| v.as_str()).unwrap_or(""),
            "size": d.get("size").and_then(|v| v.as_u64()).unwrap_or(0),
            "type": d.get("type").and_then(|v| v.as_str()).unwrap_or(""),
            "uuid": d.get("uuid").and_then(|v| v.as_str()).unwrap_or(""),
            "label": d.get("label").and_then(|v| v.as_str()).unwrap_or(""),
            "ro": d.get("ro").and_then(|v| v.as_bool()).unwrap_or(false),
            "mountpoint": mounted,
        }));
        if let Some(children) = d.get("children").and_then(|v| v.as_array()) {
            flatten(children, out);
        }
    }
}

// ── Read: fstab ────────────────────────────────────────────────────────────────

fn read_fstab() -> Value {
    let content = std::fs::read_to_string("/etc/fstab").unwrap_or_default();
    let entries: Vec<Value> = content
        .lines()
        .filter_map(|l| {
            let t = l.trim();
            if t.is_empty() || t.starts_with('#') {
                return None;
            }
            let f: Vec<&str> = t.split_whitespace().collect();
            if f.len() < 2 {
                return None;
            }
            Some(json!({
                "spec": f[0],
                "file": f[1],
                "vfstype": f.get(2).copied().unwrap_or(""),
                "options": f.get(3).copied().unwrap_or("defaults"),
                "dump": f.get(4).copied().unwrap_or("0"),
                "pass": f.get(5).copied().unwrap_or("0"),
            }))
        })
        .collect();
    json!({ "content": content, "entries": entries })
}

// ── Mutations ──────────────────────────────────────────────────────────────────

async fn mount_device(data: &Value, user: &str, password: &str) -> Value {
    let source = str_field(data, "source");
    let target = str_field(data, "target");
    let fstype = str_field(data, "fstype");
    let options = str_field(data, "options");

    if !is_valid_source(&source) {
        return json!({ "error": "invalid source device" });
    }
    if !is_abs_path(&target) {
        return json!({ "error": "target must be an absolute path" });
    }
    if !fstype.is_empty() && !is_token(&fstype) {
        return json!({ "error": "invalid filesystem type" });
    }
    if !options.is_empty() && !is_mount_options(&options) {
        return json!({ "error": "invalid mount options" });
    }

    // Ensure the mountpoint exists.
    let mk = sudo_as_user(user, password, &["mkdir", "-p", "--", &target]).await;
    if mk.get("error").is_some() {
        return mk;
    }

    let mut args: Vec<&str> = vec!["mount"];
    if !fstype.is_empty() {
        args.push("-t");
        args.push(&fstype);
    }
    if !options.is_empty() {
        args.push("-o");
        args.push(&options);
    }
    args.push("--");
    args.push(&source);
    args.push(&target);

    let r = sudo_as_user(user, password, &args).await;
    let ok = r.get("error").is_none();
    crate::audit::log(
        user,
        "storage.mount",
        &format!("{source} -> {target}"),
        ok,
        "",
    );
    if !ok { r } else { json!({ "ok": true }) }
}

async fn unmount_device(data: &Value, user: &str, password: &str) -> Value {
    let target = str_field(data, "target");
    // Accept either a mountpoint path or a /dev source.
    if !(is_abs_path(&target) || is_valid_source(&target)) {
        return json!({ "error": "invalid target" });
    }
    let r = sudo_as_user(user, password, &["umount", "--", &target]).await;
    let ok = r.get("error").is_none();
    crate::audit::log(user, "storage.unmount", &target, ok, "");
    if !ok { r } else { json!({ "ok": true }) }
}

async fn write_fstab(data: &Value, user: &str, password: &str) -> Value {
    let content = data.get("content").and_then(|v| v.as_str()).unwrap_or("");
    if content.trim().is_empty() {
        return json!({ "error": "fstab is empty" });
    }
    if content.len() > 64 * 1024 {
        return json!({ "error": "fstab too large" });
    }
    // Every non-comment line needs at least a device and a mountpoint.
    for line in content.lines() {
        let t = line.trim();
        if t.is_empty() || t.starts_with('#') {
            continue;
        }
        if t.split_whitespace().count() < 2 {
            return json!({ "error": format!("invalid fstab line: {t}") });
        }
    }
    // Back up before overwriting.
    let _ = sudo_as_user(
        user,
        password,
        &["cp", "-f", "/etc/fstab", "/etc/fstab.tenodera.bak"],
    )
    .await;
    let normalized = if content.ends_with('\n') {
        content.to_string()
    } else {
        format!("{content}\n")
    };
    let w = sudo_stdin_write_as_user(user, password, &["tee", "/etc/fstab"], &normalized).await;
    let ok = w.get("error").is_none();
    crate::audit::log(user, "storage.write_fstab", "/etc/fstab", ok, "");
    if !ok { w } else { json!({ "ok": true }) }
}

// ── Validation helpers ─────────────────────────────────────────────────────────

fn str_field(data: &Value, key: &str) -> String {
    data.get(key)
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string()
}

fn is_abs_path(p: &str) -> bool {
    p.starts_with('/')
        && p.len() <= 4096
        && !p.contains('\0')
        && !p.contains('\n')
        && !p.contains("..")
}

/// A mount source: /dev node, UUID=, LABEL=, PARTUUID=, or a path (bind mount).
fn is_valid_source(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 4096
        && !s.contains(char::is_whitespace)
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() || "-_./:=".contains(c))
}

fn is_token(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 32
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_'))
}

/// Comma-separated mount options, e.g. `rw,noatime,uid=1000`.
fn is_mount_options(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 512
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() || ",=-_.:/".contains(c))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn source_validation() {
        assert!(is_valid_source("/dev/sdb1"));
        assert!(is_valid_source("UUID=1234-abcd"));
        assert!(is_valid_source("LABEL=data"));
        assert!(!is_valid_source("/dev/sdb1; rm -rf"));
        assert!(!is_valid_source("has space"));
    }

    #[test]
    fn path_and_options() {
        assert!(is_abs_path("/mnt/data"));
        assert!(!is_abs_path("relative"));
        assert!(!is_abs_path("/a/../b"));
        assert!(is_mount_options("rw,noatime,uid=1000"));
        assert!(!is_mount_options("rw;evil"));
        assert!(is_token("ext4"));
        assert!(!is_token("ext 4"));
    }
}
