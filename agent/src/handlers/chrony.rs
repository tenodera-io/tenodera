use async_trait::async_trait;
use serde_json::{Value, json};

use crate::handler::ChannelHandler;
use crate::handlers::system_settings::{active_unit, chrony_conf_path, is_valid_ntp_host};
use crate::util::{require_admin, run_cmd, sudo_as_user, sudo_stdin_write_as_user, which};
use tenodera_protocol::channel::ChannelOpenOptions;
use tenodera_protocol::message::Message;

// ── chrony.manage ─────────────────────────────────────────────────────────────
// Live status (tracking/sources/activity), the server/pool list, the raw config
// and a few runtime commands for the chrony NTP daemon.
//
// Open-time options: no `action` → read status+config; `action` set → mutate
// (admin-gated; privileged bits run via sudo as the calling user). Read commands
// run as the agent (root), which can reach chrony's command socket.

pub struct ChronyHandler;

#[async_trait]
impl ChannelHandler for ChronyHandler {
    fn payload_type(&self) -> &str {
        "chrony.manage"
    }

    async fn open(&self, channel: &str, options: &ChannelOpenOptions) -> Vec<Message> {
        let extra = Value::Object(options.extra.clone());
        let action = options
            .extra
            .get("action")
            .and_then(|v| v.as_str())
            .unwrap_or("");

        let data = if action.is_empty() || action == "status" {
            read_all().await
        } else if let Some(err) = require_admin(&extra) {
            err
        } else {
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
            apply(action, &extra, user, password).await
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

// ── Read ─────────────────────────────────────────────────────────────────────

async fn read_all() -> Value {
    let has_chronyc = which("chronyc").await;
    let path = chrony_conf_path();
    if !has_chronyc && path.is_none() {
        return json!({ "available": false });
    }

    let tracking = parse_kv_colon(&run_cmd(&["chronyc", "tracking"]).await);
    let activity = parse_activity(&run_cmd(&["chronyc", "activity"]).await);
    let sources = parse_sources(&run_cmd(&["chronyc", "sources"]).await);

    let config_raw = path
        .as_ref()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .unwrap_or_default();
    let servers = parse_servers_struct(&config_raw);

    json!({
        "available": true,
        "config_path": path,
        "tracking": tracking,
        "activity": activity,
        "sources": sources,
        "config_raw": config_raw,
        "servers": servers,
    })
}

// ── Mutations ────────────────────────────────────────────────────────────────

async fn apply(action: &str, data: &Value, user: &str, password: &str) -> Value {
    match action {
        "set_servers" => set_servers(data, user, password).await,
        "save_config" => save_config(data, user, password).await,
        "command" => run_command(data, user, password).await,
        other => json!({ "error": format!("unknown action: {other}") }),
    }
}

/// Replace the `server`/`pool` directives from a structured list and restart chronyd.
async fn set_servers(data: &Value, user: &str, password: &str) -> Value {
    let entries = data
        .get("servers")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let mut lines_out: Vec<String> = Vec::new();
    for e in &entries {
        let kind = e.get("type").and_then(|v| v.as_str()).unwrap_or("server");
        let host = e.get("host").and_then(|v| v.as_str()).unwrap_or("").trim();
        let opts = e
            .get("options")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim();
        if kind != "server" && kind != "pool" {
            return json!({ "error": format!("invalid type: {kind}") });
        }
        if !is_valid_ntp_host(host) {
            return json!({ "error": format!("invalid host: {host}") });
        }
        for tok in opts.split_whitespace() {
            if !is_safe_opt(tok) {
                return json!({ "error": format!("invalid option: {tok}") });
            }
        }
        let line = if opts.is_empty() {
            format!("{kind} {host}")
        } else {
            format!("{kind} {host} {opts}")
        };
        lines_out.push(line);
    }
    if lines_out.is_empty() {
        return json!({ "error": "provide at least one server or pool" });
    }
    write_server_lines(user, password, &lines_out).await
}

/// Rewrite chrony.conf keeping everything except server/pool lines, then append `lines_out`.
async fn write_server_lines(user: &str, password: &str, lines_out: &[String]) -> Value {
    let Some(path) = chrony_conf_path() else {
        return json!({ "error": "chrony configuration file not found" });
    };
    let content = std::fs::read_to_string(&path).unwrap_or_default();
    let mut kept: Vec<String> = content
        .lines()
        .filter(|l| {
            let kw = l
                .split_whitespace()
                .next()
                .unwrap_or("")
                .to_ascii_lowercase();
            kw != "server" && kw != "pool"
        })
        .map(|l| l.to_string())
        .collect();
    while kept.last().map(|l| l.trim().is_empty()).unwrap_or(false) {
        kept.pop();
    }
    kept.push("# NTP servers managed by Tenodera".to_string());
    kept.extend(lines_out.iter().cloned());
    let new_content = kept.join("\n") + "\n";

    let w = sudo_stdin_write_as_user(user, password, &["tee", &path], &new_content).await;
    if w.get("error").is_some() {
        return w;
    }
    let r = restart_chrony(user, password).await;
    let ok = r.get("error").is_none();
    crate::audit::log(
        user,
        "chrony.set_servers",
        &format!("{} entries", lines_out.len()),
        ok,
        "",
    );
    if !ok { r } else { json!({ "ok": true }) }
}

/// Overwrite the whole chrony.conf with user-supplied content, then restart chronyd.
async fn save_config(data: &Value, user: &str, password: &str) -> Value {
    let content = data.get("content").and_then(|v| v.as_str()).unwrap_or("");
    if content.trim().is_empty() {
        return json!({ "error": "config is empty" });
    }
    let Some(path) = chrony_conf_path() else {
        return json!({ "error": "chrony configuration file not found" });
    };
    let normalized = if content.ends_with('\n') {
        content.to_string()
    } else {
        format!("{content}\n")
    };
    let w = sudo_stdin_write_as_user(user, password, &["tee", &path], &normalized).await;
    if w.get("error").is_some() {
        return w;
    }
    let r = restart_chrony(user, password).await;
    let ok = r.get("error").is_none();
    crate::audit::log(user, "chrony.save_config", &path, ok, "");
    if !ok { r } else { json!({ "ok": true }) }
}

/// Runtime commands: makestep / online / offline / restart.
async fn run_command(data: &Value, user: &str, password: &str) -> Value {
    let cmd = data.get("cmd").and_then(|v| v.as_str()).unwrap_or("");
    let r = match cmd {
        "makestep" => sudo_as_user(user, password, &["chronyc", "makestep"]).await,
        "online" => sudo_as_user(user, password, &["chronyc", "online"]).await,
        "offline" => sudo_as_user(user, password, &["chronyc", "offline"]).await,
        "restart" => restart_chrony(user, password).await,
        other => return json!({ "error": format!("unknown command: {other}") }),
    };
    let ok = r.get("error").is_none();
    crate::audit::log(user, "chrony.command", cmd, ok, "");
    if !ok { r } else { json!({ "ok": true }) }
}

async fn restart_chrony(user: &str, password: &str) -> Value {
    let unit = active_unit(&["chronyd", "chrony"])
        .await
        .unwrap_or_else(|| "chronyd".to_string());
    sudo_as_user(user, password, &["systemctl", "restart", &unit]).await
}

// ── Parsers ──────────────────────────────────────────────────────────────────

/// Parse "Key : Value" lines (chronyc tracking) into an object.
fn parse_kv_colon(out: &str) -> Value {
    let mut m = serde_json::Map::new();
    for line in out.lines() {
        if let Some((k, v)) = line.split_once(':') {
            let k = k.trim();
            let v = v.trim();
            if !k.is_empty() && !k.contains("Cannot") {
                m.insert(k.to_string(), Value::String(v.to_string()));
            }
        }
    }
    Value::Object(m)
}

/// Parse `chronyc activity` counts.
fn parse_activity(out: &str) -> Value {
    let first_num = |line: &str| -> i64 {
        line.split_whitespace()
            .next()
            .and_then(|t| t.parse().ok())
            .unwrap_or(0)
    };
    let mut online = 0;
    let mut offline = 0;
    let mut unknown = 0;
    for line in out.lines() {
        if line.contains("online") {
            online = first_num(line);
        } else if line.contains("offline") {
            offline = first_num(line);
        } else if line.contains("unknown address") {
            unknown = first_num(line);
        }
    }
    json!({ "online": online, "offline": offline, "unknown": unknown })
}

/// Parse `chronyc sources` rows into structured entries.
fn parse_sources(out: &str) -> Vec<Value> {
    let mut rows = Vec::new();
    for line in out.lines() {
        if line.len() < 3 {
            continue;
        }
        let code = &line[..2];
        let mode = code.chars().next().unwrap_or(' ');
        // Only real data rows begin with a mode marker (^ server, = peer, # local).
        if !matches!(mode, '^' | '=' | '#') {
            continue;
        }
        let state = code.chars().nth(1).unwrap_or(' ');
        let toks: Vec<&str> = line[2..].split_whitespace().collect();
        if toks.len() < 5 {
            continue;
        }
        rows.push(json!({
            "code": code.trim(),
            "mode": mode.to_string(),
            "state": state.to_string(),
            "synced": state == '*',
            "name": toks[0],
            "stratum": toks[1],
            "poll": toks[2],
            "reach": toks[3],
            "last_rx": toks[4],
            "last_sample": toks[5..].join(" "),
        }));
    }
    rows
}

/// Parse `server`/`pool` directives into structured entries (type, host, options).
fn parse_servers_struct(content: &str) -> Vec<Value> {
    content
        .lines()
        .filter_map(|l| {
            let t = l.trim();
            if t.starts_with('#') || t.starts_with('!') {
                return None;
            }
            let mut it = t.split_whitespace();
            let kw = it.next()?.to_ascii_lowercase();
            if kw != "server" && kw != "pool" {
                return None;
            }
            let host = it.next()?.to_string();
            let options = it.collect::<Vec<_>>().join(" ");
            Some(json!({ "type": kw, "host": host, "options": options }))
        })
        .collect()
}

/// A chrony directive option token: alphanumerics plus dash/underscore (iburst, minpoll, 6…).
fn is_safe_opt(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 32
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_'))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sources_parse() {
        let out = "MS Name/IP address         Stratum Poll Reach LastRx Last sample\n\
                   ===============================================================================\n\
                   ^* 162.159.200.1                 3   6   377    41    -83us[ -120us] +/-   12ms\n\
                   ^- time.example                  2   6   377    42   +5432us[+5432us] +/-   45ms\n";
        let rows = parse_sources(out);
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0]["name"], "162.159.200.1");
        assert_eq!(rows[0]["synced"], true);
        assert_eq!(rows[0]["stratum"], "3");
        assert_eq!(rows[1]["synced"], false);
    }

    #[test]
    fn servers_struct_parse() {
        let conf = "pool 2.debian.pool.ntp.org iburst\nserver time.cloudflare.com iburst prefer\ndriftfile /x\n";
        let s = parse_servers_struct(conf);
        assert_eq!(s.len(), 2);
        assert_eq!(s[0]["type"], "pool");
        assert_eq!(s[0]["host"], "2.debian.pool.ntp.org");
        assert_eq!(s[1]["options"], "iburst prefer");
    }

    #[test]
    fn activity_parse() {
        let out = "200 OK\n4 sources online\n1 sources offline\n0 sources with unknown address\n";
        let a = parse_activity(out);
        assert_eq!(a["online"], 4);
        assert_eq!(a["offline"], 1);
    }

    #[test]
    fn safe_opt_rules() {
        assert!(is_safe_opt("iburst"));
        assert!(is_safe_opt("6"));
        assert!(!is_safe_opt("a b"));
        assert!(!is_safe_opt("bad;"));
    }
}
