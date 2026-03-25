use std::path::Path;
use std::sync::OnceLock;

/// Resolved absolute path to `unix_chkpwd`.
///
/// On Debian/Ubuntu it lives in `/usr/sbin/` which is NOT in `$PATH`
/// for non-root users.  We probe the common locations once at startup
/// and cache the result.
static UNIX_CHKPWD: OnceLock<Option<&'static str>> = OnceLock::new();

const CANDIDATES: &[&str] = &[
    "/usr/sbin/unix_chkpwd",
    "/sbin/unix_chkpwd",
    "/usr/bin/unix_chkpwd",
    "/bin/unix_chkpwd",
];

pub fn unix_chkpwd_path() -> Option<&'static str> {
    *UNIX_CHKPWD.get_or_init(|| CANDIDATES.iter().find(|p| Path::new(p).exists()).copied())
}
