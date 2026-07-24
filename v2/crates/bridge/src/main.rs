//! Tenodera v2 bridge — runs as the operator on a managed host (over SSH, ADR-0001).
//!
//! Reads one typed [`OperationRequest`] on stdin and dispatches by operation:
//! a **read** (`service.status`) it runs directly as the operator; a **mutation**
//! it must NOT perform itself — it forwards the request verbatim (including the
//! signed grant) to the root op-helper via one `NOPASSWD` sudoers rule (ADR-0005).
//! It never builds a privileged command; the helper does, and only if the grant
//! authorizes it.

use std::io::{Read, Write};
use std::process::Command;

use tenodera_protocol as proto;

/// Path to the root-owned op-helper (installed out of band; ADR-0004/0005).
const OP_HELPER: &str = "/usr/local/bin/tenodera-op-helper";

fn main() {
    let mut input = String::new();
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

    if req.operation.is_mutating() {
        // Privileged: forward the request (with its grant) to the root op-helper.
        forward_to_helper(&input);
    } else {
        // Read: run it directly as the operator, no escalation.
        service_status(req.operation.unit());
    }
}

fn service_status(unit: &str) {
    let out = Command::new("systemctl")
        .args([
            "show",
            unit,
            "--property=ActiveState",
            "--property=SubState",
            "--property=LoadState",
            "--property=UnitFileState",
        ])
        .env_clear()
        .env("PATH", "/usr/sbin:/usr/bin:/sbin:/bin")
        .env("LANG", "C.UTF-8")
        .env("LC_ALL", "C.UTF-8")
        .output();
    let Ok(out) = out else {
        return emit_err("could not query systemctl");
    };
    let text = String::from_utf8_lossy(&out.stdout);
    let mut status = serde_json::Map::new();
    for line in text.lines() {
        if let Some((k, v)) = line.split_once('=') {
            status.insert(k.to_string(), serde_json::Value::String(v.to_string()));
        }
    }
    emit(serde_json::json!({
        "ok": true, "op": "service.status", "unit": unit, "status": status,
    }));
}

/// Forward the raw request to `sudo -n op-helper` and relay its typed result.
fn forward_to_helper(request_json: &str) {
    let mut child = match Command::new("sudo")
        .args(["-n", OP_HELPER])
        .env_clear()
        .env("PATH", "/usr/sbin:/usr/bin:/sbin:/bin")
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
    {
        Ok(c) => c,
        Err(e) => return emit_err(&format!("could not launch op-helper: {e}")),
    };
    if let Some(mut stdin) = child.stdin.take() {
        let _ = stdin.write_all(request_json.as_bytes());
    }
    match child.wait_with_output() {
        Ok(out) if out.status.success() => {
            print!("{}", String::from_utf8_lossy(&out.stdout));
        }
        Ok(out) => emit_err(&format!(
            "op-helper failed: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        )),
        Err(e) => emit_err(&format!("op-helper wait: {e}")),
    }
}

fn emit(v: serde_json::Value) {
    println!("{v}");
}

fn emit_err(msg: &str) {
    emit(serde_json::json!({ "ok": false, "error": msg }));
}
