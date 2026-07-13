//! tenodera-pam-helper — isolated privileged helper for the gateway.
//!
//! Runs setuid root so the gateway can spawn it as a non-root user.
//! Handles two privileged operations:
//!
//! ## Mode 1: PAM authentication (default)
//!
//! Reads username and password from stdin, authenticates via PAM stack.
//!
//! Stdin format:  username\n  password\n
//!
//! Exit codes:
//!   0 — authentication succeeded
//!   1 — authentication failed (bad credentials)
//!   2 — account unavailable (locked, expired, etc.)
//!   3 — usage / input error
//!   4 — PAM internal error
//!
//! ## Mode 2: sudo privilege check (--check-sudo <user>)
//!
//! Verifies whether <user> has sudo privileges by running `sudo -l -U <user>`
//! as root (requires this binary to be setuid root).
//!
//! Exit codes:
//!   0 — user has sudo privileges
//!   1 — user does not have sudo privileges
//!   3 — invalid username argument
//!   4 — sudo check failed (internal error)

use std::io::BufRead;

use pam_client::conv_mock::Conversation;
use pam_client::{Context, Flag};

fn main() {
    let args: Vec<String> = std::env::args().collect();

    if args.len() == 3 && args[1] == "--check-sudo" {
        check_sudo_mode(&args[2]);
    } else {
        pam_auth_mode();
    }
}

/// Mode 2: verify sudo privileges for <user> by running `sudo -l -U <user>` as root.
fn check_sudo_mode(user: &str) {
    if user.is_empty()
        || user
            .bytes()
            .any(|b| matches!(b, 0 | b'\n' | b' ' | b';' | b'&' | b'|' | b'`' | b'$'))
    {
        eprintln!("error: invalid username for sudo check");
        std::process::exit(3);
    }

    let output = match std::process::Command::new("sudo")
        .args(["-l", "-U", user])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .output()
    {
        Ok(o) => o,
        Err(e) => {
            eprintln!("error: failed to run sudo: {e}");
            std::process::exit(4);
        }
    };

    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);

    if !output.status.success()
        || stdout.contains("is not allowed")
        || stderr.contains("is not allowed")
    {
        std::process::exit(1);
    }

    std::process::exit(0);
}

/// Mode 1: PAM authentication — reads username/password from stdin.
fn pam_auth_mode() {
    let stdin = std::io::stdin();
    let mut lines = stdin.lock().lines();

    let user = match lines.next() {
        Some(Ok(u)) if !u.is_empty() => u,
        _ => {
            eprintln!("error: expected username on first line of stdin");
            std::process::exit(3);
        }
    };

    let password = match lines.next() {
        Some(Ok(p)) => p,
        _ => {
            eprintln!("error: expected password on second line of stdin");
            std::process::exit(3);
        }
    };

    let conv = Conversation::with_credentials(&user, &password);
    let mut context = match Context::new("tenodera", None, conv) {
        Ok(ctx) => ctx,
        Err(e) => {
            eprintln!("pam_start failed: {e}");
            std::process::exit(4);
        }
    };

    if let Err(e) = context.authenticate(Flag::NONE) {
        eprintln!("authentication failed: {e}");
        std::process::exit(1);
    }

    if let Err(e) = context.acct_mgmt(Flag::NONE) {
        eprintln!("account unavailable: {e}");
        std::process::exit(2);
    }
}
