use crate::handler::ChannelHandler;
use crate::util::{require_admin, run_cmd, sudo_as_user, sudo_stdin_write_as_user, which};
use serde_json::{Value, json};
use tenodera_protocol::channel::ChannelOpenOptions;
use tenodera_protocol::message::Message;

// ── Info handler ──────────────────────────────────────────────────────────────

pub struct DnsInfoHandler;

#[async_trait::async_trait]
impl ChannelHandler for DnsInfoHandler {
    fn payload_type(&self) -> &str {
        "dns.info"
    }

    async fn open(&self, channel: &str, _options: &ChannelOpenOptions) -> Vec<Message> {
        let data = get_dns_info().await;
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

pub struct DnsManageHandler;

#[async_trait::async_trait]
impl ChannelHandler for DnsManageHandler {
    fn payload_type(&self) -> &str {
        "dns.manage"
    }

    async fn open(&self, channel: &str, options: &ChannelOpenOptions) -> Vec<Message> {
        let data = Value::Object(options.extra.clone());
        let result = if let Some(err) = require_admin(&data) {
            err
        } else {
            let action = data.get("action").and_then(|v| v.as_str()).unwrap_or("");
            let user = data.get("_user").and_then(|v| v.as_str()).unwrap_or("");
            let password = data.get("password").and_then(|v| v.as_str()).unwrap_or("");

            match action {
                "set_resolv_conf" => {
                    let content = data.get("content").and_then(|v| v.as_str()).unwrap_or("");
                    sudo_stdin_write_as_user(user, password, &["tee", "/etc/resolv.conf"], content)
                        .await
                }
                "set_hosts" => {
                    let content = data.get("content").and_then(|v| v.as_str()).unwrap_or("");
                    sudo_stdin_write_as_user(user, password, &["tee", "/etc/hosts"], content).await
                }
                "flush_cache" => flush_dns_cache(user, password).await,
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

// ── Lookup handler ────────────────────────────────────────────────────────────

pub struct DnsLookupHandler;

#[async_trait::async_trait]
impl ChannelHandler for DnsLookupHandler {
    fn payload_type(&self) -> &str {
        "dns.lookup"
    }

    async fn open(&self, channel: &str, options: &ChannelOpenOptions) -> Vec<Message> {
        let data = Value::Object(options.extra.clone());
        let name = data
            .get("name")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim();
        let qtype = data
            .get("qtype")
            .and_then(|v| v.as_str())
            .unwrap_or("A")
            .trim();

        let result = if name.is_empty() {
            json!({ "ok": false, "output": "No hostname specified" })
        } else if !is_safe_name(name) {
            json!({ "ok": false, "output": "Invalid hostname" })
        } else {
            do_lookup(name, qtype).await
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

// ── Helpers ────────────────────────────────────────────────────────────────────

async fn get_dns_info() -> Value {
    let resolv_conf = tokio::fs::read_to_string("/etc/resolv.conf")
        .await
        .unwrap_or_default();

    let hosts = tokio::fs::read_to_string("/etc/hosts")
        .await
        .unwrap_or_default();

    let (servers, search) = parse_resolv_conf(&resolv_conf);

    let resolved_active = run_cmd(&["systemctl", "is-active", "systemd-resolved"])
        .await
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

async fn flush_dns_cache(user: &str, password: &str) -> Value {
    if which("resolvectl").await {
        let r = sudo_as_user(user, password, &["resolvectl", "flush-caches"]).await;
        if r.get("ok").and_then(|v| v.as_bool()).unwrap_or(false) {
            return json!({ "ok": true });
        }
    }
    // Fallback: restart nscd
    if which("nscd").await {
        let r = sudo_as_user(user, password, &["systemctl", "try-restart", "nscd"]).await;
        if r.get("ok").and_then(|v| v.as_bool()).unwrap_or(false) {
            return json!({ "ok": true });
        }
    }
    json!({ "ok": false, "error": "No DNS cache manager found (tried resolvectl, nscd)" })
}

async fn do_lookup(name: &str, qtype: &str) -> Value {
    let safe_type = sanitise_qtype(qtype);
    match tokio::time::timeout(
        std::time::Duration::from_secs(8),
        do_lookup_inner(name, &safe_type),
    )
    .await
    {
        Ok(v) => v,
        Err(_) => {
            json!({ "ok": false, "output": "Lookup timed out (8s). The host may not have external DNS access." })
        }
    }
}

async fn do_lookup_inner(name: &str, qtype: &str) -> Value {
    // Try dig first
    if which("dig").await {
        let out = run_cmd(&["dig", "+short", "+time=3", "+tries=1", name, qtype]).await;
        let trimmed = out.trim().to_string();
        return json!({ "ok": true, "output": if trimmed.is_empty() { "(no records)".into() } else { trimmed } });
    }

    // Fallback: host
    if which("host").await {
        let out = run_cmd(&["host", "-t", qtype, name]).await;
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

// ── systemd-resolved info handler ─────────────────────────────────────────────

pub struct DnsResolvedInfoHandler;

#[async_trait::async_trait]
impl ChannelHandler for DnsResolvedInfoHandler {
    fn payload_type(&self) -> &str {
        "dns.resolved.info"
    }

    async fn open(&self, channel: &str, _options: &ChannelOpenOptions) -> Vec<Message> {
        let data = get_resolved_info().await;
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

// ── systemd-resolved manage handler ───────────────────────────────────────────

pub struct DnsResolvedManageHandler;

#[async_trait::async_trait]
impl ChannelHandler for DnsResolvedManageHandler {
    fn payload_type(&self) -> &str {
        "dns.resolved.manage"
    }

    async fn open(&self, channel: &str, options: &ChannelOpenOptions) -> Vec<Message> {
        let data = Value::Object(options.extra.clone());
        let result = if let Some(err) = require_admin(&data) {
            err
        } else {
            let action = data.get("action").and_then(|v| v.as_str()).unwrap_or("");
            let user = data.get("_user").and_then(|v| v.as_str()).unwrap_or("");
            let password = data.get("password").and_then(|v| v.as_str()).unwrap_or("");
            match action {
                "set_config" => set_resolved_config(&data, user, password).await,
                "restart" => {
                    sudo_as_user(
                        user,
                        password,
                        &["systemctl", "restart", "systemd-resolved"],
                    )
                    .await
                }
                "start" => {
                    sudo_as_user(user, password, &["systemctl", "start", "systemd-resolved"]).await
                }
                "stop" => {
                    sudo_as_user(user, password, &["systemctl", "stop", "systemd-resolved"]).await
                }
                "flush_caches" => {
                    let r = sudo_as_user(user, password, &["resolvectl", "flush-caches"]).await;
                    if r.get("ok").and_then(|v| v.as_bool()).unwrap_or(false) {
                        r
                    } else {
                        json!({ "ok": false, "error": "flush-caches failed (is systemd-resolved active?)" })
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

// ── systemd-resolved helpers ───────────────────────────────────────────────────

async fn get_resolved_info() -> Value {
    let active = run_cmd(&["systemctl", "is-active", "systemd-resolved"])
        .await
        .trim()
        == "active";
    let has_resolvectl = which("resolvectl").await;

    let status_out = if active && has_resolvectl {
        run_cmd(&["resolvectl", "status"]).await
    } else {
        String::new()
    };

    // statistics — try without sudo; may require sudo on some distros
    let stats_out = if active && has_resolvectl {
        run_cmd(&["resolvectl", "statistics"]).await
    } else {
        String::new()
    };

    let (
        mode,
        current_dns,
        dns_servers,
        fallback_dns,
        dns_domain,
        dnssec,
        dns_over_tls,
        llmnr,
        mdns,
        links,
    ) = parse_resolvectl_status(&status_out);

    let (stat_transactions, stat_hits, stat_misses) = parse_resolvectl_stats(&stats_out);

    let conf = read_resolved_conf().await;

    json!({
        "active":           active,
        "has_resolvectl":   has_resolvectl,
        "mode":             mode,
        "current_dns":      current_dns,
        "dns_servers":      dns_servers,
        "fallback_dns":     fallback_dns,
        "dns_domain":       dns_domain,
        "dnssec":           dnssec,
        "dns_over_tls":     dns_over_tls,
        "llmnr":            llmnr,
        "mdns":             mdns,
        "links":            links,
        "stat_transactions": stat_transactions,
        "stat_hits":        stat_hits,
        "stat_misses":      stat_misses,
        "conf":             conf,
    })
}

// Parses one `resolvectl status` block into its many independent fields; a
// dedicated struct would not add clarity for a single internal call site.
#[allow(clippy::type_complexity)]
fn parse_resolvectl_status(
    output: &str,
) -> (
    String,
    String,
    Vec<String>,
    Vec<String>,
    String,
    String,
    String,
    String,
    String,
    Vec<Value>,
) {
    let mut mode = String::new();
    let mut current_dns = String::new();
    let mut dns_servers: Vec<String> = Vec::new();
    let mut fallback_dns: Vec<String> = Vec::new();
    let mut dns_domain = String::new();
    let mut dnssec = String::new();
    let mut dns_over_tls = String::new();
    let mut llmnr = String::new();
    let mut mdns = String::new();
    let mut links: Vec<Value> = Vec::new();

    #[derive(PartialEq)]
    enum Section {
        Global,
        Link,
    }
    let mut section = Section::Global;
    let mut link_name = String::new();
    let mut link_dns = String::new();
    let mut link_servers: Vec<String> = Vec::new();
    let mut link_domain = String::new();

    let flush_link =
        |name: &str, dns: &str, servers: &[String], domain: &str, links: &mut Vec<Value>| {
            if !name.is_empty() {
                links.push(json!({
                    "name": name,
                    "current_dns": dns,
                    "dns_servers": servers,
                    "dns_domain": domain,
                }));
            }
        };

    let mut proto_buf = String::new(); // accumulate multi-line Protocols value
    let mut in_proto = false;

    for raw_line in output.lines() {
        let line = raw_line.trim_end();

        // Continuation line for Protocols (starts with spaces, no colon before value)
        if in_proto && line.starts_with("                    ") && !line.contains(':') {
            proto_buf.push(' ');
            proto_buf.push_str(line.trim());
            continue;
        }
        in_proto = false;

        if line == "Global" {
            if section == Section::Link {
                flush_link(
                    &link_name,
                    &link_dns,
                    &link_servers,
                    &link_domain,
                    &mut links,
                );
                link_name.clear();
                link_dns.clear();
                link_servers.clear();
                link_domain.clear();
            }
            section = Section::Global;
            continue;
        }

        if line.starts_with("Link ") {
            // Finalise previous link
            if section == Section::Link {
                flush_link(
                    &link_name,
                    &link_dns,
                    &link_servers,
                    &link_domain,
                    &mut links,
                );
                link_name.clear();
                link_dns.clear();
                link_servers.clear();
                link_domain.clear();
            }
            // Parse "Link 2 (eth0)"
            if let (Some(s), Some(e)) = (line.find('('), line.find(')')) {
                link_name = line[s + 1..e].to_string();
            }
            section = Section::Link;
            continue;
        }

        // key: value lines
        if let Some(colon) = line.find(':') {
            let key = line[..colon].trim();
            let val = line[colon + 1..].trim().to_string();

            match section {
                Section::Global => match key {
                    "resolv.conf mode" => mode = val,
                    "Current DNS Server" => current_dns = val,
                    "DNS Servers" => {
                        dns_servers = val.split_whitespace().map(|s| s.to_string()).collect()
                    }
                    "Fallback DNS Servers" | "Fallback DNS Server" => {
                        fallback_dns = val.split_whitespace().map(|s| s.to_string()).collect()
                    }
                    "DNS Domain" => dns_domain = val,
                    "Protocols" => {
                        proto_buf = val;
                        in_proto = true;
                        let (d, dot, l, m) = parse_protocols(&proto_buf);
                        dnssec = d;
                        dns_over_tls = dot;
                        llmnr = l;
                        mdns = m;
                    }
                    _ => {}
                },
                Section::Link => match key {
                    "Current DNS Server" => link_dns = val,
                    "DNS Servers" => {
                        link_servers = val.split_whitespace().map(|s| s.to_string()).collect()
                    }
                    "DNS Domain" => link_domain = val,
                    _ => {}
                },
            }
        }
    }

    // Flush final Protocols parse (if continuation lines came after the loop)
    if in_proto {
        let (d, dot, l, m) = parse_protocols(&proto_buf);
        if dnssec.is_empty() {
            dnssec = d;
        }
        if dns_over_tls.is_empty() {
            dns_over_tls = dot;
        }
        if llmnr.is_empty() {
            llmnr = l;
        }
        if mdns.is_empty() {
            mdns = m;
        }
    }

    if section == Section::Link {
        flush_link(
            &link_name,
            &link_dns,
            &link_servers,
            &link_domain,
            &mut links,
        );
    }

    (
        mode,
        current_dns,
        dns_servers,
        fallback_dns,
        dns_domain,
        dnssec,
        dns_over_tls,
        llmnr,
        mdns,
        links,
    )
}

fn parse_protocols(s: &str) -> (String, String, String, String) {
    let mut dnssec = String::new();
    let mut dot = String::new();
    let mut llmnr = String::new();
    let mut mdns = String::new();

    for token in s.split_whitespace() {
        if let Some(v) = token.strip_prefix("DNSSEC=") {
            dnssec = v.split('/').next().unwrap_or(v).to_string();
        } else if let Some(v) = token.strip_prefix("DNSOverTLS=") {
            dot = v.to_string();
        } else if let Some(v) = token.strip_prefix("LLMNR=") {
            llmnr = v.to_string();
        } else if let Some(v) = token.strip_prefix("MulticastDNS=") {
            mdns = v.to_string();
        } else {
            match token {
                "+LLMNR" => llmnr = "yes".into(),
                "-LLMNR" => llmnr = "no".into(),
                "+mDNS" => mdns = "yes".into(),
                "-mDNS" => mdns = "no".into(),
                "+DNSOverTLS" => dot = "yes".into(),
                "-DNSOverTLS" => dot = "no".into(),
                _ => {}
            }
        }
    }

    (dnssec, dot, llmnr, mdns)
}

fn parse_resolvectl_stats(output: &str) -> (u64, u64, u64) {
    let mut transactions = 0u64;
    let mut hits = 0u64;
    let mut misses = 0u64;

    for line in output.lines() {
        let line = line.trim();
        if let Some(rest) = line.strip_prefix("Total Transactions:") {
            transactions = rest.trim().replace(',', "").parse().unwrap_or(0);
        } else if let Some(rest) = line.strip_prefix("Cache Hits:") {
            hits = rest.trim().replace(',', "").parse().unwrap_or(0);
        } else if let Some(rest) = line.strip_prefix("Cache Misses:") {
            misses = rest.trim().replace(',', "").parse().unwrap_or(0);
        }
    }
    (transactions, hits, misses)
}

async fn read_resolved_conf() -> Value {
    // Prefer /etc/systemd/resolved.conf (user override), fallback to /usr/lib
    let content = tokio::fs::read_to_string("/etc/systemd/resolved.conf")
        .await
        .or_else(|_| Ok::<String, std::io::Error>(String::new()))
        .unwrap_or_default();

    let default_content = if content.is_empty() {
        tokio::fs::read_to_string("/usr/lib/systemd/resolved.conf")
            .await
            .unwrap_or_default()
    } else {
        String::new()
    };

    let effective = if content.is_empty() {
        &default_content
    } else {
        &content
    };

    // Parse key=value pairs, skipping comments
    let mut dns = String::new();
    let mut fallback_dns = String::new();
    let mut domains = String::new();
    let mut dnssec = String::new();
    let mut dns_over_tls = String::new();
    let mut cache = String::new();
    let mut llmnr = String::new();
    let mut mdns = String::new();

    for line in effective.lines() {
        let line = line.trim();
        if line.starts_with('#') || line.starts_with('[') || line.is_empty() {
            continue;
        }
        if let Some((k, v)) = line.split_once('=') {
            match k.trim() {
                "DNS" => dns = v.trim().to_string(),
                "FallbackDNS" => fallback_dns = v.trim().to_string(),
                "Domains" => domains = v.trim().to_string(),
                "DNSSEC" => dnssec = v.trim().to_string(),
                "DNSOverTLS" => dns_over_tls = v.trim().to_string(),
                "Cache" => cache = v.trim().to_string(),
                "LLMNR" => llmnr = v.trim().to_string(),
                "MulticastDNS" => mdns = v.trim().to_string(),
                _ => {}
            }
        }
    }

    let has_user_conf = tokio::fs::metadata("/etc/systemd/resolved.conf")
        .await
        .is_ok();

    json!({
        "has_user_conf": has_user_conf,
        "dns": dns,
        "fallback_dns": fallback_dns,
        "domains": domains,
        "dnssec": dnssec,
        "dns_over_tls": dns_over_tls,
        "cache": cache,
        "llmnr": llmnr,
        "mdns": mdns,
    })
}

async fn set_resolved_config(data: &Value, user: &str, password: &str) -> Value {
    let get = |k: &str| {
        data.get(k)
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim()
            .to_string()
    };

    let dns = get("dns");
    let fallback = get("fallback_dns");
    let domains = get("domains");
    let dnssec = get("dnssec");
    let dot = get("dns_over_tls");
    let cache = get("cache");
    let llmnr = get("llmnr");
    let mdns = get("mdns");

    let mut lines = vec![
        "# Generated by Tenodera Admin Panel".to_string(),
        "[Resolve]".to_string(),
    ];

    let mut add = |key: &str, val: &str| {
        if !val.is_empty() {
            lines.push(format!("{key}={val}"));
        }
    };
    add("DNS", &dns);
    add("FallbackDNS", &fallback);
    add("Domains", &domains);
    add("DNSSEC", &dnssec);
    add("DNSOverTLS", &dot);
    add("Cache", &cache);
    add("LLMNR", &llmnr);
    add("MulticastDNS", &mdns);

    let content = lines.join("\n") + "\n";

    let write_result = sudo_stdin_write_as_user(
        user,
        password,
        &["tee", "/etc/systemd/resolved.conf"],
        &content,
    )
    .await;
    if !write_result
        .get("ok")
        .and_then(|v| v.as_bool())
        .unwrap_or(false)
    {
        return write_result;
    }

    // Reload config (HUP = reload without full restart)
    let reload = sudo_as_user(
        user,
        password,
        &["systemctl", "kill", "-s", "HUP", "systemd-resolved"],
    )
    .await;
    if reload.get("ok").and_then(|v| v.as_bool()).unwrap_or(false) {
        json!({ "ok": true })
    } else {
        // Fallback: full restart
        sudo_as_user(
            user,
            password,
            &["systemctl", "restart", "systemd-resolved"],
        )
        .await
    }
}

fn is_safe_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 253
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == '_' || c == ':')
}

fn sanitise_qtype(t: &str) -> String {
    match t.to_ascii_uppercase().as_str() {
        "A" | "AAAA" | "MX" | "NS" | "TXT" | "CNAME" | "SOA" | "PTR" | "SRV" => {
            t.to_ascii_uppercase()
        }
        _ => "A".to_string(),
    }
}
