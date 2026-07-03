# Security Analysis — Tenodera Admin Panel

**Date:** 2026-07-02  
**Scope:** Full codebase — gateway, PAM helper, agent handlers, protocol layer, frontend  
**Method:** Manual code review, no dynamic testing

---

## Summary

The codebase has a solid security foundation: PAM isolation, array-based command execution throughout, CSRF protection, rate limiting, gateway-injected identity, home-directory containment, and audit logging. One command injection vulnerability was found in the certificate verification handler. Several medium-severity issues exist around temporary file handling and agent authentication. The remainder are informational notes or accepted design trade-offs.

---

## Findings

### HIGH — Command injection in `verify_host()` via hostname

**File:** `agent/src/handlers/certs.rs:526`

```rust
let out = tokio::process::Command::new("sh")
    .args(["-c", &format!(
        "echo | openssl s_client -connect {connect} -verify_return_error -brief 2>&1 | head -30"
    )])
```

The hostname check at line 519 filters only `/`, `\`, `\n`, `\r`. Shell metacharacters `&`, `;`, `|`, `` ` ``, `$`, `(` are not filtered. Since `connect = format!("{hostname}:{port}")` and port is a validated `u16`, the hostname is the injection vector.

**Example payload:** host = `"x;id>/tmp/pwn"` → executes `id` on the agent host.

**Access requirement:** Admin-only (guarded by `require_admin()`), but a session hijack or future accidental removal of that check would result in unauthenticated RCE on the managed host.

**Fix:** Replace `sh -c` with a no-shell invocation:

```rust
tokio::process::Command::new("openssl")
    .args(["s_client", "-connect", &connect, "-verify_return_error", "-brief"])
    .stdin(Stdio::piped())  // pipe `echo` equivalent
    ...
```

Pipe the chain to `head` separately or just limit output by reading at most N bytes.

---

### MEDIUM — Private key written to world-readable `/tmp`

**File:** `agent/src/handlers/certs.rs:592`

```rust
let key_path = format!("/tmp/tenodera-selfsigned-{pid}.key");
```

The generated private key lands in `/tmp` with mode determined by the process umask (default 0022 → `rw-r--r--`). Other local users can read it before the cleanup at lines 619–620. Using `mkstemp` or creating the file with mode 0600 before writing would fix this.

**Affected paths:** `generate_selfsigned()`, `parse_pem_input()`, `cert_check()`, `trust_add()` (Arch branch).

**Fix:** Use `tokio::fs::OpenOptions::new().mode(0o600).create_new(true)` (or `tempfile` crate) for all `/tmp` certificate and key files.

---

### ~~MEDIUM — Agent identity is unauthenticated~~ **FIXED**

**Fixed in:** `panel/crates/gateway/src/agent_auth.rs`, `agent/src/identity.rs`, `protocol/src/auth.rs`

Each agent now generates a persistent Ed25519 key pair on first start (stored in `/var/lib/tenodera/identity.key`). On every WebSocket connect the gateway issues a 32-byte random challenge; the agent signs it with its private key; the gateway verifies the signature against the stored public key. Unknown keys enter a pending state requiring admin approval (TOFU — Trust on First Use). Bootstrap tokens are available for unattended enrollment. Impersonating a host requires possession of its private key.

---

### MEDIUM — `trust_remove()` path check does not canonicalize

**File:** `agent/src/handlers/certs.rs:414`

```rust
let allowed_prefixes = [
    "/usr/local/share/ca-certificates/",
    "/etc/pki/ca-trust/source/anchors/",
    "/etc/ca-certificates/trust-source/anchors/",
];
if !allowed_prefixes.iter().any(|pfx| path.starts_with(pfx)) { … }
if path.contains("..") { … }
```

The string-based `starts_with` check does not resolve symlinks. If the trust store directory itself contains a symlink pointing outside the trust store (e.g., `/usr/local/share/ca-certificates/evil → /etc/shadow`), a `rm -f` via this handler would silently delete the target. The `..` check prevents directory traversal via `..` components but not via symlinks.

**Fix:** Canonicalize the supplied path and verify the canonical form starts with the allowed directory, consistent with how `file_ops.rs` and `packages.rs` handle path safety.

---

### LOW — `require_admin()` treats absent `_role` as admin

**File:** `agent/src/util.rs`

```rust
let role = data.get("_role").and_then(|v| v.as_str());
if role.is_none() || role == Some("admin") {
    return None; // no error = proceed
}
```

Missing `_role` grants admin access. This is intentional — the gateway always injects `_role`, so absence means the message came through an unexpected path. However, any future direct agent access, protocol bug, or handler that omits the injection would silently grant admin. The safer default would be to treat missing `_role` as unauthorized.

---

### LOW — Streaming channel Data messages bypass `_role` injection

**File:** `agent/src/router.rs:131`

For streaming channels, `channel_options` has no entry, so the enrichment block at line 141 is skipped: `data` is forwarded as-is without `_user`/`_role`. Current streaming handlers (metrics, network stats, storage) do not call `require_admin()` in their `data()` methods, so there is no current impact. If a future streaming handler adds admin-protected operations in `data()`, those checks would silently pass because `_role` would not be present and `require_admin()` treats its absence as admin.

---

### LOW — Temporary certificate files use predictable paths

**Files:** `certs.rs:454`, `certs.rs:482`, `certs.rs:394`

```rust
let tmp = format!("/tmp/tenodera-parse-{}.pem", std::process::id());
```

PID is predictable by a local attacker. An attacker who can create symlinks in `/tmp` before the agent runs can redirect file writes. In practice the agent runs as root, so `/tmp` files it creates are owned root:root by default and the symlink attack would be against itself. Still, use `tempfile::NamedTempFile` to eliminate the race.

---

### INFO — Install scripts perform no integrity verification

**Files:** `tenodera.sh`, `tenodera-agent.sh`

```
curl -sSfL https://raw.githubusercontent.com/…/tenodera.sh | sudo bash
```

The scripts are downloaded over HTTPS (TLS protects against network MITM) but there is no SHA256 or GPG signature check. A compromised GitHub account or repository would deliver malicious scripts as root. This is the standard trade-off for `curl|bash` installers.

---

### INFO — `unsafe-inline` in Content Security Policy

**File:** `panel/crates/gateway/src/security_headers.rs`

The CSP header includes `style-src 'self' 'unsafe-inline'`. This is required by React inline styles and is a known limitation. It reduces the CSP's XSS protection for CSS-based injection but does not affect script injection (no `script-src unsafe-inline`).

---

### INFO — Session token in `sessionStorage` is accessible to JavaScript

**File:** `panel/ui/src/api/transport.ts:78`

`sessionStorage.getItem('session_id')` is accessible to any JavaScript running on the page. XSS could exfiltrate the session token. Mitigations already in place: HSTS, X-Frame-Options: DENY, X-Content-Type-Options, CSP without `script-src unsafe-inline`. No `httpOnly` cookie alternative is feasible with the current WebSocket auth design.

---

### INFO — Superuser password in React context (in-memory)

**Files:** `api/SuperuserContext.tsx`, `api/secureStorage.ts`

The verified superuser password is held in React context memory for the duration of the session. On HTTPS, it is encrypted (AES-GCM 256-bit non-extractable key) in IndexedDB before being stored in sessionStorage. The in-memory representation is unavoidable for a web app that needs to re-send it per-operation. The key is marked non-extractable and `sessionStorage` is cleared on tab close.

---

### INFO — `sudo_run_cmd` duplicates logic from `util::sudo_action`

**File:** `agent/src/handlers/networking.rs:995`

The function duplicates the `sudo -S` password-passing pattern from `util.rs`. No security impact today, but a future fix to the pattern in `util.rs` (e.g., adding a timeout, switching to ZeroizeOnDrop) would need to be replicated manually.

---

## What works well

| Area | Mechanism |
|------|-----------|
| PAM authentication | Isolated setuid subprocess; no password on command line |
| Command execution | Array-based exec throughout; no `sh -c` except `verify_host` (finding above) and safe base64 scripts |
| Identity injection | Gateway injects `_user`/`_role`; agent trusts only stored channel options |
| Authorization | `require_admin()` on all write handlers; read-only paths explicitly excluded |
| Input validation | Package names, usernames, paths, ports, protocols, service names all validated |
| `--` separator | Used before all user-controlled filenames and package names (dnf excepted — compensated by strict name validation) |
| Home-dir containment | Limited access restricted to `/home/<user>` via `canonicalize()` + prefix check |
| Rate limiting (gateway) | 20 attempts per 5 min, sliding window, atomic check-and-record |
| Rate limiting (agent) | `superuser.verify`: 6 attempts per 15 min per user |
| CSRF protection | Origin/Referer validation on all mutating HTTP methods |
| Security headers | HSTS 2y+subdomains (TLS), CSP, X-Frame-Options, Referrer-Policy, Permissions-Policy, Cache-Control: no-store on /api/ |
| Session lifecycle | UUID v4, idle 900s, max 4h, background reaper; WS checks expiry every 5s |
| Terminal security | 8-path shell allowlist, PTY drop to user UID/GID via `setuid`/`setgid`/`initgroups()` |
| Audit logging | Structured log to journald + `/var/log/tenodera_audit.log` (0600); log-injection-safe |
| Superuser password storage | AES-GCM 256-bit non-extractable key; only ciphertext in sessionStorage |
| Cert/trust path restrictions | `trust_remove` checks allowed prefix list; `cert_save` sanitizes name chars; `chmod 600` on saved key |
| Repository path canonicalization | APT (`/etc/apt/sources.list.d/`) and DNF (`/etc/yum.repos.d/`) both canonicalize before removal |
| Cron path restriction | `is_safe_cron_path()` allows only `/etc/crontab` and `/etc/cron.d/<alphanum>` |
| Host keyscan | Address validated to alphanumeric + `.-:[]` before ssh-keyscan |
| Firewall rules | Port (numeric), protocol (enum), IP/CIDR, service name all validated before passing to firewall commands |
