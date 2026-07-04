# Security

## Reporting a Vulnerability

If you discover a security vulnerability:

- **Do not** disclose it publicly before a fix is available
- Report via GitHub Private Vulnerability Reporting (Security tab), or via GitHub Issues for non-critical findings

Include a description, steps to reproduce, and potential impact. Fixes are provided on a best-effort basis with no guaranteed timeline.

---

## Built-in Security Features

### Authentication

- **PAM authentication** via an isolated `tenodera-pam-helper` subprocess — the gateway never calls PAM directly; all credential handling is confined to the subprocess
- **Admin role determination** at login: `getpwnam_r` + `getgrouplist` + `getgrgid_r` (the full NSS stack) checks group membership against `sudo`, `wheel`, and `admin`; LDAP/SSSD/FreeIPA groups are resolved transparently via NSS — no `sudo` process is spawned
- **Login rate limiting**: per-IP sliding window (default: 20 attempts per 5 minutes) — blocks brute-force attacks
- **Session idle timeout**: sessions expire after 900 seconds of inactivity (configurable)
- **Maximum session lifetime**: 4 hours regardless of activity
- **Authenticated logout**: requires `Authorization: Bearer <session_id>` matching the request body

### Memory Safety

- Superuser passwords (entered in the UI for `sudo -S` operations) are held in `sessionStorage` client-side and transmitted per-request; the gateway does not persist them across requests
- **Core dumps are disabled** at gateway startup (`setrlimit(RLIMIT_CORE, 0)`) to prevent session state leaking into crash files

### Transport

- **TLS required by default** — the gateway refuses to start without a certificate unless `TENODERA_ALLOW_UNENCRYPTED=1` is explicitly set (development only)
- **HSTS** (`Strict-Transport-Security: max-age=63072000; includeSubDomains`) is sent on every HTTPS response — browsers will enforce HTTPS for the origin for ~2 years
- **WebSocket Origin validation**: the browser WS connection is rejected if the `Origin` header does not match the `Host` header, preventing cross-site WebSocket hijacking (CSWSH)
- **CSRF protection**: all mutating HTTP requests (POST/PUT/DELETE/PATCH) require a matching `Origin` or `Referer` header; requests with neither header are rejected

### HTTP Security Headers

Every response includes:

- `Content-Security-Policy` — restricts script/style/connect sources
- `Strict-Transport-Security` — HSTS (TLS mode only)
- `X-Frame-Options: DENY` — prevents clickjacking
- `X-Content-Type-Options: nosniff`
- `Referrer-Policy: strict-origin-when-cross-origin`
- `Permissions-Policy` — disables camera, microphone, geolocation

### Agent Authentication (Ed25519 TOFU)

Each agent generates a persistent Ed25519 key pair on first start. Authentication follows a challenge-response protocol:

1. Agent sends `Hello` with its public key (Base64-encoded)
2. Gateway issues a 32-byte random nonce (`Challenge`)
3. Agent signs `nonce || hostname || gateway_id` with its private key and returns the signature (`ChallengeResponse`)
4. Gateway verifies the signature against the stored (or presented) public key

**Authentication paths:**

| Path | Condition | Outcome |
|------|-----------|---------|
| 1 | Public key matches a stored enrolled host | Authenticated immediately |
| 2 | Known hostname but different public key, valid re-enroll token | Key replaced, authenticated |
| 2 (fail) | Known hostname, different key, no valid re-enroll token | **SECURITY ALERT** logged, connection closed |
| 3 | New host, valid bootstrap token | Auto-enrolled, authenticated |
| 3b | New host, loopback address (127.0.0.1/::1) | Auto-enrolled as local host |
| 4 | New host, no token, not loopback | Enters **pending** state for admin approval |

**Key-mismatch detection:** if a known hostname presents an unknown public key without a valid re-enroll token, the gateway logs a `SECURITY ALERT` with both fingerprints and drops the connection immediately. This detects impersonation and MITM attempts.

**Pending registry DoS prevention:** the gateway caps simultaneous pending agents at 100 (`MAX_PENDING`). New connections beyond this limit are rejected.

**Bootstrap tokens:** single-use or TTL-bound tokens used for unattended enrollment. A token can optionally be bound to a specific hostname. Re-enroll tokens allow key rotation for already-enrolled hosts.

### Authorization

- The gateway injects `_user` (session username) and `_role` (session role) into every channel `Open` and subsequent `Data` message before forwarding to the agent — the agent never trusts client-supplied identity
- Admin-only operations (firewall changes, user management, package install, host restart, etc.) are gated by `require_admin()` on the agent side, which checks the gateway-injected `_role`
- Missing `_role` in a handler payload is treated as unauthorized — any message that bypasses gateway injection is denied by default
- Read-only users can observe but cannot execute any write operation
- **Exception:** `GET /api/hosts/{id}/user-check` is a gateway-only REST endpoint; it sends a `users.manage` channel request internally (`execute_rpc`) using the session username directly — no `_user`/`_role` injection applies since the agent's `check_exists` action requires no privileges

### Terminal Security

- The agent binary is installed **setuid root** (`-m 4755`); it drops to the authenticated user's UID/GID via `setuid()`/`setgid()` before spawning the shell — no root shell is ever exposed to the user
- **Shell allowlist**: only the following shells may be spawned — `/bin/sh`, `/bin/bash`, `/bin/zsh`, `/bin/fish`, and their `/usr/bin/` equivalents; any other shell path (including the user's configured shell if not on the list) causes the terminal session to be rejected
- The terminal requires a valid system account on the managed host; if the logged-in user does not exist on that host, the PAM/setuid drop will fail

### File Access

- **Limited mode** (no superuser password): the agent restricts all file operations (list, read, write, create, delete) to the authenticated user's home directory (`/home/<user>`); paths are resolved with `canonicalize()` before the prefix check — symlinks inside `~` that point outside are blocked
- **Administrative mode** (superuser password active): full filesystem access via `sudo`
- `symlink_metadata()` is used in directory listings to prevent symlink traversal attacks

### Input Validation

- Firewall rule inputs (IP/CIDR, port, protocol, service name) are validated before passing to ufw/firewalld/nftables
- DNS lookup inputs are validated against a safe hostname allowlist before invoking `dig`
- Certificate and TLS operations invoke `openssl` directly via argument arrays — no `sh -c`, no shell metacharacter injection possible
- Temporary files for certificate operations use 64-bit random suffixes and `O_EXCL` + mode `0o600` — prevents predictable-path symlink attacks and world-readable private key exposure
- Trust store path removal canonicalizes the supplied path via `fs::canonicalize()` before checking the allowed-prefix list — symlinks cannot redirect removal to arbitrary paths
- `getent passwd` (NSS-aware) is used for user account checks — the username is passed as a direct argument, not interpolated into a shell command

### Audit Logging

All login attempts (success and failure), logouts, and privilege escalations are written to `/var/log/tenodera_audit.log` with timestamp, username, IP address, and outcome. File permissions are enforced at startup.

### Systemd Hardening

The gateway service runs with:

- `NoNewPrivileges=yes`
- `PrivateTmp=yes`
- `ProtectSystem=strict`
- `ProtectHome=yes`
- Dedicated unprivileged service user (`tenodera-gw`)

The agent binary is installed setuid root and runs as root under systemd. For terminal sessions it drops to the authenticated user's UID/GID before spawning the shell. For other privileged operations (package install, service restart, firewall changes, etc.) it invokes `sudo -S` with the password supplied by the authenticated user — so the operation runs under the user's own sudo privileges, not unconditionally as root.

---

## Deployment Recommendations

These are not handled by the software itself and remain the operator's responsibility:

- **Use a reverse proxy** (nginx, Caddy) in front of the gateway for additional TLS termination, access logging, and DDoS mitigation
- **Restrict network access** — expose port 9090 only to trusted networks or via VPN; the agent connects outbound and needs no inbound port
- **Use strong system passwords** — authentication relies on PAM/system accounts; password strength is determined by the OS PAM configuration
- **Rotate TLS certificates** — the installer can generate a self-signed cert for testing, but use a CA-signed certificate in production
- **Review sudo configuration** — the `admin` role is granted to any user with unrestricted sudo; ensure your `/etc/sudoers` reflects intended access
- **Audit agent enrollment** — review the pending host queue regularly; revoke bootstrap tokens after use or set single-use mode

---

## Scope

This project is provided "AS IS" without warranties. The user is responsible for deployment, configuration, and securing their environment. A security audit is recommended before using in production.
