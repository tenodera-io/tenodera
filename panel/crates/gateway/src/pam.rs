use tokio::process::Command;

/// Result of a PAM authentication attempt.
#[derive(Debug)]
pub struct PamResult {
    pub success: bool,
    #[allow(dead_code)]
    pub user: String,
    pub error: Option<String>,
}

/// Authenticate a user via the unix_chkpwd PAM helper.
///
/// `unix_chkpwd` is a setuid helper shipped with pam_unix on virtually
/// all Linux distributions. It reads the password from stdin (a single
/// line terminated by NUL or newline) and exits 0 on success.
///
/// This avoids the problem with `su` which requires a real TTY.
pub async fn authenticate(user: &str, password: &str) -> PamResult {
    // Validate input: prevent injection through user field
    if user.is_empty() || user.contains('\0') || user.contains('\n') {
        return PamResult {
            success: false,
            user: user.to_string(),
            error: Some("invalid username".to_string()),
        };
    }

    // unix_chkpwd <user> nullok
    // Reads password from stdin, verifies against /etc/shadow
    let result = Command::new("unix_chkpwd")
        .args([user, "nullok"])
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped())
        .spawn();

    let mut child = match result {
        Ok(c) => c,
        Err(e) => {
            tracing::error!(error = %e, "failed to spawn unix_chkpwd");
            return PamResult {
                success: false,
                user: user.to_string(),
                error: Some(format!("auth process failed: {e}")),
            };
        }
    };

    // Write password + NUL to stdin (unix_chkpwd expects NUL-terminated)
    if let Some(mut stdin) = child.stdin.take() {
        use tokio::io::AsyncWriteExt;
        let _ = stdin.write_all(format!("{password}\0").as_bytes()).await;
        drop(stdin);
    }

    match child.wait().await {
        Ok(status) if status.success() => {
            tracing::info!(user = %user, "PAM auth succeeded");
            PamResult {
                success: true,
                user: user.to_string(),
                error: None,
            }
        }
        Ok(status) => {
            tracing::warn!(user = %user, code = ?status.code(), "PAM auth failed");
            PamResult {
                success: false,
                user: user.to_string(),
                error: Some("authentication failed".to_string()),
            }
        }
        Err(e) => {
            tracing::error!(user = %user, error = %e, "auth process error");
            PamResult {
                success: false,
                user: user.to_string(),
                error: Some(format!("auth process error: {e}")),
            }
        }
    }
}
