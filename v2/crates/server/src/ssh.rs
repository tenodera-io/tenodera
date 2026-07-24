//! SSH connection manager (Phase 2).
//!
//! Runs a typed operation on a managed host: sign a **short-lived user certificate**
//! with the control-plane CA (ADR-0003), SSH to the host as the operator's local
//! principal, execute the bridge (ADR-0001), and return its typed JSON result. The
//! CA turns "distribute N keys" into "trust one CA once" — the model validated in
//! the ADR-0003 spike.
//!
//! First cut: shells out to `ssh`/`ssh-keygen` (light, no native-crypto build) and
//! uses TOFU host-key acceptance. Host-key pinning from PostgreSQL (ADR-0003) and a
//! native transport come later.

use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;
use std::time::Duration;

use tokio::process::Command;

/// Hard ceiling on a single SSH operation (connect + bridge run).
const SSH_TIMEOUT: Duration = Duration::from_secs(20);

/// Path to the bridge on managed hosts (installed there out of band for now).
const REMOTE_BRIDGE: &str = "/usr/local/bin/tenodera-bridge";
/// User-certificate lifetime — short, per ADR-0003/0004.
const CERT_TTL: &str = "+2m";

fn env_path(key: &str) -> Result<PathBuf, String> {
    std::env::var(key)
        .map(PathBuf::from)
        .map_err(|_| format!("{key} not set"))
}

/// A scanned SSH host key: (algorithm, "algorithm base64", SHA256 fingerprint).
pub type HostKey = (String, String, String);

/// known_hosts host token: bare hostname on :22, `[host]:port` otherwise —
/// matching how OpenSSH keys the entry for the connection.
pub fn known_hosts_token(host: &str, port: i32) -> String {
    if port == 22 {
        host.to_string()
    } else {
        format!("[{host}]:{port}")
    }
}

/// Scan a host's public SSH keys with `ssh-keyscan` and fingerprint them. Used at
/// enrollment to pin the keys in PostgreSQL (ADR-0003) — an explicit, recorded
/// trust-on-first-use, not the silent accept an operation would do.
pub async fn scan_host_keys(host: &str, port: i32) -> Result<Vec<HostKey>, String> {
    let scan = Command::new("ssh-keyscan")
        .args(["-T", "5", "-p", &port.to_string(), host])
        .output()
        .await
        .map_err(|e| format!("ssh-keyscan: {e}"))?;
    let text = String::from_utf8_lossy(&scan.stdout).into_owned();
    let lines: Vec<&str> = text
        .lines()
        .filter(|l| !l.trim_start().starts_with('#') && !l.trim().is_empty())
        .collect();
    if lines.is_empty() {
        return Err("no host keys returned (host unreachable or no sshd)".into());
    }

    // Fingerprint the whole scan in one pass; ssh-keygen -lf emits one line per key
    // in file order, so we can zip by index with the parsed key lines.
    let mut nonce = [0u8; 8];
    getrandom::fill(&mut nonce).map_err(|e| e.to_string())?;
    let tmp = std::env::temp_dir().join(format!(
        "tenodera-scan-{}",
        nonce.iter().map(|b| format!("{b:02x}")).collect::<String>()
    ));
    tokio::fs::write(&tmp, &text)
        .await
        .map_err(|e| e.to_string())?;
    let fp_out = Command::new("ssh-keygen")
        .args(["-l", "-f"])
        .arg(&tmp)
        .output()
        .await
        .map_err(|e| format!("ssh-keygen: {e}"))?;
    let _ = tokio::fs::remove_file(&tmp).await;
    let fps: Vec<String> = String::from_utf8_lossy(&fp_out.stdout)
        .lines()
        .filter_map(|l| l.split_whitespace().nth(1).map(str::to_string))
        .collect();

    let mut keys = Vec::new();
    for (i, line) in lines.iter().enumerate() {
        let mut it = line.split_whitespace();
        let _token = it.next();
        if let (Some(algo), Some(blob)) = (it.next(), it.next()) {
            let fingerprint = fps.get(i).cloned().unwrap_or_default();
            keys.push((algo.to_string(), format!("{algo} {blob}"), fingerprint));
        }
    }
    if keys.is_empty() {
        return Err("could not parse scanned host keys".into());
    }
    Ok(keys)
}

/// Run `op` on `principal@host:port` via SSH+bridge; return the bridge's JSON.
/// `known_hosts` must contain the host's **pinned** keys — the connection uses
/// `StrictHostKeyChecking=yes`, so a key not present (MITM, re-provisioned host)
/// aborts the connection rather than being silently accepted.
pub async fn run_operation(
    host: &str,
    port: i32,
    principal: &str,
    op: &serde_json::Value,
    known_hosts: &str,
) -> Result<serde_json::Value, String> {
    let ca = env_path("TENODERA_SSH_CA")?;
    let key = env_path("TENODERA_SSH_KEY")?; // private key; <key>.pub is its public half

    // Isolated scratch dir so concurrent signings don't clobber one cert file.
    let mut nonce = [0u8; 8];
    getrandom::fill(&mut nonce).map_err(|e| e.to_string())?;
    let tmp = std::env::temp_dir().join(format!(
        "tenodera-ssh-{}",
        nonce.iter().map(|b| format!("{b:02x}")).collect::<String>()
    ));
    tokio::fs::create_dir_all(&tmp)
        .await
        .map_err(|e| e.to_string())?;
    // Private scratch dir — certs/keys/known_hosts must not be world-readable.
    let _ = tokio::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o700)).await;
    let pubkey_src = PathBuf::from(format!("{}.pub", key.display()));
    let pubkey = tmp.join("id.pub");
    tokio::fs::copy(&pubkey_src, &pubkey)
        .await
        .map_err(|e| format!("copy pubkey: {e}"))?;

    // Sign a short-lived cert for this principal.
    let sign = Command::new("ssh-keygen")
        .args([
            "-s",
            &ca.display().to_string(),
            "-I",
            "tenodera-op",
            "-n",
            principal,
            "-V",
            CERT_TTL,
        ])
        .arg(&pubkey)
        .output()
        .await
        .map_err(|e| format!("ssh-keygen: {e}"))?;
    if !sign.status.success() {
        let _ = tokio::fs::remove_dir_all(&tmp).await;
        return Err(format!(
            "cert signing failed: {}",
            String::from_utf8_lossy(&sign.stderr).trim()
        ));
    }
    let cert = tmp.join("id-cert.pub");
    let known = tmp.join("known_hosts");
    if let Err(e) = tokio::fs::write(&known, known_hosts).await {
        let _ = tokio::fs::remove_dir_all(&tmp).await;
        return Err(format!("write known_hosts: {e}"));
    }

    // Connect and run the bridge, feeding it the operation on stdin. The client is
    // pinned to our own options only — the server user's ~/.ssh/config must not
    // influence the connection, and no agent/X11/port forwarding is allowed.
    let target = format!("{principal}@{host}");
    let mut child = Command::new("ssh")
        .args([
            "-F",
            "/dev/null",
            "-i",
            &key.display().to_string(),
            "-o",
            &format!("CertificateFile={}", cert.display()),
            "-o",
            "IdentitiesOnly=yes",
            "-o",
            "BatchMode=yes",
            "-o",
            "StrictHostKeyChecking=yes",
            "-o",
            &format!("UserKnownHostsFile={}", known.display()),
            "-o",
            "ClearAllForwardings=yes",
            "-o",
            "ForwardAgent=no",
            "-o",
            "ForwardX11=no",
            "-o",
            "RequestTTY=no",
            "-o",
            "ConnectTimeout=8",
            "-p",
            &port.to_string(),
            &target,
            REMOTE_BRIDGE,
        ])
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| format!("ssh spawn: {e}"))?;

    if let Some(mut stdin) = child.stdin.take() {
        use tokio::io::AsyncWriteExt;
        let _ = stdin.write_all(op.to_string().as_bytes()).await;
        let _ = stdin.shutdown().await;
    }
    // Bounded: on timeout the future is dropped and kill_on_drop terminates ssh.
    let outcome = tokio::time::timeout(SSH_TIMEOUT, child.wait_with_output()).await;
    let _ = tokio::fs::remove_dir_all(&tmp).await;
    let out = match outcome {
        Ok(Ok(o)) => o,
        Ok(Err(e)) => return Err(format!("ssh wait: {e}")),
        Err(_) => return Err("ssh operation timed out".into()),
    };

    if !out.status.success() {
        return Err(format!(
            "ssh failed: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    let stdout = String::from_utf8_lossy(&out.stdout);
    serde_json::from_str(stdout.trim()).map_err(|_| format!("bridge returned non-JSON: {stdout}"))
}
