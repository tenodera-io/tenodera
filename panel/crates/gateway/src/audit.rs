use std::fs::OpenOptions;
use std::io::Write;
use std::os::unix::fs::OpenOptionsExt;

const AUDIT_LOG: &str = "/var/log/tenodera_audit.log";

/// Sanitize a field value for audit log output.
/// Replaces newlines and carriage returns to prevent log injection.
fn sanitize(s: &str) -> String {
    s.replace('\n', "\\n").replace('\r', "\\r")
}

/// Write a single audit line to the audit log file and emit via tracing.
///
/// The tracing emission ensures audit events reach journald when running
/// under systemd, providing tamper-resistant log storage separate from
/// the plaintext file.
pub fn log(user: &str, action: &str, target: &str, ok: bool, details: &str) {
    let ts = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
    let result = if ok { "ok" } else { "fail" };

    let user = sanitize(user);
    let action = sanitize(action);
    let target = sanitize(target);
    let details = sanitize(details);

    let line = format!(
        "[{ts}] user={user} action={action} target={target} result={result} details={details}\n"
    );

    // Emit via tracing → captured by journald under systemd
    tracing::info!(
        audit = true,
        audit_user = %user,
        audit_action = %action,
        audit_target = %target,
        audit_result = %result,
        audit_details = %details,
        "AUDIT"
    );

    // Also write to dedicated audit log file
    match OpenOptions::new()
        .create(true)
        .append(true)
        .mode(0o600)
        .open(AUDIT_LOG)
    {
        Ok(mut f) => {
            if let Err(e) = f.write_all(line.as_bytes()) {
                tracing::warn!(error = %e, "failed to write audit log to {}", AUDIT_LOG);
            }
        }
        Err(e) => {
            tracing::warn!(error = %e, "failed to open audit log {}", AUDIT_LOG);
        }
    }
}
