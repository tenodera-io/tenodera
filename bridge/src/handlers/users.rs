use tenodera_protocol::channel::ChannelOpenOptions;
use tenodera_protocol::message::Message;
use tokio::io::AsyncWriteExt;

use serde_json::{json, Value};

use crate::handler::ChannelHandler;

// ──────────────────────────────────────────────────────────────
//  User & group management handler
//  Manages Linux accounts via useradd/usermod/userdel/groupadd/etc.
// ──────────────────────────────────────────────────────────────

pub struct UsersManageHandler;

#[async_trait::async_trait]
impl ChannelHandler for UsersManageHandler {
    fn payload_type(&self) -> &str {
        "users.manage"
    }

    async fn open(&self, channel: &str, _options: &ChannelOpenOptions) -> Vec<Message> {
        vec![Message::Ready {
            channel: channel.to_string(),
        }]
    }

    async fn data(&self, channel: &str, data: &Value) -> Vec<Message> {
        let action = data.get("action").and_then(|a| a.as_str()).unwrap_or("");
        let password = data.get("password").and_then(|p| p.as_str()).unwrap_or("");
        let user = data.get("_user").and_then(|u| u.as_str()).unwrap_or("");

        let result = match action {
            // ── Read-only ──
            "list" => list_users().await,
            "list_groups" => list_groups().await,
            "list_shells" => list_shells().await,

            // ── User CRUD (requires sudo) ──
            "create" => {
                let r = create_user(data, password).await;
                let target = data.get("username").and_then(|v| v.as_str()).unwrap_or("");
                let ok = r.get("error").is_none();
                crate::audit::log(user, "user.create", target, ok, "");
                r
            }
            "modify" => {
                let r = modify_user(data, password).await;
                let target = data.get("username").and_then(|v| v.as_str()).unwrap_or("");
                let ok = r.get("error").is_none();
                crate::audit::log(user, "user.modify", target, ok, "");
                r
            }
            "delete" => {
                let target = data.get("username").and_then(|v| v.as_str()).unwrap_or("");
                let remove_home = data.get("remove_home").and_then(|v| v.as_bool()).unwrap_or(false);
                let r = delete_user(target, remove_home, password).await;
                let ok = r.get("error").is_none();
                crate::audit::log(user, "user.delete", target, ok, "");
                r
            }
            "lock" => {
                let target = data.get("username").and_then(|v| v.as_str()).unwrap_or("");
                let r = lock_user(target, password).await;
                let ok = r.get("error").is_none();
                crate::audit::log(user, "user.lock", target, ok, "");
                r
            }
            "unlock" => {
                let target = data.get("username").and_then(|v| v.as_str()).unwrap_or("");
                let r = unlock_user(target, password).await;
                let ok = r.get("error").is_none();
                crate::audit::log(user, "user.unlock", target, ok, "");
                r
            }
            "set_password" => {
                let target = data.get("username").and_then(|v| v.as_str()).unwrap_or("");
                let new_pw = data.get("new_password").and_then(|v| v.as_str()).unwrap_or("");
                let force_change = data.get("force_change").and_then(|v| v.as_bool()).unwrap_or(false);
                let r = set_password(target, new_pw, force_change, password).await;
                let ok = r.get("error").is_none();
                crate::audit::log(user, "user.set_password", target, ok, "");
                r
            }

            // ── Group management (requires sudo) ──
            "create_group" => {
                let name = data.get("name").and_then(|v| v.as_str()).unwrap_or("");
                let gid = data.get("gid").and_then(|v| v.as_u64()).map(|v| v as u32);
                let r = create_group(name, gid, password).await;
                let ok = r.get("error").is_none();
                crate::audit::log(user, "group.create", name, ok, "");
                r
            }
            "delete_group" => {
                let name = data.get("name").and_then(|v| v.as_str()).unwrap_or("");
                let r = delete_group(name, password).await;
                let ok = r.get("error").is_none();
                crate::audit::log(user, "group.delete", name, ok, "");
                r
            }

            _ => json!({ "error": format!("unknown action: {action}") }),
        };

        // Always echo back the action field so the frontend can match responses
        let mut result = result;
        if let Some(obj) = result.as_object_mut() {
            if !obj.contains_key("action") && !action.is_empty() {
                obj.insert("action".to_string(), json!(action));
            }
        }

        vec![Message::Data {
            channel: channel.to_string(),
            data: result,
        }]
    }
}

// ──────────────────────────────────────────────────────────────
//  List users
// ──────────────────────────────────────────────────────────────

async fn list_users() -> Value {
    // Parse /etc/passwd
    let passwd = match tokio::fs::read_to_string("/etc/passwd").await {
        Ok(c) => c,
        Err(e) => return json!({ "error": e.to_string() }),
    };

    // Parse /etc/group to build user→groups map
    let group_map = build_group_map().await;

    // Try to get lock status from passwd -S -a (may need root)
    let lock_map = build_lock_map().await;

    // Try to get last login times
    let lastlog_map = build_lastlog_map().await;

    let mut users = Vec::new();
    for line in passwd.lines() {
        let fields: Vec<&str> = line.split(':').collect();
        if fields.len() < 7 {
            continue;
        }
        let username = fields[0];
        let uid: u32 = fields[2].parse().unwrap_or(0);
        let gid: u32 = fields[3].parse().unwrap_or(0);
        let gecos = fields[4];
        let home = fields[5];
        let shell = fields[6];

        let groups = group_map.get(username).cloned().unwrap_or_default();
        let locked = lock_map.get(username).copied().unwrap_or(false);
        let last_login = lastlog_map.get(username).cloned().unwrap_or_default();

        users.push(json!({
            "username": username,
            "uid": uid,
            "gid": gid,
            "gecos": gecos,
            "home": home,
            "shell": shell,
            "groups": groups,
            "locked": locked,
            "system": uid < 1000 && uid != 0,
            "last_login": last_login,
        }));
    }

    json!({ "action": "list", "users": users })
}

async fn build_group_map() -> std::collections::HashMap<String, Vec<String>> {
    let mut map: std::collections::HashMap<String, Vec<String>> = std::collections::HashMap::new();
    if let Ok(content) = tokio::fs::read_to_string("/etc/group").await {
        for line in content.lines() {
            let fields: Vec<&str> = line.split(':').collect();
            if fields.len() < 4 {
                continue;
            }
            let group_name = fields[0];
            let members = fields[3];
            if members.is_empty() {
                continue;
            }
            for member in members.split(',') {
                let member = member.trim();
                if !member.is_empty() {
                    map.entry(member.to_string())
                        .or_default()
                        .push(group_name.to_string());
                }
            }
        }
    }
    map
}

async fn build_lock_map() -> std::collections::HashMap<String, bool> {
    let mut map = std::collections::HashMap::new();
    // Try reading /etc/shadow — if we have permission (running as root)
    if let Ok(content) = tokio::fs::read_to_string("/etc/shadow").await {
        for line in content.lines() {
            let fields: Vec<&str> = line.split(':').collect();
            if fields.len() < 2 {
                continue;
            }
            let username = fields[0];
            let pw_hash = fields[1];
            // Account is locked if password field starts with '!' or '*'
            let locked = pw_hash.starts_with('!') || pw_hash == "*" || pw_hash == "!!";
            map.insert(username.to_string(), locked);
        }
    } else {
        // Fallback: try passwd -S for each user (slow, but works without root)
        // Skip this for now — the frontend can handle missing lock status
    }
    map
}

async fn build_lastlog_map() -> std::collections::HashMap<String, String> {
    let mut map = std::collections::HashMap::new();
    // Use `lastlog` command if available
    let output = run_cmd(&["lastlog"]).await;
    for line in output.lines().skip(1) {
        // Format: "Username         Port     From             Latest"
        // or      "Username                          **Never logged in**"
        let parts: Vec<&str> = line.splitn(2, char::is_whitespace).collect();
        if parts.len() < 2 {
            continue;
        }
        let username = parts[0].trim();
        let rest = parts[1].trim();
        if rest.contains("**Never logged in**") {
            map.insert(username.to_string(), "Never".to_string());
        } else {
            // Extract the date part (last field after "From" column)
            // Try to get the last meaningful timestamp
            let trimmed = rest.trim();
            // The date is typically at the end, like "Mon Mar 24 10:30:00 +0000 2026"
            // We'll look for a pattern that starts with a weekday
            if let Some(pos) = find_date_start(trimmed) {
                map.insert(username.to_string(), trimmed[pos..].trim().to_string());
            } else if !trimmed.is_empty() {
                map.insert(username.to_string(), trimmed.to_string());
            }
        }
    }
    map
}

fn find_date_start(s: &str) -> Option<usize> {
    // Look for common weekday abbreviations that indicate start of date
    let weekdays = ["Mon ", "Tue ", "Wed ", "Thu ", "Fri ", "Sat ", "Sun "];
    for wd in &weekdays {
        if let Some(pos) = s.find(wd) {
            return Some(pos);
        }
    }
    None
}

// ──────────────────────────────────────────────────────────────
//  List groups
// ──────────────────────────────────────────────────────────────

async fn list_groups() -> Value {
    let content = match tokio::fs::read_to_string("/etc/group").await {
        Ok(c) => c,
        Err(e) => return json!({ "error": e.to_string() }),
    };

    let mut groups = Vec::new();
    for line in content.lines() {
        let fields: Vec<&str> = line.split(':').collect();
        if fields.len() < 4 {
            continue;
        }
        let name = fields[0];
        let gid: u32 = fields[2].parse().unwrap_or(0);
        let members: Vec<&str> = if fields[3].is_empty() {
            vec![]
        } else {
            fields[3].split(',').map(|m| m.trim()).collect()
        };

        groups.push(json!({
            "name": name,
            "gid": gid,
            "members": members,
            "system": gid < 1000 && gid != 0,
        }));
    }

    json!({ "action": "list_groups", "groups": groups })
}

// ──────────────────────────────────────────────────────────────
//  List available shells
// ──────────────────────────────────────────────────────────────

async fn list_shells() -> Value {
    let shells = read_valid_shells().await;
    json!({ "action": "list_shells", "shells": shells })
}

/// Read `/etc/shells` and return only entries whose binaries actually exist
/// on this host.  Always includes nologin/false variants when present.
async fn read_valid_shells() -> Vec<String> {
    let mut shells = Vec::new();

    if let Ok(content) = tokio::fs::read_to_string("/etc/shells").await {
        for line in content.lines() {
            let line = line.trim();
            if line.is_empty() || line.starts_with('#') {
                continue;
            }
            // Only include shells whose binary actually exists
            if std::path::Path::new(line).exists() {
                shells.push(line.to_string());
            }
        }
    }

    // Always include nologin options if not already present
    for nologin in &["/usr/sbin/nologin", "/sbin/nologin", "/bin/false"] {
        if !shells.iter().any(|s| s == nologin) {
            if std::path::Path::new(nologin).exists() {
                shells.push(nologin.to_string());
            }
        }
    }

    shells
}

/// Check whether `shell` is listed in `/etc/shells` and its binary exists.
async fn is_valid_shell(shell: &str) -> bool {
    let valid = read_valid_shells().await;
    valid.iter().any(|s| s == shell)
}

// ──────────────────────────────────────────────────────────────
//  Create user
// ──────────────────────────────────────────────────────────────

async fn create_user(data: &Value, password: &str) -> Value {
    let username = data.get("username").and_then(|v| v.as_str()).unwrap_or("");
    let gecos = data.get("gecos").and_then(|v| v.as_str()).unwrap_or("");
    let home = data.get("home").and_then(|v| v.as_str()).unwrap_or("");
    let shell = data.get("shell").and_then(|v| v.as_str()).unwrap_or("");
    let create_home = data.get("create_home").and_then(|v| v.as_bool()).unwrap_or(true);
    let new_password = data.get("new_password").and_then(|v| v.as_str()).unwrap_or("");
    let force_change = data.get("force_change").and_then(|v| v.as_bool()).unwrap_or(false);
    let groups = extract_string_array(data, "groups");

    // Validate username
    if !is_valid_username(username) {
        return json!({ "error": "Invalid username. Must be 1-32 chars, start with lowercase letter or _, contain only lowercase letters, digits, hyphens, underscores." });
    }

    // Build useradd command
    let mut args: Vec<String> = vec!["useradd".into()];

    if create_home {
        args.push("-m".into());
    }

    if !gecos.is_empty() {
        if !is_valid_gecos(gecos) {
            return json!({ "error": "Invalid full name. Must not contain ':', newlines, or null bytes, and must be at most 256 characters." });
        }
        args.push("-c".into());
        args.push(gecos.to_string());
    }

    if !home.is_empty() {
        if !is_valid_path(home) {
            return json!({ "error": "Invalid home directory path" });
        }
        args.push("-d".into());
        args.push(home.to_string());
    }

    if !shell.is_empty() {
        if !is_valid_shell(shell).await {
            return json!({ "error": format!("Invalid shell: {shell}. Must be listed in /etc/shells and exist on this host.") });
        }
        args.push("-s".into());
        args.push(shell.to_string());
    }

    if !groups.is_empty() {
        // Validate group names
        for g in &groups {
            if !is_valid_groupname(g) {
                return json!({ "error": format!("Invalid group name: {g}") });
            }
        }
        args.push("-G".into());
        args.push(groups.join(","));
    }

    args.push("--".into());
    args.push(username.to_string());

    // Create the user
    let result = sudo_action(password, &args).await;
    if result.get("error").is_some() {
        return result;
    }

    // Set password if provided
    if !new_password.is_empty() {
        let pw_result = set_password_internal(username, new_password, force_change, password).await;
        if pw_result.get("error").is_some() {
            return pw_result;
        }
    }

    json!({ "ok": true })
}

// ──────────────────────────────────────────────────────────────
//  Modify user
// ──────────────────────────────────────────────────────────────

async fn modify_user(data: &Value, password: &str) -> Value {
    let username = data.get("username").and_then(|v| v.as_str()).unwrap_or("");

    if !is_valid_username(username) {
        return json!({ "error": "Invalid username" });
    }

    let mut args: Vec<String> = vec!["usermod".into()];
    let mut changed = false;

    if let Some(gecos) = data.get("gecos").and_then(|v| v.as_str()) {
        if !is_valid_gecos(gecos) {
            return json!({ "error": "Invalid full name. Must not contain ':', newlines, or null bytes, and must be at most 256 characters." });
        }
        args.push("-c".into());
        args.push(gecos.to_string());
        changed = true;
    }

    if let Some(shell) = data.get("shell").and_then(|v| v.as_str()) {
        if !is_valid_shell(shell).await {
            return json!({ "error": format!("Invalid shell: {shell}. Must be listed in /etc/shells and exist on this host.") });
        }
        args.push("-s".into());
        args.push(shell.to_string());
        changed = true;
    }

    if let Some(home) = data.get("home").and_then(|v| v.as_str()) {
        if !is_valid_path(home) {
            return json!({ "error": "Invalid home directory path" });
        }
        args.push("-d".into());
        args.push(home.to_string());
        if data.get("move_home").and_then(|v| v.as_bool()).unwrap_or(false) {
            args.push("-m".into());
        }
        changed = true;
    }

    if let Some(groups_val) = data.get("groups") {
        if let Some(arr) = groups_val.as_array() {
            let groups: Vec<String> = arr.iter()
                .filter_map(|v| v.as_str().map(|s| s.to_string()))
                .collect();
            for g in &groups {
                if !is_valid_groupname(g) {
                    return json!({ "error": format!("Invalid group name: {g}") });
                }
            }
            args.push("-G".into());
            args.push(groups.join(","));
            changed = true;
        }
    }

    if !changed {
        return json!({ "error": "No changes specified" });
    }

    args.push("--".into());
    args.push(username.to_string());

    sudo_action(password, &args).await
}

// ──────────────────────────────────────────────────────────────
//  Delete user
// ──────────────────────────────────────────────────────────────

async fn delete_user(username: &str, remove_home: bool, password: &str) -> Value {
    if !is_valid_username(username) {
        return json!({ "error": "Invalid username" });
    }

    // Prevent deleting root
    if username == "root" {
        return json!({ "error": "Cannot delete root account" });
    }

    let mut args = vec!["userdel".to_string()];
    if remove_home {
        args.push("-r".into());
    }
    args.push("--".into());
    args.push(username.to_string());

    sudo_action(password, &args).await
}

// ──────────────────────────────────────────────────────────────
//  Lock / Unlock user
// ──────────────────────────────────────────────────────────────

async fn lock_user(username: &str, password: &str) -> Value {
    if !is_valid_username(username) {
        return json!({ "error": "Invalid username" });
    }
    if username == "root" {
        return json!({ "error": "Cannot lock root account" });
    }
    sudo_action(password, &["usermod", "-L", "--", username]).await
}

async fn unlock_user(username: &str, password: &str) -> Value {
    if !is_valid_username(username) {
        return json!({ "error": "Invalid username" });
    }
    sudo_action(password, &["usermod", "-U", "--", username]).await
}

// ──────────────────────────────────────────────────────────────
//  Set password
// ──────────────────────────────────────────────────────────────

async fn set_password(username: &str, new_pw: &str, force_change: bool, sudo_pw: &str) -> Value {
    if !is_valid_username(username) {
        return json!({ "error": "Invalid username" });
    }
    if new_pw.is_empty() {
        return json!({ "error": "New password cannot be empty" });
    }
    set_password_internal(username, new_pw, force_change, sudo_pw).await
}

async fn set_password_internal(username: &str, new_pw: &str, force_change: bool, sudo_pw: &str) -> Value {
    // Use chpasswd via stdin: "username:password\n"
    let input = format!("{username}:{new_pw}\n");
    let result = sudo_stdin_write(sudo_pw, &["chpasswd"], &input).await;
    if result.get("error").is_some() {
        return result;
    }

    // Force password change on first login if requested
    if force_change {
        let chage_result = sudo_action(sudo_pw, &["chage", "-d", "0", "--", username]).await;
        if chage_result.get("error").is_some() {
            return chage_result;
        }
    }

    json!({ "ok": true })
}

// ──────────────────────────────────────────────────────────────
//  Group management
// ──────────────────────────────────────────────────────────────

async fn create_group(name: &str, gid: Option<u32>, password: &str) -> Value {
    if !is_valid_groupname(name) {
        return json!({ "error": "Invalid group name. Must be 1-32 chars, start with lowercase letter or _, contain only lowercase letters, digits, hyphens, underscores." });
    }
    let mut args = vec!["groupadd".to_string()];
    if let Some(id) = gid {
        args.push("-g".into());
        args.push(id.to_string());
    }
    args.push("--".into());
    args.push(name.to_string());
    sudo_action(password, &args).await
}

async fn delete_group(name: &str, password: &str) -> Value {
    if !is_valid_groupname(name) {
        return json!({ "error": "Invalid group name" });
    }
    // Prevent deleting critical groups
    if matches!(name, "root" | "wheel" | "sudo" | "adm") {
        return json!({ "error": format!("Cannot delete system group: {name}") });
    }
    sudo_action(password, &["groupdel", "--", name]).await
}

// ──────────────────────────────────────────────────────────────
//  Validation
// ──────────────────────────────────────────────────────────────

/// Validate POSIX username: 1-32 chars, starts with [a-z_], contains [a-z0-9_-], may end with $.
fn is_valid_username(name: &str) -> bool {
    if name.is_empty() || name.len() > 32 {
        return false;
    }
    let bytes = name.as_bytes();
    let first = bytes[0];
    if !(first.is_ascii_lowercase() || first == b'_') {
        return false;
    }
    let (body, _tail) = if bytes.last() == Some(&b'$') {
        (&bytes[1..bytes.len() - 1], true)
    } else {
        (&bytes[1..], false)
    };
    body.iter().all(|&b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_' || b == b'-')
}

fn is_valid_groupname(name: &str) -> bool {
    // Same rules as username
    is_valid_username(name)
}

fn is_valid_path(path: &str) -> bool {
    // Must be absolute, no .. traversal
    path.starts_with('/')
        && !path.contains("..")
        && !path.contains('\0')
        && path.len() <= 4096
}

/// Validate GECOS (full name / comment) field.
/// Reject characters that could corrupt `/etc/passwd` or confuse parsers.
fn is_valid_gecos(gecos: &str) -> bool {
    if gecos.len() > 256 {
        return false;
    }
    // Colon is the /etc/passwd field separator — must never appear in gecos.
    // Newlines/carriage-returns would inject new passwd lines.
    // Null bytes could truncate strings in C-level tools.
    !gecos.contains(':')
        && !gecos.contains('\n')
        && !gecos.contains('\r')
        && !gecos.contains('\0')
}

// ──────────────────────────────────────────────────────────────
//  Helpers
// ──────────────────────────────────────────────────────────────

async fn run_cmd(args: &[&str]) -> String {
    let Some((cmd, rest)) = args.split_first() else {
        return String::new();
    };
    match tokio::process::Command::new(cmd)
        .args(rest)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .output()
        .await
    {
        Ok(out) => {
            let stdout = String::from_utf8_lossy(&out.stdout).to_string();
            if stdout.is_empty() {
                String::from_utf8_lossy(&out.stderr).to_string()
            } else {
                stdout
            }
        }
        Err(e) => format!("error: {e}"),
    }
}

async fn sudo_action(password: &str, args: &[impl AsRef<str>]) -> Value {
    let str_args: Vec<&str> = args.iter().map(|a| a.as_ref()).collect();

    // When running as root, skip sudo entirely — avoid stdin password interference
    let am_root = unsafe { libc::geteuid() } == 0;

    if !am_root && password.is_empty() {
        return json!({ "error": "password required" });
    }

    let (cmd, cmd_args) = if am_root {
        // Running as root: call the command directly, no sudo needed
        let first = str_args.first().copied().unwrap_or("true");
        let rest: Vec<&str> = str_args.iter().skip(1).copied().collect();
        (first.to_string(), rest)
    } else {
        // Running as normal user: use sudo -S
        let mut sa = vec!["-S"];
        sa.extend_from_slice(&str_args);
        ("sudo".to_string(), sa)
    };

    if am_root {
        // Running as root: no stdin needed, use null
        let out = tokio::process::Command::new(&cmd)
            .args(&cmd_args)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .output()
            .await;

        match out {
            Ok(out) if out.status.success() => {
                let stdout = String::from_utf8_lossy(&out.stdout).trim().to_string();
                json!({ "ok": true, "output": stdout })
            }
            Ok(out) => {
                let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
                let msg = if stderr.is_empty() {
                    format!("command failed (exit {})", out.status.code().unwrap_or(-1))
                } else {
                    stderr
                };
                json!({ "error": msg })
            }
            Err(e) => json!({ "error": e.to_string() }),
        }
    } else {
        // Running as non-root: pipe password to sudo -S via stdin
        let child = tokio::process::Command::new(&cmd)
            .args(&cmd_args)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn();

        let mut child = match child {
            Ok(c) => c,
            Err(e) => return json!({ "error": e.to_string() }),
        };

        if let Some(mut stdin) = child.stdin.take() {
            let _ = stdin.write_all(format!("{password}\n").as_bytes()).await;
            drop(stdin);
        }

        match child.wait_with_output().await {
            Ok(out) if out.status.success() => {
                let stdout = String::from_utf8_lossy(&out.stdout).trim().to_string();
                json!({ "ok": true, "output": stdout })
            }
            Ok(out) => {
                let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
                let clean = stderr
                    .lines()
                    .filter(|l| !l.contains("[sudo]") && !l.contains("password for"))
                    .collect::<Vec<_>>()
                    .join("\n");
                let msg = if clean.is_empty() {
                    "command failed".to_string()
                } else {
                    clean
                };
                json!({ "error": msg })
            }
            Err(e) => json!({ "error": e.to_string() }),
        }
    }
}

async fn sudo_stdin_write(password: &str, args: &[&str], content: &str) -> Value {
    // When running as root, skip sudo entirely
    let am_root = unsafe { libc::geteuid() } == 0;

    if !am_root && password.is_empty() {
        return json!({ "error": "password required" });
    }

    let (cmd, cmd_args): (String, Vec<&str>) = if am_root {
        let first = args.first().copied().unwrap_or("true");
        let rest: Vec<&str> = args.iter().skip(1).copied().collect();
        (first.to_string(), rest)
    } else {
        let mut sa = vec!["-S"];
        sa.extend_from_slice(args);
        ("sudo".to_string(), sa)
    };

    let child = tokio::process::Command::new(&cmd)
        .args(&cmd_args)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn();

    let mut child = match child {
        Ok(c) => c,
        Err(e) => return json!({ "error": e.to_string() }),
    };

    if let Some(mut stdin) = child.stdin.take() {
        if !am_root {
            let _ = stdin.write_all(format!("{password}\n").as_bytes()).await;
        }
        let _ = stdin.write_all(content.as_bytes()).await;
        drop(stdin);
    }

    match child.wait_with_output().await {
        Ok(out) if out.status.success() => {
            json!({ "ok": true })
        }
        Ok(out) => {
            let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
            let clean = stderr
                .lines()
                .filter(|l| !l.contains("[sudo]") && !l.contains("password for"))
                .collect::<Vec<_>>()
                .join("\n");
            let msg = if clean.is_empty() {
                "operation failed".to_string()
            } else {
                clean
            };
            json!({ "error": msg })
        }
        Err(e) => json!({ "error": e.to_string() }),
    }
}

fn extract_string_array(data: &Value, key: &str) -> Vec<String> {
    data.get(key)
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(|s| s.to_string()))
                .collect()
        })
        .unwrap_or_default()
}
