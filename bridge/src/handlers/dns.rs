use crate::handler::ChannelHandler;
use crate::util::{require_admin, run_cmd, sudo_action, sudo_stdin_write, which};
use serde_json::{json, Value};
use tenodera_protocol::channel::ChannelOpenOptions;
use tenodera_protocol::message::Message;

// ── Info handler ──────────────────────────────────────────────────────────────

pub struct DnsInfoHandler;

#[async_trait::async_trait]
impl ChannelHandler for DnsInfoHandler {
    fn payload_type(&self) -> &str { "dns.info" }

    async fn open(&self, channel: &str, _options: &ChannelOpenOptions) -> Vec<Message> {
        let data = get_dns_info().await;
        vec![
            Message::Ready { channel: channel.into() },
            Message::Data { channel: channel.into(), data },
            Message::Close { channel: channel.into(), problem: None },
        ]
    }
}

// ── Manage handler ────────────────────────────────────────────────────────────

pub struct DnsManageHandler;

#[async_trait::async_trait]
impl ChannelHandler for DnsManageHandler {
    fn payload_type(&self) -> &str { "dns.manage" }

    async fn open(&self, channel: &str, options: &ChannelOpenOptions) -> Vec<Message> {
        let data = Value::Object(options.extra.clone());
        let result = if let Some(err) = require_admin(&data) {
            err
        } else {
            let action = data.get("action").and_then(|v| v.as_str()).unwrap_or("");
            let password = data.get("password").and_then(|v| v.as_str()).unwrap_or("");

            match action {
                "set_resolv_conf" => {
                    let content = data.get("content").and_then(|v| v.as_str()).unwrap_or("");
                    sudo_stdin_write(password, &["tee", "/etc/resolv.conf"], content).await
                }
                "set_hosts" => {
                    let content = data.get("content").and_then(|v| v.as_str()).unwrap_or("");
                    sudo_stdin_write(password, &["tee", "/etc/hosts"], content).await
                }
                "flush_cache" => flush_dns_cache(password).await,
                _ => json!({ "ok": false, "error": format!("unknown action: {action}") }),
            }
        };

        vec![
            Message::Ready { channel: channel.into() },
            Message::Data { channel: channel.into(), data: result },
            Message::Close { channel: channel.into(), problem: None },
        ]
    }
}

// ── Lookup handler ────────────────────────────────────────────────────────────

pub struct DnsLookupHandler;

#[async_trait::async_trait]
impl ChannelHandler for DnsLookupHandler {
    fn payload_type(&self) -> &str { "dns.lookup" }

    async fn open(&self, channel: &str, options: &ChannelOpenOptions) -> Vec<Message> {
        let data = Value::Object(options.extra.clone());
        let name = data.get("name").and_then(|v| v.as_str()).unwrap_or("").trim();
        let qtype = data.get("type").and_then(|v| v.as_str()).unwrap_or("A").trim();

        let result = if name.is_empty() {
            json!({ "ok": false, "output": "No hostname specified" })
        } else if !is_safe_name(name) {
            json!({ "ok": false, "output": "Invalid hostname" })
        } else {
            do_lookup(name, qtype).await
        };

        vec![
            Message::Ready { channel: channel.into() },
            Message::Data { channel: channel.into(), data: result },
            Message::Close { channel: channel.into(), problem: None },
        ]
    }
}

// ── Helpers ────────────────────────────────────────────────────────────────────

async fn get_dns_info() -> Value {
    let resolv_conf = tokio::fs::read_to_string("/etc/resolv.conf")
        .await
        .unwrap_or_default();

    let hosts = tokio::fs::read_to_string("/etc/hosts")
        .await
        .unwrap_or_default();

    let (servers, search) = parse_resolv_conf(&resolv_conf);

    let resolved_active = run_cmd(&["systemctl", "is-active", "systemd-resolved"]).await
        .trim()
        .eq("active");

    json!({
        "resolv_conf": resolv_conf,
        "hosts":       hosts,
        "servers":     servers,
        "search":      search,
        "resolved_active": resolved_active,
    })
}

fn parse_resolv_conf(content: &str) -> (Vec<String>, Vec<String>) {
    let mut servers = Vec::new();
    let mut search = Vec::new();

    for line in content.lines() {
        let line = line.trim();
        if line.starts_with('#') || line.is_empty() {
            continue;
        }
        if let Some(rest) = line.strip_prefix("nameserver") {
            let ip = rest.trim().to_string();
            if !ip.is_empty() {
                servers.push(ip);
            }
        } else if let Some(rest) = line.strip_prefix("search") {
            for domain in rest.split_whitespace() {
                search.push(domain.to_string());
            }
        } else if let Some(rest) = line.strip_prefix("domain") {
            let d = rest.trim().to_string();
            if !d.is_empty() && !search.contains(&d) {
                search.push(d);
            }
        }
    }

    (servers, search)
}

async fn flush_dns_cache(password: &str) -> Value {
    if which("resolvectl").await {
        let r = sudo_action(password, &["resolvectl", "flush-caches"]).await;
        if r.get("ok").and_then(|v| v.as_bool()).unwrap_or(false) {
            return json!({ "ok": true });
        }
    }
    // Fallback: restart nscd
    if which("nscd").await {
        let r = sudo_action(password, &["systemctl", "try-restart", "nscd"]).await;
        if r.get("ok").and_then(|v| v.as_bool()).unwrap_or(false) {
            return json!({ "ok": true });
        }
    }
    json!({ "ok": false, "error": "No DNS cache manager found (tried resolvectl, nscd)" })
}

async fn do_lookup(name: &str, qtype: &str) -> Value {
    let safe_type = sanitise_qtype(qtype);

    // Try dig first
    if which("dig").await {
        let out = run_cmd(&["dig", "+short", "+time=3", "+tries=1", name, &safe_type]).await;
        let trimmed = out.trim().to_string();
        return json!({ "ok": true, "output": if trimmed.is_empty() { "(no records)".into() } else { trimmed } });
    }

    // Fallback: host
    if which("host").await {
        let out = run_cmd(&["host", "-t", &safe_type, name]).await;
        return json!({ "ok": true, "output": out.trim().to_string() });
    }

    // Fallback: resolvectl query
    if which("resolvectl").await {
        let out = run_cmd(&["resolvectl", "query", name]).await;
        return json!({ "ok": true, "output": out.trim().to_string() });
    }

    // Fallback: nslookup
    if which("nslookup").await {
        let out = run_cmd(&["nslookup", name]).await;
        return json!({ "ok": true, "output": out.trim().to_string() });
    }

    json!({ "ok": false, "output": "No DNS lookup tool found (dig, host, resolvectl, nslookup)" })
}

fn is_safe_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 253
        && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == '_' || c == ':')
}

fn sanitise_qtype(t: &str) -> String {
    match t.to_ascii_uppercase().as_str() {
        "A" | "AAAA" | "MX" | "NS" | "TXT" | "CNAME" | "SOA" | "PTR" | "SRV" => t.to_ascii_uppercase(),
        _ => "A".to_string(),
    }
}
