use std::path::Path;

use tenodera_protocol::channel::ChannelOpenOptions;
use tenodera_protocol::message::Message;
use tokio::io::AsyncWriteExt;

use crate::handler::ChannelHandler;

pub struct FileListHandler;

#[async_trait::async_trait]
impl ChannelHandler for FileListHandler {
    fn payload_type(&self) -> &str {
        "file.list"
    }

    async fn open(&self, channel: &str, options: &ChannelOpenOptions) -> Vec<Message> {
        let path = options
            .extra
            .get("path")
            .and_then(|v| v.as_str())
            .unwrap_or("/");

        let password = options
            .extra
            .get("password")
            .and_then(|v| v.as_str())
            .unwrap_or("");

        let data = if password.is_empty() {
            list_directory(path)
        } else {
            sudo_list_directory(path, password).await
        };

        vec![
            Message::Ready {
                channel: channel.to_string(),
            },
            Message::Data {
                channel: channel.to_string(),
                data,
            },
            Message::Close {
                channel: channel.to_string(),
                problem: None,
            },
        ]
    }
}

fn list_directory(path: &str) -> serde_json::Value {
    let dir = Path::new(path);

    // Basic path traversal protection: resolve and verify prefix
    let canonical = match dir.canonicalize() {
        Ok(p) => p,
        Err(e) => {
            return serde_json::json!({ "error": format!("cannot resolve path: {e}") });
        }
    };

    let entries: Vec<serde_json::Value> = match std::fs::read_dir(&canonical) {
        Ok(rd) => rd
            .filter_map(|e| e.ok())
            .map(|entry| {
                let meta = entry.metadata().ok();
                serde_json::json!({
                    "name": entry.file_name().to_string_lossy(),
                    "type": meta.as_ref().map(|m| {
                        if m.is_dir() { "directory" }
                        else if m.is_symlink() { "symlink" }
                        else { "file" }
                    }).unwrap_or("unknown"),
                    "size": meta.as_ref().map(|m| m.len()).unwrap_or(0),
                })
            })
            .collect(),
        Err(e) => {
            return serde_json::json!({ "error": format!("cannot read directory: {e}") });
        }
    };

    serde_json::json!({
        "path": canonical.to_string_lossy(),
        "entries": entries,
    })
}

/// List directory using sudo — parses `ls -la` output.
async fn sudo_list_directory(path: &str, password: &str) -> serde_json::Value {
    // First try without sudo; fall back to sudo only on permission error
    let dir = Path::new(path);
    if let Ok(canonical) = dir.canonicalize()
        && std::fs::read_dir(&canonical).is_ok() {
            return list_directory(path);
        }

    // Resolve path via sudo
    let resolved = sudo_cmd(password, &["readlink", "-f", path]).await;
    let resolved = resolved.trim();
    if resolved.is_empty() || resolved.starts_with("error:") {
        return serde_json::json!({ "error": format!("cannot resolve path: {path}") });
    }

    let out = sudo_cmd(password, &["ls", "-laH", "--time-style=long-iso", resolved]).await;
    if out.contains("Permission denied") || out.starts_with("error:") {
        return serde_json::json!({ "error": format!("cannot read directory: Permission denied") });
    }

    let mut entries = Vec::new();
    for line in out.lines().skip(1) {
        // typical: drwxr-xr-x  2 root root 4096 2025-03-10 12:00 dirname
        let parts: Vec<&str> = line.splitn(8, char::is_whitespace)
            .filter(|s| !s.is_empty())
            .collect();
        if parts.len() < 7 {
            continue;
        }
        // After splitting permissions, links, owner, group, size, date, time — rest is name
        // Use a second approach: split from the right to get the filename
        let perms = parts[0];
        let size_str = parts[3];

        // Get filename: everything after the 7th whitespace-delimited field
        let name = extract_filename(line);
        if name.is_empty() || name == "." || name == ".." {
            continue;
        }

        let ftype = if perms.starts_with('d') {
            "directory"
        } else if perms.starts_with('l') {
            "symlink"
        } else {
            "file"
        };

        let size: u64 = size_str.parse().unwrap_or(0);
        entries.push(serde_json::json!({
            "name": name,
            "type": ftype,
            "size": size,
        }));
    }

    serde_json::json!({
        "path": resolved,
        "entries": entries,
    })
}

/// Extract the filename from an `ls -la` output line.
/// Format: `drwxr-xr-x 2 root root 4096 2025-03-10 12:00 filename with spaces`
fn extract_filename(line: &str) -> String {
    // Skip 7 whitespace-separated fields: perms, links, owner, group, size, date, time
    let mut fields_skipped = 0;
    let mut chars = line.char_indices();
    let mut in_field = false;

    for (i, c) in &mut chars {
        if c.is_whitespace() {
            if in_field {
                fields_skipped += 1;
                in_field = false;
                if fields_skipped == 7 {
                    // Everything from here (skip leading space) is the filename
                    let rest = &line[i..].trim_start();
                    // For symlinks: "name -> target" — only take the name part
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
