//! Tenodera v2 op-helper (ADR-0004/0005) — the **only** program run as root.
//!
//! The bridge runs as the operator and cannot touch privileged state directly. For
//! a mutating operation it invokes this helper via a single `NOPASSWD` sudoers rule
//! that names exactly this binary (no arguments, no wildcard). The helper reads one
//! **typed operation** as JSON on stdin, and — this is the whole security claim —
//! only ever runs a fixed, allow-listed command as an **argv vector, never a
//! shell**. There is no code path from an operator to `sudo systemctl <anything>`
//! or `sudo sh -c`; root executes typed operations or nothing.
//!
//! Request:  {"op":"service.restart","args":{"unit":"nginx.service"}}
//! Response: {"ok":true,"op":"service.restart","unit":"nginx.service"}

use std::io::Read;
use std::process::Command;

fn main() {
    let mut input = String::new();
    if std::io::stdin().read_to_string(&mut input).is_err() {
        return emit_err("could not read stdin");
    }
    let req: serde_json::Value = match serde_json::from_str(input.trim()) {
        Ok(v) => v,
        Err(_) => return emit_err("invalid json"),
    };

    let op = req.get("op").and_then(|v| v.as_str()).unwrap_or("");
    let args = req.get("args").cloned().unwrap_or_else(|| serde_json::json!({}));

    // Allow-list: map op -> the one systemctl verb it is permitted to run.
    let verb = match op {
        "service.start" => "start",
        "service.stop" => "stop",
        "service.restart" => "restart",
        other => return emit_err(&format!("operation not permitted: {other}")),
    };

    let unit = args.get("unit").and_then(|v| v.as_str()).unwrap_or("");
    if !valid_unit(unit) {
        return emit_err("invalid unit name");
    }

    match run(&["systemctl", verb, unit]) {
        Some((true, _)) => emit(serde_json::json!({ "ok": true, "op": op, "unit": unit })),
        Some((false, err)) => emit(serde_json::json!({
            "ok": false, "op": op, "unit": unit, "error": err,
        })),
        None => emit_err("could not run systemctl"),
    }
}

/// A systemd unit name — strictly bounded; anything with shell/path metacharacters
/// is rejected. We build argv (no shell), so this is defence in depth (ADR-0005).
fn valid_unit(u: &str) -> bool {
    !u.is_empty()
        && u.len() <= 256
        && u.bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'@' | b':' | b'-'))
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
