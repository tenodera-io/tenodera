use std::path::Path;

use tenodera_protocol::channel::ChannelOpenOptions;
use tenodera_protocol::message::Message;
use tokio::io::AsyncWriteExt;

use crate::handler::ChannelHandler;
use crate::util::run_cmd;

pub struct FileListHandler;

#[async_trait::async_trait]
impl ChannelHandler for FileListHandler {
    fn payload_type(&self) -> &str {
        "file.list"
    }

    async fn open(&self, channel: &str, options: &ChannelOpenOptions) -> Vec<Message> {
        let path = options.extra.get("path").and_then(|v| v.as_str()).unwrap_or("/");
        let password = options.extra.get("password").and_then(|v| v.as_str()).unwrap_or("");
        let user = options.extra.get("_user").and_then(|v| v.as_str()).unwrap_or("");

        let data = if password.is_empty() {
            // No admin password — list as the requesting panel user so Linux
            // filesystem permissions apply naturally.
            list_as_user(path, user).await
        } else {
            // Admin password provided — full root access via sudo.
            sudo_list_directory(path, password).await
        };

        vec![
            Message::Ready  { channel: channel.into() },
            Message::Data   { channel: channel.into(), data },
            Message::Close  { channel: channel.into(), problem: None },
        ]
    }
}

/// List `path` as the requesting panel user by impersonating them via
/// `sudo -n -u <user>` (agent process is root; no password needed to switch
/// to a less-privileged identity).  Linux permissions apply — the user sees
/// exactly what they would see in their own shell session.
async fn list_as_user(path: &str, user: &str) -> serde_json::Value {
    if !is_valid_username(user) {
        return serde_json::json!({ "error": "invalid user context" });
    }

    let canonical = match Path::new(path).canonicalize() {
        Ok(p) => p,
        Err(e) => return serde_json::json!({ "error": format!("cannot resolve path: {e}") }),
    };
    let resolved = canonical.to_string_lossy();

    let out = run_cmd(&[
        "sudo", "-n", "-u", user, "--",
        "ls", "-laH", "--time-style=long-iso", "--", &resolved,
    ]).await;

    if out.starts_with("error:") || out.contains("sudo:") || out.contains("Permission denied") {
        return serde_json::json!({ "error": "Permission denied" });
    }

    serde_json::json!({
        "path": resolved,
        "entries": parse_ls_output(&out),
    })
}

/// List directory as root using the user's admin password.
/// Fast-paths through `std::fs::read_dir` when the process can already read
/// the target (avoids an extra subprocess for directories accessible as root).
async fn sudo_list_directory(path: &str, password: &str) -> serde_json::Value {
    let am_root = unsafe { libc::geteuid() } == 0;

    let dir = Path::new(path);
    if let Ok(canonical) = dir.canonicalize()
        && std::fs::read_dir(&canonical).is_ok()
    {
        let resolved = canonical.to_string_lossy().to_string();
        let entries: Vec<serde_json::Value> = match std::fs::read_dir(&canonical) {
            Ok(rd) => rd.filter_map(|e| e.ok()).map(|entry| {
                let meta = entry.path().symlink_metadata().ok();
                serde_json::json!({
                    "name": entry.file_name().to_string_lossy(),
                    "type": meta.as_ref().map(|m| {
                        if m.is_symlink() { "symlink" }
                        else if m.is_dir() { "directory" }
                        else { "file" }
                    }).unwrap_or("unknown"),
                    "size": meta.as_ref().map(|m| m.len()).unwrap_or(0),
                })
            }).collect(),
            Err(e) => return serde_json::json!({ "error": format!("cannot read directory: {e}") }),
        };
        return serde_json::json!({ "path": resolved, "entries": entries });
    }

    let resolved = if am_root {
        run_cmd(&["readlink", "-f", "--", path]).await
    } else {
        sudo_cmd(password, &["readlink", "-f", "--", path]).await
    };
    let resolved = resolved.trim();
    if resolved.is_empty() || resolved.starts_with("error:") {
        return serde_json::json!({ "error": format!("cannot resolve path: {path}") });
    }

    let out = if am_root {
        run_cmd(&["ls", "-laH", "--time-style=long-iso", "--", resolved]).await
    } else {
        sudo_cmd(password, &["ls", "-laH", "--time-style=long-iso", "--", resolved]).await
    };

    if out.contains("Permission denied") || out.starts_with("error:") {
        return serde_json::json!({ "error": "Permission denied" });
    }

    serde_json::json!({
        "path": resolved,
        "entries": parse_ls_output(&out),
    })
}

/// Parse `ls -laH --time-style=long-iso` output into JSON entry list.
/// Skips `.` and `..`.  First line (total …) is also skipped.
fn parse_ls_output(out: &str) -> Vec<serde_json::Value> {
    let mut entries = Vec::new();
    for line in out.lines().skip(1) {
        let parts: Vec<&str> = line.splitn(8, char::is_whitespace)
            .filter(|s| !s.is_empty())
            .collect();
        if parts.len() < 7 { continue; }
        let perms = parts[0];
        let size_str = parts[3];
        let name = extract_filename(line);
        if name.is_empty() || name == "." || name == ".." { continue; }
        let ftype = if perms.starts_with('d') { "directory" }
            else if perms.starts_with('l') { "symlink" }
            else { "file" };
        let size: u64 = size_str.parse().unwrap_or(0);
        entries.push(serde_json::json!({ "name": name, "type": ftype, "size": size }));
    }
    entries
}

/// Validate that a string is a safe Unix username (no shell metacharacters).
/// Sufficient because the value is passed as a Command argument, not through
/// a shell — but we validate anyway as a defence-in-depth measure.
fn is_valid_username(user: &str) -> bool {
    !user.is_empty()
        && user.len() <= 64
        && !user.starts_with('-')
        && user.chars().all(|c| c.is_alphanumeric() || c == '_' || c == '-' || c == '.')
}

/// Extract the filename from an `ls -la` output line.
/// Format: `drwxr-xr-x 2 root root 4096 2025-03-10 12:00 filename with spaces`
fn extract_filename(line: &str) -> String {
    let mut fields_skipped = 0;
    let mut chars = line.char_indices();
    let mut in_field = false;

    for (i, c) in &mut chars {
        if c.is_whitespace() {
            if in_field {
                fields_skipped += 1;
                in_field = false;
                if fields_skipped == 7 {
                    let rest = &line[i..].trim_start();
                    if let Some(arrow) = rest.find(" -> ") {
                        return rest[..arrow].to_string();
                    }
                    return rest.to_string();
                }
            }
        } else {
            in_field = true;
        }
    }
    String::new()
}

async fn sudo_cmd(password: &str, args: &[&str]) -> String {
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
        drop(stdin);
    }

    match child.wait_with_output().await {
        Ok(out) => {
            let stdout = String::from_utf8_lossy(&out.stdout).to_string();
            if stdout.is_empty() {
                let stderr = String::from_utf8_lossy(&out.stderr).to_string();
                stderr
                    .lines()
                    .filter(|l| !l.contains("[sudo]") && !l.contains("password for"))
                    .collect::<Vec<_>>()
                    .join("\n")
            } else {
                stdout
            }
        }
        Err(e) => format!("error: {e}"),
    }
}
