use serde_json::Value;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

// ── Command execution helpers ─────────────────────────────────
// Shared across multiple handler modules to avoid duplication.
//
// Every command the agent spawns goes through these helpers, so the same three
// guarantees hold everywhere: a wall-clock timeout, a cap on collected output,
// and a fixed minimal environment. The agent runs as root — an unbounded or
// environment-influenced child is a direct path to hanging or exhausting it.

/// Grace period between SIGTERM and SIGKILL when a command times out.
const KILL_GRACE: std::time::Duration = std::time::Duration::from_millis(500);

/// Wall-clock ceiling for any spawned command; on expiry the whole process group
/// is terminated.
///
/// This is a **safety net against hangs, not a functional limit** — it must stay
/// well above the slowest legitimate operation (`apt upgrade`, a large package
/// install, an image pull). Killing one of those mid-transaction would be far
/// worse than the hang it guards against. Override with
/// `TENODERA_CMD_TIMEOUT_SECS` when a host legitimately needs longer.
fn cmd_timeout() -> std::time::Duration {
    static V: std::sync::OnceLock<std::time::Duration> = std::sync::OnceLock::new();
    *V.get_or_init(|| {
        let secs = std::env::var("TENODERA_CMD_TIMEOUT_SECS")
            .ok()
            .and_then(|s| s.parse::<u64>().ok())
            .filter(|s| *s > 0)
            .unwrap_or(900);
        std::time::Duration::from_secs(secs)
    })
}

/// Cap on collected stdout (and, separately, stderr). A runaway command (`yes`,
/// an enormous journal) must not be able to exhaust the agent's memory. Output
/// past the cap is dropped and flagged. Override with `TENODERA_CMD_MAX_OUTPUT_MB`.
fn max_output_bytes() -> usize {
    static V: std::sync::OnceLock<usize> = std::sync::OnceLock::new();
    *V.get_or_init(|| {
        let mb = std::env::var("TENODERA_CMD_MAX_OUTPUT_MB")
            .ok()
            .and_then(|s| s.parse::<usize>().ok())
            .filter(|m| *m > 0)
            .unwrap_or(4);
        mb * 1024 * 1024
    })
}

/// Give a command a fixed, minimal environment.
///
/// The agent runs as root, so inheriting its environment would let anything that
/// influenced it (`PATH`, `LD_PRELOAD`, `LD_LIBRARY_PATH`, `BASH_ENV`, …) steer the
/// child. A fixed `PATH` makes helper lookup deterministic, and `C.UTF-8` pins the
/// locale so command output stays in the stable form the handlers parse.
fn harden_env(cmd: &mut tokio::process::Command, home: Option<&str>) {
    cmd.env_clear()
        .env("PATH", "/usr/sbin:/usr/bin:/sbin:/bin")
        .env("LANG", "C.UTF-8")
        .env("LC_ALL", "C.UTF-8");
    if let Some(h) = home {
        cmd.env("HOME", h);
    }
}

/// Put the child in its own session/process group **before** any privilege drop,
/// so a timeout can signal the whole tree — `sudo` *and* whatever it spawned —
/// rather than orphaning the real worker.
///
/// # Safety
/// `pre_exec` runs in the forked child between fork and exec; `setsid` is
/// async-signal-safe and the child is never a group leader at that point.
fn detach_process_group(cmd: &mut tokio::process::Command) {
    unsafe {
        cmd.pre_exec(|| {
            if libc::setsid() == -1 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
}

/// Read to EOF but never buffer more than `cap` bytes; stops early once the cap is
/// hit (the caller then kills the child, so it can't block forever on a full pipe).
async fn read_capped<R: tokio::io::AsyncRead + Unpin>(mut r: R, cap: usize) -> (Vec<u8>, bool) {
    let mut buf = Vec::new();
    let mut chunk = [0u8; 8192];
    loop {
        match r.read(&mut chunk).await {
            Ok(0) | Err(_) => return (buf, false),
            Ok(n) => {
                if buf.len() + n > cap {
                    let take = cap.saturating_sub(buf.len());
                    buf.extend_from_slice(&chunk[..take]);
                    return (buf, true);
                }
                buf.extend_from_slice(&chunk[..n]);
            }
        }
    }
}

/// Output of a command run under the agent's limits.
struct CappedOutput {
    status: std::process::ExitStatus,
    stdout: Vec<u8>,
    stderr: Vec<u8>,
    /// Output exceeded the size cap and was cut short.
    truncated: bool,
    /// The command hit the wall-clock timeout and was killed.
    timed_out: bool,
}

/// Collect a spawned child's output under the configured timeout and size caps.
async fn wait_capped(child: tokio::process::Child) -> std::io::Result<CappedOutput> {
    wait_capped_with(child, cmd_timeout(), max_output_bytes()).await
}

/// Core of [`wait_capped`], with the limits passed in so they can be tested.
///
/// Terminates the child's process group (TERM, then KILL after a grace period) if
/// it overruns, and always reaps the child.
async fn wait_capped_with(
    mut child: tokio::process::Child,
    timeout: std::time::Duration,
    cap: usize,
) -> std::io::Result<CappedOutput> {
    let pgid = child.id().map(|p| p as i32);
    let out_pipe = child.stdout.take();
    let err_pipe = child.stderr.take();

    let collect = async {
        let o = async {
            match out_pipe {
                Some(p) => read_capped(p, cap).await,
                None => (Vec::new(), false),
            }
        };
        let e = async {
            match err_pipe {
                Some(p) => read_capped(p, cap).await,
                None => (Vec::new(), false),
            }
        };
        tokio::join!(o, e)
    };

    let run = async {
        let ((so, so_cut), (se, se_cut)) = collect.await;
        let status = child.wait().await?;
        Ok::<_, std::io::Error>((status, so, se, so_cut || se_cut))
    };

    match tokio::time::timeout(timeout, run).await {
        Ok(Ok((status, stdout, stderr, truncated))) => Ok(CappedOutput {
            status,
            stdout,
            stderr,
            truncated,
            timed_out: false,
        }),
        Ok(Err(e)) => Err(e),
        Err(_) => {
            // Overran: signal the group so sudo's child dies with it, then reap.
            if let Some(pgid) = pgid {
                unsafe { libc::killpg(pgid, libc::SIGTERM) };
                tokio::time::sleep(KILL_GRACE).await;
                unsafe { libc::killpg(pgid, libc::SIGKILL) };
            }
            let status = child.wait().await?;
            Ok(CappedOutput {
                status,
                stdout: Vec::new(),
                stderr: Vec::new(),
                truncated: false,
                timed_out: true,
            })
        }
    }
}

/// Message surfaced when a command is killed for overrunning the timeout.
fn timeout_error() -> String {
    format!("command timed out after {}s", cmd_timeout().as_secs())
}

/// Run a command and return its stdout (falling back to stderr if stdout is empty).
pub async fn run_cmd(args: &[&str]) -> String {
    let Some((cmd, rest)) = args.split_first() else {
        return String::new();
    };
    let mut command = tokio::process::Command::new(cmd);
    command
        .args(rest)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    harden_env(&mut command, None);
    detach_process_group(&mut command);

    let child = match command.spawn() {
        Ok(c) => c,
        Err(e) => return format!("error: {e}"),
    };
    match wait_capped(child).await {
        Ok(out) if out.timed_out => format!("error: {}", timeout_error()),
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
    harden_env(&mut cmd, None);
    // Own process group first, so a timeout can kill sudo *and* the command it ran.
    detach_process_group(&mut cmd);

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

    match wait_capped(child).await {
        Ok(out) if out.timed_out => serde_json::json!({ "error": timeout_error() }),
        Ok(out) if out.status.success() => {
            let stdout = String::from_utf8_lossy(&out.stdout).trim().to_string();
            if out.truncated {
                serde_json::json!({ "ok": true, "output": stdout, "truncated": true })
            } else {
                serde_json::json!({ "ok": true, "output": stdout })
            }
        }
        Ok(out) => serde_json::json!({ "error": clean_sudo_stderr(&out.stderr) }),
        Err(e) => serde_json::json!({ "error": e.to_string() }),
    }
}

/// Outcome of running a read-only command dropped to a target user (no sudo, no
/// password). Lets callers distinguish "this user has no account here" (baseline
/// only) from a command that actually ran.
pub enum UserReadOutcome {
    /// The user is unknown to this host — the caller should surface a `restricted`
    /// result (only baseline, world-readable data is available to them).
    NoAccount,
    /// The command ran; inspect `.status` / `.stdout` / `.stderr`. A non-zero exit
    /// is still `Ran` — the kernel's own permission check, not a spawn failure.
    Ran(std::process::Output),
    /// The command could not be spawned (e.g. the privilege drop failed).
    SpawnFailed(String),
}

/// Run a read-only `args` **as `user`** by dropping privileges (initgroups → setgid →
/// setuid) in `pre_exec`, with **no sudo and no password**. The host's own file
/// permissions and group membership then decide what the user may read — exactly what
/// that user would see in their own shell session on the host. A user unknown to this
/// host yields [`UserReadOutcome::NoAccount`].
///
/// This is the read-side counterpart to [`sudo_as_user`]: same per-host authorization
/// gate, but without escalating — reads never prompt for a password.
pub async fn run_cmd_as_user(user: &str, args: &[&str]) -> UserReadOutcome {
    let Some((uid, gid, home, _shell)) = lookup_user(user) else {
        return UserReadOutcome::NoAccount;
    };
    let ucstr = match std::ffi::CString::new(user) {
        Ok(c) => c,
        Err(_) => return UserReadOutcome::SpawnFailed("invalid username".to_string()),
    };
    let Some((program, rest)) = args.split_first() else {
        return UserReadOutcome::SpawnFailed("no command".to_string());
    };

    let mut cmd = tokio::process::Command::new(program);
    cmd.args(rest)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    // Runs as the target user, so give them their own HOME alongside the fixed env.
    harden_env(&mut cmd, Some(&home));
    detach_process_group(&mut cmd);

    // pre_exec runs in the forked child before exec: drop to the target user so the
    // kernel enforces *their* access rights. gid before uid; initgroups pulls
    // supplementary groups so group-based ACLs (e.g. `adm` on the journal) apply.
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

    let child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => return UserReadOutcome::SpawnFailed(e.to_string()),
    };
    match wait_capped(child).await {
        Ok(out) if out.timed_out => UserReadOutcome::SpawnFailed(timeout_error()),
        Ok(out) => UserReadOutcome::Ran(std::process::Output {
            status: out.status,
            stdout: out.stdout,
            stderr: out.stderr,
        }),
        Err(e) => UserReadOutcome::SpawnFailed(e.to_string()),
    }
}

/// Run a read-only command AS THE USER via sudo and return its stdout, so the host
/// decides who may read privileged content. A refusal (wrong password, or the host's
/// rules denying the command) comes back as `error: <message>`, which callers already
/// treat as a failure.
pub async fn sudo_output_as_user(user: &str, password: &str, args: &[&str]) -> String {
    let res = sudo_as_user(user, password, args).await;
    match res.get("output").and_then(|v| v.as_str()) {
        Some(out) => out.to_string(),
        None => format!(
            "error: {}",
            res.get("error")
                .and_then(|v| v.as_str())
                .unwrap_or("command failed")
        ),
    }
}

/// Check if a command exists on `$PATH`.
pub async fn which(cmd: &str) -> bool {
    let mut command = tokio::process::Command::new("which");
    command
        .arg(cmd)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    // Fixed PATH matters most here: this is what decides whether a tool "exists".
    harden_env(&mut command, None);
    match tokio::time::timeout(cmd_timeout(), command.status()).await {
        Ok(Ok(s)) => s.success(),
        _ => false,
    }
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

    fn piped(program: &str, args: &[&str]) -> tokio::process::Child {
        let mut c = tokio::process::Command::new(program);
        c.args(args)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());
        harden_env(&mut c, None);
        detach_process_group(&mut c);
        c.spawn().expect("spawn")
    }

    #[tokio::test]
    async fn overrunning_command_is_killed_and_reported() {
        let started = std::time::Instant::now();
        let out = wait_capped_with(
            piped("sleep", &["120"]),
            std::time::Duration::from_millis(300),
            1024,
        )
        .await
        .expect("wait");
        assert!(out.timed_out, "expected the command to be killed");
        // Must not have waited anywhere near the sleep duration.
        assert!(started.elapsed() < std::time::Duration::from_secs(10));
    }

    #[tokio::test]
    async fn runaway_output_is_capped_not_buffered_forever() {
        // `yes` never ends and never stops writing — the cap must bound it.
        let out = wait_capped_with(
            piped("yes", &["flood"]),
            std::time::Duration::from_secs(20),
            4096,
        )
        .await
        .expect("wait");
        assert!(out.truncated, "expected output to be marked truncated");
        assert!(
            out.stdout.len() <= 4096,
            "buffered {} bytes, cap was 4096",
            out.stdout.len()
        );
    }

    #[tokio::test]
    async fn environment_is_replaced_not_inherited() {
        unsafe { std::env::set_var("TENODERA_TEST_LEAK", "leaked") };
        let out = run_cmd(&["env"]).await;
        assert!(
            !out.contains("TENODERA_TEST_LEAK"),
            "agent environment leaked into the child: {out}"
        );
        assert!(out.contains("PATH=/usr/sbin:/usr/bin:/sbin:/bin"));
    }

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

    #[tokio::test]
    async fn run_cmd_as_user_rejects_unknown_user() {
        // A user not present on this host yields NoAccount before anything is spawned —
        // the read-side per-host authorization gate. Runs without root.
        let res = run_cmd_as_user("no-such-user-9f3a2b1c", &["true"]).await;
        assert!(matches!(res, UserReadOutcome::NoAccount));
    }

    #[test]
    fn clean_sudo_stderr_strips_prompt_noise() {
        let raw = b"[sudo] password for bob: \nSorry, try again.\n";
        let out = clean_sudo_stderr(raw);
        assert!(out.contains("try again"));
        assert!(!out.contains("[sudo]"));
    }
}
