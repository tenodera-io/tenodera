use async_trait::async_trait;
use serde_json::{Value, json};

use crate::handler::ChannelHandler;
use crate::util::{require_admin, run_cmd, sudo_as_user, sudo_stdin_write_as_user, which};
use tenodera_protocol::channel::ChannelOpenOptions;
use tenodera_protocol::message::Message;

// ── system.settings ──────────────────────────────────────────────────────────
// Time/date (timezone, NTP), hostname and locale/keymap for the active host.
//
// Uses open-time options (not a subsequent Data frame) so the frontend's one-shot
// request() works: no `action` → read current settings; `action` set → mutate
// (admin-gated, run via sudo as the calling user so host sudoers/HBAC apply).

pub struct SystemSettingsHandler;

#[async_trait]
impl ChannelHandler for SystemSettingsHandler {
    fn payload_type(&self) -> &str {
        "system.settings"
    }

    async fn open(&self, channel: &str, options: &ChannelOpenOptions) -> Vec<Message> {
        let extra = Value::Object(options.extra.clone());
        let action = options
            .extra
            .get("action")
            .and_then(|v| v.as_str())
            .unwrap_or("");

        let data = if action.is_empty() || action == "read" {
            read_settings().await
        } else {
            // All mutations require admin.
            if let Some(err) = require_admin(&extra) {
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
                apply_action(action, &extra, user, password).await
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

// ── Read ─────────────────────────────────────────────────────────────────────

async fn read_settings() -> Value {
    let td = parse_kv(&run_cmd(&["timedatectl", "show"]).await);
    let timezone = td.get("Timezone").cloned().unwrap_or_default();
    let ntp = td.get("NTP").map(|v| v == "yes").unwrap_or(false);
    let ntp_synced = td
        .get("NTPSynchronized")
        .map(|v| v == "yes")
        .unwrap_or(false);
    let can_ntp = td.get("CanNTP").map(|v| v == "yes").unwrap_or(false);
    let local_rtc = td.get("LocalRTC").map(|v| v == "yes").unwrap_or(false);

    let local_time = run_cmd(&["date", "+%Y-%m-%d %H:%M:%S %Z"])
        .await
        .trim()
        .to_string();
    let utc_time = run_cmd(&["date", "-u", "+%Y-%m-%d %H:%M:%S"])
        .await
        .trim()
        .to_string();
    let rtc_time = td
        .get("RTCTimeUSec")
        .map(|s| strip_weekday(s))
        .unwrap_or_default();

    let (ntp_service, ntp_server) = ntp_source().await;

    // Configured NTP server lists — editable for timesyncd and chrony.
    let (ntp_servers, ntp_fallback) = match ntp_service.as_str() {
        "systemd-timesyncd" => {
            let ts = parse_kv(&run_cmd(&["timedatectl", "show-timesync"]).await);
            (
                ts.get("SystemNTPServers").cloned().unwrap_or_default(),
                ts.get("FallbackNTPServers").cloned().unwrap_or_default(),
            )
        }
        "chrony" => {
            let servers = chrony_conf_path()
                .and_then(|p| std::fs::read_to_string(p).ok())
                .map(|c| parse_chrony_servers(&c))
                .unwrap_or_default();
            (servers.join(" "), String::new())
        }
        _ => (String::new(), String::new()),
    };

    let (reboot_required, reboot_reason) = reboot_required().await;

    let hn = parse_hostnamectl(&run_cmd(&["hostnamectl", "status"]).await);
    let static_hostname = match hn.get("static") {
        Some(h) if !h.is_empty() => h.clone(),
        _ => run_cmd(&["hostnamectl", "--static"])
            .await
            .trim()
            .to_string(),
    };
    let transient_hostname = run_cmd(&["hostname"]).await.trim().to_string();

    // Parse `localectl status` for locale, VC keymap and X11 keyboard.
    let loc = parse_localectl(&run_cmd(&["localectl", "status"]).await);

    let timezones = lines(&run_cmd(&["timedatectl", "list-timezones"]).await);
    let locales = lines(&run_cmd(&["localectl", "list-locales"]).await);
    let keymaps = lines(&run_cmd(&["localectl", "list-keymaps"]).await);
    let x11_layouts = lines(&run_cmd(&["localectl", "list-x11-keymap-layouts"]).await);

    json!({
        "time": {
            "timezone": timezone,
            "ntp": ntp,
            "ntp_synced": ntp_synced,
            "can_ntp": can_ntp,
            "local_rtc": local_rtc,
            "local_time": local_time,
            "utc_time": utc_time,
            "rtc_time": rtc_time,
            "ntp_service": ntp_service,
            "ntp_server": ntp_server,
            "ntp_servers": ntp_servers,
            "ntp_fallback": ntp_fallback,
        },
        "reboot_required": reboot_required,
        "reboot_reason": reboot_reason,
        "hostname": {
            "static": static_hostname,
            "transient": transient_hostname,
            "pretty": hn.get("pretty").cloned().unwrap_or_default(),
            "chassis": hn.get("chassis").cloned().unwrap_or_default(),
            "deployment": hn.get("deployment").cloned().unwrap_or_default(),
            "location": hn.get("location").cloned().unwrap_or_default(),
            "icon_name": hn.get("icon").cloned().unwrap_or_default(),
        },
        "locale": {
            "lang": loc.lang,
            "keymap": loc.keymap,
            "x11_layout": loc.x11_layout,
            "x11_model": loc.x11_model,
            "x11_variant": loc.x11_variant,
        },
        "options": {
            "timezones": timezones,
            "locales": locales,
            "keymaps": keymaps,
            "x11_layouts": x11_layouts,
            "chassis": ["desktop", "laptop", "convertible", "server", "tablet", "handset", "watch", "embedded", "vm", "container"],
            "deployments": ["development", "integration", "staging", "production"],
        },
    })
}

// ── Mutations ────────────────────────────────────────────────────────────────

async fn apply_action(action: &str, data: &Value, user: &str, password: &str) -> Value {
    match action {
        "set_timezone" => {
            let tz = str_field(data, "timezone");
            if tz.is_empty() {
                return json!({ "error": "timezone is required" });
            }
            // Defence-in-depth: only accept a known zone even though args aren't shelled.
            // Skip the check if the list is unavailable — timedatectl still validates.
            let known = lines(&run_cmd(&["timedatectl", "list-timezones"]).await);
            if !known.is_empty() && !known.iter().any(|z| z == &tz) {
                return json!({ "error": format!("unknown timezone: {tz}") });
            }
            let r = sudo_as_user(user, password, &["timedatectl", "set-timezone", &tz]).await;
            crate::audit::log(
                user,
                "system.set_timezone",
                &tz,
                r.get("error").is_none(),
                "",
            );
            r
        }
        "set_ntp" => {
            let enabled = data
                .get("enabled")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            let arg = if enabled { "true" } else { "false" };
            let r = sudo_as_user(user, password, &["timedatectl", "set-ntp", arg]).await;
            crate::audit::log(user, "system.set_ntp", arg, r.get("error").is_none(), "");
            r
        }
        "set_time" => {
            let ts = str_field(data, "time");
            if !is_valid_datetime(&ts) {
                return json!({ "error": "expected time as YYYY-MM-DD HH:MM:SS" });
            }
            let r = sudo_as_user(user, password, &["timedatectl", "set-time", &ts]).await;
            crate::audit::log(user, "system.set_time", &ts, r.get("error").is_none(), "");
            r
        }
        "set_ntp_servers" => set_ntp_servers(data, user, password).await,
        "set_local_rtc" => {
            let enabled = data
                .get("enabled")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            let arg = if enabled { "true" } else { "false" };
            let r = sudo_as_user(user, password, &["timedatectl", "set-local-rtc", arg]).await;
            crate::audit::log(
                user,
                "system.set_local_rtc",
                arg,
                r.get("error").is_none(),
                "",
            );
            r
        }
        "set_hostname" => {
            let name = str_field(data, "hostname");
            if !is_valid_hostname(&name) {
                return json!({ "error": "invalid hostname" });
            }
            let r = sudo_as_user(user, password, &["hostnamectl", "set-hostname", &name]).await;
            crate::audit::log(
                user,
                "system.set_hostname",
                &name,
                r.get("error").is_none(),
                "",
            );
            r
        }
        "set_locale" => {
            let lang = str_field(data, "lang");
            if lang.is_empty() {
                return json!({ "error": "locale is required" });
            }
            let known = lines(&run_cmd(&["localectl", "list-locales"]).await);
            if !known.is_empty() && !known.iter().any(|l| l == &lang) {
                return json!({ "error": format!("unknown locale: {lang}") });
            }
            let arg = format!("LANG={lang}");
            let r = sudo_as_user(user, password, &["localectl", "set-locale", &arg]).await;
            crate::audit::log(
                user,
                "system.set_locale",
                &lang,
                r.get("error").is_none(),
                "",
            );
            r
        }
        "set_keymap" => {
            let keymap = str_field(data, "keymap");
            if keymap.is_empty() {
                return json!({ "error": "keymap is required" });
            }
            let known = lines(&run_cmd(&["localectl", "list-keymaps"]).await);
            if !known.is_empty() && !known.iter().any(|k| k == &keymap) {
                return json!({ "error": format!("unknown keymap: {keymap}") });
            }
            let r = sudo_as_user(user, password, &["localectl", "set-keymap", &keymap]).await;
            crate::audit::log(
                user,
                "system.set_keymap",
                &keymap,
                r.get("error").is_none(),
                "",
            );
            r
        }
        "set_x11_keymap" => {
            let layout = str_field(data, "x11_layout");
            let variant = str_field(data, "x11_variant");
            if layout.is_empty() {
                return json!({ "error": "X11 layout is required" });
            }
            if !is_safe_token(&layout) || (!variant.is_empty() && !is_safe_token(&variant)) {
                return json!({ "error": "invalid layout/variant" });
            }
            // set-x11-keymap LAYOUT [MODEL [VARIANT]] — pass empty model to reach variant.
            let mut args: Vec<&str> = vec!["localectl", "set-x11-keymap", &layout];
            if !variant.is_empty() {
                args.push("");
                args.push(&variant);
            }
            let r = sudo_as_user(user, password, &args).await;
            let target = if variant.is_empty() {
                layout.clone()
            } else {
                format!("{layout} {variant}")
            };
            crate::audit::log(
                user,
                "system.set_x11_keymap",
                &target,
                r.get("error").is_none(),
                "",
            );
            r
        }
        "set_pretty_hostname" => {
            let name = str_field(data, "pretty");
            if name.len() > 200 {
                return json!({ "error": "pretty hostname too long" });
            }
            let r = sudo_as_user(
                user,
                password,
                &["hostnamectl", "set-hostname", "--pretty", &name],
            )
            .await;
            crate::audit::log(
                user,
                "system.set_pretty_hostname",
                &name,
                r.get("error").is_none(),
                "",
            );
            r
        }
        "set_chassis" => {
            let chassis = str_field(data, "chassis");
            const VALID: [&str; 10] = [
                "desktop",
                "laptop",
                "convertible",
                "server",
                "tablet",
                "handset",
                "watch",
                "embedded",
                "vm",
                "container",
            ];
            if !VALID.contains(&chassis.as_str()) {
                return json!({ "error": format!("invalid chassis: {chassis}") });
            }
            let r = sudo_as_user(user, password, &["hostnamectl", "set-chassis", &chassis]).await;
            crate::audit::log(
                user,
                "system.set_chassis",
                &chassis,
                r.get("error").is_none(),
                "",
            );
            r
        }
        "set_deployment" => {
            let dep = str_field(data, "deployment");
            if !dep.is_empty() && !is_safe_token(&dep) {
                return json!({ "error": "invalid deployment" });
            }
            let r = sudo_as_user(user, password, &["hostnamectl", "set-deployment", &dep]).await;
            crate::audit::log(
                user,
                "system.set_deployment",
                &dep,
                r.get("error").is_none(),
                "",
            );
            r
        }
        "set_location" => {
            let loc = str_field(data, "location");
            if loc.len() > 200 {
                return json!({ "error": "location too long" });
            }
            let r = sudo_as_user(user, password, &["hostnamectl", "set-location", &loc]).await;
            crate::audit::log(
                user,
                "system.set_location",
                &loc,
                r.get("error").is_none(),
                "",
            );
            r
        }
        other => json!({ "error": format!("unknown action: {other}") }),
    }
}

/// Configure NTP servers for whichever daemon the host runs.
/// Supports systemd-timesyncd (drop-in) and chrony (chrony.conf); others are read-only.
async fn set_ntp_servers(data: &Value, user: &str, password: &str) -> Value {
    let servers = tokenize(&str_field(data, "servers"));
    let fallback = tokenize(&str_field(data, "fallback"));
    if servers.is_empty() && fallback.is_empty() {
        return json!({ "error": "provide at least one NTP server" });
    }
    for host in servers.iter().chain(fallback.iter()) {
        if !is_valid_ntp_host(host) {
            return json!({ "error": format!("invalid server: {host}") });
        }
    }

    let (service, _) = ntp_source().await;
    match service.as_str() {
        "systemd-timesyncd" => set_timesyncd_servers(user, password, &servers, &fallback).await,
        "chrony" => set_chrony_servers(user, password, &servers).await,
        "" => json!({ "error": "no active NTP service detected" }),
        other => json!({ "error": format!("NTP server editing is not supported for {other}") }),
    }
}

/// systemd-timesyncd: write a drop-in with NTP=/FallbackNTP= and restart it.
async fn set_timesyncd_servers(
    user: &str,
    password: &str,
    servers: &[String],
    fallback: &[String],
) -> Value {
    let mut content = String::from("# Managed by Tenodera\n[Time]\n");
    content.push_str(&format!("NTP={}\n", servers.join(" ")));
    if !fallback.is_empty() {
        content.push_str(&format!("FallbackNTP={}\n", fallback.join(" ")));
    }

    let dir = "/etc/systemd/timesyncd.conf.d";
    let file = "/etc/systemd/timesyncd.conf.d/90-tenodera.conf";

    let mk = sudo_as_user(user, password, &["mkdir", "-p", dir]).await;
    if mk.get("error").is_some() {
        return mk;
    }
    let w = sudo_stdin_write_as_user(user, password, &["tee", file], &content).await;
    if w.get("error").is_some() {
        return w;
    }
    let r = sudo_as_user(
        user,
        password,
        &["systemctl", "restart", "systemd-timesyncd"],
    )
    .await;
    let ok = r.get("error").is_none();
    crate::audit::log(
        user,
        "system.set_ntp_servers",
        &servers.join(","),
        ok,
        "timesyncd",
    );
    if !ok { r } else { json!({ "ok": true }) }
}

/// chrony: replace the `server`/`pool` directives in chrony.conf and restart chronyd.
async fn set_chrony_servers(user: &str, password: &str, servers: &[String]) -> Value {
    if servers.is_empty() {
        return json!({ "error": "provide at least one NTP server" });
    }
    let Some(path) = chrony_conf_path() else {
        return json!({ "error": "chrony configuration file not found" });
    };
    // Agent runs as root, so it can read the config directly.
    let content = std::fs::read_to_string(&path).unwrap_or_default();

    // Keep every line that isn't a server/pool directive, then append the new set.
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
    for s in servers {
        kept.push(format!("server {s} iburst"));
    }
    let new_content = kept.join("\n") + "\n";

    let w = sudo_stdin_write_as_user(user, password, &["tee", &path], &new_content).await;
    if w.get("error").is_some() {
        return w;
    }
    let unit = active_unit(&["chronyd", "chrony"])
        .await
        .unwrap_or_else(|| "chronyd".to_string());
    let r = sudo_as_user(user, password, &["systemctl", "restart", &unit]).await;
    let ok = r.get("error").is_none();
    crate::audit::log(
        user,
        "system.set_ntp_servers",
        &servers.join(","),
        ok,
        "chrony",
    );
    if !ok { r } else { json!({ "ok": true }) }
}

/// Locate the chrony main config across common distro layouts.
pub(crate) fn chrony_conf_path() -> Option<String> {
    ["/etc/chrony/chrony.conf", "/etc/chrony.conf"]
        .into_iter()
        .find(|p| std::path::Path::new(p).exists())
        .map(|p| p.to_string())
}

/// Extract the hosts from `server`/`pool` directives in a chrony config.
fn parse_chrony_servers(content: &str) -> Vec<String> {
    content
        .lines()
        .filter_map(|l| {
            let t = l.trim();
            if t.starts_with('#') || t.starts_with('!') {
                return None;
            }
            let mut it = t.split_whitespace();
            let kw = it.next()?.to_ascii_lowercase();
            if kw == "server" || kw == "pool" {
                it.next().map(|s| s.to_string())
            } else {
                None
            }
        })
        .collect()
}

/// Return the first active systemd unit among the candidates.
pub(crate) async fn active_unit(candidates: &[&str]) -> Option<String> {
    for u in candidates {
        if run_cmd(&["systemctl", "is-active", u]).await.trim() == "active" {
            return Some(u.to_string());
        }
    }
    None
}

/// Detect whether the host needs a reboot (post-update), with a short reason.
async fn reboot_required() -> (bool, String) {
    if std::path::Path::new("/run/reboot-required").exists()
        || std::path::Path::new("/var/run/reboot-required").exists()
    {
        let pkgs = std::fs::read_to_string("/run/reboot-required.pkgs")
            .or_else(|_| std::fs::read_to_string("/var/run/reboot-required.pkgs"))
            .unwrap_or_default();
        let n = pkgs.lines().filter(|l| !l.trim().is_empty()).count();
        let reason = if n == 0 {
            "A system update requires a reboot.".to_string()
        } else {
            format!("{n} updated package(s) require a reboot.")
        };
        return (true, reason);
    }
    // Fedora/RHEL: `needs-restarting -r` exits 1 when a reboot is advised.
    if which("needs-restarting").await && cmd_status(&["needs-restarting", "-r"]).await == Some(1) {
        return (true, "Updated packages require a reboot.".to_string());
    }
    (false, String::new())
}

/// Run a command discarding output and return its exit code.
async fn cmd_status(args: &[&str]) -> Option<i32> {
    let (cmd, rest) = args.split_first()?;
    tokio::process::Command::new(cmd)
        .args(rest)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .await
        .ok()
        .and_then(|s| s.code())
}

/// Split a server list on whitespace and commas.
fn tokenize(s: &str) -> Vec<String> {
    s.split([',', ' ', '\t', '\n'])
        .map(|t| t.trim().to_string())
        .filter(|t| !t.is_empty())
        .collect()
}

/// Accept a hostname or IPv4/IPv6 literal for an NTP server entry.
pub(crate) fn is_valid_ntp_host(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 255
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '.' | ':'))
}

// ── Helpers ──────────────────────────────────────────────────────────────────

fn str_field(data: &Value, key: &str) -> String {
    data.get(key)
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string()
}

/// Parse `key=value` lines (as emitted by `timedatectl show`).
fn parse_kv(out: &str) -> std::collections::HashMap<String, String> {
    out.lines()
        .filter_map(|l| l.split_once('='))
        .map(|(k, v)| (k.trim().to_string(), v.trim().to_string()))
        .collect()
}

#[derive(Default)]
struct LocaleInfo {
    lang: String,
    keymap: String,
    x11_layout: String,
    x11_model: String,
    x11_variant: String,
}

/// Normalise localectl's "unset" markers to an empty string.
fn norm_unset(s: &str) -> String {
    let s = s.trim();
    if s == "n/a" || s == "(unset)" {
        String::new()
    } else {
        s.to_string()
    }
}

/// Parse `localectl status` for locale, VC keymap and X11 keyboard settings.
fn parse_localectl(out: &str) -> LocaleInfo {
    let mut info = LocaleInfo::default();
    for line in out.lines() {
        let l = line.trim();
        if let Some(rest) = l.strip_prefix("System Locale:") {
            // e.g. "System Locale: LANG=en_US.UTF-8"
            for tok in rest.split_whitespace() {
                if let Some(v) = tok.strip_prefix("LANG=") {
                    info.lang = v.to_string();
                }
            }
        } else if let Some(rest) = l.strip_prefix("VC Keymap:") {
            info.keymap = norm_unset(rest);
        } else if let Some(rest) = l.strip_prefix("X11 Layout:") {
            info.x11_layout = norm_unset(rest);
        } else if let Some(rest) = l.strip_prefix("X11 Model:") {
            info.x11_model = norm_unset(rest);
        } else if let Some(rest) = l.strip_prefix("X11 Variant:") {
            info.x11_variant = norm_unset(rest);
        }
    }
    info
}

/// Parse `hostnamectl status` into a field map (static, pretty, chassis, …).
/// Lines look like "   Static hostname: panel" — key before ':', value after.
fn parse_hostnamectl(out: &str) -> std::collections::HashMap<String, String> {
    let mut m = std::collections::HashMap::new();
    for line in out.lines() {
        let Some((key, val)) = line.split_once(':') else {
            continue;
        };
        let key = key.trim().to_lowercase();
        let mut val = norm_unset(val);
        let slot = match key.as_str() {
            "static hostname" => "static",
            "pretty hostname" => "pretty",
            "transient hostname" => "transient",
            "icon name" => "icon",
            // Newer systemd appends a decorative glyph (e.g. "vm 🖴") — keep the token only.
            "chassis" => {
                val = val.split_whitespace().next().unwrap_or("").to_string();
                "chassis"
            }
            "deployment" => "deployment",
            "location" => "location",
            _ => continue,
        };
        m.insert(slot.to_string(), val);
    }
    m
}

/// Strip the leading weekday from a timedatectl timestamp:
/// "Thu 2026-07-16 21:11:05 UTC" → "2026-07-16 21:11:05 UTC".
fn strip_weekday(s: &str) -> String {
    let s = s.trim();
    match s.split_once(' ') {
        Some((first, rest))
            if first.len() == 3 && first.chars().all(|c| c.is_ascii_alphabetic()) =>
        {
            rest.to_string()
        }
        _ => s.to_string(),
    }
}

/// Detect the active time-sync daemon and (for timesyncd) its current server.
async fn ntp_source() -> (String, String) {
    let candidates = [
        ("systemd-timesyncd", "systemd-timesyncd"),
        ("chronyd", "chrony"),
        ("chrony", "chrony"),
        ("ntpsec", "ntpsec"),
        ("ntpd", "ntpd"),
        ("ntp", "ntpd"),
        ("openntpd", "openntpd"),
        ("ptp4l", "ptp4l"),
        ("phc2sys", "phc2sys"),
    ];
    let mut service = String::new();
    for (unit, label) in candidates {
        if run_cmd(&["systemctl", "is-active", unit]).await.trim() == "active" {
            service = label.to_string();
            break;
        }
    }

    // timesyncd exposes the peer via `timedatectl timesync-status`.
    let mut server = String::new();
    if service == "systemd-timesyncd" {
        let ts = parse_kv(&run_cmd(&["timedatectl", "show-timesync"]).await);
        server = ts
            .get("ServerName")
            .or_else(|| ts.get("ServerAddress"))
            .cloned()
            .unwrap_or_default();
    }

    (service, server)
}

/// Safe short token for keyboard layouts/variants and deployment tags:
/// alphanumerics plus a few separators (localectl accepts comma-separated layouts).
fn is_safe_token(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 64
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | ',' | '.'))
}

/// Validate a "YYYY-MM-DD HH:MM:SS" timestamp (chars only; timedatectl re-validates).
fn is_valid_datetime(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 25
        && s.chars()
            .all(|c| c.is_ascii_digit() || c == '-' || c == ':' || c == ' ')
        && s.contains('-')
        && s.contains(':')
}

fn lines(out: &str) -> Vec<String> {
    out.lines()
        .map(|l| l.trim().to_string())
        .filter(|l| !l.is_empty() && !l.starts_with("error:"))
        .collect()
}

/// RFC-1123-ish hostname validation (labels of [a-z0-9-], dots between).
fn is_valid_hostname(h: &str) -> bool {
    if h.is_empty() || h.len() > 253 {
        return false;
    }
    h.split('.').all(|label| {
        !label.is_empty()
            && label.len() <= 63
            && !label.starts_with('-')
            && !label.ends_with('-')
            && label.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hostname_validation() {
        assert!(is_valid_hostname("web-01"));
        assert!(is_valid_hostname("panel.tenodera.test"));
        assert!(!is_valid_hostname(""));
        assert!(!is_valid_hostname("-bad"));
        assert!(!is_valid_hostname("bad-"));
        assert!(!is_valid_hostname("has space"));
        assert!(!is_valid_hostname("under_score"));
    }

    #[test]
    fn parse_kv_basic() {
        let m = parse_kv("Timezone=Europe/Warsaw\nNTP=yes\nNTPSynchronized=no\n");
        assert_eq!(m.get("Timezone").unwrap(), "Europe/Warsaw");
        assert_eq!(m.get("NTP").unwrap(), "yes");
    }

    #[test]
    fn datetime_validation() {
        assert!(is_valid_datetime("2026-07-16 21:11:05"));
        assert!(!is_valid_datetime(""));
        assert!(!is_valid_datetime("2026/07/16"));
        assert!(!is_valid_datetime("rm -rf /"));
        assert!(!is_valid_datetime("21:11:05")); // no date part
    }

    #[test]
    fn strip_weekday_works() {
        assert_eq!(
            strip_weekday("Thu 2026-07-16 21:11:05 UTC"),
            "2026-07-16 21:11:05 UTC"
        );
        assert_eq!(
            strip_weekday("2026-07-16 21:11:05 UTC"),
            "2026-07-16 21:11:05 UTC"
        );
    }

    #[test]
    fn parse_localectl_status() {
        let out = "   System Locale: LANG=en_US.UTF-8\n       VC Keymap: pl\n    X11 Layout: us\n     X11 Variant: intl\n";
        let loc = parse_localectl(out);
        assert_eq!(loc.lang, "en_US.UTF-8");
        assert_eq!(loc.keymap, "pl");
        assert_eq!(loc.x11_layout, "us");
        assert_eq!(loc.x11_variant, "intl");
    }

    #[test]
    fn parse_hostnamectl_fields() {
        let out = "   Static hostname: panel\n   Pretty hostname: My Panel\n          Chassis: vm\n       Deployment: production\n         Icon name: computer-vm\n";
        let m = parse_hostnamectl(out);
        assert_eq!(m.get("static").unwrap(), "panel");
        assert_eq!(m.get("pretty").unwrap(), "My Panel");
        assert_eq!(m.get("chassis").unwrap(), "vm");
        assert_eq!(m.get("deployment").unwrap(), "production");
    }

    #[test]
    fn chrony_servers_parse() {
        let conf = "# comment\npool 2.debian.pool.ntp.org iburst\nserver time.cloudflare.com iburst\ndriftfile /var/lib/chrony/drift\n";
        let s = parse_chrony_servers(conf);
        assert_eq!(s, vec!["2.debian.pool.ntp.org", "time.cloudflare.com"]);
    }

    #[test]
    fn ntp_host_and_tokenize() {
        assert_eq!(tokenize("a.b, c d\ne"), vec!["a.b", "c", "d", "e"]);
        assert!(is_valid_ntp_host("pool.ntp.org"));
        assert!(is_valid_ntp_host("192.168.1.1"));
        assert!(is_valid_ntp_host("2001:db8::1"));
        assert!(!is_valid_ntp_host("bad host"));
        assert!(!is_valid_ntp_host("a;b"));
    }

    #[test]
    fn safe_token_rules() {
        assert!(is_safe_token("us"));
        assert!(is_safe_token("us,pl"));
        assert!(is_safe_token("dvorak-intl"));
        assert!(!is_safe_token(""));
        assert!(!is_safe_token("us; rm -rf"));
        assert!(!is_safe_token("has space"));
    }
}
