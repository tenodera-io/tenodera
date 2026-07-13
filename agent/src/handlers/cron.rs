use crate::handler::ChannelHandler;
use crate::util::{require_admin, sudo_stdin_write};
use serde::Serialize;
use serde_json::{Value, json};
use tenodera_protocol::channel::ChannelOpenOptions;
use tenodera_protocol::message::Message;
use tokio::fs;

// ── List handler ──────────────────────────────────────────────────────────────

pub struct CronListHandler;

#[async_trait::async_trait]
impl ChannelHandler for CronListHandler {
    fn payload_type(&self) -> &str {
        "cron.list"
    }

    async fn open(&self, channel: &str, _options: &ChannelOpenOptions) -> Vec<Message> {
        let data = list_cron_jobs().await;
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

// ── Manage handler ────────────────────────────────────────────────────────────

pub struct CronManageHandler;

#[async_trait::async_trait]
impl ChannelHandler for CronManageHandler {
    fn payload_type(&self) -> &str {
        "cron.manage"
    }

    // One-shot: action arrives in Open options, handler responds and closes.
    async fn open(&self, channel: &str, options: &ChannelOpenOptions) -> Vec<Message> {
        let data = Value::Object(options.extra.clone());
        let action = data.get("action").and_then(|a| a.as_str()).unwrap_or("");
        let user = data.get("_user").and_then(|u| u.as_str()).unwrap_or("");
        let password = data.get("password").and_then(|v| v.as_str()).unwrap_or("");

        let result = if let Some(err) = require_admin(&data) {
            err
        } else {
            match action {
                "set_user_crontab" => {
                    let target = data
                        .get("target_user")
                        .and_then(|v| v.as_str())
                        .unwrap_or(user);
                    let content = data.get("content").and_then(|v| v.as_str()).unwrap_or("");
                    if !is_safe_username(target) {
                        json!({ "ok": false, "error": "invalid username" })
                    } else {
                        let r =
                            sudo_stdin_write(password, &["crontab", "-u", target, "-"], content)
                                .await;
                        let ok = r.get("ok").and_then(|v| v.as_bool()).unwrap_or(false);
                        crate::audit::log(user, "cron.set", target, ok, "");
                        r
                    }
                }
                "write_system_file" => {
                    let path = data.get("path").and_then(|v| v.as_str()).unwrap_or("");
                    let content = data.get("content").and_then(|v| v.as_str()).unwrap_or("");
                    if !is_safe_cron_path(path) {
                        json!({ "ok": false, "error": "invalid path" })
                    } else {
                        let r = sudo_stdin_write(password, &["tee", path], content).await;
                        let ok = r.get("ok").and_then(|v| v.as_bool()).unwrap_or(false);
                        crate::audit::log(user, "cron.write", path, ok, "");
                        r
                    }
                }
                _ => json!({ "ok": false, "error": format!("unknown action: {action}") }),
            }
        };

        vec![
            Message::Ready {
                channel: channel.into(),
            },
            Message::Data {
                channel: channel.into(),
                data: result,
            },
            Message::Close {
                channel: channel.into(),
                problem: None,
            },
        ]
    }
}

// ── Data structures ───────────────────────────────────────────────────────────

#[derive(Serialize)]
struct CronSource {
    source: String,
    path: String,
    source_type: String,
    user: Option<String>,
    content: String,
    entries: Vec<CronEntry>,
}

#[derive(Serialize)]
struct CronEntry {
    schedule: String,
    user: String,
    command: String,
    comment: String,
}

// ── Main logic ────────────────────────────────────────────────────────────────

async fn list_cron_jobs() -> Value {
    let mut sources: Vec<CronSource> = Vec::new();

    // /etc/crontab
    if let Ok(content) = fs::read_to_string("/etc/crontab").await {
        let entries = parse_system_crontab(&content);
        sources.push(CronSource {
            source: "/etc/crontab".into(),
            path: "/etc/crontab".into(),
            source_type: "system_file".into(),
            user: None,
            content,
            entries,
        });
    }

    // /etc/cron.d/*
    if let Ok(mut dir) = fs::read_dir("/etc/cron.d").await {
        let mut files: Vec<String> = Vec::new();
        while let Ok(Some(entry)) = dir.next_entry().await {
            let name = entry.file_name().to_string_lossy().to_string();
            if !name.starts_with('.') && !name.ends_with('~') {
                files.push(name);
            }
        }
        files.sort();
        for name in files {
            let path = format!("/etc/cron.d/{name}");
            if let Ok(content) = fs::read_to_string(&path).await {
                let entries = parse_system_crontab(&content);
                sources.push(CronSource {
                    source: format!("/etc/cron.d/{name}"),
                    path,
                    source_type: "system_file".into(),
                    user: None,
                    content,
                    entries,
                });
            }
        }
    }

    // User crontabs — list from /var/spool/cron/crontabs/ (needs root)
    let crontab_users = get_crontab_users().await;
    for username in crontab_users {
        let out = tokio::process::Command::new("sudo")
            .args(["-n", "crontab", "-u", &username, "-l"])
            .output()
            .await;
        if let Ok(out) = out
            && out.status.success()
        {
            let content = String::from_utf8_lossy(&out.stdout).to_string();
            if !content.trim().is_empty() && !content.trim_start().starts_with("no crontab") {
                let entries = parse_user_crontab(&content, &username);
                sources.push(CronSource {
                    source: format!("crontab:{username}"),
                    path: String::new(),
                    source_type: "user_crontab".into(),
                    user: Some(username),
                    content,
                    entries,
                });
            }
        }
    }

    json!({ "sources": sources })
}

async fn get_crontab_users() -> Vec<String> {
    // Try direct read first (works if we're root)
    if let Ok(mut dir) = fs::read_dir("/var/spool/cron/crontabs").await {
        let mut users = Vec::new();
        while let Ok(Some(entry)) = dir.next_entry().await {
            users.push(entry.file_name().to_string_lossy().to_string());
        }
        if !users.is_empty() {
            users.sort();
            return users;
        }
    }
    // Fallback: sudo ls
    if let Ok(out) = tokio::process::Command::new("sudo")
        .args(["-n", "ls", "/var/spool/cron/crontabs"])
        .output()
        .await
        && out.status.success()
    {
        let mut users: Vec<String> = String::from_utf8_lossy(&out.stdout)
            .lines()
            .filter(|l| !l.is_empty())
            .map(|l| l.to_string())
            .collect();
        users.sort();
        return users;
    }
    Vec::new()
}

// ── Crontab parsers ───────────────────────────────────────────────────────────

fn parse_system_crontab(content: &str) -> Vec<CronEntry> {
    let mut entries = Vec::new();
    let mut pending_comment = String::new();

    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with('#') {
            let c = trimmed.trim_start_matches('#').trim();
            if !c.is_empty() {
                if !pending_comment.is_empty() {
                    pending_comment.push(' ');
                }
                pending_comment.push_str(c);
            }
            continue;
        }
        if trimmed.is_empty() {
            pending_comment.clear();
            continue;
        }
        // Skip env var assignments
        if let Some(eq) = trimmed.find('=') {
            let before = &trimmed[..eq];
            if before
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '_')
            {
                pending_comment.clear();
                continue;
            }
        }
        if let Some(entry) = parse_system_line(trimmed, &pending_comment) {
            entries.push(entry);
        }
        pending_comment.clear();
    }
    entries
}

fn parse_user_crontab(content: &str, username: &str) -> Vec<CronEntry> {
    let mut entries = Vec::new();
    let mut pending_comment = String::new();

    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with('#') {
            let c = trimmed.trim_start_matches('#').trim();
            if !c.is_empty() {
                if !pending_comment.is_empty() {
                    pending_comment.push(' ');
                }
                pending_comment.push_str(c);
            }
            continue;
        }
        if trimmed.is_empty() {
            pending_comment.clear();
            continue;
        }
        if let Some(eq) = trimmed.find('=') {
            let before = &trimmed[..eq];
            if before
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '_')
            {
                pending_comment.clear();
                continue;
            }
        }
        if let Some(entry) = parse_user_line(trimmed, username, &pending_comment) {
            entries.push(entry);
        }
        pending_comment.clear();
    }
    entries
}

fn parse_system_line(line: &str, comment: &str) -> Option<CronEntry> {
    let tokens: Vec<&str> = line.split_whitespace().collect();
    if tokens.is_empty() {
        return None;
    }

    if tokens[0].starts_with('@') {
        // @special user command...
        if tokens.len() < 3 {
            return None;
        }
        return Some(CronEntry {
            schedule: tokens[0].to_string(),
            user: tokens[1].to_string(),
            command: tokens[2..].join(" "),
            comment: comment.to_string(),
        });
    }

    // min hour dom month dow user command...
    if tokens.len() < 7 {
        return None;
    }
    Some(CronEntry {
        schedule: tokens[..5].join(" "),
        user: tokens[5].to_string(),
        command: tokens[6..].join(" "),
        comment: comment.to_string(),
    })
}

fn parse_user_line(line: &str, username: &str, comment: &str) -> Option<CronEntry> {
    let tokens: Vec<&str> = line.split_whitespace().collect();
    if tokens.is_empty() {
        return None;
    }

    if tokens[0].starts_with('@') {
        if tokens.len() < 2 {
            return None;
        }
        return Some(CronEntry {
            schedule: tokens[0].to_string(),
            user: username.to_string(),
            command: tokens[1..].join(" "),
            comment: comment.to_string(),
        });
    }

    if tokens.len() < 6 {
        return None;
    }
    Some(CronEntry {
        schedule: tokens[..5].join(" "),
        user: username.to_string(),
        command: tokens[5..].join(" "),
        comment: comment.to_string(),
    })
}

// ── Validation ────────────────────────────────────────────────────────────────

fn is_safe_cron_path(path: &str) -> bool {
    use std::path::Path;
    let p = Path::new(path);
    if p == Path::new("/etc/crontab") {
        return true;
    }
    if let Some(parent) = p.parent()
        && parent == Path::new("/etc/cron.d")
        && let Some(name) = p.file_name()
    {
        let name = name.to_string_lossy();
        return name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "-_.".contains(c));
    }
    false
}

fn is_safe_username(name: &str) -> bool {
    !name.is_empty()
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "-_.".contains(c))
}
