use std::time::Duration;

use serde_json::{Value, json};

use crate::handler::ChannelHandler;
use crate::util::{require_admin, run_cmd, sudo_as_user, sudo_stdin_write_as_user};
use tenodera_protocol::channel::ChannelOpenOptions;
use tenodera_protocol::message::Message;

/// Run an absolute-path command with args (thin wrapper over `run_cmd`).
async fn run_cmd_at(bin: &str, args: &[&str]) -> String {
    let mut argv: Vec<&str> = Vec::with_capacity(args.len() + 1);
    argv.push(bin);
    argv.extend_from_slice(args);
    run_cmd(&argv).await
}

// ── security.status / security.manage ────────────────────────────────────────
// Status and basic actions for host hardening subsystems: fail2ban, SELinux and
// AppArmor. Detection is by resolving the tools on disk (the agent's PATH may not
// include /usr/sbin). Status is read-only; actions are admin-gated.

/// Resolve a command to an absolute path across the usual bin dirs (PATH-agnostic).
fn resolve(cmd: &str) -> Option<String> {
    for d in [
        "/usr/sbin",
        "/usr/bin",
        "/sbin",
        "/bin",
        "/usr/local/sbin",
        "/usr/local/bin",
    ] {
        let p = format!("{d}/{cmd}");
        if std::path::Path::new(&p).exists() {
            return Some(p);
        }
    }
    None
}

// ── status ───────────────────────────────────────────────────────────────────

pub struct SecurityStatusHandler;

#[async_trait::async_trait]
impl ChannelHandler for SecurityStatusHandler {
    fn payload_type(&self) -> &str {
        "security.status"
    }

    async fn open(&self, channel: &str, options: &ChannelOpenOptions) -> Vec<Message> {
        let query = options
            .extra
            .get("query")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        let data = match query {
            "selinux_booleans" => selinux_booleans().await,
            "selinux_denials" => selinux_denials().await,
            "selinux_modules" => selinux_modules().await,
            _ => json!({
                "fail2ban": fail2ban_status().await,
                "selinux": selinux_status().await,
                "apparmor": apparmor_status().await,
            }),
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

/// Pull the value after "Label:" on a fail2ban-client status line.
fn after(line: &str, label: &str) -> Option<String> {
    line.find(label)
        .map(|i| line[i + label.len()..].trim().to_string())
}

async fn fail2ban_status() -> Value {
    let Some(bin) = resolve("fail2ban-client") else {
        return json!({ "available": false });
    };
    let overview = run_cmd_at(&bin, &["status"]).await;
    // If the daemon isn't running, `status` fails with a socket error.
    let jail_line = overview.lines().find(|l| l.contains("Jail list:"));
    let Some(jail_line) = jail_line else {
        return json!({ "available": true, "active": false, "jails": [] });
    };
    let jails_raw = after(jail_line, "Jail list:").unwrap_or_default();
    let mut jails: Vec<Value> = Vec::new();
    for name in jails_raw
        .split(',')
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        if !valid_name(name) {
            continue;
        }
        let s = run_cmd_at(&bin, &["status", name]).await;
        let mut banned_ips: Vec<String> = Vec::new();
        let (mut total_banned, mut cur_banned, mut cur_failed, mut total_failed) =
            (0u64, 0u64, 0u64, 0u64);
        for line in s.lines() {
            if let Some(v) = after(line, "Banned IP list:") {
                banned_ips = v.split_whitespace().map(str::to_string).collect();
            } else if let Some(v) = after(line, "Total banned:") {
                total_banned = v.parse().unwrap_or(0);
            } else if let Some(v) = after(line, "Currently banned:") {
                cur_banned = v.parse().unwrap_or(0);
            } else if let Some(v) = after(line, "Currently failed:") {
                cur_failed = v.parse().unwrap_or(0);
            } else if let Some(v) = after(line, "Total failed:") {
                total_failed = v.parse().unwrap_or(0);
            }
        }
        jails.push(json!({
            "name": name,
            "banned_ips": banned_ips,
            "currently_banned": cur_banned,
            "total_banned": total_banned,
            "currently_failed": cur_failed,
            "total_failed": total_failed,
        }));
    }
    json!({ "available": true, "active": true, "jails": jails })
}

async fn selinux_status() -> Value {
    let Some(getenforce) = resolve("getenforce") else {
        return json!({ "available": false });
    };
    let current = run_cmd_at(&getenforce, &[]).await.trim().to_lowercase();
    let mut config = String::new();
    let mut policy = String::new();
    if let Some(sestatus) = resolve("sestatus") {
        let out = run_cmd_at(&sestatus, &[]).await;
        for line in out.lines() {
            if let Some(v) = after(line, "Mode from config file:") {
                config = v.to_lowercase();
            } else if let Some(v) = after(line, "Loaded policy name:") {
                policy = v;
            }
        }
    }
    json!({
        "available": true,
        "current": current,   // enforcing | permissive | disabled
        "config": config,
        "policy": policy,
    })
}

/// `getsebool -a` → list of { name, on }.
async fn selinux_booleans() -> Value {
    let Some(bin) = resolve("getsebool") else {
        return json!({ "booleans": [] });
    };
    let out = run_cmd_at(&bin, &["-a"]).await;
    let mut list: Vec<Value> = Vec::new();
    for line in out.lines() {
        if let Some((name, val)) = line.split_once("-->") {
            let name = name.trim();
            if valid_name(name) {
                list.push(json!({ "name": name, "on": val.trim() == "on" }));
            }
        }
    }
    json!({ "booleans": list })
}

/// `semodule -l` → loaded policy module names.
async fn selinux_modules() -> Value {
    let Some(bin) = resolve("semodule") else {
        return json!({ "modules": [] });
    };
    let out = run_cmd_at(&bin, &["-l"]).await;
    let mods: Vec<&str> = out
        .lines()
        .filter_map(|l| l.split_whitespace().next())
        .filter(|s| !s.is_empty())
        .collect();
    json!({ "modules": mods })
}

/// Recent AVC denials from the journal (this boot), newest first.
async fn selinux_denials() -> Value {
    let Some(jbin) = resolve("journalctl") else {
        return json!({ "denials": [] });
    };
    let out = run_cmd_at(
        &jbin,
        &[
            "-b",
            "--no-pager",
            "-o",
            "short-iso",
            "--grep",
            "avc:.*denied",
        ],
    )
    .await;
    let mut denials: Vec<Value> = Vec::new();
    for line in out.lines().rev() {
        if !line.contains("avc:") || !line.contains("denied") {
            continue;
        }
        let time = line.split_whitespace().next().unwrap_or("").to_string();
        let op = between(line, "{", "}")
            .unwrap_or_default()
            .trim()
            .to_string();
        denials.push(json!({
            "time": time,
            "comm": kv(line, "comm="),
            "op": op,
            "scontext": kv(line, "scontext="),
            "tcontext": kv(line, "tcontext="),
            "tclass": kv(line, "tclass="),
            "permissive": kv(line, "permissive="),
        }));
        if denials.len() >= 200 {
            break;
        }
    }
    json!({ "denials": denials })
}

/// Extract a `key=value` field (handles `key="quoted"` and bare tokens).
fn kv(line: &str, key: &str) -> String {
    match line.find(key) {
        None => String::new(),
        Some(i) => {
            let rest = &line[i + key.len()..];
            if let Some(r) = rest.strip_prefix('"') {
                r.split('"').next().unwrap_or("").to_string()
            } else {
                rest.split_whitespace().next().unwrap_or("").to_string()
            }
        }
    }
}

fn between(s: &str, a: &str, b: &str) -> Option<String> {
    let i = s.find(a)?;
    let rest = &s[i + a.len()..];
    let j = rest.find(b)?;
    Some(rest[..j].to_string())
}

async fn apparmor_status() -> Value {
    let Some(bin) = resolve("aa-status") else {
        return json!({ "available": false });
    };
    let out = run_cmd_at(&bin, &["--json"]).await;
    let parsed: Value = serde_json::from_str(out.trim()).unwrap_or(Value::Null);
    let mut profiles: Vec<Value> = Vec::new();
    let (mut enforce, mut complain, mut other) = (0u64, 0u64, 0u64);
    if let Some(map) = parsed.get("profiles").and_then(|p| p.as_object()) {
        for (name, mode) in map {
            let mode = mode.as_str().unwrap_or("");
            match mode {
                "enforce" => enforce += 1,
                "complain" => complain += 1,
                _ => other += 1,
            }
            if profiles.len() < 500 {
                profiles.push(json!({ "name": name, "mode": mode }));
            }
        }
    }
    profiles.sort_by(|a, b| {
        a["name"]
            .as_str()
            .unwrap_or("")
            .cmp(b["name"].as_str().unwrap_or(""))
    });
    json!({
        "available": true,
        "can_manage": resolve("aa-complain").is_some() && resolve("aa-enforce").is_some(),
        "enforce": enforce,
        "complain": complain,
        "other": other,
        "profiles": profiles,
    })
}

// ── manage (admin-gated) ─────────────────────────────────────────────────────

pub struct SecurityManageHandler;

#[async_trait::async_trait]
impl ChannelHandler for SecurityManageHandler {
    fn payload_type(&self) -> &str {
        "security.manage"
    }

    async fn open(&self, channel: &str, options: &ChannelOpenOptions) -> Vec<Message> {
        let extra = Value::Object(options.extra.clone());
        let get = |k: &str| {
            options
                .extra
                .get(k)
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string()
        };
        let action = get("action");
        // The operator (== audit user). Every write below runs as this user via
        // `sudo` with their own password, so the host's sudoers/HBAC — not just
        // the injected admin role — decides whether the action is permitted.
        let user = get("_user");
        let password = get("password");

        let data = if let Some(err) = require_admin(&extra) {
            err
        } else {
            match action.as_str() {
                "fail2ban_unban" => {
                    fail2ban_action("unbanip", &get("jail"), &get("ip"), &user, &password).await
                }
                "fail2ban_ban" => {
                    fail2ban_action("banip", &get("jail"), &get("ip"), &user, &password).await
                }
                "fail2ban_reload" => fail2ban_reload(&user, &password).await,
                "selinux_setenforce" => {
                    selinux_setenforce(&get("mode"), get("persist") == "true", &user, &password)
                        .await
                }
                "apparmor_set" => {
                    apparmor_set(&get("profile"), &get("mode"), &user, &password).await
                }
                "selinux_setbool" => {
                    selinux_setbool(
                        &get("name"),
                        &get("value"),
                        get("persist") == "true",
                        &user,
                        &password,
                    )
                    .await
                }
                "selinux_restorecon" => selinux_restorecon(&get("path"), &user, &password).await,
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

fn valid_name(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 128
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() || "-_.@/:".contains(c))
}

fn valid_ip(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 64
        && s.chars()
            .all(|c| c.is_ascii_hexdigit() || ".:/".contains(c))
}

/// Interpret a `sudo_as_user` result: audit it and normalise to `{ok, output}`,
/// or pass the sudo/host error through (audited as a failure). This is how the
/// host's decision — a rejected password or a sudoers denial — surfaces to the
/// operator instead of the action running unconditionally as root.
fn finish(res: Value, user: &str, action: &str, target: &str, detail: &str) -> Value {
    if let Some(err) = res.get("error").and_then(|e| e.as_str()) {
        crate::audit::log(user, action, target, false, err);
        return json!({ "error": err });
    }
    let out = res.get("output").and_then(|o| o.as_str()).unwrap_or("");
    let note = if detail.is_empty() { out } else { detail };
    crate::audit::log(user, action, target, true, note);
    json!({ "ok": true, "output": out })
}

async fn fail2ban_action(op: &str, jail: &str, ip: &str, user: &str, password: &str) -> Value {
    let Some(bin) = resolve("fail2ban-client") else {
        return json!({ "error": "fail2ban is not installed" });
    };
    if !valid_name(jail) {
        return json!({ "error": "invalid jail name" });
    }
    if !valid_ip(ip) {
        return json!({ "error": "invalid IP address" });
    }
    let res = sudo_as_user(user, password, &[bin.as_str(), "set", jail, op, ip]).await;
    finish(
        res,
        user,
        &format!("security.fail2ban_{op}"),
        &format!("{jail}:{ip}"),
        "",
    )
}

async fn fail2ban_reload(user: &str, password: &str) -> Value {
    let Some(bin) = resolve("fail2ban-client") else {
        return json!({ "error": "fail2ban is not installed" });
    };
    let res = sudo_as_user(user, password, &[bin.as_str(), "reload"]).await;
    finish(res, user, "security.fail2ban_reload", "", "")
}

async fn selinux_setenforce(mode: &str, persist: bool, user: &str, password: &str) -> Value {
    let Some(bin) = resolve("setenforce") else {
        return json!({ "error": "SELinux is not available" });
    };
    let arg = match mode {
        "enforcing" => "1",
        "permissive" => "0",
        _ => return json!({ "error": "mode must be enforcing or permissive" }),
    };
    let res = sudo_as_user(user, password, &[bin.as_str(), arg]).await;
    if let Some(err) = res.get("error").and_then(|e| e.as_str()) {
        crate::audit::log(user, "security.selinux_setenforce", mode, false, err);
        return json!({ "error": err });
    }
    // Optionally make it survive reboots by rewriting SELINUX= in the config —
    // the privileged write is brokered through the operator's sudo, same as the
    // runtime toggle above.
    if persist && let Ok(content) = std::fs::read_to_string("/etc/selinux/config") {
        let new: String = content
            .lines()
            .map(|l| {
                if l.trim_start().starts_with("SELINUX=")
                    && !l.trim_start().starts_with("SELINUXTYPE=")
                {
                    format!("SELINUX={mode}")
                } else {
                    l.to_string()
                }
            })
            .collect::<Vec<_>>()
            .join("\n");
        let w = sudo_stdin_write_as_user(
            user,
            password,
            &["tee", "/etc/selinux/config"],
            &(new + "\n"),
        )
        .await;
        if let Some(err) = w.get("error").and_then(|e| e.as_str()) {
            crate::audit::log(user, "security.selinux_setenforce", mode, false, err);
            return json!({ "error": format!("runtime change applied, but persisting failed: {err}") });
        }
    }
    crate::audit::log(
        user,
        "security.selinux_setenforce",
        mode,
        true,
        if persist { "persisted" } else { "runtime" },
    );
    json!({ "ok": true })
}

async fn selinux_setbool(
    name: &str,
    value: &str,
    persist: bool,
    user: &str,
    password: &str,
) -> Value {
    let Some(bin) = resolve("setsebool") else {
        return json!({ "error": "setsebool not available" });
    };
    if !valid_name(name) {
        return json!({ "error": "invalid boolean name" });
    }
    if value != "on" && value != "off" {
        return json!({ "error": "value must be on or off" });
    }
    let mut args: Vec<&str> = vec![bin.as_str()];
    if persist {
        args.push("-P");
    }
    args.push(name);
    args.push(value);
    let res = sudo_as_user(user, password, &args).await;
    finish(
        res,
        user,
        "security.selinux_setbool",
        &format!("{name}={value}"),
        if persist { "persisted" } else { "runtime" },
    )
}

async fn selinux_restorecon(path: &str, user: &str, password: &str) -> Value {
    let Some(bin) = resolve("restorecon") else {
        return json!({ "error": "restorecon not available" });
    };
    if !path.starts_with('/') {
        return json!({ "error": "path must be absolute" });
    }
    if !std::path::Path::new(path).exists() {
        return json!({ "error": "path not found" });
    }
    match tokio::time::timeout(
        Duration::from_secs(120),
        sudo_as_user(user, password, &[bin.as_str(), "-Rv", "--", path]),
    )
    .await
    {
        Ok(res) => finish(res, user, "security.selinux_restorecon", path, ""),
        Err(_) => {
            crate::audit::log(user, "security.selinux_restorecon", path, false, "timeout");
            json!({ "error": "restorecon timed out (still running in background)" })
        }
    }
}

async fn apparmor_set(profile: &str, mode: &str, user: &str, password: &str) -> Value {
    if !valid_name(profile) {
        return json!({ "error": "invalid profile name" });
    }
    let tool = match mode {
        "enforce" => "aa-enforce",
        "complain" => "aa-complain",
        _ => return json!({ "error": "mode must be enforce or complain" }),
    };
    let Some(bin) = resolve(tool) else {
        return json!({ "error": "apparmor-utils is not installed (aa-enforce/aa-complain missing)" });
    };
    let res = sudo_as_user(user, password, &[bin.as_str(), profile]).await;
    finish(
        res,
        user,
        "security.apparmor_set",
        &format!("{profile}:{mode}"),
        "",
    )
}
