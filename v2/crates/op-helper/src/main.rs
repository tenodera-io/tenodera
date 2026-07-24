//! Tenodera v2 op-helper (ADR-0004/0005) — the **only** program run as root.
//!
//! It executes a privileged operation ONLY when the request carries a valid,
//! control-plane-signed [`ExecutionGrant`] that authorizes exactly this operation
//! on this host. Possession of the `NOPASSWD` sudoers rule is therefore not enough
//! to act: without a grant the caller is refused. The grant is single-use
//! (replay-guarded) and time-bounded. Even with a grant, the command is a fixed
//! `systemctl <verb> <unit>` argv — never a shell.
//!
//! Input (stdin): a JSON `OperationRequest` with a `grant`.
//! Output (stdout): `{ "ok": true, "op": ..., "unit": ... }` or `{ "ok": false, "error": ... }`.

use std::io::{Read, Write};
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

use tenodera_protocol as proto;

/// Public key of the control plane's grant signer (world-readable, root-installed).
const VERIFY_KEY_PATH: &str = "/etc/tenodera/grant-signing.pub";
/// This host's control-plane id (root-installed) — binds a grant to this machine.
const HOST_ID_PATH: &str = "/etc/tenodera/host-id";
/// Append-only record of spent grant ids (single-use enforcement).
const REPLAY_DIR: &str = "/var/lib/tenodera";
const REPLAY_DB: &str = "/var/lib/tenodera/used-grants";

fn main() {
    let mut input = String::new();
    // Bounded read — never slurp an unbounded stream from the caller.
    let mut limited = std::io::stdin().take((proto::MAX_FRAME_BYTES + 1) as u64);
    if limited.read_to_string(&mut input).is_err() {
        return emit_err("could not read stdin");
    }
    if input.len() > proto::MAX_FRAME_BYTES {
        return emit_err("request too large");
    }

    let req: proto::OperationRequest = match serde_json::from_str(input.trim()) {
        Ok(r) => r,
        Err(_) => return emit_err("invalid request"),
    };
    if req.check_version().is_err() {
        return emit_err("unsupported protocol version");
    }
    if req.operation.validate().is_err() {
        return emit_err("invalid unit name");
    }
    // The helper performs privileged (mutating) operations only.
    let Some(verb) = req.operation.systemctl_verb() else {
        return emit_err("operation not permitted");
    };

    // The grant's actor must be the unix user that actually invoked us via sudo,
    // so one operator cannot present a grant issued for another.
    if let Ok(sudo_user) = std::env::var("SUDO_USER") {
        if sudo_user != req.actor {
            return emit_err("actor mismatch");
        }
    }

    // A signed grant is mandatory.
    let Some(grant) = &req.grant else {
        return emit_err("grant required");
    };

    // Bind the grant to THIS physical host (a grant for another host is refused).
    if let Ok(local_host_id) = std::fs::read_to_string(HOST_ID_PATH) {
        if local_host_id.trim() != grant.host_id.to_string() {
            return emit_err("grant not for this host");
        }
    }
    let verifying_key = match std::fs::read_to_string(VERIFY_KEY_PATH)
        .ok()
        .and_then(|s| proto::verifying_key_from_hex(&s))
    {
        Some(k) => k,
        None => return emit_err("no grant verification key configured"),
    };
    let now = unix_now();
    let expect = proto::GrantExpectation {
        job_id: req.job_id,
        actor: &req.actor,
        host_id: grant.host_id, // grant is bound to a host; verify() re-checks the signature covers it
        operation_hash: req.operation.hash(),
    };
    if let Err(e) = grant.verify(&verifying_key, now, &expect) {
        return emit_err(&format!("grant rejected: {e}"));
    }

    // Single-use: refuse a grant id we've already spent.
    if !claim_grant(&grant.grant_id.to_string()) {
        return emit_err("grant already used");
    }

    let unit = req.operation.unit();
    // Local, root-side audit trail independent of the control plane.
    eprintln!(
        "tenodera-op-helper: job={} grant={} actor={} op={} unit={}",
        req.job_id,
        grant.grant_id,
        req.actor,
        req.operation.key(),
        unit
    );

    match run(&["systemctl", verb, unit]) {
        Some((true, _)) => emit(serde_json::json!({
            "ok": true, "op": req.operation.key(), "unit": unit,
        })),
        Some((false, err)) => emit(serde_json::json!({
            "ok": false, "op": req.operation.key(), "unit": unit, "error": err,
        })),
        None => emit_err("could not run systemctl"),
    }
}

fn unix_now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// Record `grant_id` as spent; return false if it was already present. Best-effort
/// file store (a follow-up should flock for strict concurrency).
fn claim_grant(grant_id: &str) -> bool {
    let _ = std::fs::create_dir_all(REPLAY_DIR);
    if let Ok(existing) = std::fs::read_to_string(REPLAY_DB) {
        if existing.lines().any(|l| l == grant_id) {
            return false;
        }
    }
    match std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(REPLAY_DB)
    {
        Ok(mut f) => writeln!(f, "{grant_id}").is_ok(),
        Err(_) => false, // fail-closed: can't record spend -> don't run
    }
}

/// Run an argv vector in a fixed, minimal environment. Returns (success, stderr).
fn run(argv: &[&str]) -> Option<(bool, String)> {
    let out = Command::new(argv[0])
        .args(&argv[1..])
        .env_clear()
        .env("PATH", "/usr/sbin:/usr/bin:/sbin:/bin")
        .env("LANG", "C.UTF-8")
        .env("LC_ALL", "C.UTF-8")
        .output()
        .ok()?;
    Some((
        out.status.success(),
        String::from_utf8_lossy(&out.stderr).trim().to_string(),
    ))
}

fn emit(v: serde_json::Value) {
    println!("{v}");
}

fn emit_err(msg: &str) {
    emit(serde_json::json!({ "ok": false, "error": msg }));
}
