use async_trait::async_trait;
use chrono::{DateTime, NaiveDateTime, Utc};
use serde_json::{json, Value};
use std::path::Path;
use tokio::fs;

use crate::handler::ChannelHandler;
use crate::util::{require_admin, run_cmd, sudo_action, sudo_stdin_write, which};
use tenodera_protocol::channel::ChannelOpenOptions;
use tenodera_protocol::message::Message;

// ── certs.list ─────────────────────────────────────────────────────────────────

pub struct CertsListHandler;

#[async_trait]
impl ChannelHandler for CertsListHandler {
    fn payload_type(&self) -> &str { "certs.list" }

    async fn open(&self, channel: &str, _options: &ChannelOpenOptions) -> Vec<Message> {
        let data = scan_all_certs().await;
        vec![
            Message::Ready { channel: channel.into() },
            Message::Data { channel: channel.into(), data },
            Message::Close { channel: channel.into(), problem: None },
        ]
    }
}

// ── certs.manage ───────────────────────────────────────────────────────────────

pub struct CertsManageHandler;

#[async_trait]
impl ChannelHandler for CertsManageHandler {
    fn payload_type(&self) -> &str { "certs.manage" }

    async fn open(&self, channel: &str, _options: &ChannelOpenOptions) -> Vec<Message> {
        vec![Message::Ready { channel: channel.into() }]
    }

    async fn data(&self, channel: &str, data: &Value) -> Vec<Message> {
        if let Some(err) = require_admin(data) {
            return vec![
                Message::Data { channel: channel.into(), data: err },
                Message::Close { channel: channel.into(), problem: None },
            ];
        }
        let action = data.get("action").and_then(|v| v.as_str()).unwrap_or("");
        let password = data.get("password").and_then(|v| v.as_str()).unwrap_or("");

        let result = match action {
            "parse"        => parse_pem_input(data).await,
            "trust_add"    => trust_add(data, password).await,
            "trust_remove" => trust_remove(data, password).await,
            "verify_host"  => verify_host(data).await,
            "cert_check"   => cert_check(data).await,
            "cert_save"    => cert_save(data, password).await,
            _ => json!({ "error": format!("unknown action: {action}") }),
        };

        vec![
            Message::Data { channel: channel.into(), data: result },
            Message::Close { channel: channel.into(), problem: None },
        ]
    }
}

// ── certs.selfsigned ───────────────────────────────────────────────────────────

pub struct CertsSelfSignedHandler;

#[async_trait]
impl ChannelHandler for CertsSelfSignedHandler {
    fn payload_type(&self) -> &str { "certs.selfsigned" }

    async fn open(&self, channel: &str, _options: &ChannelOpenOptions) -> Vec<Message> {
        vec![Message::Ready { channel: channel.into() }]
    }

    async fn data(&self, channel: &str, data: &Value) -> Vec<Message> {
        if let Some(err) = require_admin(data) {
            return vec![
                Message::Data { channel: channel.into(), data: err },
                Message::Close { channel: channel.into(), problem: None },
            ];
        }
        let result = generate_selfsigned(data).await;
        vec![
            Message::Data { channel: channel.into(), data: result },
            Message::Close { channel: channel.into(), problem: None },
        ]
    }
}

// ── certs.letsencrypt ──────────────────────────────────────────────────────────

pub struct CertsLetsEncryptHandler;

#[async_trait]
impl ChannelHandler for CertsLetsEncryptHandler {
    fn payload_type(&self) -> &str { "certs.letsencrypt" }

    async fn open(&self, channel: &str, _options: &ChannelOpenOptions) -> Vec<Message> {
        let data = letsencrypt_info().await;
        vec![
            Message::Ready { channel: channel.into() },
            Message::Data { channel: channel.into(), data },
            Message::Close { channel: channel.into(), problem: None },
        ]
    }

    async fn data(&self, channel: &str, data: &Value) -> Vec<Message> {
        if let Some(err) = require_admin(data) {
            return vec![
                Message::Data { channel: channel.into(), data: err },
                Message::Close { channel: channel.into(), problem: None },
            ];
        }
        let action = data.get("action").and_then(|v| v.as_str()).unwrap_or("");
        let password = data.get("password").and_then(|v| v.as_str()).unwrap_or("");

        let result = match action {
            "renew_all"  => letsencrypt_renew_all(password).await,
            "renew"      => letsencrypt_renew(data, password).await,
            "delete"     => letsencrypt_delete(data, password).await,
            _ => json!({ "error": format!("unknown action: {action}") }),
        };

        vec![
            Message::Data { channel: channel.into(), data: result },
            Message::Close { channel: channel.into(), problem: None },
        ]
    }
}

// ── cert scanning ──────────────────────────────────────────────────────────────

// Flat dirs to scan (dir, source_tag)
const CERT_DIRS: &[(&str, &str)] = &[
    ("/usr/local/share/ca-certificates", "trusted"),
    ("/etc/pki/ca-trust/source/anchors", "trusted"),
    ("/etc/ca-certificates/trust-source/anchors", "trusted"),
    ("/etc/nginx/ssl", "nginx"),
    ("/etc/nginx/certs", "nginx"),
    ("/etc/apache2/ssl", "apache"),
    ("/etc/httpd/conf/ssl", "apache"),
];

async fn scan_dir_recursive(dir: &str, skip_subdirs: &[&str], source: &str, out: &mut Vec<Value>) {
    let p = Path::new(dir);
    if !p.exists() { return; }
    let mut stack = vec![p.to_path_buf()];
    while let Some(current) = stack.pop() {
        let mut rd = match fs::read_dir(&current).await {
            Ok(r) => r,
            Err(_) => continue,
        };
        while let Ok(Some(entry)) = rd.next_entry().await {
            let path = entry.path();
            let is_dir = entry.file_type().await.map(|t| t.is_dir()).unwrap_or(false);
            if is_dir {
                let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
                if !skip_subdirs.contains(&name) {
                    stack.push(path);
                }
            } else {
                let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("");
                if matches!(ext, "pem" | "crt" | "cer") {
                    if let Some(info) = parse_cert(&path.to_string_lossy(), source).await {
                        out.push(info);
                    }
                }
            }
        }
    }
}

async fn scan_all_certs() -> Value {
    if !which("openssl").await {
        return json!({ "error": "openssl not found", "certs": [] });
    }

    let mut certs: Vec<Value> = Vec::new();

    // Let's Encrypt — one subdir per domain
    let le_base = Path::new("/etc/letsencrypt/live");
    if le_base.exists() {
        if let Ok(mut rd) = fs::read_dir(le_base).await {
            while let Ok(Some(entry)) = rd.next_entry().await {
                let cert_path = entry.path().join("fullchain.pem");
                if cert_path.exists() {
                    if let Some(info) = parse_cert(&cert_path.to_string_lossy(), "letsencrypt").await {
                        certs.push(info);
                    }
                }
            }
        }
    }

    // /etc/ssl/ — recursive, skip /etc/ssl/certs/ (system bundle)
    scan_dir_recursive("/etc/ssl", &["certs"], "ssl", &mut certs).await;

    // Flat cert directories
    for (dir, source) in CERT_DIRS {
        let p = Path::new(dir);
        if !p.exists() { continue; }
        if let Ok(mut rd) = fs::read_dir(p).await {
            while let Ok(Some(entry)) = rd.next_entry().await {
                let path = entry.path();
                let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("");
                if !matches!(ext, "pem" | "crt" | "cer") { continue; }
                // Skip if already covered by /etc/ssl scan
                if path.to_str().map(|p| p.starts_with("/etc/ssl/")).unwrap_or(false) { continue; }
                if let Some(info) = parse_cert(&path.to_string_lossy(), source).await {
                    certs.push(info);
                }
            }
        }
    }

    // Sort by days_remaining ascending (expiring soonest first)
    certs.sort_by(|a, b| {
        let da = a.get("days_remaining").and_then(|v| v.as_i64()).unwrap_or(9999);
        let db = b.get("days_remaining").and_then(|v| v.as_i64()).unwrap_or(9999);
        da.cmp(&db)
    });

    json!({ "certs": certs })
}

async fn parse_cert(path: &str, source: &str) -> Option<Value> {
    let out = run_cmd(&[
        "openssl", "x509", "-in", path, "-noout",
        "-subject", "-issuer", "-startdate", "-enddate",
        "-ext", "subjectAltName", "-ext", "basicConstraints",
    ]).await;

    if out.contains("unable to load") || out.starts_with("error:") || out.is_empty() {
        return None;
    }

    let mut cn = String::new();
    let mut issuer_cn = String::new();
    let mut issuer_org = String::new();
    let mut not_before = String::new();
    let mut not_after = String::new();
    let mut sans: Vec<String> = Vec::new();
    let mut is_ca = false;
    let mut in_san = false;
    let mut in_bc = false;

    for line in out.lines() {
        let l = line.trim();

        if l.starts_with("subject=") {
            cn = extract_field(l, "CN");
        } else if l.starts_with("issuer=") {
            issuer_cn = extract_field(l, "CN");
            issuer_org = extract_field(l, "O");
        } else if l.starts_with("notBefore=") {
            not_before = l.trim_start_matches("notBefore=").to_string();
        } else if l.starts_with("notAfter=") {
            not_after = l.trim_start_matches("notAfter=").to_string();
        } else if l.contains("Subject Alternative Name") {
            in_san = true; in_bc = false;
        } else if l.contains("Basic Constraints") {
            in_bc = true; in_san = false;
        } else if in_san && !l.is_empty() {
            for part in l.split(',') {
                let p = part.trim();
                if let Some(v) = p.strip_prefix("DNS:") {
                    sans.push(v.to_string());
                } else if let Some(v) = p.strip_prefix("IP Address:").or(p.strip_prefix("IP:")) {
                    sans.push(v.to_string());
                }
            }
            in_san = false;
        } else if in_bc && !l.is_empty() {
            if l.contains("CA:TRUE") { is_ca = true; }
            in_bc = false;
        } else {
            in_san = false; in_bc = false;
        }
    }

    // Calculate days remaining
    let days_remaining = parse_openssl_date(&not_after)
        .map(|exp| (exp - Utc::now()).num_days())
        .unwrap_or(0);

    let filename = Path::new(path)
        .file_name()
        .and_then(|f| f.to_str())
        .unwrap_or("")
        .to_string();

    let display_cn = if cn.is_empty() { filename.clone() } else { cn };

    Some(json!({
        "path": path,
        "filename": filename,
        "cn": display_cn,
        "issuer_cn": issuer_cn,
        "issuer_org": issuer_org,
        "not_before": not_before,
        "not_after": not_after,
        "days_remaining": days_remaining,
        "sans": sans,
        "is_ca": is_ca,
        "source": source,
    }))
}

fn extract_field(line: &str, field: &str) -> String {
    // Handles "CN = foo" and "CN=foo" formats
    for part in line.split(',') {
        let p = part.trim();
        if let Some(rest) = p.strip_prefix(&format!("{field} ="))
            .or_else(|| p.strip_prefix(&format!("{field}=")))
        {
            return rest.trim().to_string();
        }
    }
    String::new()
}

fn parse_openssl_date(s: &str) -> Option<DateTime<Utc>> {
    // "Jan  1 00:00:00 2024 GMT" — strip timezone suffix, parse as UTC
    let s = s.trim()
        .trim_end_matches(" GMT")
        .trim_end_matches(" UTC")
        .trim();
    NaiveDateTime::parse_from_str(s, "%b %e %H:%M:%S %Y")
        .ok()
        .map(|dt| DateTime::from_naive_utc_and_offset(dt, Utc))
}

// ── trust store ────────────────────────────────────────────────────────────────

#[derive(Debug)]
enum Distro { Debian, Fedora, Arch, Unknown }

async fn detect_distro() -> Distro {
    let content = fs::read_to_string("/etc/os-release").await.unwrap_or_default();
    let id_like = content.lines()
        .find(|l| l.starts_with("ID_LIKE="))
        .map(|l| l.trim_start_matches("ID_LIKE=").replace('"', ""))
        .unwrap_or_default()
        .to_lowercase();
    let id = content.lines()
        .find(|l| l.starts_with("ID="))
        .map(|l| l.trim_start_matches("ID=").replace('"', ""))
        .unwrap_or_default()
        .to_lowercase();

    if id == "debian" || id == "ubuntu" || id_like.contains("debian") || id_like.contains("ubuntu") {
        Distro::Debian
    } else if id == "fedora" || id == "rhel" || id == "centos" || id_like.contains("fedora") || id_like.contains("rhel") {
        Distro::Fedora
    } else if id == "arch" || id_like.contains("arch") {
        Distro::Arch
    } else {
        Distro::Unknown
    }
}

async fn trust_add(data: &Value, password: &str) -> Value {
    let pem = match data.get("pem").and_then(|v| v.as_str()) {
        Some(p) if !p.is_empty() => p,
        _ => return json!({ "error": "missing pem" }),
    };
    let name = data.get("name").and_then(|v| v.as_str()).unwrap_or("custom");
    // Sanitise name: allow alphanumeric, hyphen, underscore, dot
    let safe_name: String = name.chars()
        .map(|c| if c.is_alphanumeric() || "-_.".contains(c) { c } else { '_' })
        .collect();

    match detect_distro().await {
        Distro::Debian => {
            let dest = format!("/usr/local/share/ca-certificates/{safe_name}.crt");
            let write = sudo_stdin_write(password, &["tee", &dest], pem).await;
            if write.get("error").is_some() { return write; }
            sudo_action(password, &["update-ca-certificates"]).await
        }
        Distro::Fedora => {
            let dest = format!("/etc/pki/ca-trust/source/anchors/{safe_name}.crt");
            let write = sudo_stdin_write(password, &["tee", &dest], pem).await;
            if write.get("error").is_some() { return write; }
            sudo_action(password, &["update-ca-trust", "extract"]).await
        }
        Distro::Arch => {
            // Write to temp, then trust anchor --store (handles saving + update atomically)
            let tmp = format!("/tmp/tenodera-trust-{}.crt", std::process::id());
            let write = sudo_stdin_write(password, &["tee", &tmp], pem).await;
            if write.get("error").is_some() { return write; }
            let result = sudo_action(password, &["trust", "anchor", "--store", &tmp]).await;
            let _ = sudo_action(password, &["rm", "-f", &tmp]).await;
            result
        }
        Distro::Unknown => {
            json!({ "error": "unsupported distro — cannot determine trust store path" })
        }
    }
}

async fn trust_remove(data: &Value, password: &str) -> Value {
    let path = match data.get("path").and_then(|v| v.as_str()) {
        Some(p) if !p.is_empty() => p.to_string(),
        _ => return json!({ "error": "missing path" }),
    };

    // Safety: only allow removing from known trust store paths
    let allowed_prefixes = [
        "/usr/local/share/ca-certificates/",
        "/etc/pki/ca-trust/source/anchors/",
        "/etc/ca-certificates/trust-source/anchors/",
    ];
    if !allowed_prefixes.iter().any(|pfx| path.starts_with(pfx)) {
        return json!({ "error": "path not in a known trust store directory" });
    }
    if path.contains("..") {
        return json!({ "error": "invalid path" });
    }

    let rm = sudo_action(password, &["rm", "-f", &path]).await;
    if rm.get("error").is_some() { return rm; }

    match detect_distro().await {
        Distro::Debian  => sudo_action(password, &["update-ca-certificates", "--fresh"]).await,
        Distro::Fedora  => sudo_action(password, &["update-ca-trust"]).await,
        Distro::Arch    => sudo_action(password, &["trust", "extract-compat"]).await, // best-effort after rm
        Distro::Unknown => json!({ "ok": true, "output": "removed file (update trust manually)" }),
    }
}

// ── parse / verify ─────────────────────────────────────────────────────────────

async fn parse_pem_input(data: &Value) -> Value {
    let raw = match data.get("pem").and_then(|v| v.as_str()) {
        Some(s) if !s.is_empty() => s.trim().to_string(),
        _ => return json!({ "error": "missing certificate data" }),
    };

    if !which("openssl").await {
        return json!({ "error": "openssl not found" });
    }

    // Detect DER (binary) vs PEM (text starting with -----BEGIN)
    let pem = if raw.starts_with("-----BEGIN") {
        raw.clone()
    } else {
        // Treat as base64-encoded DER — convert to PEM
        let tmp_der = format!("/tmp/tenodera-import-{}.der", std::process::id());
        let tmp_pem = format!("/tmp/tenodera-import-{}.pem", std::process::id());

        // Decode base64 and write DER
        use base64::Engine;
        let der_bytes = match base64::engine::general_purpose::STANDARD.decode(raw.replace(['\n', '\r', ' '], "")) {
            Ok(b) => b,
            Err(_) => return json!({ "error": "not valid PEM or base64-encoded DER" }),
        };
        if fs::write(&tmp_der, &der_bytes).await.is_err() {
            return json!({ "error": "failed to write temp file" });
        }
        let out = run_cmd(&["openssl", "x509", "-inform", "DER", "-in", &tmp_der, "-out", &tmp_pem]).await;
        let _ = fs::remove_file(&tmp_der).await;
        if out.contains("error") && !out.is_empty() {
            let _ = fs::remove_file(&tmp_pem).await;
            return json!({ "error": format!("DER conversion failed: {out}") });
        }
        let pem_content = fs::read_to_string(&tmp_pem).await.unwrap_or_default();
        let _ = fs::remove_file(&tmp_pem).await;
        pem_content
    };

    if pem.is_empty() {
        return json!({ "error": "empty certificate after conversion" });
    }

    // Write pem to temp and parse
    let tmp = format!("/tmp/tenodera-parse-{}.pem", std::process::id());
    if fs::write(&tmp, &pem).await.is_err() {
        return json!({ "error": "failed to write temp file" });
    }

    let result = parse_cert(&tmp, "import").await;
    let _ = fs::remove_file(&tmp).await;

    match result {
        Some(mut info) => {
            info["pem"] = json!(pem); // return converted PEM for trust_add
            json!({ "ok": true, "cert": info })
        }
        None => json!({ "error": "failed to parse certificate — not a valid X.509 cert" }),
    }
}

async fn verify_host(data: &Value) -> Value {
    let host_raw = match data.get("host").and_then(|v| v.as_str()) {
        Some(h) if !h.is_empty() => h,
        _ => return json!({ "error": "missing host" }),
    };

    // Strip protocol prefix if present
    let host = host_raw
        .trim_start_matches("https://")
        .trim_start_matches("http://")
        .trim_end_matches('/');

    // Split host:port
    let (hostname, port) = if let Some((h, p)) = host.rsplit_once(':') {
        (h, p.to_string())
    } else {
        (host, "443".to_string())
    };

    // Strict hostname validation — allow only safe characters, reject all shell metacharacters.
    // Covers DNS names, IPv4, and bracketed IPv6 addresses.
    let valid_hostname = !hostname.is_empty()
        && hostname.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '[' | ']' | ':'));
    if !valid_hostname {
        return json!({ "error": "invalid hostname" });
    }

    // Validate port is a valid number (avoids injecting arbitrary strings).
    let port_num: u16 = match port.parse::<u16>() {
        Ok(p) if p > 0 => p,
        _ => return json!({ "error": "invalid port" }),
    };

    let connect = format!("{hostname}:{port_num}");

    // Invoke openssl directly — no sh -c, no shell metacharacter injection possible.
    // stdin = null causes openssl to receive EOF and close the connection after the handshake.
    let out = tokio::process::Command::new("openssl")
        .args(["s_client", "-connect", &connect, "-verify_return_error", "-brief"])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .output()
        .await;

    let output = match out {
        Ok(o) => {
            let combined = String::from_utf8_lossy(&o.stdout).to_string()
                + &String::from_utf8_lossy(&o.stderr);
            // Limit to first 30 lines (replaces the former | head -30).
            combined.lines().take(30).collect::<Vec<_>>().join("\n")
        }
        Err(e) => return json!({ "error": e.to_string() }),
    };

    // Parse result
    let trusted = output.contains("Verification: OK")
        || output.contains("verify return:1")
        || output.contains("SSL handshake has read");
    let failed  = output.contains("verify error")
        || output.contains("certificate verify failed")
        || output.contains("Verification error");

    json!({
        "ok": trusted && !failed,
        "trusted": trusted && !failed,
        "output": output.trim(),
        "host": host,
    })
}

// ── self-signed generation ─────────────────────────────────────────────────────

async fn generate_selfsigned(data: &Value) -> Value {
    if !which("openssl").await {
        return json!({ "error": "openssl not installed" });
    }

    let cn    = data.get("cn").and_then(|v| v.as_str()).unwrap_or("localhost");
    let org   = data.get("org").and_then(|v| v.as_str()).unwrap_or("");
    let country = data.get("country").and_then(|v| v.as_str()).unwrap_or("");
    let days  = data.get("days").and_then(|v| v.as_u64()).unwrap_or(365);
    let bits  = data.get("key_size").and_then(|v| v.as_u64()).unwrap_or(2048);
    let san_raw = data.get("san").and_then(|v| v.as_str()).unwrap_or("");

    // Build subject
    let mut subj = format!("/CN={cn}");
    if !org.is_empty()     { subj.push_str(&format!("/O={org}")); }
    if !country.is_empty() { subj.push_str(&format!("/C={country}")); }

    // Build SANs — always include CN as DNS SAN
    let mut san_parts: Vec<String> = vec![format!("DNS:{cn}")];
    for part in san_raw.split([',', ' ', '\n']) {
        let p = part.trim();
        if p.is_empty() || p == cn { continue; }
        if p.contains(':') {
            san_parts.push(p.to_string()); // already typed (DNS:x or IP:x)
        } else if p.chars().next().map(|c| c.is_ascii_digit()).unwrap_or(false) {
            san_parts.push(format!("IP:{p}"));
        } else {
            san_parts.push(format!("DNS:{p}"));
        }
    }
    let san_ext = format!("subjectAltName={}", san_parts.join(","));

    // Write to temp files
    let tmp = format!("/tmp/tenodera-selfsigned-{}", std::process::id());
    let key_path  = format!("{tmp}.key");
    let cert_path = format!("{tmp}.crt");

    let days_str = days.to_string();
    let bits_str = bits.to_string();

    let out = tokio::process::Command::new("openssl")
        .args([
            "req", "-x509",
            "-newkey", &format!("rsa:{bits_str}"),
            "-keyout", &key_path,
            "-out", &cert_path,
            "-days", &days_str,
            "-nodes",
            "-subj", &subj,
            "-addext", &san_ext,
        ])
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .output()
        .await;

    match out {
        Ok(o) if o.status.success() => {
            let cert = fs::read_to_string(&cert_path).await.unwrap_or_default();
            let key  = fs::read_to_string(&key_path).await.unwrap_or_default();
            let _ = fs::remove_file(&cert_path).await;
            let _ = fs::remove_file(&key_path).await;
            json!({ "ok": true, "cert": cert, "key": key })
        }
        Ok(o) => {
            let _ = fs::remove_file(&cert_path).await;
            let _ = fs::remove_file(&key_path).await;
            let stderr = String::from_utf8_lossy(&o.stderr).to_string();
            json!({ "error": stderr })
        }
        Err(e) => json!({ "error": e.to_string() }),
    }
}

// ── Let's Encrypt ──────────────────────────────────────────────────────────────

async fn letsencrypt_info() -> Value {
    let certbot = which("certbot").await;
    if !certbot {
        let distro = detect_distro().await;
        let install_hint = match distro {
            Distro::Debian  => "sudo apt install certbot",
            Distro::Fedora  => "sudo dnf install certbot",
            Distro::Arch    => "sudo pacman -S certbot",
            Distro::Unknown => "install certbot from https://certbot.eff.org",
        };
        return json!({
            "available": false,
            "install_hint": install_hint,
            "certs": [],
        });
    }

    let version = run_cmd(&["certbot", "--version"]).await;
    let certs = parse_certbot_certificates().await;

    json!({
        "available": true,
        "version": version.trim().to_string(),
        "certs": certs,
    })
}

async fn parse_certbot_certificates() -> Vec<Value> {
    // certbot certificates requires sudo on some systems but try without first
    let out = run_cmd(&["certbot", "certificates", "--non-interactive"]).await;
    let mut certs: Vec<Value> = Vec::new();
    let mut current: std::collections::HashMap<&str, String> = std::collections::HashMap::new();

    for line in out.lines() {
        let l = line.trim();
        if l.starts_with("Certificate Name:") {
            if !current.is_empty() {
                certs.push(certbot_entry_to_json(&current));
                current.clear();
            }
            current.insert("name", l.trim_start_matches("Certificate Name:").trim().to_string());
        } else if l.starts_with("Domains:") {
            current.insert("domains", l.trim_start_matches("Domains:").trim().to_string());
        } else if l.starts_with("Expiry Date:") {
            current.insert("expiry", l.trim_start_matches("Expiry Date:").trim().to_string());
        } else if l.starts_with("Certificate Path:") {
            current.insert("cert_path", l.trim_start_matches("Certificate Path:").trim().to_string());
        } else if l.starts_with("Private Key Path:") {
            current.insert("key_path", l.trim_start_matches("Private Key Path:").trim().to_string());
        }
    }
    if !current.is_empty() {
        certs.push(certbot_entry_to_json(&current));
    }

    certs
}

fn certbot_entry_to_json(m: &std::collections::HashMap<&str, String>) -> Value {
    let expiry_str = m.get("expiry").map(|s| s.as_str()).unwrap_or("");
    // "2024-04-01 00:00:00+00:00 (VALID: 89 days)" or "(EXPIRED)"
    let days: i64 = if expiry_str.contains("EXPIRED") {
        -1
    } else {
        expiry_str.split("VALID:")
            .nth(1)
            .and_then(|s| s.split_whitespace().next())
            .and_then(|s| s.parse().ok())
            .unwrap_or(0)
    };

    json!({
        "name": m.get("name").map(|s| s.as_str()).unwrap_or(""),
        "domains": m.get("domains").map(|s| s.as_str()).unwrap_or(""),
        "expiry": expiry_str,
        "days_remaining": days,
        "cert_path": m.get("cert_path").map(|s| s.as_str()).unwrap_or(""),
        "key_path": m.get("key_path").map(|s| s.as_str()).unwrap_or(""),
    })
}

// ── cert import (check + save) ─────────────────────────────────────────────────

async fn cert_check(data: &Value) -> Value {
    let cert_pem = match data.get("cert").and_then(|v| v.as_str()) {
        Some(s) if !s.trim().is_empty() => s.trim().to_string(),
        _ => return json!({ "error": "missing certificate" }),
    };
    let key_pem = match data.get("key").and_then(|v| v.as_str()) {
        Some(s) if !s.trim().is_empty() => s.trim().to_string(),
        _ => return json!({ "error": "missing private key" }),
    };

    if !which("openssl").await {
        return json!({ "error": "openssl not found" });
    }

    let pid = std::process::id();
    let cert_tmp = format!("/tmp/tenodera-certchk-{pid}.crt");
    let key_tmp  = format!("/tmp/tenodera-certchk-{pid}.key");

    if fs::write(&cert_tmp, &cert_pem).await.is_err() {
        return json!({ "error": "failed to write temp cert file" });
    }
    if fs::write(&key_tmp, &key_pem).await.is_err() {
        let _ = fs::remove_file(&cert_tmp).await;
        return json!({ "error": "failed to write temp key file" });
    }

    // Extract modulus hash from cert (leaf = first cert in chain)
    let cert_mod_out = tokio::process::Command::new("sh")
        .args(["-c", &format!("openssl x509 -noout -modulus -in {cert_tmp} 2>&1 | openssl md5")])
        .output().await;

    // Extract modulus hash from key (auto-detect RSA/EC)
    let key_mod_out = tokio::process::Command::new("sh")
        .args(["-c", &format!(
            "openssl rsa -noout -modulus -in {key_tmp} 2>&1 | openssl md5 || \
             openssl ec  -noout -pubout  -in {key_tmp} 2>&1 | openssl md5"
        )])
        .output().await;

    let cert_mod = cert_mod_out
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap_or_default();
    let key_mod = key_mod_out
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap_or_default();

    // Parse cert info while files still exist
    let cert_info = parse_cert(&cert_tmp, "import").await;

    let _ = fs::remove_file(&cert_tmp).await;
    let _ = fs::remove_file(&key_tmp).await;

    if cert_mod.is_empty() || cert_mod.contains("unable to") || cert_mod.contains("error") {
        return json!({ "error": format!("invalid certificate: {cert_mod}") });
    }
    if key_mod.is_empty() || key_mod.contains("unable to") || key_mod.contains("error") {
        return json!({ "error": format!("invalid private key: {key_mod}") });
    }
    if cert_mod != key_mod {
        return json!({
            "ok": false,
            "error": "certificate and private key do NOT match (modulus mismatch)"
        });
    }

    match cert_info {
        Some(info) => json!({ "ok": true, "cert": info }),
        None => json!({ "error": "certificate is valid but could not extract details" }),
    }
}

async fn cert_save(data: &Value, password: &str) -> Value {
    let name = match data.get("name").and_then(|v| v.as_str()) {
        Some(n) if !n.trim().is_empty() => n.trim(),
        _ => return json!({ "error": "missing name" }),
    };
    let cert_pem = match data.get("cert").and_then(|v| v.as_str()) {
        Some(s) if !s.trim().is_empty() => s.trim().to_string(),
        _ => return json!({ "error": "missing certificate" }),
    };
    let key_pem = match data.get("key").and_then(|v| v.as_str()) {
        Some(s) if !s.trim().is_empty() => s.trim().to_string(),
        _ => return json!({ "error": "missing private key" }),
    };

    let safe_name: String = name.chars()
        .map(|c| if c.is_alphanumeric() || "-_.".contains(c) { c } else { '_' })
        .collect();

    let subdir = data.get("subdir").and_then(|v| v.as_bool()).unwrap_or(false);

    let (cert_path, key_path) = if subdir {
        let dir = format!("/etc/ssl/{safe_name}");
        let mk = sudo_action(password, &["mkdir", "-p", &dir]).await;
        if mk.get("error").is_some() { return mk; }
        (format!("{dir}/{safe_name}.crt"), format!("{dir}/{safe_name}.key"))
    } else {
        (format!("/etc/ssl/{safe_name}.crt"), format!("/etc/ssl/{safe_name}.key"))
    };

    let write_cert = sudo_stdin_write(password, &["tee", &cert_path], &cert_pem).await;
    if write_cert.get("error").is_some() { return write_cert; }

    let write_key = sudo_stdin_write(password, &["tee", &key_path], &key_pem).await;
    if write_key.get("error").is_some() {
        let _ = sudo_action(password, &["rm", "-f", &cert_path]).await;
        return write_key;
    }

    let chmod = sudo_action(password, &["chmod", "600", &key_path]).await;
    if chmod.get("error").is_some() { return chmod; }

    json!({
        "ok": true,
        "cert_path": cert_path,
        "key_path": key_path,
    })
}

async fn letsencrypt_renew_all(password: &str) -> Value {
    sudo_action(password, &["certbot", "renew", "--non-interactive"]).await
}

async fn letsencrypt_renew(data: &Value, password: &str) -> Value {
    let name = match data.get("name").and_then(|v| v.as_str()) {
        Some(n) if !n.is_empty() => n,
        _ => return json!({ "error": "missing cert name" }),
    };
    if name.contains('/') || name.contains("..") {
        return json!({ "error": "invalid cert name" });
    }
    sudo_action(password, &["certbot", "renew", "--cert-name", name, "--non-interactive"]).await
}

async fn letsencrypt_delete(data: &Value, password: &str) -> Value {
    let name = match data.get("name").and_then(|v| v.as_str()) {
        Some(n) if !n.is_empty() => n,
        _ => return json!({ "error": "missing cert name" }),
    };
    if name.contains('/') || name.contains("..") {
        return json!({ "error": "invalid cert name" });
    }
    sudo_action(password, &[
        "certbot", "delete", "--cert-name", name, "--non-interactive",
    ]).await
}
