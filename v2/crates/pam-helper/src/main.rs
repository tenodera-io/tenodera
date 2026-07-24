//! Tenodera v2 pam-helper (ADR-0004).
//!
//! Verifies a control-plane login password via **PAM**, so the server never needs
//! shadow/PAM access itself: the unprivileged server invokes this small helper
//! (one NOPASSWD sudoers rule), which does the PAM conversation and exits 0 on
//! success / 1 on failure. PAM is the delegation point for local accounts, SSSD,
//! and FreeIPA — Tenodera stores no password material of its own.
//!
//! Usage:  pam-helper <service> <username>   (password on stdin)
//! Exit:   0 = authenticated, 1 = rejected, 2 = usage/internal error.

use std::io::Read;

use zeroize::Zeroizing;

fn main() {
    let mut args = std::env::args().skip(1);
    let (service, user) = match (args.next(), args.next()) {
        (Some(s), Some(u)) if !s.is_empty() && !u.is_empty() => (s, u),
        _ => {
            eprintln!("usage: pam-helper <service> <username>  (password on stdin)");
            std::process::exit(2);
        }
    };

    // Password from stdin; kept in a Zeroizing buffer and wiped on drop.
    let mut buf = Zeroizing::new(String::new());
    if std::io::stdin().read_to_string(&mut buf).is_err() {
        std::process::exit(2);
    }
    let password = Zeroizing::new(buf.trim_end_matches(['\n', '\r']).to_string());

    std::process::exit(if authenticate(&service, &user, &password) {
        0
    } else {
        1
    });
}

/// Real PAM auth: PAM checks the password against the account database (pam_unix
/// shadow, SSSD, FreeIPA, …) as configured for `service`. Any error = rejected.
fn authenticate(service: &str, user: &str, password: &str) -> bool {
    match pam::Authenticator::with_password(service) {
        Ok(mut auth) => {
            auth.get_handler().set_credentials(user, password);
            auth.authenticate().is_ok()
        }
        Err(_) => false,
    }
}
