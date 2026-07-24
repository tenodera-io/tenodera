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

use std::path::PathBuf;

use tokio::process::Command;

/// Path to the bridge on managed hosts (installed there out of band for now).
const REMOTE_BRIDGE: &str = "/usr/local/bin/tenodera-bridge";
/// User-certificate lifetime — short, per ADR-0003/0004.
const CERT_TTL: &str = "+2m";

fn env_path(key: &str) -> Result<PathBuf, String> {
    std::env::var(key)
        .map(PathBuf::from)
        .map_err(|_| format!("{key} not set"))
}

/// Run `op` on `principal@host:port` via SSH+bridge; return the bridge's JSON.
pub async fn run_operation(
    host: &str,
    port: i32,
    principal: &str,
    op: &serde_json::Value,
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

    // Connect and run the bridge, feeding it the operation on stdin.
    let target = format!("{principal}@{host}");
    let mut child = Command::new("ssh")
        .args([
            "-i",
            &key.display().to_string(),
            "-o",
            &format!("CertificateFile={}", cert.display()),
            "-o",
            "BatchMode=yes",
            "-o",
            "StrictHostKeyChecking=accept-new",
            "-o",
            &format!("UserKnownHostsFile={}", known.display()),
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
        .spawn()
        .map_err(|e| format!("ssh spawn: {e}"))?;

    if let Some(mut stdin) = child.stdin.take() {
        use tokio::io::AsyncWriteExt;
        let _ = stdin.write_all(op.to_string().as_bytes()).await;
        let _ = stdin.shutdown().await;
    }
    let out = child
        .wait_with_output()
        .await
        .map_err(|e| format!("ssh wait: {e}"))?;
    let _ = tokio::fs::remove_dir_all(&tmp).await;

    if !out.status.success() {
        return Err(format!(
            "ssh failed: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    let stdout = String::from_utf8_lossy(&out.stdout);
    serde_json::from_str(stdout.trim()).map_err(|_| format!("bridge returned non-JSON: {stdout}"))
}
