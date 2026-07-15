use std::path::Path;

use tenodera_protocol::channel::ChannelOpenOptions;
use tenodera_protocol::message::Message;

use crate::handler::ChannelHandler;
use crate::util::{is_valid_username, run_cmd, sudo_output_as_user};

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
        let user = options
            .extra
            .get("_user")
            .and_then(|v| v.as_str())
            .unwrap_or("");

        let data = if password.is_empty() {
            // No admin password — list as the requesting panel user so Linux
            // filesystem permissions apply naturally.
            list_as_user(path, user).await
        } else {
            // Admin password provided — elevate via sudo AS THE USER, so the host
            // decides whether they may list this directory.
            sudo_list_directory(path, user, password).await
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

    // Limited access is confined to the user's home directory.
    let home = Path::new("/home").join(user);
    if !canonical.starts_with(&home) {
        return serde_json::json!({ "error": "Limited access: restricted to your home directory" });
    }

    let resolved = canonical.to_string_lossy();

    let out = run_cmd(&[
        "sudo",
        "-n",
        "-u",
        user,
        "--",
        "ls",
        "-laH",
        "--time-style=long-iso",
        "--",
        &resolved,
    ])
    .await;

    if out.starts_with("error:") || out.contains("sudo:") || out.contains("Permission denied") {
        return serde_json::json!({ "error": "Permission denied" });
    }

    serde_json::json!({
        "path": resolved,
        "entries": parse_ls_output(&out),
    })
}

/// List a directory with elevated rights, running as the requesting user via sudo so
/// the host's rules decide. Always uses `ls -laH` (same as list_as_user) for
/// consistent field output.
async fn sudo_list_directory(path: &str, user: &str, password: &str) -> serde_json::Value {
    let canonical = match Path::new(path).canonicalize() {
        Ok(p) => p,
        Err(e) => return serde_json::json!({ "error": format!("cannot resolve path: {e}") }),
    };
    let resolved = canonical.to_string_lossy().to_string();

    let out = sudo_output_as_user(
        user,
        password,
        &["ls", "-laH", "--time-style=long-iso", "--", &resolved],
    )
    .await;

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
/// split_whitespace collapses padding spaces so multi-space size alignment
/// doesn't consume the splitn budget: perms[0] links[1] user[2] group[3] size[4]
fn parse_ls_output(out: &str) -> Vec<serde_json::Value> {
    let mut entries = Vec::new();
    for line in out.lines().skip(1) {
        let name = extract_filename(line);
        if name.is_empty() || name == "." || name == ".." {
            continue;
        }
        let parts: Vec<&str> = line.split_whitespace().collect();
        if parts.len() < 5 {
            continue;
        }
        let perms = parts[0];
        let user = parts[2];
        let group = parts[3];
        let size_str = parts[4];
        let ftype = if perms.starts_with('d') {
            "directory"
        } else if perms.starts_with('l') {
            "symlink"
        } else {
            "file"
        };
        let size: u64 = size_str.parse().unwrap_or(0);
        entries.push(serde_json::json!({
            "name":  name,
            "type":  ftype,
            "size":  size,
            "perms": perms,
            "user":  user,
            "group": group,
        }));
    }
    entries
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
