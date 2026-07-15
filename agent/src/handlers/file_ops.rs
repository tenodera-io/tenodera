use std::path::Path;

use async_trait::async_trait;
use serde_json::json;
use tokio::io::AsyncWriteExt;

use tenodera_protocol::channel::ChannelOpenOptions;
use tenodera_protocol::message::Message;

use crate::handler::ChannelHandler;
use crate::util::{is_valid_username, run_cmd, sudo_as_user, sudo_stdin_write_as_user};

const PAGE_LINES: usize = 200;

// ── file.read ──────────────────────────────────────────────────────────────

pub struct FileReadHandler;

#[async_trait]
impl ChannelHandler for FileReadHandler {
    fn payload_type(&self) -> &str {
        "file.read"
    }

    async fn open(&self, channel: &str, options: &ChannelOpenOptions) -> Vec<Message> {
        let path = get_str(options, "path");
        let password = get_str(options, "password");
        let user = get_str(options, "_user");
        let offset = get_usize(options, "offset");

        if path.is_empty() {
            return err_msgs(channel, "path required");
        }

        let data = read_file(path, user, password, offset).await;
        ok_msgs(channel, data)
    }
}

// ── file.write ─────────────────────────────────────────────────────────────

pub struct FileWriteHandler;

#[async_trait]
impl ChannelHandler for FileWriteHandler {
    fn payload_type(&self) -> &str {
        "file.write"
    }

    async fn open(&self, channel: &str, options: &ChannelOpenOptions) -> Vec<Message> {
        let path = get_str(options, "path");
        let password = get_str(options, "password");
        let user = get_str(options, "_user");
        let content = get_str(options, "content");

        if path.is_empty() {
            return err_msgs(channel, "path required");
        }

        let data = if password.is_empty() {
            write_as_user(path, content, user).await
        } else {
            sudo_stdin_write_as_user(user, password, &["tee", "--", path], content).await
        };
        ok_msgs(channel, data)
    }
}

// ── file.mkdir ─────────────────────────────────────────────────────────────

pub struct FileMkdirHandler;

#[async_trait]
impl ChannelHandler for FileMkdirHandler {
    fn payload_type(&self) -> &str {
        "file.mkdir"
    }

    async fn open(&self, channel: &str, options: &ChannelOpenOptions) -> Vec<Message> {
        let path = get_str(options, "path");
        let password = get_str(options, "password");
        let user = get_str(options, "_user");

        if path.is_empty() {
            return err_msgs(channel, "path required");
        }

        let data = if password.is_empty() {
            mkdir_as_user(path, user).await
        } else {
            sudo_as_user(user, password, &["mkdir", "--", path]).await
        };
        ok_msgs(channel, data)
    }
}

// ── file.delete ────────────────────────────────────────────────────────────

pub struct FileDeleteHandler;

#[async_trait]
impl ChannelHandler for FileDeleteHandler {
    fn payload_type(&self) -> &str {
        "file.delete"
    }

    async fn open(&self, channel: &str, options: &ChannelOpenOptions) -> Vec<Message> {
        let path = get_str(options, "path");
        let password = get_str(options, "password");
        let user = get_str(options, "_user");

        if path.is_empty() {
            return err_msgs(channel, "path required");
        }

        let data = if password.is_empty() {
            delete_as_user(path, user).await
        } else {
            let args: &[&str] = if std::path::Path::new(path).is_dir() {
                &["rm", "-r", "--", path]
            } else {
                &["rm", "--", path]
            };
            sudo_as_user(user, password, args).await
        };
        ok_msgs(channel, data)
    }
}

// ── read implementation ────────────────────────────────────────────────────

async fn read_file(path: &str, user: &str, password: &str, offset: usize) -> serde_json::Value {
    let am_root = unsafe { libc::geteuid() } == 0;

    // Resolve canonical path — agent runs as root so this always succeeds
    let canonical = match Path::new(path).canonicalize() {
        Ok(p) => p,
        Err(_) => return json!({ "error": "file not found" }),
    };
    let resolved = canonical.to_string_lossy().to_string();

    // Detect binary via MIME type before trying to read as text
    let mime_out = run_cmd(&["file", "-b", "--mime-type", "--", &resolved]).await;
    let mime = mime_out.trim().to_string();
    if !is_text_mime(&mime) {
        return json!({ "binary": true, "mime": mime, "path": resolved });
    }

    // Decide execution context
    let as_user = password.is_empty();
    if as_user {
        if !is_valid_username(user) {
            return json!({ "error": "invalid user context" });
        }
        // Limited access is confined to the user's home directory.
        let home = std::path::Path::new("/home").join(user);
        if !canonical.starts_with(&home) {
            return json!({ "error": "Limited access: restricted to your home directory" });
        }
    }

    // Count total lines
    let wc_raw = if as_user {
        run_cmd(&["sudo", "-n", "-u", user, "--", "wc", "-l", "--", &resolved]).await
    } else if am_root {
        run_cmd(&["wc", "-l", "--", &resolved]).await
    } else {
        sudo_read(password, &["wc", "-l", "--", &resolved]).await
    };

    if wc_raw.contains("Permission denied") {
        return json!({ "error": "Permission denied" });
    }

    let total_lines: usize = wc_raw
        .split_whitespace()
        .next()
        .and_then(|s| s.parse().ok())
        .unwrap_or(0);

    // Read the requested page via sed (sed uses 1-based line numbers)
    let start = offset + 1;
    let end = start + PAGE_LINES - 1;
    let range = format!("{start},{end}p");

    let content = if as_user {
        run_cmd(&[
            "sudo", "-n", "-u", user, "--", "sed", "-n", &range, "--", &resolved,
        ])
        .await
    } else if am_root {
        run_cmd(&["sed", "-n", &range, "--", &resolved]).await
    } else {
        sudo_read(password, &["sed", "-n", &range, "--", &resolved]).await
    };

    if content.starts_with("error:") || content.contains("Permission denied") {
        return json!({ "error": "Permission denied" });
    }

    json!({
        "path":        resolved,
        "content":     content,
        "total_lines": total_lines,
        "offset":      offset,
        "limit":       PAGE_LINES,
    })
}

fn is_text_mime(mime: &str) -> bool {
    if mime.starts_with("text/") || mime == "inode/x-empty" {
        return true;
    }
    matches!(
        mime,
        "application/json"
            | "application/xml"
            | "application/javascript"
            | "application/x-sh"
            | "application/x-shellscript"
            | "application/toml"
            | "application/x-yaml"
            | "application/x-httpd-php"
            | "application/x-perl"
            | "application/x-ruby"
            | "application/x-python"
    ) || mime.ends_with("+xml")
        || mime.ends_with("+json")
}

/// Write `content` to `path` as the requesting user via `sudo -n -u <user>`.
/// Linux filesystem write permissions apply — no root escalation.
async fn write_as_user(path: &str, content: &str, user: &str) -> serde_json::Value {
    if !is_valid_username(user) {
        return json!({ "error": "invalid user context" });
    }

    // Limited access is confined to the user's home directory.
    let canonical = match std::path::Path::new(path)
        .parent()
        .and_then(|p| p.canonicalize().ok())
    {
        Some(dir) => dir.join(std::path::Path::new(path).file_name().unwrap_or_default()),
        None => std::path::PathBuf::from(path),
    };
    let home = std::path::Path::new("/home").join(user);
    if !canonical.starts_with(&home) {
        return json!({ "error": "Limited access: restricted to your home directory" });
    }

    use base64::Engine;
    let b64 = base64::engine::general_purpose::STANDARD.encode(content.as_bytes());
    let script = format!(
        "printf '{}' | base64 -d | tee -- {}",
        b64,
        crate::util::shell_escape(path),
    );

    match tokio::process::Command::new("sudo")
        .args(["-n", "-u", user, "--", "sh", "-c", &script])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped())
        .output()
        .await
    {
        Ok(out) if out.status.success() => json!({ "ok": true }),
        Ok(out) => {
            let msg = String::from_utf8_lossy(&out.stderr).trim().to_string();
            json!({ "error": if msg.is_empty() { "Permission denied".to_string() } else { msg } })
        }
        Err(e) => json!({ "error": e.to_string() }),
    }
}

/// Create directory `path` as the requesting user via `sudo -n -u <user>`.
/// Limited access confined to the user's home directory.
async fn mkdir_as_user(path: &str, user: &str) -> serde_json::Value {
    if !is_valid_username(user) {
        return json!({ "error": "invalid user context" });
    }

    // Directory doesn't exist yet — canonicalize the parent.
    let p = std::path::Path::new(path);
    let canonical = match p.parent().and_then(|parent| parent.canonicalize().ok()) {
        Some(dir) => dir.join(p.file_name().unwrap_or_default()),
        None => std::path::PathBuf::from(path),
    };
    let home = std::path::Path::new("/home").join(user);
    if !canonical.starts_with(&home) {
        return json!({ "error": "Limited access: restricted to your home directory" });
    }

    match tokio::process::Command::new("sudo")
        .args(["-n", "-u", user, "--", "mkdir", "--", path])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped())
        .output()
        .await
    {
        Ok(out) if out.status.success() => json!({ "ok": true }),
        Ok(out) => {
            let msg = String::from_utf8_lossy(&out.stderr).trim().to_string();
            json!({ "error": if msg.is_empty() { "Permission denied".to_string() } else { msg } })
        }
        Err(e) => json!({ "error": e.to_string() }),
    }
}

/// Delete `path` as the requesting user via `sudo -n -u <user>`.
/// Linux filesystem write permissions apply — no root escalation.
async fn delete_as_user(path: &str, user: &str) -> serde_json::Value {
    if !is_valid_username(user) {
        return json!({ "error": "invalid user context" });
    }

    // Limited access is confined to the user's home directory.
    let canonical = match std::path::Path::new(path).canonicalize() {
        Ok(p) => p,
        Err(_) => return json!({ "error": "file not found" }),
    };
    let home = std::path::Path::new("/home").join(user);
    if !canonical.starts_with(&home) {
        return json!({ "error": "Limited access: restricted to your home directory" });
    }

    let rm_args: &[&str] = if canonical.is_dir() {
        &["-n", "-u", user, "--", "rm", "-r", "--", path]
    } else {
        &["-n", "-u", user, "--", "rm", "--", path]
    };

    match tokio::process::Command::new("sudo")
        .args(rm_args)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped())
        .output()
        .await
    {
        Ok(out) if out.status.success() => json!({ "ok": true }),
        Ok(out) => {
            let msg = String::from_utf8_lossy(&out.stderr).trim().to_string();
            json!({ "error": if msg.is_empty() { "Permission denied".to_string() } else { msg } })
        }
        Err(e) => json!({ "error": e.to_string() }),
    }
}

/// Run a command via `sudo -S`, returning raw stdout.
/// Used for the non-root agent path when an admin password is needed.
async fn sudo_read(password: &str, args: &[&str]) -> String {
    let mut cmd_args = vec!["-S"];
    cmd_args.extend_from_slice(args);

    let child = tokio::process::Command::new("sudo")
        .args(&cmd_args)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn();

    let mut child = match child {
        Ok(c) => c,
        Err(e) => return format!("error: {e}"),
    };

    if let Some(mut stdin) = child.stdin.take() {
        let _ = stdin.write_all(format!("{password}\n").as_bytes()).await;
    }

    match child.wait_with_output().await {
        Ok(out) => String::from_utf8_lossy(&out.stdout).to_string(),
        Err(e) => format!("error: {e}"),
    }
}

// ── helpers ────────────────────────────────────────────────────────────────

fn get_str<'a>(options: &'a ChannelOpenOptions, key: &str) -> &'a str {
    options
        .extra
        .get(key)
        .and_then(|v| v.as_str())
        .unwrap_or("")
}

fn get_usize(options: &ChannelOpenOptions, key: &str) -> usize {
    options
        .extra
        .get(key)
        .and_then(|v| {
            v.as_u64()
                .map(|n| n as usize)
                .or_else(|| v.as_str().and_then(|s| s.parse().ok()))
        })
        .unwrap_or(0)
}

fn ok_msgs(channel: &str, data: serde_json::Value) -> Vec<Message> {
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

fn err_msgs(channel: &str, msg: &str) -> Vec<Message> {
    ok_msgs(channel, json!({ "error": msg }))
}
