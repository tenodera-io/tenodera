use serde_json::{Value, json};

use crate::handler::ChannelHandler;
use crate::handlers::system_settings::active_unit;
use crate::util::{require_admin, run_cmd, sudo_as_user, sudo_stdin_write_as_user};
use tenodera_protocol::channel::ChannelOpenOptions;
use tenodera_protocol::message::Message;

// ── ssh.manage ─────────────────────────────────────────────────────────────────
// Manage authorized_keys per user and the sshd_config. Reads are open; mutations
// are admin-gated. Runs as the agent (root); the sshd_config is validated with
// `sshd -t` before it is applied.

pub struct SshManageHandler;

#[async_trait::async_trait]
impl ChannelHandler for SshManageHandler {
    fn payload_type(&self) -> &str {
        "ssh.manage"
    }

    async fn open(&self, channel: &str, options: &ChannelOpenOptions) -> Vec<Message> {
        let extra = Value::Object(options.extra.clone());
        let action = options
            .extra
            .get("action")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        let user_arg = options
            .extra
            .get("user")
            .and_then(|v| v.as_str())
            .unwrap_or("");

        let data = if matches!(action, "list_users" | "list_keys" | "read_sshd") {
            match action {
                "list_users" => list_users().await,
                "list_keys" => list_keys(user_arg),
                _ => read_sshd(),
            }
        } else if let Some(err) = require_admin(&extra) {
            err
        } else {
            // The operator (== audit user, from the gateway-injected `_user`).
            // Every mutation below runs on the host under *their* sudo with
            // *their* password, so the host's sudoers — not just the admin role —
            // decides. `user_arg` is the target account whose keys are edited.
            let get = |k: &str| options.extra.get(k).and_then(|v| v.as_str()).unwrap_or("");
            let operator = get("_user");
            let password = get("password");
            match action {
                "add_key" => add_key(user_arg, get("key"), operator, password).await,
                "remove_key" => remove_key(user_arg, get("key"), operator, password).await,
                "edit_key" => edit_key(user_arg, get("old"), get("key"), operator, password).await,
                "set_sshd" => set_sshd(get("content"), operator, password).await,
                other => json!({ "error": format!("unknown action: {other}") }),
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

// ── Users ──────────────────────────────────────────────────────────────────────

/// Login users that can own SSH keys: root plus real accounts (uid >= 1000)
/// with a non-nologin shell. Uses `getent passwd` so NSS sources (SSSD/FreeIPA)
/// are included, not just local /etc/passwd — falls back to the file if getent
/// yields nothing.
async fn list_users() -> Value {
    let content = run_cmd(&["getent", "passwd"]).await;
    let content = if content.trim().is_empty() {
        std::fs::read_to_string("/etc/passwd").unwrap_or_default()
    } else {
        content
    };
    let mut users: Vec<Value> = Vec::new();
    for line in content.lines() {
        let f: Vec<&str> = line.split(':').collect();
        if f.len() < 7 {
            continue;
        }
        let name = f[0];
        let uid: u32 = f[2].parse().unwrap_or(u32::MAX);
        let home = f[5];
        let shell = f[6];
        // root, or a real account (uid >= 1000, excluding `nobody`). Directory
        // users (SSSD/FreeIPA/AD) live in very high ranges, so no upper bound.
        let is_login = uid == 0 || (uid >= 1000 && uid != 65534);
        let has_shell =
            !shell.is_empty() && !shell.ends_with("nologin") && !shell.ends_with("false");
        if is_login && has_shell {
            users.push(json!({ "name": name, "uid": uid, "home": home }));
        }
    }
    json!({ "users": users })
}

// ── authorized_keys ────────────────────────────────────────────────────────────

fn home_of(user: &str) -> Option<String> {
    crate::util::lookup_user(user).map(|(_, _, home, _)| home)
}

fn authkeys_path(user: &str) -> Option<String> {
    home_of(user).map(|h| format!("{h}/.ssh/authorized_keys"))
}

const KEY_PREFIXES: &[&str] = &[
    "ssh-rsa",
    "ssh-ed25519",
    "ssh-dss",
    "ecdsa-sha2-nistp256",
    "ecdsa-sha2-nistp384",
    "ecdsa-sha2-nistp521",
    "sk-ssh-ed25519@openssh.com",
    "sk-ecdsa-sha2-nistp256@openssh.com",
];

/// Split a key line into (type, comment); options (before the type) are ignored
/// for display but preserved via the raw line.
fn parse_key_line(line: &str) -> Option<Value> {
    let t = line.trim();
    if t.is_empty() || t.starts_with('#') {
        return None;
    }
    let toks: Vec<&str> = t.split_whitespace().collect();
    let type_idx = toks.iter().position(|tok| KEY_PREFIXES.contains(tok))?;
    let ktype = toks[type_idx];
    let comment = toks
        .get(type_idx + 2..)
        .map(|c| c.join(" "))
        .unwrap_or_default();
    let blob = toks.get(type_idx + 1).copied().unwrap_or("");
    let preview = if blob.len() > 20 {
        format!("{}…{}", &blob[..10], &blob[blob.len() - 6..])
    } else {
        blob.to_string()
    };
    Some(json!({ "type": ktype, "comment": comment, "preview": preview, "raw": t }))
}

fn list_keys(user: &str) -> Value {
    if user.is_empty() || home_of(user).is_none() {
        return json!({ "error": "unknown user", "keys": [] });
    }
    let path = authkeys_path(user).unwrap_or_default();
    let content = std::fs::read_to_string(&path).unwrap_or_default();
    let keys: Vec<Value> = content.lines().filter_map(parse_key_line).collect();
    json!({ "user": user, "path": path, "keys": keys })
}

/// Validate a public key with ssh-keygen and return its fingerprint, or None.
async fn key_fingerprint(key: &str) -> Option<String> {
    // ssh-keygen -l -f /dev/stdin reads the key from stdin.
    use tokio::io::AsyncWriteExt;
    let mut child = tokio::process::Command::new("ssh-keygen")
        .args(["-l", "-f", "/dev/stdin"])
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
        .ok()?;
    if let Some(mut stdin) = child.stdin.take() {
        let _ = stdin.write_all(key.as_bytes()).await;
        let _ = stdin.write_all(b"\n").await;
        drop(stdin);
    }
    let out = child.wait_with_output().await.ok()?;
    if out.status.success() {
        Some(String::from_utf8_lossy(&out.stdout).trim().to_string())
    } else {
        None
    }
}

/// Write `content` to a target user's authorized_keys **as the operator**, via
/// their sudo: ensure `~/.ssh` (mode 700), write the file, then restore owner and
/// mode 600. Every step runs under the operator's own sudo, so the host — not the
/// injected admin role — authorises editing another account's keys.
async fn apply_authkeys(
    operator: &str,
    password: &str,
    ssh_dir: &str,
    path: &str,
    uid: u32,
    gid: u32,
    content: &str,
) -> Value {
    let uid_s = uid.to_string();
    let gid_s = gid.to_string();
    let mk = sudo_as_user(
        operator,
        password,
        &[
            "install", "-d", "-m", "700", "-o", &uid_s, "-g", &gid_s, ssh_dir,
        ],
    )
    .await;
    if let Some(err) = mk.get("error") {
        return json!({ "error": err.clone() });
    }
    // tee (run as root via sudo) creates the file root-owned; the chown/chmod
    // below hand it back to the target account.
    let w = sudo_stdin_write_as_user(operator, password, &["tee", path], content).await;
    if let Some(err) = w.get("error") {
        return json!({ "error": err.clone() });
    }
    let owner = format!("{uid}:{gid}");
    for step in [
        sudo_as_user(operator, password, &["chown", &owner, path]).await,
        sudo_as_user(operator, password, &["chmod", "600", path]).await,
    ] {
        if let Some(err) = step.get("error") {
            return json!({ "error": err.clone() });
        }
    }
    json!({ "ok": true })
}

/// Audit an authorized_keys mutation and normalise the `apply_authkeys` result.
fn finish_key(res: Value, operator: &str, action: &str, target: &str) -> Value {
    if let Some(err) = res.get("error").and_then(|e| e.as_str()) {
        crate::audit::log(operator, action, target, false, err);
        return json!({ "error": err });
    }
    crate::audit::log(operator, action, target, true, "");
    json!({ "ok": true })
}

async fn add_key(user: &str, key: &str, operator: &str, password: &str) -> Value {
    let key = key.trim();
    let Some((uid, gid, home, _)) = crate::util::lookup_user(user) else {
        return json!({ "error": "unknown user" });
    };
    if parse_key_line(key).is_none() {
        return json!({ "error": "not a recognised SSH public key" });
    }
    if key_fingerprint(key).await.is_none() {
        return json!({ "error": "invalid SSH public key (ssh-keygen rejected it)" });
    }

    let ssh_dir = format!("{home}/.ssh");
    let path = format!("{ssh_dir}/authorized_keys");
    let mut existing = std::fs::read_to_string(&path).unwrap_or_default();
    if existing.lines().any(|l| l.trim() == key) {
        return json!({ "error": "key already present" });
    }
    if !existing.is_empty() && !existing.ends_with('\n') {
        existing.push('\n');
    }
    existing.push_str(key);
    existing.push('\n');

    let res = apply_authkeys(operator, password, &ssh_dir, &path, uid, gid, &existing).await;
    finish_key(res, operator, "ssh.add_key", user)
}

async fn remove_key(user: &str, key: &str, operator: &str, password: &str) -> Value {
    let key = key.trim();
    let Some((uid, gid, home, _)) = crate::util::lookup_user(user) else {
        return json!({ "error": "unknown user" });
    };
    let ssh_dir = format!("{home}/.ssh");
    let path = format!("{ssh_dir}/authorized_keys");
    let content = std::fs::read_to_string(&path).unwrap_or_default();
    let kept: Vec<&str> = content.lines().filter(|l| l.trim() != key).collect();
    let new_content = if kept.is_empty() {
        String::new()
    } else {
        kept.join("\n") + "\n"
    };
    let res = apply_authkeys(operator, password, &ssh_dir, &path, uid, gid, &new_content).await;
    finish_key(res, operator, "ssh.remove_key", user)
}

/// Replace one existing key line (matched by its raw text) with a new, validated
/// key — in place, preserving order and the rest of the file.
async fn edit_key(user: &str, old: &str, new_key: &str, operator: &str, password: &str) -> Value {
    let old = old.trim();
    let new_key = new_key.trim();
    let Some((uid, gid, home, _)) = crate::util::lookup_user(user) else {
        return json!({ "error": "unknown user" });
    };
    if parse_key_line(new_key).is_none() {
        return json!({ "error": "not a recognised SSH public key" });
    }
    if key_fingerprint(new_key).await.is_none() {
        return json!({ "error": "invalid SSH public key (ssh-keygen rejected it)" });
    }
    let ssh_dir = format!("{home}/.ssh");
    let path = format!("{ssh_dir}/authorized_keys");
    let content = std::fs::read_to_string(&path).unwrap_or_default();
    if !content.lines().any(|l| l.trim() == old) {
        return json!({ "error": "original key not found (reload and retry)" });
    }
    if new_key != old && content.lines().any(|l| l.trim() == new_key) {
        return json!({ "error": "key already present" });
    }
    let mut replaced = false;
    let kept: Vec<String> = content
        .lines()
        .map(|l| {
            if !replaced && l.trim() == old {
                replaced = true;
                new_key.to_string()
            } else {
                l.to_string()
            }
        })
        .collect();
    let new_content = kept.join("\n") + "\n";
    let res = apply_authkeys(operator, password, &ssh_dir, &path, uid, gid, &new_content).await;
    finish_key(res, operator, "ssh.edit_key", user)
}

// ── sshd_config ────────────────────────────────────────────────────────────────

const SSHD_CONFIG: &str = "/etc/ssh/sshd_config";

fn read_sshd() -> Value {
    let content = std::fs::read_to_string(SSHD_CONFIG).unwrap_or_default();
    json!({ "content": content, "path": SSHD_CONFIG })
}

async fn set_sshd(content: &str, operator: &str, password: &str) -> Value {
    if content.trim().is_empty() {
        return json!({ "error": "config is empty" });
    }
    if content.len() > 128 * 1024 {
        return json!({ "error": "config too large" });
    }
    let normalized = if content.ends_with('\n') {
        content.to_string()
    } else {
        format!("{content}\n")
    };

    // Stage a scratch copy, then validate it with `sshd -t` run under the
    // operator's sudo (`sshd -t` needs root to open the host keys). The staged
    // file is a throwaway, not the live config, so writing it as the agent is
    // fine — the privileged writes to the real config are all brokered below.
    let tmp = "/run/tenodera-sshd-check.conf";
    if let Err(e) = std::fs::write(tmp, &normalized) {
        return json!({ "error": format!("failed to stage config: {e}") });
    }
    let sshd_bin = if crate::util::which("sshd").await {
        "sshd"
    } else {
        "/usr/sbin/sshd"
    };
    let check = sudo_as_user(operator, password, &[sshd_bin, "-t", "-f", tmp]).await;
    let _ = std::fs::remove_file(tmp);
    if let Some(err) = check.get("error").and_then(|e| e.as_str()) {
        crate::audit::log(
            operator,
            "ssh.set_sshd",
            SSHD_CONFIG,
            false,
            "validation failed",
        );
        return json!({ "error": format!("sshd validation failed:\n{err}") });
    }

    // Back up, write, reload — all under the operator's sudo.
    let backup = format!("{SSHD_CONFIG}.tenodera.bak");
    let _ = sudo_as_user(operator, password, &["cp", SSHD_CONFIG, &backup]).await;
    let w = sudo_stdin_write_as_user(operator, password, &["tee", SSHD_CONFIG], &normalized).await;
    if let Some(err) = w.get("error").and_then(|e| e.as_str()) {
        crate::audit::log(operator, "ssh.set_sshd", SSHD_CONFIG, false, "write failed");
        return json!({ "error": format!("failed to write sshd_config: {err}") });
    }
    let unit = active_unit(&["sshd", "ssh"])
        .await
        .unwrap_or_else(|| "sshd".to_string());
    let reload = sudo_as_user(operator, password, &["systemctl", "reload", &unit]).await;
    if let Some(err) = reload.get("error").and_then(|e| e.as_str()) {
        crate::audit::log(
            operator,
            "ssh.set_sshd",
            SSHD_CONFIG,
            true,
            "written; reload failed",
        );
        return json!({ "error": format!("config written but reload failed: {err}") });
    }
    crate::audit::log(operator, "ssh.set_sshd", SSHD_CONFIG, true, &unit);
    json!({ "ok": true, "reloaded": unit })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_key_line() {
        let line = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIabc123def456 alice@host";
        let v = parse_key_line(line).unwrap();
        assert_eq!(v["type"], "ssh-ed25519");
        assert_eq!(v["comment"], "alice@host");
    }

    #[test]
    fn parses_key_with_options() {
        let line = "no-pty,no-agent-forwarding ssh-rsa AAAAB3Nzaaaaaaaaaaaaaaaaaaaa bob";
        let v = parse_key_line(line).unwrap();
        assert_eq!(v["type"], "ssh-rsa");
        assert_eq!(v["comment"], "bob");
    }

    #[test]
    fn rejects_non_key() {
        assert!(parse_key_line("# comment").is_none());
        assert!(parse_key_line("").is_none());
        assert!(parse_key_line("just some text here").is_none());
    }
}
