//! tenodera-pam-helper — isolated PAM authentication helper.
//!
//! Reads a username and password from stdin (one line each) and
//! authenticates via the PAM stack using the "login" service.
//!
//! Exit codes:
//!   0 — authentication succeeded
//!   1 — authentication failed (bad credentials)
//!   2 — account unavailable (locked, expired, etc.)
//!   3 — usage / input error
//!   4 — PAM internal error
//!
//! This runs as a separate process so that any crash in the PAM
//! C library (e.g. pam_sss.so SEGFAULT) kills only the helper,
//! not the gateway.
//!
//! Stdin format (two lines, no trailing newline required):
//!   username\n
//!   password\n

use std::io::BufRead;

use pam_client::conv_mock::Conversation;
use pam_client::{Context, Flag};

fn main() {
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

    // Create PAM context with mock conversation (non-interactive)
    let conv = Conversation::with_credentials(&user, &password);
    let mut context = match Context::new("login", None, conv) {
        Ok(ctx) => ctx,
        Err(e) => {
            eprintln!("pam_start failed: {e}");
            std::process::exit(4);
        }
    };

    // Authenticate: verifies credentials via the full PAM stack
    // (pam_unix for local, pam_sss for FreeIPA/SSSD, etc.)
    if let Err(e) = context.authenticate(Flag::NONE) {
        eprintln!("authentication failed: {e}");
        std::process::exit(1);
    }

    // Account validation: check if account is locked, expired, etc.
    if let Err(e) = context.acct_mgmt(Flag::NONE) {
        eprintln!("account unavailable: {e}");
        std::process::exit(2);
    }

    // Success — exit 0
}
