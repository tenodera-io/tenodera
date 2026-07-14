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

    // When running as root, skip sudo entirely — avoid stdin password interference.
    // NOTE: this legacy path does NOT enforce host authorization; handlers are being
    // migrated to `sudo_as_user` (which drops to the user and lets the host decide).
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
        Ok(out) => serde_json::json!({ "error": clean_sudo_stderr(&out.stderr) }),
        Err(e) => serde_json::json!({ "error": e.to_string() }),
    }
}

/// Look up a user via NSS (getpwnam_r) → (uid, gid, home, shell). Resolves local
/// **and** LDAP/SSSD/FreeIPA users, unlike reading /etc/passwd directly.
pub fn lookup_user(username: &str) -> Option<(u32, u32, String, String)> {
    let cname = std::ffi::CString::new(username).ok()?;
    let mut pwd = unsafe { std::mem::zeroed::<libc::passwd>() };
    let mut buf = vec![0u8; 4096];
    let mut result: *mut libc::passwd = std::ptr::null_mut();
    let ret = unsafe {
        libc::getpwnam_r(
            cname.as_ptr(),
            &mut pwd,
            buf.as_mut_ptr().cast::<libc::c_char>(),
            buf.len(),
            &mut result,
        )
    };
    if ret != 0 || result.is_null() {
        return None;
    }
    unsafe {
        Some((
            (*result).pw_uid,
            (*result).pw_gid,
            std::ffi::CStr::from_ptr((*result).pw_dir)
                .to_string_lossy()
                .into_owned(),
            std::ffi::CStr::from_ptr((*result).pw_shell)
                .to_string_lossy()
                .into_owned(),
        ))
    }
}

/// Strip sudo's password prompt / `[sudo]` noise from stderr, returning a clean
/// error message (or "command failed" if nothing meaningful remains).
pub fn clean_sudo_stderr(stderr: &[u8]) -> String {
    let s = String::from_utf8_lossy(stderr);
    let clean = s
        .lines()
        .filter(|l| !l.contains("[sudo]") && !l.contains("password for"))
        .collect::<Vec<_>>()
        .join("\n")
        .trim()
        .to_string();
    if clean.is_empty() {
        "command failed".to_string()
    } else {
        clean
    }
}

/// Run `args` via `sudo` **as `user`** so the host's sudoers / FreeIPA rules decide
/// what is permitted. The agent (root) drops to the user in `pre_exec`
/// (initgroups → setgid → setuid), then execs `sudo -S -k`, feeding `password` on
/// stdin. A user unknown to this host is rejected — the per-host authorization gate.
pub async fn sudo_as_user(user: &str, password: &str, args: &[&str]) -> Value {
    let Some((uid, gid, _home, _shell)) = lookup_user(user) else {
        return serde_json::json!({
            "error": format!("user '{user}' is not present on this host")
        });
    };
    let ucstr = match std::ffi::CString::new(user) {
        Ok(c) => c,
        Err(_) => return serde_json::json!({ "error": "invalid username" }),
    };

    let mut sudo_args: Vec<&str> = vec!["-S", "-k"];
    sudo_args.extend_from_slice(args);

    let mut cmd = tokio::process::Command::new("sudo");
    cmd.args(&sudo_args)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());

    // pre_exec runs in the forked child before exec: drop to the target user so
    // `sudo` sees the real user and applies their rules. gid before uid; initgroups
    // pulls supplementary groups so group-based sudoers/HBAC apply.
    unsafe {
        cmd.pre_exec(move || {
            if libc::initgroups(ucstr.as_ptr(), gid) != 0
                || libc::setgid(gid) != 0
                || libc::setuid(uid) != 0
            {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }

    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => return serde_json::json!({ "error": e.to_string() }),
    };
    if let Some(mut stdin) = child.stdin.take() {
        let _ = stdin.write_all(format!("{password}\n").as_bytes()).await;
        drop(stdin);
    }

    match child.wait_with_output().await {
        Ok(out) if out.status.success() => {
            let stdout = String::from_utf8_lossy(&out.stdout).trim().to_string();
            serde_json::json!({ "ok": true, "output": stdout })
        }
        Ok(out) => serde_json::json!({ "error": clean_sudo_stderr(&out.stderr) }),
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

/// Write `content` into a command run as `user` via sudo (e.g. `tee <path>`).
///
/// `sudo -S` consumes stdin for the password, so the content can't also be piped in
/// directly; it is base64-embedded and decoded inside a `sh -c`. That means the
/// user's sudo rules must permit `sh` — acceptable for admin config writes, which is
/// the only caller.
pub async fn sudo_stdin_write_as_user(
    user: &str,
    password: &str,
    args: &[&str],
    content: &str,
) -> Value {
    use base64::Engine;
    let b64 = base64::engine::general_purpose::STANDARD.encode(content.as_bytes());
    let escaped_args: Vec<String> = args.iter().map(|a| shell_escape(a)).collect();
    let inner = format!("printf '{}' | base64 -d | {}", b64, escaped_args.join(" "));

    let res = sudo_as_user(user, password, &["sh", "-c", &inner]).await;
    if res.get("ok").is_some() {
        serde_json::json!({ "ok": true })
    } else {
        res
    }
}

/// Validate that a string is a safe Unix username (no shell metacharacters).
/// Values are passed as Command arguments (no shell involved), but validated
/// as a defence-in-depth measure.
pub fn is_valid_username(user: &str) -> bool {
    !user.is_empty()
        && user.len() <= 64
        && !user.starts_with('-')
        && user
            .chars()
            .all(|c| c.is_alphanumeric() || c == '_' || c == '-' || c == '.')
}

/// Return a "permission denied" error JSON if the caller's role is `readonly`.
///
/// Usage in write handlers:
/// ```ignore
/// if let Some(err) = require_admin(data) { return vec![...err...] }
/// ```
pub fn require_admin(data: &Value) -> Option<Value> {
    match data.get("_role").and_then(|v| v.as_str()) {
        Some("admin") => None,
        // Absent _role is denied, not granted — the gateway always injects it;
        // absence means an unexpected code path and must not silently grant admin.
        _ => Some(serde_json::json!({ "error": "permission denied" })),
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lookup_user_root_resolves() {
        // root always exists (uid/gid 0) — covers the NSS lookup path.
        let (uid, gid, _home, _shell) = lookup_user("root").expect("root must resolve");
        assert_eq!(uid, 0);
        assert_eq!(gid, 0);
    }

    #[test]
    fn lookup_user_missing_is_none() {
        assert!(lookup_user("no-such-user-9f3a2b1c").is_none());
    }

    #[tokio::test]
    async fn sudo_as_user_rejects_unknown_user() {
        // A user not present on this host is denied before sudo is ever spawned —
        // this is the per-host authorization gate. Runs without root.
        let res = sudo_as_user("no-such-user-9f3a2b1c", "", &["true"]).await;
        let err = res.get("error").and_then(|v| v.as_str()).unwrap_or("");
        assert!(err.contains("not present on this host"), "got: {res}");
        assert!(res.get("ok").is_none());
    }

    #[test]
    fn clean_sudo_stderr_strips_prompt_noise() {
        let raw = b"[sudo] password for bob: \nSorry, try again.\n";
        let out = clean_sudo_stderr(raw);
        assert!(out.contains("try again"));
        assert!(!out.contains("[sudo]"));
    }
}
