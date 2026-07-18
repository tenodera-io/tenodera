use std::path::Path;

use tenodera_protocol::channel::ChannelOpenOptions;
use tenodera_protocol::message::Message;
use tokio::io::AsyncWriteExt;

use crate::handler::ChannelHandler;
use crate::util::{is_valid_username, lookup_user};

pub struct LogFilesHandler;

#[async_trait::async_trait]
impl ChannelHandler for LogFilesHandler {
    fn payload_type(&self) -> &str {
        "log.files"
    }

    async fn open(&self, channel: &str, _options: &ChannelOpenOptions) -> Vec<Message> {
        // Only send Ready — keep channel open for bidirectional commands.
        vec![Message::Ready {
            channel: channel.into(),
        }]
    }

    async fn data(&self, channel: &str, data: &serde_json::Value) -> Vec<Message> {
        let action = data.get("action").and_then(|a| a.as_str()).unwrap_or("");
        let password = data.get("password").and_then(|p| p.as_str()).unwrap_or("");
        // Reads under /var/log are privileged: run AS the logged-in user (their fs
        // permissions decide which logs they can read/list), no sudo. Superuser mode
        // escalates via `sudo` as that user. The gateway injects `_user` on every
        // message on this channel.
        let user = data.get("_user").and_then(|u| u.as_str()).unwrap_or("");

        let result = match action {
            "list" | "refresh" => list_log_files("/var/log", user, password).await,
            "tail" => {
                let path = data.get("path").and_then(|p| p.as_str()).unwrap_or("");
                let lines = data.get("lines").and_then(|n| n.as_u64()).unwrap_or(100);
                tail_log(path, lines, user, password).await
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
                search_log(
                    path, query, lines, before, after, date_from, date_to, no_limit, user, password,
                )
                .await
            }
            "filter" => {
                // Date-only filtering: read file, filter lines by timestamp
                let path = data.get("path").and_then(|p| p.as_str()).unwrap_or("");
                let date_from = data.get("date_from").and_then(|d| d.as_str());
                let date_to = data.get("date_to").and_then(|d| d.as_str());
                filter_by_date(path, date_from, date_to, user, password).await
            }
            _ => serde_json::json!({ "ok": false, "error": format!("unknown action: {action}") }),
        };

        vec![Message::Data {
            channel: channel.into(),
            data: serde_json::json!({ "type": "response", "action": action, "data": result }),
        }]
    }
}

// ── Per-user command brokering ──────────────────────────────────────────────

/// Outcome of a brokered command: the user has no account here, it ran (inspect the
/// `Output`), or it could not be spawned.
enum Brokered {
    NoAccount,
    Ran(std::process::Output),
    Failed(String),
}

/// Run `args` brokered to `user`. No password → drop to the user
/// (initgroups→setgid→setuid) and exec directly, so the kernel enforces *their* file
/// permissions. Password → drop to the user then exec `sudo -S <args>` (host sudoers
/// decides), feeding the password on stdin. A user unknown to this host → `NoAccount`.
async fn broker_output(user: &str, password: &str, args: &[&str]) -> Brokered {
    if !is_valid_username(user) {
        return Brokered::Failed("no session user".into());
    }
    let Some((uid, gid, _home, _shell)) = lookup_user(user) else {
        return Brokered::NoAccount;
    };
    let ucstr = match std::ffi::CString::new(user) {
        Ok(c) => c,
        Err(_) => return Brokered::Failed("invalid username".into()),
    };

    let use_sudo = !password.is_empty();
    let (program, rest): (&str, Vec<&str>) = if use_sudo {
        let mut v = vec!["-S"];
        v.extend_from_slice(args);
        ("sudo", v)
    } else {
        match args.split_first() {
            Some((first, r)) => (*first, r.to_vec()),
            None => return Brokered::Failed("no command".into()),
        }
    };

    let mut cmd = tokio::process::Command::new(program);
    cmd.args(&rest)
        .stdin(if use_sudo {
            std::process::Stdio::piped()
        } else {
            std::process::Stdio::null()
        })
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());

    // Drop to the user before exec (gid before uid; initgroups for supplementary
    // groups). When escalating, `sudo` is setuid-root and re-elevates per sudoers.
    unsafe {
        cmd.pre_exec(move || {
            if libc::initgroups(ucstr.as_ptr(), gid) != 0
                || libc::setgid(gid) != 0
                || libc::setuid(uid) != 0
            {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }

    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => return Brokered::Failed(e.to_string()),
    };
    if use_sudo && let Some(mut stdin) = child.stdin.take() {
        let _ = stdin.write_all(format!("{password}\n").as_bytes()).await;
        drop(stdin);
    }

    // Bound BOTH the output we buffer AND the wall-clock time. A read command pointed
    // at a pathological file (e.g. a ~200 GB sparse `lastlog`, or a multi-GB text log)
    // would otherwise either stream gigabytes into memory (OOM) or spend minutes
    // scanning input before producing any output (hang). We read at most OUT_CAP bytes,
    // draining both pipes concurrently to avoid a full-pipe deadlock, under a hard
    // deadline; whatever is still running is killed.
    const OUT_CAP: u64 = 64 << 20; // 64 MiB
    const ERR_CAP: u64 = 256 << 10; // 256 KiB
    const DEADLINE: std::time::Duration = std::time::Duration::from_secs(30);
    use tokio::io::AsyncReadExt;
    let out_pipe = child.stdout.take();
    let err_pipe = child.stderr.take();
    let drain = async move {
        let out_fut = async move {
            let mut buf = Vec::new();
            if let Some(p) = out_pipe {
                let _ = p.take(OUT_CAP).read_to_end(&mut buf).await;
            }
            buf
        };
        let err_fut = async move {
            let mut buf = Vec::new();
            if let Some(p) = err_pipe {
                let _ = p.take(ERR_CAP).read_to_end(&mut buf).await;
            }
            buf
        };
        tokio::join!(out_fut, err_fut)
    };

    // If the command takes too long to even produce its (capped) output, give up.
    let (stdout, stderr) = match tokio::time::timeout(DEADLINE, drain).await {
        Ok(pair) => pair,
        Err(_) => {
            let _ = child.start_kill();
            let _ = child.wait().await;
            return Brokered::Failed("read timed out (file too large or unreadable)".into());
        }
    };

    // Output drained (or hit the cap). Reap; if the child is still writing past the
    // cap, give it a short grace period then kill it so `wait` can't block.
    let status = match tokio::time::timeout(std::time::Duration::from_secs(5), child.wait()).await {
        Ok(Ok(s)) => s,
        Ok(Err(e)) => return Brokered::Failed(e.to_string()),
        Err(_) => {
            let _ = child.start_kill();
            match child.wait().await {
                Ok(s) => s,
                Err(e) => return Brokered::Failed(e.to_string()),
            }
        }
    };

    Brokered::Ran(std::process::Output {
        status,
        stdout,
        stderr,
    })
}

/// Filter sudo prompt noise from stderr and trim.
fn clean_stderr(stderr: &[u8]) -> String {
    String::from_utf8_lossy(stderr)
        .lines()
        .filter(|l| !l.contains("[sudo]") && !l.contains("password for"))
        .collect::<Vec<_>>()
        .join("\n")
        .trim()
        .to_string()
}

/// A brokered "restricted: no-account" response carrying an empty payload of `shape`.
fn no_account(extra: serde_json::Value) -> serde_json::Value {
    let mut v = serde_json::json!({ "restricted": true, "reason": "no-account" });
    if let (Some(obj), Some(ex)) = (v.as_object_mut(), extra.as_object()) {
        for (k, val) in ex {
            obj.insert(k.clone(), val.clone());
        }
    }
    v
}

// ── List log files recursively ──────────────────────────────────────────────

/// List log files under `base`, brokered to the user: `find` runs as them, so only
/// directories/files they can read appear (superuser sees everything via sudo). A
/// user with no account here → restricted.
async fn list_log_files(base: &str, user: &str, password: &str) -> serde_json::Value {
    // find exits non-zero when some dirs are unreadable but still prints the rest —
    // that partial output is exactly what we want (the files the user CAN see).
    let output = match broker_output(
        user,
        password,
        &[
            "find",
            base,
            "-maxdepth",
            "5",
            "-type",
            "f",
            "-printf",
            "%p\\t%s\\t%T@\\n",
        ],
    )
    .await
    {
        Brokered::NoAccount => return no_account(serde_json::json!({ "files": [] })),
        Brokered::Failed(e) => return serde_json::json!({ "files": [], "error": e }),
        Brokered::Ran(out) => String::from_utf8_lossy(&out.stdout).to_string(),
    };

    let mut files = Vec::new();
    for line in output.lines() {
        let parts: Vec<&str> = line.splitn(3, '\t').collect();
        if parts.len() < 3 {
            continue;
        }
        let path = parts[0];
        let name = Path::new(path)
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default();

        if !is_log_file(&name) {
            continue;
        }

        let size: u64 = parts[1].parse().unwrap_or(0);
        let modified: u64 = parts[2]
            .split('.')
            .next()
            .and_then(|s| s.parse().ok())
            .unwrap_or(0);

        files.push(serde_json::json!({
            "path": path,
            "name": name,
            "size_bytes": size,
            "modified": modified,
        }));
    }

    files.sort_by(|a, b| {
        let na = a.get("path").and_then(|v| v.as_str()).unwrap_or("");
        let nb = b.get("path").and_then(|v| v.as_str()).unwrap_or("");
        na.cmp(nb)
    });
    serde_json::json!({ "files": files })
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
        // NOTE: lastlog/wtmp/btmp/faillog are deliberately EXCLUDED — they are binary
        // databases (indexed by UID), not text logs. With high UIDs (e.g. FreeIPA's
        // ~716M) lastlog becomes a ~200 GB sparse file; tail/cat/grep on it scans and
        // buffers gigabytes → OOM. Use `last`/`lastb`/`lastlog` tooling instead.
        || name == "mail.log"
        || name == "mail.err"
        || name == "cron.log"
        || name.starts_with("syslog")
        || name.starts_with("messages")
        || name.starts_with("secure")
        || name.starts_with("maillog")
}

// ── Path validation ─────────────────────────────────────────────────────────

/// Validate a user-supplied log path: absolute, under /var/log, no traversal. We do
/// NOT canonicalize as root — the command runs AS the user, so the kernel is the real
/// gate; a symlink can only ever reach files that user (or their sudo) may already
/// read. Returns the validated path string.
fn validate_log_path(path: &str) -> Result<String, String> {
    if path.is_empty() || !Path::new(path).is_absolute() || path.contains("..") {
        return Err("invalid path".into());
    }
    if path != "/var/log" && !path.starts_with("/var/log/") {
        return Err("path must be under /var/log".into());
    }
    Ok(path.to_string())
}

/// Friendly error message from a failed brokered read (e.g. "Permission denied").
fn read_error(out: &std::process::Output) -> String {
    let e = clean_stderr(&out.stderr);
    if e.is_empty() {
        "command failed".into()
    } else {
        e
    }
}

// ── Tail: read last N lines ─────────────────────────────────────────────────

async fn tail_log(path: &str, lines: u64, user: &str, password: &str) -> serde_json::Value {
    let path = match validate_log_path(path) {
        Ok(p) => p,
        Err(e) => return serde_json::json!({ "ok": false, "error": e }),
    };
    let count = lines.min(10000).to_string();

    match broker_output(user, password, &["tail", "-n", &count, "--", &path]).await {
        Brokered::NoAccount => {
            no_account(serde_json::json!({ "ok": false, "error": "no account on this host" }))
        }
        Brokered::Failed(e) => serde_json::json!({ "ok": false, "error": e }),
        Brokered::Ran(out) if out.status.success() => {
            let content = String::from_utf8_lossy(&out.stdout);
            let result_lines: Vec<&str> = content.lines().collect();
            serde_json::json!({
                "ok": true,
                "path": path,
                "total_lines": result_lines.len(),
                "lines": result_lines,
            })
        }
        Brokered::Ran(out) => serde_json::json!({ "ok": false, "error": read_error(&out) }),
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
    user: &str,
    password: &str,
) -> serde_json::Value {
    let path = match validate_log_path(path) {
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

    // Build grep args (`--` ends options so a query starting with '-' is safe).
    let mut args: Vec<String> = vec!["grep".into(), "-n".into(), "-i".into()];
    if before > 0 || after > 0 {
        args.push(format!("-B{before}"));
        args.push(format!("-A{after}"));
    }
    if max_lines > 0 {
        args.push(format!("-m{max_lines}"));
    }
    args.push("-F".into());
    args.push("--".into());
    args.push(query.into());
    args.push(path.clone());

    let str_args: Vec<&str> = args.iter().map(|s| s.as_str()).collect();

    match broker_output(user, password, &str_args).await {
        Brokered::NoAccount => {
            no_account(serde_json::json!({ "ok": false, "error": "no account on this host" }))
        }
        Brokered::Failed(e) => serde_json::json!({ "ok": false, "error": e }),
        // grep: exit 0 = match, 1 = no match (both fine), 2+ = real error.
        Brokered::Ran(out) if out.status.success() || out.status.code() == Some(1) => {
            let content = String::from_utf8_lossy(&out.stdout);
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
        Brokered::Ran(out) => serde_json::json!({ "ok": false, "error": read_error(&out) }),
    }
}

// ── Filter by date: read file, keep only lines within date range ───────────

async fn filter_by_date(
    path: &str,
    date_from: Option<&str>,
    date_to: Option<&str>,
    user: &str,
    password: &str,
) -> serde_json::Value {
    let path = match validate_log_path(path) {
        Ok(p) => p,
        Err(e) => return serde_json::json!({ "ok": false, "error": e }),
    };

    let from_ts = date_from.and_then(|d| parse_filter_date(d, true));
    let to_ts = date_to.and_then(|d| parse_filter_date(d, false));

    if from_ts.is_none() && to_ts.is_none() {
        return serde_json::json!({ "ok": false, "error": "no date range specified" });
    }

    let content = match broker_output(user, password, &["cat", "--", &path]).await {
        Brokered::NoAccount => {
            return no_account(
                serde_json::json!({ "ok": false, "error": "no account on this host" }),
            );
        }
        Brokered::Failed(e) => return serde_json::json!({ "ok": false, "error": e }),
        Brokered::Ran(out) if out.status.success() => {
            String::from_utf8_lossy(&out.stdout).to_string()
        }
        Brokered::Ran(out) => return serde_json::json!({ "ok": false, "error": read_error(&out) }),
    };

    {
        let mut filtered: Vec<serde_json::Value> = Vec::new();

        for (i, line) in content.lines().enumerate() {
            let line_num = (i + 1) as u64;
            if let Some(ts) = extract_timestamp(line) {
                if let Some(from) = from_ts
                    && ts < from
                {
                    continue;
                }
                if let Some(to) = to_ts
                    && ts > to
                {
                    continue;
                }
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

        if has_date_filter && let Some(line_ts) = extract_timestamp(text) {
            if let Some(from) = from_ts
                && line_ts < from
            {
                continue;
            }
            if let Some(to) = to_ts
                && line_ts > to
            {
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
    if line.as_bytes().get(4) == Some(&b'/')
        && line.len() >= 19
        && let Ok(dt) = chrono::NaiveDateTime::parse_from_str(&line[..19], "%Y/%m/%d %H:%M:%S")
    {
        return Some(dt.and_utc().timestamp());
    }

    None
}
