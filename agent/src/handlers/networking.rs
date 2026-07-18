use tenodera_protocol::channel::{ChannelId, ChannelOpenOptions};
use tenodera_protocol::message::Message;
use tokio::io::AsyncWriteExt;
use tokio::sync::{mpsc, watch};

use crate::handler::ChannelHandler;
use crate::util::{
    UserReadOutcome, is_valid_username, run_cmd, run_cmd_as_user, sudo_as_user, which,
};

// ──────────────────────────────────────────────────────────────
//  Streaming handler  –  network traffic (TX / RX rates)
// ──────────────────────────────────────────────────────────────

pub struct NetworkStreamHandler;

#[async_trait::async_trait]
impl ChannelHandler for NetworkStreamHandler {
    fn payload_type(&self) -> &str {
        "networking.stream"
    }

    fn is_streaming(&self) -> bool {
        true
    }

    async fn open(&self, channel: &str, _options: &ChannelOpenOptions) -> Vec<Message> {
        vec![Message::Ready {
            channel: channel.into(),
        }]
    }

    async fn stream(
        &self,
        channel: &str,
        options: &ChannelOpenOptions,
        tx: mpsc::Sender<Message>,
        mut shutdown: watch::Receiver<bool>,
    ) {
        let interval_ms = options
            .extra
            .get("interval")
            .and_then(|v| v.as_u64())
            .unwrap_or(1000)
            .max(500);

        let channel: ChannelId = channel.into();
        let mut ticker = tokio::time::interval(std::time::Duration::from_millis(interval_ms));
        let mut prev = read_proc_net_dev().await;

        // First tick just establishes baseline.
        ticker.tick().await;

        loop {
            tokio::select! {
                _ = ticker.tick() => {
                    let cur = read_proc_net_dev().await;
                    let secs = interval_ms as f64 / 1000.0;

                    let mut ifaces = Vec::new();
                    for (name, (rx, tx_b)) in &cur {
                        if let Some((prx, ptx)) = prev.get(name) {
                            let rx_rate = (rx.saturating_sub(*prx)) as f64 / secs;
                            let tx_rate = (tx_b.saturating_sub(*ptx)) as f64 / secs;
                            ifaces.push(serde_json::json!({
                                "name": name,
                                "rx_bps": rx_rate,
                                "tx_bps": tx_rate,
                            }));
                        }
                    }

                    let ts = chrono::Utc::now().to_rfc3339();
                    if tx.send(Message::Data {
                        channel: channel.clone(),
                        data: serde_json::json!({ "timestamp": ts, "interfaces": ifaces }),
                    }).await.is_err() {
                        break;
                    }
                    prev = cur;
                }
                _ = shutdown.changed() => {
                    if *shutdown.borrow() { break; }
                }
            }
        }

        let _ = tx
            .send(Message::Close {
                channel,
                problem: None,
            })
            .await;
    }
}

async fn read_proc_net_dev() -> std::collections::HashMap<String, (u64, u64)> {
    let mut map = std::collections::HashMap::new();
    let Ok(content) = tokio::fs::read_to_string("/proc/net/dev").await else {
        return map;
    };
    for line in content.lines().skip(2) {
        let line = line.trim();
        let Some((iface, rest)) = line.split_once(':') else {
            continue;
        };
        let iface = iface.trim();
        if iface == "lo" {
            continue;
        }
        let vals: Vec<u64> = rest
            .split_whitespace()
            .filter_map(|v| v.parse().ok())
            .collect();
        if vals.len() >= 10 {
            map.insert(iface.to_string(), (vals[0], vals[8]));
        }
    }
    map
}

// ──────────────────────────────────────────────────────────────
//  Management handler  –  firewall, interfaces, VPN, logs
// ──────────────────────────────────────────────────────────────

pub struct NetworkManageHandler;

#[async_trait::async_trait]
impl ChannelHandler for NetworkManageHandler {
    fn payload_type(&self) -> &str {
        "networking.manage"
    }

    async fn open(&self, channel: &str, _options: &ChannelOpenOptions) -> Vec<Message> {
        vec![Message::Ready {
            channel: channel.into(),
        }]
    }

    async fn data(&self, channel: &str, data: &serde_json::Value) -> Vec<Message> {
        let action = data.get("action").and_then(|a| a.as_str()).unwrap_or("");
        let password = data.get("password").and_then(|p| p.as_str()).unwrap_or("");
        let user = data.get("_user").and_then(|u| u.as_str()).unwrap_or("");

        if !matches!(
            action,
            "list_interfaces" | "firewall_status" | "firewall_rules" | "list_ports"
        ) && let Some(err) = crate::util::require_admin(data)
        {
            return vec![Message::Data {
                channel: channel.into(),
                data: err,
            }];
        }

        let result = match action {
            // ── Interface listing ──
            "list_interfaces" => list_interfaces_detailed().await,

            // ── Firewall ──
            "firewall_status" => firewall_status_all(password).await,
            "firewall_rules" => firewall_rules_all(password).await,
            "firewall_enable" => {
                let backend = data.get("backend").and_then(|v| v.as_str()).unwrap_or("");
                let be = parse_backend(backend).unwrap_or(detect_firewall().await);
                net_sudo(user, password, &firewall_enable_cmd_for(be)).await
            }
            "firewall_disable" => {
                let backend = data.get("backend").and_then(|v| v.as_str()).unwrap_or("");
                let be = parse_backend(backend).unwrap_or(detect_firewall().await);
                net_sudo(user, password, &firewall_disable_cmd_for(be)).await
            }
            "firewall_add_rule" => {
                let rule = data.get("rule").cloned().unwrap_or_default();
                let backend = data
                    .get("backend")
                    .and_then(|v| v.as_str())
                    .or_else(|| rule.get("backend").and_then(|v| v.as_str()))
                    .unwrap_or("");
                let be = parse_backend(backend);
                firewall_add_rule(user, password, &rule, be).await
            }
            "firewall_remove_rule" => {
                let rule = data.get("rule").cloned().unwrap_or_default();
                let backend = data
                    .get("backend")
                    .and_then(|v| v.as_str())
                    .or_else(|| rule.get("backend").and_then(|v| v.as_str()))
                    .unwrap_or("");
                let be = parse_backend(backend);
                firewall_remove_rule(user, password, &rule, be).await
            }

            // ── Interface management ──
            "add_bridge" => {
                let name = data.get("name").and_then(|v| v.as_str()).unwrap_or("");
                add_bridge(user, password, name).await
            }
            "add_vlan" => {
                let parent = data.get("parent").and_then(|v| v.as_str()).unwrap_or("");
                let vlan_id = data.get("vlan_id").and_then(|v| v.as_u64()).unwrap_or(0);
                add_vlan(user, password, parent, vlan_id as u32).await
            }
            "remove_interface" => {
                let name = data.get("name").and_then(|v| v.as_str()).unwrap_or("");
                remove_interface(user, password, name).await
            }
            "iface_up" => {
                let name = data.get("name").and_then(|v| v.as_str()).unwrap_or("");
                if name.is_empty()
                    || !name
                        .chars()
                        .all(|c| c.is_alphanumeric() || "-_.".contains(c))
                {
                    serde_json::json!({ "error": "invalid interface name" })
                } else {
                    net_sudo(user, password, &["ip", "link", "set", "dev", name, "up"]).await
                }
            }
            "iface_down" => {
                let name = data.get("name").and_then(|v| v.as_str()).unwrap_or("");
                if name.is_empty()
                    || !name
                        .chars()
                        .all(|c| c.is_alphanumeric() || "-_.".contains(c))
                {
                    serde_json::json!({ "error": "invalid interface name" })
                } else {
                    net_sudo(user, password, &["ip", "link", "set", "dev", name, "down"]).await
                }
            }

            // ── VPN ──
            "vpn_list" => vpn_list().await,
            "vpn_connect" => {
                let name = data.get("name").and_then(|v| v.as_str()).unwrap_or("");
                if name.is_empty()
                    || !name
                        .chars()
                        .all(|c| c.is_alphanumeric() || "-_ ".contains(c))
                {
                    serde_json::json!({ "error": "invalid connection name" })
                } else {
                    net_sudo(user, password, &["nmcli", "connection", "up", "--", name]).await
                }
            }
            "vpn_disconnect" => {
                let name = data.get("name").and_then(|v| v.as_str()).unwrap_or("");
                if name.is_empty()
                    || !name
                        .chars()
                        .all(|c| c.is_alphanumeric() || "-_ ".contains(c))
                {
                    serde_json::json!({ "error": "invalid connection name" })
                } else {
                    net_sudo(user, password, &["nmcli", "connection", "down", "--", name]).await
                }
            }

            // ── Network logs ──
            "network_logs" => {
                let lines = data.get("lines").and_then(|v| v.as_u64()).unwrap_or(100);
                network_logs(lines).await
            }

            // ── Listening ports ──
            "list_ports" => list_ports(user, password).await,
            "kill_process" => {
                let pid = data.get("pid").and_then(|v| v.as_u64()).unwrap_or(0);
                let signal = data
                    .get("signal")
                    .and_then(|v| v.as_str())
                    .unwrap_or("TERM");
                kill_process(user, password, pid, signal).await
            }

            _ => serde_json::json!({ "error": format!("unknown action: {action}") }),
        };

        // Audit mutating network actions
        match action {
            "firewall_enable"
            | "firewall_disable"
            | "firewall_add_rule"
            | "firewall_remove_rule"
            | "add_bridge"
            | "add_vlan"
            | "remove_interface"
            | "iface_up"
            | "iface_down"
            | "vpn_connect"
            | "vpn_disconnect" => {
                let target = data
                    .get("name")
                    .or(data.get("parent"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                let ok = result.get("error").is_none();
                crate::audit::log(user, &format!("net.{action}"), target, ok, "");
            }
            _ => {}
        }

        // Always echo back the action field so the frontend can match responses
        let mut result = result;
        if let Some(obj) = result.as_object_mut()
            && !obj.contains_key("action")
            && !action.is_empty()
        {
            obj.insert("action".to_string(), serde_json::json!(action));
        }

        vec![Message::Data {
            channel: channel.into(),
            data: result,
        }]
    }
}

// ──────────────────────────────────────────────────────────────
//  Firewall detection & abstraction
// ──────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq)]
enum FirewallBackend {
    Ufw,
    Firewalld,
    Nftables,
    Iptables,
    None,
}

async fn detect_firewall() -> FirewallBackend {
    if which("ufw").await {
        FirewallBackend::Ufw
    } else if which("firewall-cmd").await {
        FirewallBackend::Firewalld
    } else if which("nft").await {
        FirewallBackend::Nftables
    } else if which("iptables").await {
        FirewallBackend::Iptables
    } else {
        FirewallBackend::None
    }
}

async fn detect_all_firewalls() -> Vec<FirewallBackend> {
    let mut backends = Vec::new();
    if which("ufw").await {
        backends.push(FirewallBackend::Ufw);
    }
    if which("firewall-cmd").await {
        backends.push(FirewallBackend::Firewalld);
    }
    if which("nft").await {
        backends.push(FirewallBackend::Nftables);
    }
    if which("iptables").await {
        backends.push(FirewallBackend::Iptables);
    }
    backends
}

fn backend_str(b: FirewallBackend) -> &'static str {
    match b {
        FirewallBackend::Ufw => "ufw",
        FirewallBackend::Firewalld => "firewalld",
        FirewallBackend::Nftables => "nftables",
        FirewallBackend::Iptables => "iptables",
        FirewallBackend::None => "none",
    }
}

fn parse_backend(s: &str) -> Option<FirewallBackend> {
    match s {
        "ufw" => Some(FirewallBackend::Ufw),
        "firewalld" => Some(FirewallBackend::Firewalld),
        "nftables" => Some(FirewallBackend::Nftables),
        "iptables" => Some(FirewallBackend::Iptables),
        _ => None,
    }
}

async fn firewall_status_single(backend: FirewallBackend, password: &str) -> (bool, String) {
    match backend {
        FirewallBackend::Ufw => {
            let out = sudo_run_cmd(password, &["ufw", "status"]).await;
            let active = out.contains("Status: active");
            let status_line = out
                .lines()
                .find(|l| l.starts_with("Status:"))
                .unwrap_or("")
                .trim()
                .to_string();
            (active, status_line)
        }
        FirewallBackend::Firewalld => {
            let out = run_cmd(&["firewall-cmd", "--state"]).await;
            let active = out.trim() == "running";
            (active, out)
        }
        FirewallBackend::Nftables => {
            let out = sudo_run_cmd(password, &["nft", "list", "ruleset"]).await;
            let active = !out.is_empty() && !out.starts_with("error:");
            (
                active,
                if !active {
                    "no rules loaded".to_string()
                } else {
                    "nftables active".to_string()
                },
            )
        }
        FirewallBackend::Iptables => {
            let out = sudo_run_cmd(password, &["iptables", "-L", "-n", "--line-numbers"]).await;
            let active = out.contains("Chain");
            (active, "iptables loaded".to_string())
        }
        FirewallBackend::None => (false, "no firewall detected".to_string()),
    }
}

async fn firewall_status_all(password: &str) -> serde_json::Value {
    let backends = detect_all_firewalls().await;
    let primary = detect_firewall().await;

    let mut statuses = Vec::new();
    for be in &backends {
        let (active, details) = firewall_status_single(*be, password).await;
        statuses.push(serde_json::json!({
            "backend": backend_str(*be),
            "active": active,
            "details": details,
        }));
    }

    if statuses.is_empty() {
        statuses.push(serde_json::json!({
            "backend": "none",
            "active": false,
            "details": "no firewall detected",
        }));
    }

    serde_json::json!({
        "primary": backend_str(primary),
        "backends": statuses,
    })
}

async fn firewall_rules_for(backend: FirewallBackend, password: &str) -> Vec<serde_json::Value> {
    let mut rules = match backend {
        FirewallBackend::Ufw => parse_ufw_rules(password).await,
        FirewallBackend::Firewalld => parse_firewalld_rules().await,
        FirewallBackend::Nftables => {
            let out = sudo_run_cmd(password, &["nft", "list", "ruleset"]).await;
            if out.trim().is_empty() || out.starts_with("error:") {
                vec![]
            } else {
                // Parse nft output line by line for better display
                out.lines()
                    .filter(|l| {
                        l.contains("counter")
                            || l.contains("accept")
                            || l.contains("drop")
                            || l.contains("reject")
                    })
                    .enumerate()
                    .map(|(i, l)| {
                        serde_json::json!({
                            "number": i + 1,
                            "rule": l.trim(),
                        })
                    })
                    .collect()
            }
        }
        FirewallBackend::Iptables => parse_iptables_rules(password).await,
        FirewallBackend::None => vec![],
    };
    // Tag each rule with backend
    let name = backend_str(backend);
    for r in &mut rules {
        if let Some(obj) = r.as_object_mut() {
            obj.insert("backend".to_string(), serde_json::json!(name));
        }
    }
    rules
}

async fn firewall_rules_all(password: &str) -> serde_json::Value {
    let backends = detect_all_firewalls().await;
    let has_ufw = backends.contains(&FirewallBackend::Ufw);
    let has_firewalld = backends.contains(&FirewallBackend::Firewalld);
    let mut all_rules = Vec::new();

    for be in &backends {
        let mut rules = firewall_rules_for(*be, password).await;
        // When a high-level frontend (ufw/firewalld) is present, low-level
        // backends contain their internal chains → filter them out so only
        // user-meaningful rules from the low-level backend remain.
        if (*be == FirewallBackend::Nftables || *be == FirewallBackend::Iptables)
            && (has_ufw || has_firewalld)
        {
            rules.retain(|r| {
                let text = r.get("rule").and_then(|v| v.as_str()).unwrap_or("");
                let chain = r.get("chain").and_then(|v| v.as_str()).unwrap_or("");
                let combined = format!("{chain} {text}").to_lowercase();
                // Skip ufw / firewalld / docker internal chains
                !combined.contains("ufw")
                    && !combined.contains("fwd_")
                    && !combined.contains("inp_")
                    && !combined.contains("docker")
                    && !combined.contains("in_")
                    && !combined.contains("out_")
            });
        }
        all_rules.extend(rules);
    }

    let backend_names: Vec<&str> = backends.iter().map(|b| backend_str(*b)).collect();

    serde_json::json!({
        "backends": backend_names,
        "rules": all_rules,
    })
}

async fn parse_ufw_rules(password: &str) -> Vec<serde_json::Value> {
    let out = sudo_run_cmd(password, &["ufw", "status", "numbered"]).await;
    let mut rules = Vec::new();
    for line in out.lines() {
        let line = line.trim();
        if line.starts_with('[') {
            // format: "[ 1] 22/tcp  ALLOW IN  Anywhere"
            let parts: Vec<&str> = line.splitn(2, ']').collect();
            if parts.len() == 2 {
                let num = parts[0].trim_start_matches('[').trim();
                let rest = parts[1].trim();
                rules.push(serde_json::json!({
                    "number": num.parse::<u32>().unwrap_or(0),
                    "rule": rest,
                }));
            }
        }
    }
    rules
}

async fn parse_firewalld_rules() -> Vec<serde_json::Value> {
    let zone = run_cmd(&["firewall-cmd", "--get-default-zone"]).await;
    let zone = zone.trim();

    let services_out = run_cmd(&["firewall-cmd", "--zone", zone, "--list-services"]).await;
    let ports_out = run_cmd(&["firewall-cmd", "--zone", zone, "--list-ports"]).await;
    let rich_out = run_cmd(&["firewall-cmd", "--zone", zone, "--list-rich-rules"]).await;

    let mut rules = Vec::new();

    for svc in services_out.split_whitespace() {
        if !svc.is_empty() {
            rules.push(serde_json::json!({
                "type": "service",
                "value": svc,
                "zone": zone,
            }));
        }
    }
    for port in ports_out.split_whitespace() {
        if !port.is_empty() {
            rules.push(serde_json::json!({
                "type": "port",
                "value": port,
                "zone": zone,
            }));
        }
    }
    for rich in rich_out.lines() {
        let rich = rich.trim();
        if !rich.is_empty() {
            rules.push(serde_json::json!({
                "type": "rich-rule",
                "value": rich,
                "zone": zone,
            }));
        }
    }

    rules
}

async fn parse_iptables_rules(password: &str) -> Vec<serde_json::Value> {
    let out = sudo_run_cmd(password, &["iptables", "-L", "-n", "--line-numbers"]).await;
    let mut rules = Vec::new();
    let mut chain = String::new();
    for line in out.lines() {
        let line = line.trim();
        if line.starts_with("Chain ") {
            chain = line.to_string();
            continue;
        }
        if line.starts_with("num") || line.is_empty() {
            continue;
        }
        let parts: Vec<&str> = line.splitn(2, ' ').collect();
        if parts.len() == 2 {
            rules.push(serde_json::json!({
                "chain": chain,
                "number": parts[0].trim().parse::<u32>().unwrap_or(0),
                "rule": parts[1].trim(),
            }));
        }
    }
    rules
}

fn firewall_enable_cmd_for(be: FirewallBackend) -> Vec<String> {
    match be {
        FirewallBackend::Ufw => vec!["ufw".into(), "--force".into(), "enable".into()],
        FirewallBackend::Firewalld => vec!["systemctl".into(), "start".into(), "firewalld".into()],
        FirewallBackend::Nftables => vec!["systemctl".into(), "start".into(), "nftables".into()],
        _ => vec!["true".into()],
    }
}

fn firewall_disable_cmd_for(be: FirewallBackend) -> Vec<String> {
    match be {
        FirewallBackend::Ufw => vec!["ufw".into(), "disable".into()],
        FirewallBackend::Firewalld => vec!["systemctl".into(), "stop".into(), "firewalld".into()],
        FirewallBackend::Nftables => vec!["systemctl".into(), "stop".into(), "nftables".into()],
        _ => vec!["true".into()],
    }
}

async fn firewall_add_rule(
    user: &str,
    password: &str,
    rule: &serde_json::Value,
    target: Option<FirewallBackend>,
) -> serde_json::Value {
    let backend = match target {
        Some(b) => b,
        None => detect_firewall().await,
    };

    // Shared validation for port and protocol
    let validate_port = |p: &str| -> bool {
        // Port can be a single number or range like "8000:8080"
        p.split(':').all(|part| part.parse::<u16>().is_ok())
    };
    let validate_proto = |p: &str| -> bool { matches!(p, "tcp" | "udp" | "icmp") };
    // Validate IP address or CIDR notation (IPv4 and IPv6)
    let validate_ip_or_cidr = |s: &str| -> bool {
        if s == "any" {
            return true;
        }
        // Split optional /prefix
        let (addr_part, prefix_part) = match s.rsplit_once('/') {
            Some((a, p)) => (a, Some(p)),
            None => (s, None),
        };
        // Validate prefix length if present
        if let Some(p) = prefix_part {
            let Ok(prefix) = p.parse::<u32>() else {
                return false;
            };
            // IPv4 max /32, IPv6 max /128 — we allow up to 128 here;
            // an IPv4 with /128 is nonsensical but harmless, the real
            // check is on the address itself.
            if prefix > 128 {
                return false;
            }
        }
        // Validate address
        addr_part.parse::<std::net::IpAddr>().is_ok()
    };
    // Validate firewalld service name: alphanumeric + hyphens only
    let validate_service_name = |s: &str| -> bool {
        !s.is_empty()
            && s.len() <= 128
            && s.chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.')
    };

    match backend {
        FirewallBackend::Ufw => {
            let port = rule.get("port").and_then(|v| v.as_str()).unwrap_or("");
            let proto = rule.get("proto").and_then(|v| v.as_str()).unwrap_or("tcp");
            let action = rule
                .get("action")
                .and_then(|v| v.as_str())
                .unwrap_or("allow");
            let from = rule.get("from").and_then(|v| v.as_str()).unwrap_or("any");

            if port.is_empty() {
                return serde_json::json!({ "error": "port required" });
            }
            if !validate_port(port) {
                return serde_json::json!({ "error": "invalid port number" });
            }
            if !validate_proto(proto) {
                return serde_json::json!({ "error": "invalid protocol (tcp, udp, icmp)" });
            }
            if !matches!(action, "allow" | "deny" | "reject" | "limit") {
                return serde_json::json!({ "error": "invalid action" });
            }
            if !validate_ip_or_cidr(from) {
                return serde_json::json!({ "error": "invalid source address (expected IP, CIDR, or \"any\")" });
            }

            let port_proto = format!("{port}/{proto}");
            if from == "any" {
                net_sudo(user, password, &["ufw", action, &port_proto]).await
            } else {
                net_sudo(
                    user,
                    password,
                    &[
                        "ufw", action, "from", from, "to", "any", "port", port, "proto", proto,
                    ],
                )
                .await
            }
        }
        FirewallBackend::Firewalld => {
            let port = rule.get("port").and_then(|v| v.as_str()).unwrap_or("");
            let proto = rule.get("proto").and_then(|v| v.as_str()).unwrap_or("tcp");
            let service = rule.get("service").and_then(|v| v.as_str());

            if let Some(svc) = service {
                if !validate_service_name(svc) {
                    return serde_json::json!({ "error": "invalid service name (alphanumeric, hyphens, underscores, dots only)" });
                }
                net_sudo(
                    user,
                    password,
                    &["firewall-cmd", "--permanent", "--add-service", svc],
                )
                .await
            } else if !port.is_empty() {
                if !validate_port(port) {
                    return serde_json::json!({ "error": "invalid port number" });
                }
                if !validate_proto(proto) {
                    return serde_json::json!({ "error": "invalid protocol (tcp, udp, icmp)" });
                }
                let port_proto = format!("{port}/{proto}");
                net_sudo(
                    user,
                    password,
                    &["firewall-cmd", "--permanent", "--add-port", &port_proto],
                )
                .await
            } else {
                serde_json::json!({ "error": "port or service required" })
            }
        }
        _ => {
            // nftables / iptables: add rule via direct command
            let port = rule.get("port").and_then(|v| v.as_str()).unwrap_or("");
            let proto = rule.get("proto").and_then(|v| v.as_str()).unwrap_or("tcp");
            let action = rule
                .get("action")
                .and_then(|v| v.as_str())
                .unwrap_or("accept");
            if port.is_empty() {
                return serde_json::json!({ "error": "port required" });
            }
            if !validate_port(port) {
                return serde_json::json!({ "error": "invalid port number" });
            }
            if !validate_proto(proto) {
                return serde_json::json!({ "error": "invalid protocol (tcp, udp, icmp)" });
            }
            match backend {
                FirewallBackend::Iptables => {
                    let action_flag = match action {
                        "drop" | "deny" => "DROP",
                        "reject" => "REJECT",
                        _ => "ACCEPT",
                    };
                    net_sudo(
                        user,
                        password,
                        &[
                            "iptables",
                            "-A",
                            "INPUT",
                            "-p",
                            proto,
                            "--dport",
                            port,
                            "-j",
                            action_flag,
                        ],
                    )
                    .await
                }
                FirewallBackend::Nftables => {
                    let nft_action = match action {
                        "drop" | "deny" => "drop",
                        "reject" => "reject",
                        _ => "accept",
                    };
                    // Each word must be a separate argument to nft
                    net_sudo(
                        user,
                        password,
                        &[
                            "nft", "add", "rule", "inet", "filter", "input", proto, "dport", port,
                            nft_action,
                        ],
                    )
                    .await
                }
                _ => serde_json::json!({ "error": "no firewall backend available" }),
            }
        }
    }
}

async fn firewall_remove_rule(
    user: &str,
    password: &str,
    rule: &serde_json::Value,
    target: Option<FirewallBackend>,
) -> serde_json::Value {
    let backend = match target {
        Some(b) => b,
        None => {
            // Try to get backend from rule itself
            rule.get("backend")
                .and_then(|v| v.as_str())
                .and_then(parse_backend)
                .unwrap_or(detect_firewall().await)
        }
    };

    match backend {
        FirewallBackend::Ufw => {
            let number = rule.get("number").and_then(|v| v.as_u64());
            if let Some(n) = number {
                let n_str = n.to_string();
                net_sudo(user, password, &["ufw", "--force", "delete", &n_str]).await
            } else {
                serde_json::json!({ "error": "rule number required for ufw delete" })
            }
        }
        FirewallBackend::Firewalld => {
            let port = rule.get("port").and_then(|v| v.as_str()).unwrap_or("");
            let proto = rule.get("proto").and_then(|v| v.as_str()).unwrap_or("tcp");
            let service = rule.get("service").and_then(|v| v.as_str());

            // Validate service name — alphanumeric, hyphens, underscores, dots
            let valid_svc_name = |s: &str| -> bool {
                !s.is_empty()
                    && s.len() <= 128
                    && s.chars()
                        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.')
            };

            if let Some(svc) = service {
                if !valid_svc_name(svc) {
                    return serde_json::json!({ "error": "invalid service name" });
                }
                net_sudo(
                    user,
                    password,
                    &["firewall-cmd", "--permanent", "--remove-service", svc],
                )
                .await
            } else if !port.is_empty() {
                let port_proto = format!("{port}/{proto}");
                net_sudo(
                    user,
                    password,
                    &["firewall-cmd", "--permanent", "--remove-port", &port_proto],
                )
                .await
            } else {
                serde_json::json!({ "error": "port/service or rule number required" })
            }
        }
        _ => {
            // nftables / iptables: remove by handle/number
            let number = rule.get("number").and_then(|v| v.as_u64());
            match backend {
                FirewallBackend::Iptables => {
                    let chain = rule.get("chain").and_then(|v| v.as_str()).unwrap_or("");
                    // Chain line format: "Chain INPUT (policy ACCEPT)" → extract name
                    let chain_name = chain.split_whitespace().nth(1).unwrap_or("INPUT");
                    if let Some(n) = number {
                        let n_str = n.to_string();
                        net_sudo(user, password, &["iptables", "-D", chain_name, &n_str]).await
                    } else {
                        serde_json::json!({ "error": "rule number required for iptables delete" })
                    }
                }
                FirewallBackend::Nftables => {
                    // nft delete rule <family> <table> <chain> handle <handle>
                    let table = rule
                        .get("table")
                        .and_then(|v| v.as_str())
                        .unwrap_or("filter");
                    let chain = rule
                        .get("chain")
                        .and_then(|v| v.as_str())
                        .unwrap_or("input");
                    let family = rule
                        .get("family")
                        .and_then(|v| v.as_str())
                        .unwrap_or("inet");
                    if let Some(handle) = number {
                        let handle_str = handle.to_string();
                        net_sudo(
                            user,
                            password,
                            &[
                                "nft",
                                "delete",
                                "rule",
                                family,
                                table,
                                chain,
                                "handle",
                                &handle_str,
                            ],
                        )
                        .await
                    } else {
                        serde_json::json!({ "error": "rule handle required for nftables delete" })
                    }
                }
                _ => serde_json::json!({ "error": "no firewall backend available" }),
            }
        }
    }
}

// ──────────────────────────────────────────────────────────────
//  Interface management
// ──────────────────────────────────────────────────────────────

async fn list_interfaces_detailed() -> serde_json::Value {
    let out = tokio::process::Command::new("ip")
        .args(["-j", "addr", "show"])
        .output()
        .await;

    let parsed: Vec<serde_json::Value> = match out {
        Ok(o) if o.status.success() => serde_json::from_slice(&o.stdout).unwrap_or_default(),
        _ => return serde_json::json!({ "interfaces": [] }),
    };

    let mut ifaces = Vec::new();
    for entry in &parsed {
        let name = entry.get("ifname").and_then(|v| v.as_str()).unwrap_or("");
        if name == "lo" {
            continue;
        }

        let state = entry
            .get("operstate")
            .and_then(|v| v.as_str())
            .unwrap_or("unknown")
            .to_lowercase();
        let mac = entry.get("address").and_then(|v| v.as_str()).unwrap_or("");
        let mtu = entry.get("mtu").and_then(|v| v.as_u64()).unwrap_or(0);
        let link_type = entry
            .get("link_type")
            .and_then(|v| v.as_str())
            .unwrap_or("unknown");
        let flags: Vec<String> = entry
            .get("flags")
            .and_then(|v| v.as_array())
            .map(|a| {
                a.iter()
                    .filter_map(|f| f.as_str().map(|s| s.to_string()))
                    .collect()
            })
            .unwrap_or_default();

        let mut ipv4 = Vec::new();
        let mut ipv6 = Vec::new();
        if let Some(addrs) = entry.get("addr_info").and_then(|a| a.as_array()) {
            for ai in addrs {
                let family = ai.get("family").and_then(|f| f.as_str()).unwrap_or("");
                let local = ai.get("local").and_then(|l| l.as_str()).unwrap_or("");
                let prefix = ai.get("prefixlen").and_then(|p| p.as_u64()).unwrap_or(0);
                if local.is_empty() {
                    continue;
                }
                let addr = format!("{local}/{prefix}");
                match family {
                    "inet" => ipv4.push(addr),
                    "inet6" => ipv6.push(addr),
                    _ => {}
                }
            }
        }

        // Detect interface type
        let iface_type = detect_iface_type(name).await;

        ifaces.push(serde_json::json!({
            "name": name,
            "state": state,
            "mac": mac,
            "mtu": mtu,
            "link_type": link_type,
            "iface_type": iface_type,
            "flags": flags,
            "ipv4": ipv4,
            "ipv6": ipv6,
        }));
    }

    serde_json::json!({ "interfaces": ifaces })
}

async fn detect_iface_type(name: &str) -> &'static str {
    // Check /sys/class/net/<name>/type and various indicators
    let type_path = format!("/sys/class/net/{name}/type");
    let bridge_path = format!("/sys/class/net/{name}/bridge");
    let vlan_path = format!("/sys/class/net/{name}/../../uevent");

    if std::path::Path::new(&bridge_path).exists() {
        return "bridge";
    }
    if name.contains('.') {
        // likely VLAN like eth0.100
        return "vlan";
    }
    if name.starts_with("tun") || name.starts_with("tap") || name.starts_with("wg") {
        return "vpn";
    }
    if name.starts_with("veth") || name.starts_with("docker") || name.starts_with("br-") {
        return "container";
    }
    if name.starts_with("bond") {
        return "bond";
    }
    if name.starts_with("wl") || name.starts_with("wlan") {
        return "wireless";
    }

    let _ = vlan_path;
    // Read /sys to check for wireless
    let wireless_path = format!("/sys/class/net/{name}/wireless");
    if std::path::Path::new(&wireless_path).exists() {
        return "wireless";
    }

    if let Ok(type_val) = tokio::fs::read_to_string(&type_path).await {
        match type_val.trim() {
            "1" => return "ethernet",
            "772" => return "loopback",
            _ => {}
        }
    }

    "ethernet"
}

async fn add_bridge(user: &str, password: &str, name: &str) -> serde_json::Value {
    if name.is_empty()
        || !name
            .chars()
            .all(|c| c.is_alphanumeric() || c == '-' || c == '_')
    {
        return serde_json::json!({ "error": "invalid bridge name" });
    }
    // Try nmcli first, fall back to ip
    if which("nmcli").await {
        net_sudo(
            user,
            password,
            &[
                "nmcli",
                "connection",
                "add",
                "type",
                "bridge",
                "ifname",
                name,
                "con-name",
                name,
            ],
        )
        .await
    } else {
        let r1 = net_sudo(
            user,
            password,
            &["ip", "link", "add", "name", name, "type", "bridge"],
        )
        .await;
        if r1.get("ok").and_then(|v| v.as_bool()) == Some(true) {
            net_sudo(user, password, &["ip", "link", "set", "dev", name, "up"]).await
        } else {
            r1
        }
    }
}

async fn add_vlan(user: &str, password: &str, parent: &str, vlan_id: u32) -> serde_json::Value {
    if parent.is_empty() || vlan_id == 0 || vlan_id > 4094 {
        return serde_json::json!({ "error": "invalid parent or VLAN ID (1-4094)" });
    }
    if !parent
        .chars()
        .all(|c| c.is_alphanumeric() || c == '-' || c == '_')
    {
        return serde_json::json!({ "error": "invalid parent interface name" });
    }
    let name = format!("{parent}.{vlan_id}");
    let id_str = vlan_id.to_string();

    if which("nmcli").await {
        net_sudo(
            user,
            password,
            &[
                "nmcli",
                "connection",
                "add",
                "type",
                "vlan",
                "ifname",
                &name,
                "dev",
                parent,
                "id",
                &id_str,
            ],
        )
        .await
    } else {
        net_sudo(
            user,
            password,
            &[
                "ip", "link", "add", "link", parent, "name", &name, "type", "vlan", "id", &id_str,
            ],
        )
        .await
    }
}

async fn remove_interface(user: &str, password: &str, name: &str) -> serde_json::Value {
    if name.is_empty()
        || !name
            .chars()
            .all(|c| c.is_alphanumeric() || c == '-' || c == '_' || c == '.')
    {
        return serde_json::json!({ "error": "invalid interface name" });
    }
    // Try nmcli first
    if which("nmcli").await {
        let r = net_sudo(
            user,
            password,
            &["nmcli", "connection", "delete", "--", name],
        )
        .await;
        if r.get("ok").and_then(|v| v.as_bool()) == Some(true) {
            return r;
        }
    }
    net_sudo(user, password, &["ip", "link", "delete", "dev", name]).await
}

// ──────────────────────────────────────────────────────────────
//  VPN
// ──────────────────────────────────────────────────────────────

async fn vpn_list() -> serde_json::Value {
    if !which("nmcli").await {
        return serde_json::json!({ "vpns": [], "note": "NetworkManager not available" });
    }

    let out = run_cmd(&[
        "nmcli",
        "-t",
        "-f",
        "NAME,TYPE,DEVICE,STATE",
        "connection",
        "show",
    ])
    .await;
    let mut vpns = Vec::new();

    for line in out.lines() {
        let parts: Vec<&str> = line.split(':').collect();
        if parts.len() >= 4 {
            let conn_type = parts[1];
            if conn_type.contains("vpn")
                || conn_type.contains("wireguard")
                || conn_type.contains("tun")
            {
                vpns.push(serde_json::json!({
                    "name": parts[0],
                    "type": parts[1],
                    "device": parts[2],
                    "state": parts[3],
                }));
            }
        }
    }

    serde_json::json!({ "vpns": vpns })
}

// ──────────────────────────────────────────────────────────────
//  Network logs
// ──────────────────────────────────────────────────────────────

async fn network_logs(lines: u64) -> serde_json::Value {
    let n = lines.min(500).to_string();

    // Try NetworkManager logs, fall back to systemd-networkd
    let out = if which("nmcli").await {
        run_cmd(&[
            "journalctl",
            "-u",
            "NetworkManager",
            "-n",
            &n,
            "--no-pager",
            "--output=short-iso",
        ])
        .await
    } else {
        run_cmd(&[
            "journalctl",
            "-u",
            "systemd-networkd",
            "-n",
            &n,
            "--no-pager",
            "--output=short-iso",
        ])
        .await
    };

    // Also grab firewall logs
    let fw_logs = run_cmd(&[
        "journalctl",
        "-t",
        "kernel",
        "--grep",
        "UFW\\|FIREWALL\\|nft\\|iptables",
        "-n",
        "50",
        "--no-pager",
        "--output=short-iso",
    ])
    .await;

    let entries: Vec<&str> = out.lines().collect();
    let fw_entries: Vec<&str> = fw_logs.lines().filter(|l| !l.is_empty()).collect();

    serde_json::json!({
        "network_logs": entries,
        "firewall_logs": fw_entries,
    })
}

// ──────────────────────────────────────────────────────────────
//  Utility  –  sudo_run_cmd (networking-specific, returns String)
// ──────────────────────────────────────────────────────────────

/// Like `run_cmd` but uses `sudo -S` when password is non-empty.
/// Falls back to unprivileged `run_cmd` when no password is supplied.
/// Run a networking command AS THE USER via sudo, so the host's rules (local sudoers
/// or FreeIPA sudo via SSSD) decide what is permitted.
async fn net_sudo(user: &str, password: &str, args: &[impl AsRef<str>]) -> serde_json::Value {
    let refs: Vec<&str> = args.iter().map(|a| a.as_ref()).collect();
    sudo_as_user(user, password, &refs).await
}

async fn sudo_run_cmd(password: &str, args: &[&str]) -> String {
    if password.is_empty() {
        return run_cmd(args).await;
    }
    let mut cmd_args = vec!["-S"];
    cmd_args.extend_from_slice(args);

    let child = tokio::process::Command::new("sudo")
        .args(&cmd_args)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn();

    let mut child = match child {
        Ok(c) => c,
        Err(e) => return format!("error: {e}"),
    };

    if let Some(mut stdin) = child.stdin.take() {
        let _ = stdin.write_all(format!("{password}\n").as_bytes()).await;
        drop(stdin);
    }

    match child.wait_with_output().await {
        Ok(out) => {
            let stdout = String::from_utf8_lossy(&out.stdout).to_string();
            if stdout.is_empty() {
                let stderr = String::from_utf8_lossy(&out.stderr).to_string();
                // Filter sudo prompts from stderr
                stderr
                    .lines()
                    .filter(|l| !l.contains("[sudo]") && !l.contains("password for"))
                    .collect::<Vec<_>>()
                    .join("\n")
            } else {
                stdout
            }
        }
        Err(e) => format!("error: {e}"),
    }
}

// ──────────────────────────────────────────────────────────────
//  Listening ports (ss) + process kill
// ──────────────────────────────────────────────────────────────

/// List listening ports. Brokered per-user: `ss -p` reveals which process owns each
/// socket, which the kernel only shows for sockets the caller owns (or to root). Run
/// AS the logged-in user so the process/pid columns are populated only for their own
/// sockets — everyone still sees the port list itself. Superuser mode runs `sudo ss`
/// AS the user (host sudoers decides) to reveal every owner.
///
/// -t tcp, -u udp, -l listening, -p process, -n numeric, -H no header.
async fn list_ports(user: &str, password: &str) -> serde_json::Value {
    if !which("ss").await {
        return serde_json::json!({ "error": "ss (iproute2) is not available", "ports": [] });
    }
    if !is_valid_username(user) {
        return serde_json::json!({ "ports": [], "error": "no session user" });
    }
    let args = ["ss", "-tulpnH"];

    if !password.is_empty() {
        let res = sudo_as_user(user, password, &args).await;
        return match res.get("output").and_then(|v| v.as_str()) {
            Some(out) => ports_json(out),
            None => serde_json::json!({
                "ports": [],
                "error": res.get("error").and_then(|v| v.as_str()).unwrap_or("command failed")
            }),
        };
    }

    match run_cmd_as_user(user, &args).await {
        UserReadOutcome::NoAccount => {
            serde_json::json!({ "ports": [], "restricted": true, "reason": "no-account" })
        }
        UserReadOutcome::SpawnFailed(e) => serde_json::json!({ "ports": [], "error": e }),
        UserReadOutcome::Ran(out) => {
            let stdout = String::from_utf8_lossy(&out.stdout);
            ports_json(&stdout)
        }
    }
}

fn ports_json(ss_output: &str) -> serde_json::Value {
    let ports: Vec<serde_json::Value> = ss_output.lines().filter_map(parse_ss_line).collect();
    let count = ports.len();
    serde_json::json!({ "ports": ports, "count": count })
}

fn parse_ss_line(line: &str) -> Option<serde_json::Value> {
    let t = line.trim();
    if t.is_empty() {
        return None;
    }
    let cols: Vec<&str> = t.split_whitespace().collect();
    if cols.len() < 5 {
        return None;
    }
    // Columns: Netid State Recv-Q Send-Q Local-Address:Port [Peer] [Process]
    let proto = cols[0];
    let state = cols[1];
    let local = cols[4];
    let (address, port) = split_hostport(local);
    let (process, pid) = match t.find("users:((") {
        Some(i) => parse_proc(&t[i..]),
        None => (String::new(), 0),
    };
    Some(serde_json::json!({
        "proto": proto,
        "state": state,
        "local": local,
        "address": address,
        "port": port,
        "process": process,
        "pid": pid,
    }))
}

/// Split "addr:port", stripping IPv6 brackets: "[::]:22" → ("::", 22).
fn split_hostport(s: &str) -> (String, u32) {
    match s.rfind(':') {
        Some(i) => {
            let addr = s[..i].trim_matches(['[', ']']);
            let port = s[i + 1..].parse().unwrap_or(0);
            (addr.to_string(), port)
        }
        None => (s.to_string(), 0),
    }
}

/// Extract (process_name, pid) from ss's `users:(("name",pid=NN,fd=NN))` field.
fn parse_proc(s: &str) -> (String, u64) {
    let name = s
        .find('"')
        .and_then(|a| {
            s[a + 1..]
                .find('"')
                .map(|b| s[a + 1..a + 1 + b].to_string())
        })
        .unwrap_or_default();
    let pid = s
        .find("pid=")
        .map(|i| &s[i + 4..])
        .map(|r| {
            r.chars()
                .take_while(|c| c.is_ascii_digit())
                .collect::<String>()
        })
        .and_then(|d| d.parse().ok())
        .unwrap_or(0);
    (name, pid)
}

async fn kill_process(user: &str, password: &str, pid: u64, signal: &str) -> serde_json::Value {
    if pid <= 1 {
        return serde_json::json!({ "error": "refusing to signal this pid" });
    }
    let sig = match signal {
        "KILL" | "TERM" | "HUP" | "INT" => signal,
        _ => "TERM",
    };
    let r = net_sudo(
        user,
        password,
        &["kill".to_string(), format!("-{sig}"), pid.to_string()],
    )
    .await;
    let ok = r.get("error").is_none();
    crate::audit::log(user, "net.kill_process", &pid.to_string(), ok, sig);
    if !ok {
        r
    } else {
        serde_json::json!({ "ok": true })
    }
}

#[cfg(test)]
mod ports_tests {
    use super::*;

    #[test]
    fn parse_ss_tcp_line() {
        let line =
            "tcp   LISTEN 0      128    0.0.0.0:22    0.0.0.0:*    users:((\"sshd\",pid=800,fd=3))";
        let v = parse_ss_line(line).unwrap();
        assert_eq!(v["proto"], "tcp");
        assert_eq!(v["port"], 22);
        assert_eq!(v["address"], "0.0.0.0");
        assert_eq!(v["process"], "sshd");
        assert_eq!(v["pid"], 800);
    }

    #[test]
    fn parse_ss_ipv6_no_proc() {
        let line = "udp   UNCONN 0      0      [::]:5353   [::]:*";
        let v = parse_ss_line(line).unwrap();
        assert_eq!(v["proto"], "udp");
        assert_eq!(v["address"], "::");
        assert_eq!(v["port"], 5353);
        assert_eq!(v["pid"], 0);
    }

    #[test]
    fn hostport_split() {
        assert_eq!(
            split_hostport("127.0.0.1:631"),
            ("127.0.0.1".to_string(), 631)
        );
        assert_eq!(split_hostport("*:5353"), ("*".to_string(), 5353));
    }
}
