use serde_json::Value;
use tokio::io::AsyncWriteExt;

// ── Command execution helpers ─────────────────────────────────
// Shared across multiple handler modules to avoid duplication.

/// Run a command and return its stdout (falling back to stderr if stdout is empty).
pub async fn run_cmd(args: &[&str]) -> String {
    let Some((cmd, rest)) = args.split_first() else {
        return String::new();
    };
    match tokio::process::Command::new(cmd)
        .args(rest)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .output()
        .await
    {
        Ok(out) => {
            let stdout = String::from_utf8_lossy(&out.stdout).to_string();
            if stdout.is_empty() {
                String::from_utf8_lossy(&out.stderr).to_string()
            } else {
                stdout
            }
        }
        Err(e) => format!("error: {e}"),
    }
}

/// Run a command via `sudo -S` (or directly when running as root).
/// Returns `{"ok": true, "output": ...}` on success or `{"error": ...}` on failure.
pub async fn sudo_action(password: &str, args: &[impl AsRef<str>]) -> Value {
    let str_args: Vec<&str> = args.iter().map(|a| a.as_ref()).collect();

    // When running as root, skip sudo entirely — avoid stdin password interference
    let am_root = unsafe { libc::geteuid() } == 0;

    if !am_root && password.is_empty() {
        return serde_json::json!({ "error": "password required" });
    }

    let (cmd, cmd_args) = if am_root {
        let first = str_args.first().copied().unwrap_or("true");
        let rest: Vec<&str> = str_args.iter().skip(1).copied().collect();
        (first.to_string(), rest)
    } else {
        let mut sa = vec!["-S"];
        sa.extend_from_slice(&str_args);
        ("sudo".to_string(), sa)
    };

    let child = tokio::process::Command::new(&cmd)
        .args(&cmd_args)
        .env("DEBIAN_FRONTEND", "noninteractive")
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn();

    let mut child = match child {
        Ok(c) => c,
        Err(e) => return serde_json::json!({ "error": e.to_string() }),
    };

    if let Some(mut stdin) = child.stdin.take() {
        if !am_root {
            let _ = stdin.write_all(format!("{password}\n").as_bytes()).await;
        }
        drop(stdin);
    }

    match child.wait_with_output().await {
        Ok(out) if out.status.success() => {
            let stdout = String::from_utf8_lossy(&out.stdout).trim().to_string();
            serde_json::json!({ "ok": true, "output": stdout })
        }
        Ok(out) => {
            let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
            let clean = stderr
                .lines()
                .filter(|l| !l.contains("[sudo]") && !l.contains("password for"))
                .collect::<Vec<_>>()
                .join("\n");
            let msg = if clean.is_empty() {
                "command failed".to_string()
            } else {
                clean
            };
            serde_json::json!({ "error": msg })
        }
        Err(e) => serde_json::json!({ "error": e.to_string() }),
    }
}

/// Check if a command exists on `$PATH`.
pub async fn which(cmd: &str) -> bool {
    tokio::process::Command::new("which")
        .arg(cmd)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .await
        .map(|s| s.success())
        .unwrap_or(false)
}

/// Escape a string for safe embedding in a POSIX shell single-quoted context.
pub fn shell_escape(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

/// Parse stderr bytes into a JSON error value, filtering out sudo prompt lines.
pub fn stderr_to_error(stderr: &[u8]) -> Value {
    let raw = String::from_utf8_lossy(stderr).trim().to_string();
    let clean = raw
        .lines()
        .filter(|l| !l.contains("[sudo]") && !l.contains("password for"))
        .collect::<Vec<_>>()
        .join("\n");
    let msg = if clean.is_empty() {
        "operation failed".to_string()
    } else {
        clean
    };
    serde_json::json!({ "error": msg })
}

/// Write `content` to a command's stdin via sudo, avoiding shell execution
/// when running as root. Uses base64-encoding when non-root to avoid
/// mixing the sudo password with command data on stdin.
pub async fn sudo_stdin_write(password: &str, args: &[&str], content: &str) -> Value {
    let am_root = unsafe { libc::geteuid() } == 0;

    if !am_root && password.is_empty() {
        return serde_json::json!({ "error": "password required" });
    }

    if am_root {
        let first = args.first().copied().unwrap_or("true");
        let rest: Vec<&str> = args.iter().skip(1).copied().collect();

        let child = tokio::process::Command::new(first)
            .args(&rest)
            .env("DEBIAN_FRONTEND", "noninteractive")
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn();

        let mut child = match child {
            Ok(c) => c,
            Err(e) => return serde_json::json!({ "error": e.to_string() }),
        };

        if let Some(mut stdin) = child.stdin.take() {
            let _ = stdin.write_all(content.as_bytes()).await;
            drop(stdin);
        }

        return match child.wait_with_output().await {
            Ok(out) if out.status.success() => serde_json::json!({ "ok": true }),
            Ok(out) => stderr_to_error(&out.stderr),
            Err(e) => serde_json::json!({ "error": e.to_string() }),
        };
    }

    // Non-root path — base64-encode content, embed in sh -c.
    use base64::Engine;
    let b64 = base64::engine::general_purpose::STANDARD.encode(content.as_bytes());

    let escaped_args: Vec<String> = args.iter().map(|a| shell_escape(a)).collect();
    let inner = format!("printf '{}' | base64 -d | {}", b64, escaped_args.join(" "));

    let child = tokio::process::Command::new("sudo")
        .args(["-S", "sh", "-c", &inner])
        .env("DEBIAN_FRONTEND", "noninteractive")
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn();

    let mut child = match child {
        Ok(c) => c,
        Err(e) => return serde_json::json!({ "error": e.to_string() }),
    };

    if let Some(mut stdin) = child.stdin.take() {
        let _ = stdin.write_all(format!("{password}\n").as_bytes()).await;
        drop(stdin);
    }

    match child.wait_with_output().await {
        Ok(out) if out.status.success() => serde_json::json!({ "ok": true }),
        Ok(out) => stderr_to_error(&out.stderr),
        Err(e) => serde_json::json!({ "error": e.to_string() }),
    }
}

/// Extract a JSON array of strings from a `Value` by key.
pub fn extract_string_array(data: &Value, key: &str) -> Vec<String> {
    data.get(key)
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(|s| s.to_string()))
                .collect()
        })
        .unwrap_or_default()
}
