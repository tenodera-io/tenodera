use std::path::{Path, PathBuf};

use tenodera_protocol::channel::ChannelOpenOptions;
use tenodera_protocol::message::Message;

use crate::handler::ChannelHandler;

pub struct LogFilesHandler;

#[async_trait::async_trait]
impl ChannelHandler for LogFilesHandler {
    fn payload_type(&self) -> &str {
        "log.files"
    }

    async fn open(&self, channel: &str, _options: &ChannelOpenOptions) -> Vec<Message> {
        // Only send Ready — keep channel open for bidirectional commands.
        vec![Message::Ready { channel: channel.to_string() }]
    }

    async fn data(&self, channel: &str, data: &serde_json::Value) -> Vec<Message> {
        let action = data.get("action").and_then(|a| a.as_str()).unwrap_or("");

        let result = match action {
            "list" | "refresh" => {
                let files = list_log_files("/var/log").await;
                serde_json::json!({ "files": files })
            }
            "tail" => {
                let path = data.get("path").and_then(|p| p.as_str()).unwrap_or("");
                let lines = data.get("lines").and_then(|n| n.as_u64()).unwrap_or(100);
                tail_log(path, lines).await
            }
            "search" => {
                let path = data.get("path").and_then(|p| p.as_str()).unwrap_or("");
                let query = data.get("query").and_then(|q| q.as_str()).unwrap_or("");
                let lines = data.get("lines").and_then(|n| n.as_u64()).unwrap_or(100);
                let before = data.get("before").and_then(|n| n.as_u64()).unwrap_or(0);
                let after = data.get("after").and_then(|n| n.as_u64()).unwrap_or(0);
                let date_from = data.get("date_from").and_then(|d| d.as_str());
                let date_to = data.get("date_to").and_then(|d| d.as_str());
                let no_limit = date_from.is_some() || date_to.is_some();
                search_log(path, query, lines, before, after, date_from, date_to, no_limit).await
            }
            "filter" => {
                // Date-only filtering: read file, filter lines by timestamp
                let path = data.get("path").and_then(|p| p.as_str()).unwrap_or("");
                let date_from = data.get("date_from").and_then(|d| d.as_str());
                let date_to = data.get("date_to").and_then(|d| d.as_str());
                filter_by_date(path, date_from, date_to).await
            }
            _ => serde_json::json!({ "ok": false, "error": format!("unknown action: {action}") }),
        };

        vec![Message::Data {
            channel: channel.to_string(),
            data: serde_json::json!({ "type": "response", "action": action, "data": result }),
        }]
    }
}

// ── List log files recursively ──────────────────────────────────────────────

async fn list_log_files(base: &str) -> Vec<serde_json::Value> {
    let mut files = Vec::new();
    let mut dirs_to_scan: Vec<(PathBuf, u32)> = vec![(PathBuf::from(base), 0)];

    while let Some((dir, depth)) = dirs_to_scan.pop() {
        if depth > 4 {
            continue;
        }
        let mut entries = match tokio::fs::read_dir(&dir).await {
            Ok(e) => e,
            Err(_) => continue,
        };
        while let Ok(Some(entry)) = entries.next_entry().await {
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().to_string();
            let meta = match entry.metadata().await {
                Ok(m) => m,
                Err(_) => continue,
            };
            if meta.is_dir() {
                dirs_to_scan.push((path, depth + 1));
            } else if is_log_file(&name) {
                let modified = meta
                    .modified()
                    .ok()
                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|d| d.as_secs())
                    .unwrap_or(0);
                files.push(serde_json::json!({
                    "path": path.to_string_lossy(),
                    "name": name,
                    "size_bytes": meta.len(),
                    "modified": modified,
                }));
            }
        }
    }

    files.sort_by(|a, b| {
        let na = a.get("path").and_then(|v| v.as_str()).unwrap_or("");
        let nb = b.get("path").and_then(|v| v.as_str()).unwrap_or("");
        na.cmp(nb)
    });
    files
}

fn is_log_file(name: &str) -> bool {
    // Include common log extensions and rotated logs
    if name.ends_with(".gz") || name.ends_with(".xz") || name.ends_with(".bz2") {
        return false; // compressed archives — skip for now
    }
    name.ends_with(".log")
        || name.ends_with(".err")
        || name.ends_with(".out")
        || name.contains(".log.")  // rotated: syslog.1, kern.log.2
        || name == "syslog"
        || name == "messages"
        || name == "dmesg"
        || name == "kern.log"
        || name == "auth.log"
        || name == "daemon.log"
        || name == "lastlog"
        || name == "wtmp"
        || name == "btmp"
        || name == "faillog"
        || name == "mail.log"
        || name == "mail.err"
        || name == "cron.log"
        || name.starts_with("syslog")
        || name.starts_with("messages")
        || name.starts_with("secure")
        || name.starts_with("maillog")
}

// ── Path validation ─────────────────────────────────────────────────────────

fn validate_log_path(path: &str) -> Result<PathBuf, String> {
    let p = Path::new(path);
    if !p.is_absolute() || path.contains("..") {
        return Err("invalid path".into());
    }
    if !path.starts_with("/var/log") {
        return Err("path must be under /var/log".into());
    }
    Ok(p.to_path_buf())
}

// ── Tail: read last N lines ─────────────────────────────────────────────────

async fn tail_log(path: &str, lines: u64) -> serde_json::Value {
    let log_path = match validate_log_path(path) {
        Ok(p) => p,
        Err(e) => return serde_json::json!({ "ok": false, "error": e }),
    };

    // Use `tail` command — efficient for large files
    let output = tokio::process::Command::new("tail")
        .args(["-n", &lines.min(10000).to_string(), log_path.to_str().unwrap_or("")])
        .output()
        .await;

    match output {
        Ok(out) if out.status.success() => {
            let content = String::from_utf8_lossy(&out.stdout);
            let result_lines: Vec<&str> = content.lines().collect();
            serde_json::json!({
                "ok": true,
                "path": path,
                "total_lines": result_lines.len(),
                "lines": result_lines,
            })
        }
        Ok(out) => {
            // May fail due to permissions — try with sudo fallback info
            let stderr = String::from_utf8_lossy(&out.stderr);
            serde_json::json!({ "ok": false, "error": stderr.trim() })
        }
        Err(e) => serde_json::json!({ "ok": false, "error": e.to_string() }),
    }
}

// ── Search: grep with context, optional date filtering ──────────────────────

#[allow(clippy::too_many_arguments)]
async fn search_log(
    path: &str,
    query: &str,
    max_lines: u64,
    before: u64,
    after: u64,
    date_from: Option<&str>,
    date_to: Option<&str>,
    no_limit: bool,
) -> serde_json::Value {
    let log_path = match validate_log_path(path) {
        Ok(p) => p,
        Err(e) => return serde_json::json!({ "ok": false, "error": e }),
    };

    if query.is_empty() {
        return serde_json::json!({ "ok": false, "error": "query is empty" });
    }

    // Sanitize: limit context lines
    let before = before.min(50);
    let after = after.min(50);
    let max_lines = if no_limit { 0 } else { max_lines.min(10000) };

    // If date filtering requested, we do it in Rust after grep output
    // Use grep for the text search (fast, handles large files)
    let mut cmd = tokio::process::Command::new("grep");
    cmd.args(["-n", "-i"]); // line numbers, case insensitive

    if before > 0 || after > 0 {
        cmd.arg(format!("-B{before}"));
        cmd.arg(format!("-A{after}"));
    }

    // Max count for safety (skip if date filter → no_limit)
    if max_lines > 0 {
        cmd.arg(format!("-m{}", max_lines));
    }

    // Use fixed string matching for safety (no regex injection)
    cmd.arg("-F");
    cmd.arg(query);
    cmd.arg(log_path.to_str().unwrap_or(""));

    let output = cmd.output().await;

    match output {
        Ok(out) => {
            let content = String::from_utf8_lossy(&out.stdout);

            // Parse grep output into structured matches
            let matches = parse_grep_output(&content, date_from, date_to);
            let match_count = matches.len();

            serde_json::json!({
                "ok": true,
                "path": path,
                "query": query,
                "match_count": match_count,
                "matches": matches,
            })
        }
        Err(e) => serde_json::json!({ "ok": false, "error": e.to_string() }),
    }
}

// ── Filter by date: read file, keep only lines within date range ───────────

async fn filter_by_date(
    path: &str,
    date_from: Option<&str>,
    date_to: Option<&str>,
) -> serde_json::Value {
    let log_path = match validate_log_path(path) {
        Ok(p) => p,
        Err(e) => return serde_json::json!({ "ok": false, "error": e }),
    };

    let from_ts = date_from.and_then(|d| parse_filter_date(d, true));
    let to_ts = date_to.and_then(|d| parse_filter_date(d, false));

    if from_ts.is_none() && to_ts.is_none() {
        return serde_json::json!({ "ok": false, "error": "no date range specified" });
    }

    // Read the file with `cat` (respects permissions like other commands)
    let output = tokio::process::Command::new("cat")
        .arg(log_path.to_str().unwrap_or(""))
        .output()
        .await;

    match output {
        Ok(out) if out.status.success() => {
            let content = String::from_utf8_lossy(&out.stdout);
            let mut filtered: Vec<serde_json::Value> = Vec::new();

            for (i, line) in content.lines().enumerate() {
                let line_num = (i + 1) as u64;
                if let Some(ts) = extract_timestamp(line) {
                    if let Some(from) = from_ts
                        && ts < from { continue; }
                    if let Some(to) = to_ts
                        && ts > to { continue; }
                    filtered.push(serde_json::json!({
                        "num": line_num,
                        "text": line,
                    }));
                } else {
                    // Lines without timestamps: include if adjacent to included lines
                    // (continuation lines, stack traces, etc.)
                    if !filtered.is_empty() {
                        filtered.push(serde_json::json!({
                            "num": line_num,
                            "text": line,
                        }));
                    }
                }
            }

            serde_json::json!({
                "ok": true,
                "path": path,
                "total_lines": filtered.len(),
                "lines": filtered,
            })
        }
        Ok(out) => {
            let stderr = String::from_utf8_lossy(&out.stderr);
            serde_json::json!({ "ok": false, "error": stderr.trim() })
        }
        Err(e) => serde_json::json!({ "ok": false, "error": e.to_string() }),
    }
}

/// Parse grep -n output (with optional -B/-A context) into grouped matches.
/// Each match group is separated by "--" in grep output.
/// Line format: "123:matched line" or "123-context line"
fn parse_grep_output(
    output: &str,
    date_from: Option<&str>,
    date_to: Option<&str>,
) -> Vec<serde_json::Value> {
    let from_ts = date_from.and_then(|d| parse_filter_date(d, true));
    let to_ts = date_to.and_then(|d| parse_filter_date(d, false));
    let has_date_filter = from_ts.is_some() || to_ts.is_some();

    let mut groups: Vec<Vec<serde_json::Value>> = Vec::new();
    let mut current_group: Vec<serde_json::Value> = Vec::new();

    for line in output.lines() {
        if line == "--" {
            if !current_group.is_empty() {
                groups.push(std::mem::take(&mut current_group));
            }
            continue;
        }

        // Parse "123:text" (match) or "123-text" (context)
        let (line_num, is_match, text) = parse_grep_line(line);

        if has_date_filter
            && let Some(line_ts) = extract_timestamp(text) {
                if let Some(from) = from_ts
                    && line_ts < from {
                        continue;
                    }
                if let Some(to) = to_ts
                    && line_ts > to {
                        continue;
                    }
            }
            // Lines without parseable dates pass through when date filter active

        current_group.push(serde_json::json!({
            "num": line_num,
            "match": is_match,
            "text": text,
        }));
    }

    if !current_group.is_empty() {
        groups.push(current_group);
    }

    groups
        .into_iter()
        .map(|lines| serde_json::json!({ "lines": lines }))
        .collect()
}

fn parse_grep_line(line: &str) -> (u64, bool, &str) {
    // Match line: "123:some text"
    // Context line: "123-some text"
    if let Some(colon_pos) = line.find(':') {
        let num_part = &line[..colon_pos];
        if let Ok(num) = num_part.parse::<u64>() {
            return (num, true, &line[colon_pos + 1..]);
        }
    }
    if let Some(dash_pos) = line.find('-') {
        let num_part = &line[..dash_pos];
        if let Ok(num) = num_part.parse::<u64>() {
            return (num, false, &line[dash_pos + 1..]);
        }
    }
    (0, false, line)
}

// ── Date/timestamp parsing (multi-format) ───────────────────────────────────
//
// Supported formats detected in log lines:
// 1. Syslog:    "Mar 23 14:30:01"           (no year — assume current year)
// 2. ISO:       "2026-03-23T14:30:01"       or "2026-03-23 14:30:01"
// 3. Apache:    "23/Mar/2026:14:30:01"
// 4. Numeric:   "2026/03/23 14:30:01"
// 5. sssd/misc: "03/23/2026 14:30:01"

/// Parse a user-supplied date filter string (YYYY-MM-DD or YYYY-MM-DD HH:MM:SS).
fn parse_filter_date(s: &str, is_start: bool) -> Option<i64> {
    // Try "YYYY-MM-DD HH:MM:SS"
    if let Ok(dt) = chrono::NaiveDateTime::parse_from_str(s, "%Y-%m-%d %H:%M:%S") {
        return Some(dt.and_utc().timestamp());
    }
    // Try "YYYY-MM-DD" with start/end of day
    if let Ok(d) = chrono::NaiveDate::parse_from_str(s, "%Y-%m-%d") {
        let time = if is_start {
            chrono::NaiveTime::from_hms_opt(0, 0, 0).unwrap()
        } else {
            chrono::NaiveTime::from_hms_opt(23, 59, 59).unwrap()
        };
        return Some(d.and_time(time).and_utc().timestamp());
    }
    None
}

/// Attempt to extract a UTC timestamp (seconds) from the beginning of a log line.
fn extract_timestamp(line: &str) -> Option<i64> {
    let line = line.trim();
    if line.len() < 10 {
        return None;
    }

    // 1. ISO: "2026-03-23T14:30:01" or "2026-03-23 14:30:01"
    if line.as_bytes().get(4) == Some(&b'-') && line.as_bytes().get(7) == Some(&b'-') {
        let candidate = if line.len() >= 19 {
            &line[..19]
        } else {
            &line[..10]
        };
        if let Ok(dt) = chrono::NaiveDateTime::parse_from_str(candidate, "%Y-%m-%dT%H:%M:%S") {
            return Some(dt.and_utc().timestamp());
        }
        if let Ok(dt) = chrono::NaiveDateTime::parse_from_str(candidate, "%Y-%m-%d %H:%M:%S") {
            return Some(dt.and_utc().timestamp());
        }
        if let Ok(d) = chrono::NaiveDate::parse_from_str(&line[..10], "%Y-%m-%d") {
            return Some(
                d.and_time(chrono::NaiveTime::from_hms_opt(0, 0, 0).unwrap())
                    .and_utc()
                    .timestamp(),
            );
        }
    }

    // 2. Syslog: "Mar 23 14:30:01" (first 15 chars)
    if line.len() >= 15 {
        let syslog_part = &line[..15];
        let current_year = chrono::Utc::now().format("%Y").to_string();
        let with_year = format!("{current_year} {syslog_part}");
        if let Ok(dt) = chrono::NaiveDateTime::parse_from_str(&with_year, "%Y %b %d %H:%M:%S") {
            return Some(dt.and_utc().timestamp());
        }
        // Single-digit day: "Mar  3 14:30:01"
        if let Ok(dt) = chrono::NaiveDateTime::parse_from_str(&with_year, "%Y %b  %d %H:%M:%S") {
            return Some(dt.and_utc().timestamp());
        }
    }

    // 3. Apache: "23/Mar/2026:14:30:01" — typically inside []
    if let Some(bracket_start) = line.find('[') {
        let after = &line[bracket_start + 1..];
        if let Some(bracket_end) = after.find(']') {
            let inside = &after[..bracket_end];
            // "23/Mar/2026:14:30:01 +0000"
            if let Ok(dt) = chrono::NaiveDateTime::parse_from_str(
                inside.split_whitespace().next().unwrap_or(""),
                "%d/%b/%Y:%H:%M:%S",
            ) {
                return Some(dt.and_utc().timestamp());
            }
        }
    }

    // 4. Numeric: "2026/03/23 14:30:01"
    if line.as_bytes().get(4) == Some(&b'/') && line.len() >= 19
        && let Ok(dt) = chrono::NaiveDateTime::parse_from_str(&line[..19], "%Y/%m/%d %H:%M:%S") {
            return Some(dt.and_utc().timestamp());
        }

    None
}
