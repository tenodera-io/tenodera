//! Tenodera v2 bridge (Phase 2, first operation).
//!
//! Runs **as the operator** on a managed host (reached over SSH — ADR-0001). It
//! reads one **typed operation** as JSON on stdin, dispatches by `op`, and writes a
//! typed JSON result on stdout. Commands are built as **argv vectors — never a
//! shell** (ADR-0005), in a fixed minimal environment. Privileged (mutating)
//! operations will go through the root op-helper (ADR-0004/0005); `service.status`
//! is a read and needs no escalation.
//!
//! Request:  {"v":1,"op":"service.status","args":{"unit":"sshd.service"}}
//! Response: {"ok":true,"op":"service.status","unit":"sshd.service","status":{...}}

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
    let args = req
        .get("args")
        .cloned()
        .unwrap_or_else(|| serde_json::json!({}));

    match op {
        "service.status" => service_status(&args),
        other => emit(serde_json::json!({ "ok": false, "error": format!("unknown op: {other}") })),
    }
}

/// A systemd unit name — deny anything with shell/path metacharacters. We build
/// argv (no shell) so this is defence in depth, per ADR-0005.
fn valid_unit(u: &str) -> bool {
    !u.is_empty()
        && u.len() <= 256
        && u.bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'@' | b':' | b'-'))
}

/// Run a command as an argv vector in a fixed minimal environment (no shell,
/// no inherited environment — the agent-exec discipline carried into v2).
fn run(argv: &[&str]) -> Option<String> {
    let out = Command::new(argv[0])
        .args(&argv[1..])
        .env_clear()
        .env("PATH", "/usr/sbin:/usr/bin:/sbin:/bin")
        .env("LANG", "C.UTF-8")
        .env("LC_ALL", "C.UTF-8")
        .output()
        .ok()?;
    Some(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

fn service_status(args: &serde_json::Value) {
    let unit = args.get("unit").and_then(|v| v.as_str()).unwrap_or("");
    if !valid_unit(unit) {
        return emit_err("invalid unit name");
    }
    // `systemctl show <unit> --property=...` — KEY=VALUE lines, no shell.
    let Some(out) = run(&[
        "systemctl",
        "show",
        unit,
        "--property=ActiveState",
        "--property=SubState",
        "--property=LoadState",
        "--property=UnitFileState",
    ]) else {
        return emit_err("could not query systemctl");
    };

    let mut status = serde_json::Map::new();
    for line in out.lines() {
        if let Some((k, v)) = line.split_once('=') {
            status.insert(k.to_string(), serde_json::Value::String(v.to_string()));
        }
    }
    emit(serde_json::json!({
        "ok": true,
        "op": "service.status",
        "unit": unit,
        "status": status,
    }));
}

fn emit(v: serde_json::Value) {
    println!("{v}");
}

fn emit_err(msg: &str) {
    emit(serde_json::json!({ "ok": false, "error": msg }));
}
