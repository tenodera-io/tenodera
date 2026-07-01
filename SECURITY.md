# Security

## Reporting a Vulnerability

If you discover a security vulnerability:

- **Do not** disclose it publicly before a fix is available
- Report via GitHub Private Vulnerability Reporting (Security tab), or via GitHub Issues for non-critical findings

Include a description, steps to reproduce, and potential impact. Fixes are provided on a best-effort basis with no guaranteed timeline.

---

## Built-in Security Features

### Authentication

- **PAM authentication** via an isolated `tenodera-pam-helper` subprocess — the gateway never handles PAM directly
- **Sudo privilege check** at login (`sudo -l -U <user>`): members of `sudo`, `wheel`, or `admin` get `admin` role; all other users get `readonly` role and can log in with restricted access
- **Login rate limiting**: per-IP sliding window (default: 20 attempts per 5 minutes) — blocks brute-force attacks
- **Session idle timeout**: sessions expire after 900 seconds of inactivity (configurable)
- **Maximum session lifetime**: 4 hours regardless of activity
- **Authenticated logout**: requires `Authorization: Bearer <session_id>` matching the request body

### Memory Safety

- Passwords are stored as `Zeroizing<String>` and overwritten with zeros immediately on drop
- **Core dumps are disabled** at gateway startup to prevent session passwords leaking into crash files

### Transport

- **TLS required by default** — the gateway refuses to start without a certificate unless `TENODERA_ALLOW_UNENCRYPTED=1` is explicitly set (development only)
- **WebSocket Origin validation**: the browser WS connection is rejected if the `Origin` header does not match the `Host` header, preventing cross-site WebSocket hijacking (CSWSH)
- **CSRF protection**: all mutating HTTP requests (POST/PUT/DELETE/PATCH) require a matching `Origin` header

### HTTP Headers

Every response includes:

- `Content-Security-Policy` — restricts script/style/connect sources
- `X-Frame-Options: DENY` — prevents clickjacking
- `X-Content-Type-Options: nosniff`
- `Referrer-Policy: strict-origin-when-cross-origin`
- `Permissions-Policy` — disables camera, microphone, geolocation

### Authorization

- The gateway injects `_user` and `_role` into every channel message before forwarding to the agent — the agent never trusts client-supplied identity
- Admin-only operations (firewall changes, user management, package install, host restart, etc.) are gated by `require_admin()` on the agent side, which checks the gateway-injected `_role`
- Read-only users can observe but cannot execute any write operation

### Audit Logging

All login attempts (success and failure), logouts, and privilege escalations are written to `/var/log/tenodera_audit.log` with timestamp, username, IP address, and outcome. File permissions are enforced at startup.

### Systemd Hardening

The gateway service runs with:

- `NoNewPrivileges=yes`
- `PrivateTmp=yes`
- `ProtectSystem=strict`
- `ProtectHome=yes`
- Dedicated unprivileged service user (`tenodera-gw`)

The agent service runs as a separate unprivileged user (`tenodera-brdg`) and uses `sudo -S` only for operations that require elevated privileges, with the password supplied by the authenticated user.

### Input Validation

- Firewall rule inputs (IP/CIDR, port, protocol, service name) are validated before passing to ufw/firewalld/nftables
- DNS lookup inputs are validated against a safe hostname allowlist before invoking `dig`
- File listing uses `symlink_metadata()` to prevent symlink traversal attacks

---

## Deployment Recommendations

These are not handled by the software itself and remain the operator's responsibility:

- **Use a reverse proxy** (nginx, Caddy) in front of the gateway for additional TLS termination, access logging, and DDoS mitigation
- **Restrict network access** — expose port 9090 only to trusted networks or via VPN; the agent connects outbound and needs no inbound port
- **Use strong system passwords** — authentication relies on PAM/system accounts; password strength is determined by the OS PAM configuration
- **Rotate TLS certificates** — the installer can generate a self-signed cert for testing, but use a CA-signed certificate in production
- **Review sudo configuration** — the `admin` role is granted to any user with unrestricted sudo; ensure your `/etc/sudoers` reflects intended access

---

## Scope

This project is provided "AS IS" without warranties. The user is responsible for deployment, configuration, and securing their environment. A security audit is recommended before using in production.
