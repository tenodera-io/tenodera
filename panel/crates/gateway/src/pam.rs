use tokio::process::Command;

/// Result of a PAM authentication attempt.
#[derive(Debug)]
pub struct PamResult {
    pub success: bool,
    #[allow(dead_code)]
    pub user: String,
    pub error: Option<String>,
}

/// Authenticate a user via the PAM stack.
///
/// Uses `pam-client` to call `pam_authenticate()` + `pam_acct_mgmt()`
/// through the system PAM configuration. This works with all PAM-backed
/// identity sources: local `/etc/shadow`, FreeIPA/SSSD, LDAP, Kerberos,
/// etc.
///
/// The PAM service name is `login`, which uses the standard system
/// authentication policy (same as `su` / `ssh` on most distributions).
///
/// PAM calls are blocking, so we run them inside `spawn_blocking` to
/// avoid stalling the Tokio runtime.
pub async fn authenticate(user: &str, password: &str) -> PamResult {
    // Validate input: prevent injection through user field
    if user.is_empty() || user.contains('\0') || user.contains('\n') {
        return PamResult {
            success: false,
            user: user.to_string(),
            error: Some("invalid username".to_string()),
        };
    }

    let user_owned = user.to_string();
    let password_owned = password.to_string();

    let result = tokio::task::spawn_blocking(move || {
        pam_authenticate_blocking(&user_owned, &password_owned)
    })
    .await;

    match result {
        Ok(pam_result) => pam_result,
        Err(e) => {
            tracing::error!(error = %e, "PAM task panicked");
            PamResult {
                success: false,
                user: user.to_string(),
                error: Some("authentication failed".to_string()),
            }
        }
    }
}

/// Blocking PAM authentication — runs on a dedicated thread.
fn pam_authenticate_blocking(user: &str, password: &str) -> PamResult {
    use pam_client::{Context, Flag};
    use pam_client::conv_mock::Conversation;

    let conv = Conversation::with_credentials(user, password);
    let mut context = match Context::new("login", None, conv) {
        Ok(ctx) => ctx,
        Err(e) => {
            tracing::error!(error = %e, "failed to create PAM context");
            return PamResult {
                success: false,
                user: user.to_string(),
                error: Some("authentication failed".to_string()),
            };
        }
    };

    // Authenticate: verifies credentials via the PAM stack
    // (pam_unix for local, pam_sss for FreeIPA/SSSD, etc.)
    if let Err(e) = context.authenticate(Flag::NONE) {
        tracing::warn!(user = %user, error = %e, "PAM authentication failed");
        return PamResult {
            success: false,
            user: user.to_string(),
            error: Some("authentication failed".to_string()),
        };
    }

    // Account validation: check if account is locked, expired, etc.
    if let Err(e) = context.acct_mgmt(Flag::NONE) {
        tracing::warn!(user = %user, error = %e, "PAM account validation failed");
        return PamResult {
            success: false,
            user: user.to_string(),
            error: Some("account unavailable".to_string()),
        };
    }

    tracing::info!(user = %user, "PAM auth succeeded");
    PamResult {
        success: true,
        user: user.to_string(),
        error: None,
    }
}

/// Verify that the user has sudo privileges by running `sudo -l -U <user>`.
///
/// The gateway runs as root, so `sudo -l -U <user>` queries the sudoers
/// policy for the given user without requiring their password.  When the
/// user has NO sudo rights, the output contains "is not allowed to run sudo".
///
/// This ensures the authenticated user can actually perform privileged
/// operations (package management, firewall changes, etc.) rather than
/// failing later with cryptic "permission denied" errors.
///
/// Returns `Ok(())` on success or `Err(message)` on failure.
pub async fn verify_sudo(user: &str) -> Result<(), String> {
    let output = Command::new("sudo")
        .args(["-l", "-U", user])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .output()
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "sudo check process failed");
            "unable to verify user privileges".to_string()
        })?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);

    // sudo -l -U prints "User X is not allowed to run sudo on <host>."
    // when the user has no sudoers entries.
    if stdout.contains("is not allowed to run sudo")
        || stderr.contains("is not allowed to run sudo")
    {
        tracing::warn!(user = %user, "user has no sudo privileges");
        return Err("user does not have sudo privileges".to_string());
    }

    tracing::info!(user = %user, "sudo access verified");
    Ok(())
}
