use std::os::unix::process::ExitStatusExt;

use tokio::process::Command;

/// Result of a PAM authentication attempt.
#[derive(Debug)]
pub struct PamResult {
    pub success: bool,
    pub error: Option<String>,
}

/// Authenticate a user via the PAM stack.
///
/// Spawns the `tenodera-pam-helper` binary as a **separate process**,
/// passing the username and password on its stdin. The helper calls
/// `pam_authenticate()` + `pam_acct_mgmt()` through libpam and exits
/// with a status code indicating the result.
///
/// Running PAM in a child process provides complete isolation: if the
/// PAM C library or an SSSD module (pam_sss.so) crashes, only the
/// helper process dies — the gateway remains unaffected.
///
/// Exit codes from the helper:
///   0 — success
///   1 — authentication failed (bad credentials)
///   2 — account unavailable (locked / expired)
///   3 — usage / input error
///   4 — PAM internal error
pub async fn authenticate(user: &str, password: &str) -> PamResult {
    // Validate input: prevent injection through user field
    if user.is_empty() || user.contains('\0') || user.contains('\n') {
        return PamResult {
            success: false,
            error: Some("invalid username".to_string()),
        };
    }

    if password.contains('\0') || password.contains('\n') {
        return PamResult {
            success: false,
            error: Some("invalid password".to_string()),
        };
    }

    let helper_bin = std::env::var("TENODERA_PAM_HELPER")
        .unwrap_or_else(|_| "tenodera-pam-helper".to_string());

    let mut child = match Command::new(&helper_bin)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true)
        .spawn()
    {
        Ok(c) => c,
        Err(e) => {
            tracing::error!(error = %e, bin = %helper_bin, "failed to spawn PAM helper");
            return PamResult {
                success: false,
                error: Some("authentication service unavailable".to_string()),
            };
        }
    };

    // Write username and password to helper's stdin
    if let Some(mut stdin) = child.stdin.take() {
        use tokio::io::AsyncWriteExt;
        let input = format!("{user}\n{password}\n");
        if let Err(e) = stdin.write_all(input.as_bytes()).await {
            tracing::error!(error = %e, "failed to write to PAM helper stdin");
            let _ = child.kill().await;
            return PamResult {
                success: false,
                error: Some("authentication service unavailable".to_string()),
            };
        }
        // Drop stdin to close the pipe — helper reads EOF
        drop(stdin);
    }

    // Wait for the helper to exit (with timeout).
    // Note: wait_with_output() consumes child, so we grab the PID first
    // for potential kill-on-timeout. kill_on_drop(true) above ensures
    // cleanup if we drop the child without waiting.
    let child_id = child.id();
    let result = tokio::time::timeout(
        std::time::Duration::from_secs(30),
        child.wait_with_output(),
    )
    .await;

    match result {
        Ok(Ok(output)) => {
            let code = output.status.code().unwrap_or(255);
            let stderr = String::from_utf8_lossy(&output.stderr)
                .trim()
                .to_string();

            match code {
                0 => {
                    tracing::info!(user = %user, "PAM auth succeeded (via helper)");
                    PamResult {
                        success: true,
                        error: None,
                    }
                }
                1 => {
                    tracing::warn!(user = %user, "PAM authentication failed (via helper)");
                    PamResult {
                        success: false,
                        error: Some("authentication failed".to_string()),
                    }
                }
                2 => {
                    tracing::warn!(user = %user, stderr = %stderr, "PAM account unavailable");
                    PamResult {
                        success: false,
                        error: Some("authentication failed".to_string()),
                    }
                }
                _ => {
                    // Exit by signal (e.g. SEGFAULT in pam_sss.so) — code is None,
                    // mapped to 255 above. Log the signal for debugging.
                    if let Some(signal) = output.status.signal() {
                        tracing::error!(user = %user, signal = signal, "PAM helper killed by signal");
                    } else {
                        tracing::error!(user = %user, code = code, stderr = %stderr, "PAM helper error");
                    }
                    PamResult {
                        success: false,
                        error: Some("authentication failed".to_string()),
                    }
                }
            }
        }
        Ok(Err(e)) => {
            tracing::error!(error = %e, "PAM helper process error");
            PamResult {
                success: false,
                error: Some("authentication service unavailable".to_string()),
            }
        }
        Err(_) => {
            tracing::error!(user = %user, "PAM helper timed out (30s)");
            // kill_on_drop handles cleanup; also try explicit kill via PID
            if let Some(pid) = child_id {
                unsafe { libc::kill(pid as i32, libc::SIGKILL); }
            }
            PamResult {
                success: false,
                error: Some("authentication timed out".to_string()),
            }
        }
    }
}

/// Verify that the user has sudo privileges by running `sudo -l -U <user>`.
///
/// The gateway runs as root, so `sudo -l -U <user>` queries the sudoers
/// policy for the given user without requiring their password.
///
/// Primary check: exit code (0 = has privileges, non-zero = denied).
/// Secondary (fallback): scan output for "is not allowed" in case the
/// exit code is unreliable on exotic sudo builds.
///
/// Returns `Ok(())` on success or `Err(message)` on failure.
pub async fn verify_sudo(user: &str) -> Result<(), String> {
    let output = tokio::time::timeout(
        std::time::Duration::from_secs(30),
        Command::new("sudo")
            .args(["-l", "-U", user])
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .output(),
    )
    .await
    .map_err(|_| {
        tracing::error!(user = %user, "sudo check timed out (30s)");
        "sudo verification timed out".to_string()
    })?
    .map_err(|e| {
        tracing::error!(error = %e, "sudo check process failed");
        "unable to verify user privileges".to_string()
    })?;

    // Primary check: exit code. sudo -l -U exits 0 when the user has
    // at least one allowed command, non-zero otherwise.
    if !output.status.success() {
        tracing::warn!(
            user = %user,
            code = ?output.status.code(),
            "user has no sudo privileges (exit code)"
        );
        return Err("user does not have sudo privileges".to_string());
    }

    // Secondary check: even with exit 0, verify the output doesn't
    // contain denial text (belt-and-suspenders for unusual sudo configs).
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);

    if stdout.contains("is not allowed")
        || stderr.contains("is not allowed")
    {
        tracing::warn!(user = %user, "user has no sudo privileges (output text)");
        return Err("user does not have sudo privileges".to_string());
    }

    tracing::info!(user = %user, "sudo access verified");
    Ok(())
}
