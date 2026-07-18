# Security

For the design-level view — trust boundaries, the outbound-only trade-off,
gateway blast radius, and what is implemented versus planned — see
[THREAT_MODEL.md](THREAT_MODEL.md). This document covers the concrete controls.

## Reporting a Vulnerability

If you discover a security vulnerability:

- **Do not** disclose it publicly before a fix is available
- Report via GitHub Private Vulnerability Reporting (Security tab), or via GitHub Issues for non-critical findings

Include a description, steps to reproduce, and potential impact. Fixes are provided on a best-effort basis with no guaranteed timeline.

---

## Verifying releases

Release artifacts (`.deb` / `.rpm`, amd64 and arm64) are checksummed in a
`SHA256SUMS` file, and that file is signed with
[minisign](https://jedisct1.github.io/minisign/). Verifying the signature proves
the packages came from this project's release pipeline and were not tampered with
in transit.

Public key:

```
untrusted comment: minisign public key 691ADB50B83EB5A6
RWSmtT64UNsaaa2uow7VxKq5kApYJmEmvcqO9SgeXnCAcYl7FI74eDql
```

Verify a downloaded release:

```bash
# 1. verify the signature on the checksum file
minisign -Vm SHA256SUMS -P 'RWSmtT64UNsaaa2uow7VxKq5kApYJmEmvcqO9SgeXnCAcYl7FI74eDql'

# 2. verify the packages against the (now-trusted) checksums
sha256sum -c SHA256SUMS
```

> The signing key is Ed25519. The private key never leaves CI (stored as a
> GitHub Actions secret); only the public key above is needed to verify.

---

## Built-in Security Features

### Authentication

- **PAM authentication** via an isolated `tenodera-pam-helper` subprocess — the gateway never calls PAM directly; all credential handling is confined to the subprocess
- **Admin role determination** at login: `getpwnam_r` + `getgrouplist` + `getgrgid_r` (the full NSS stack) checks group membership against `sudo`, `wheel`, and `admin`; LDAP/SSSD/FreeIPA groups are resolved transparently via NSS — no `sudo` process is spawned
- **Login rate limiting**: per-IP sliding window (default: 20 attempts per 5 minutes) — blocks brute-force attacks
- **Session idle timeout**: sessions expire after 900 seconds of inactivity (configurable via `TENODERA_IDLE_TIMEOUT` in `tenodera.cnf` — see §4.1 of DOCS.md)
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

> **The token persists on the agent.** `tenodera-agent.sh --token <value>` writes `TENODERA_BOOTSTRAP_TOKEN=…` into `/etc/tenodera/agent.cnf` and it is **not** removed after enrollment (the agent only needs it once — its Ed25519 key is pinned on first connect). Treat it as a bearer secret: prefer **single-use, short-TTL, hostname-bound** tokens so a leftover value is already spent, and delete the line once the host is enrolled. Never leave one long-lived, multi-use token sitting in every host's `agent.cnf`.

### Authorization

- The gateway injects `_user` (session username) and `_role` (session role) into every channel `Open` and subsequent `Data` message before forwarding to the agent — the agent never trusts client-supplied identity
- Admin-only operations (firewall changes, user management, package install, host restart, etc.) are gated by `require_admin()` on the agent side, which checks the gateway-injected `_role`
- Missing `_role` in a handler payload is treated as unauthorized — any message that bypasses gateway injection is denied by default
- Read-only users can observe but cannot execute any write operation
- **The managed host is the authority (for most operations).** `require_admin()`/`_role` is a first-line filter, not the security boundary. **Most** state-changing operations are executed *as the logged-in user*: the agent (running as root) drops to their UID/GID inside `pre_exec` (`initgroups` → `setgid` → `setuid`) and only then execs `sudo -S -k <command>`, feeding their own password on stdin. The host's own rules decide what is permitted — local `/etc/sudoers`, or FreeIPA/LDAP sudo rules resolved via SSSD — per command and per host. Tenodera keeps no permission store of its own. **The exceptions are listed in the two bullets below** (reads, and a few admin subsystems), which run at the agent's root privilege without dropping
- **The user must exist, with the rights they intend to use, on every managed host.** A user unknown to a host is denied there (`getpwnam_r` miss), even with an admin session on the panel
- **Reads are being brokered per-user, incrementally.** The journal, log files under `/var/log` (tail/search/filter), the process list (`ps`, honouring `hidepid`), the process owning each listening socket (`ss -p`), and container reads (list/inspect/logs/stats/volumes/networks — the user's own runtime access, e.g. `docker` group or rootless podman) now run *as the logged-in user* — their own file/group permissions decide, and the superuser password escalates via `sudo` as that user, exactly like writes. The remaining privileged reads run at the agent's privilege (root): the baseline world-readable introspection (metrics, disk, network stats, hardware/system info, DNS, packages) by design, plus a few borderline file reads (cron, kdump, cert keys); for those, any authenticated user can read that state regardless of their rights on the host — see `THREAT_MODEL.md` §6
- **A few administrative subsystems run as the agent (root), gated only by the admin role — not by the host's `sudo`.** SSH access management (authorized_keys / `sshd_config`), the Security page actions (fail2ban, SELinux, AppArmor), and host enrollment / token management execute at the agent's privilege once `require_admin()` passes; the host's `/etc/sudoers` does **not** further adjudicate them. For these operations the admin role *is* the boundary, so grant it only to fully-trusted operators. The bulk of state-changing operations — services, packages, users & groups, networking/firewall, storage mounts, cron, DNS, certificates, time & system settings, files — still drop to the logged-in user and run under their own `sudo`, adjudicated per-command by the host
- **Exception:** `GET /api/hosts/{id}/user-check` is a gateway-only REST endpoint; it sends a `users.manage` channel request internally (`execute_rpc`) using the session username directly — no `_user`/`_role` injection applies since the agent's `check_exists` action requires no privileges

### Terminal Security

- The agent runs as root under systemd (the binary is installed root-owned, mode `0755`, **without** a setuid bit); for terminal sessions it drops to the authenticated user's UID/GID via `setuid()`/`setgid()` before spawning the shell — no root shell is ever exposed to the user
- **Shell allowlist**: only the following shells may be spawned — `/bin/sh`, `/bin/bash`, `/bin/zsh`, `/bin/fish`, and their `/usr/bin/` equivalents; any other shell path (including the user's configured shell if not on the list) causes the terminal session to be rejected
- The terminal requires a valid system account on the managed host; if the logged-in user does not exist on that host, the PAM/setuid drop will fail
- **Container exec** (opening a shell inside a running Docker/Podman container) reuses the same PTY channel but first re-verifies the user's password via PAM; the shell then runs *inside the container* via `docker`/`podman exec` (auto-selecting `bash`, else `ash`/`sh`), not on the host, so the shell allowlist above does not apply to it

### File Access

- **Limited mode** (no superuser password): the agent restricts all file operations (list, read, write, create, delete) to a single directory — the literal path `/home/<username>/` (not all of `/home`, and not the account's real home from `passwd`). Paths are `canonicalize()`d and must start with `/home/<username>/`, so symlinks inside `~` pointing elsewhere are blocked. Because the prefix is the literal `/home/<username>`, accounts whose home is elsewhere (e.g. `root` at `/root`, or a directory-managed user under `/var/home`) do not get a usable Limited-mode file browser — they need Administrative mode
- **Administrative mode** (superuser password active): full filesystem access via `sudo`
- `symlink_metadata()` is used in directory listings to prevent symlink traversal attacks

### Input Validation

- Firewall rule inputs (IP/CIDR, port, protocol, service name) are validated before passing to ufw/firewalld/nftables
- DNS lookup inputs are validated against a safe hostname allowlist before invoking `dig`
- Certificate and TLS operations invoke `openssl` directly via argument arrays — no `sh -c`, no shell metacharacter injection possible
- Temporary files for certificate operations use 64-bit random suffixes and `O_EXCL` + mode `0o600` — prevents predictable-path symlink attacks and world-readable private key exposure
- Trust store path removal canonicalizes the supplied path via `fs::canonicalize()` before checking the allowed-prefix list — symlinks cannot redirect removal to arbitrary paths
- `getent passwd` (NSS-aware) is used for user account checks — the username is passed as a direct argument, not interpolated into a shell command
- **SSH keys** are validated with `ssh-keygen` before being appended to a user's `authorized_keys`; ownership and mode on `~/.ssh` and `authorized_keys` are restored (`chown` uid:gid, `0700`/`0600`) after every change
- **`sshd_config`** edits are validated with `sshd -t` against a staged copy in `/run` and rejected if invalid; the live config is backed up (`sshd_config.tenodera.bak`) before the new one is written and the daemon reloaded
- **Security actions** validate their inputs before invoking tools via argument arrays (no shell): fail2ban jail/IP, SELinux boolean names, `restorecon` paths (absolute, existing). Hardening tools are resolved to absolute paths rather than trusting `PATH`
- **The disk-usage scanner** validates the target path, stays on one filesystem (`du -x`), runs at idle CPU/I/O priority (`nice -n19 ionice -c3`) with a hard timeout, allows only one scan at a time, and is killed when the panel cancels the channel — bounding its impact on busy hosts

### Audit Logging

Login attempts (success and failure), logouts, and privilege escalations are written to `/var/log/tenodera_audit.log` with timestamp, username, IP address, and outcome. File permissions are enforced at startup.

Mutating actions taken *through the panel* are recorded there too — service control, package changes, user/group changes, firewall/networking, storage mounts, cron, DNS, certificates, time/system settings, container actions, SSH key/`sshd_config` changes, and Security-page actions (fail2ban/SELinux/AppArmor) — each with the acting user, action, target, result, and details. The log is viewable in the panel under **Admin → Audit log** and is designed to be rotated by `logrotate`.

### Systemd Hardening

The gateway service runs with:

- `NoNewPrivileges=yes`
- `PrivateTmp=yes`
- `ProtectSystem=strict`
- `ProtectHome=yes`
- Dedicated unprivileged service user (`tenodera-gw`)

The agent binary is installed root-owned (mode `0755`, no setuid bit) and runs as root because systemd starts it. How it uses that privilege depends on the operation:

- **Terminal, and most privileged writes** (package install, service restart, firewall changes, storage mounts, cron, DNS, certificates, time/system settings, files): the agent **drops to the authenticated user** (`initgroups` → `setgid` → `setuid` in `pre_exec`) and then either spawns their shell or execs `sudo -S` with the password they supplied — so the operation runs under the user's own sudo privileges and the host adjudicates it, not unconditionally as root.
- **A few admin subsystems, and the not-yet-brokered reads, run as root without dropping**: SSH access management, the Security page (fail2ban/SELinux/AppArmor), host enrollment/tokens, the baseline world-readable system introspection, and a few borderline file reads (cron, kdump, cert keys) execute at the agent's root privilege after only the `require_admin()`/authentication check. (The journal, log files, process list, listening-port owners, and container reads are now brokered to the logged-in user and drop privilege like writes.) For the admin subsystems the injected admin role is the boundary — see the Authorization section and `THREAT_MODEL.md` §6.

---

## Deployment Recommendations

These are not handled by the software itself and remain the operator's responsibility:

- **Know the two TLS defaults.** In code, TLS is mandatory and the gateway binds to `127.0.0.1:9090`. But the **package installer ships `/etc/tenodera/tenodera.cnf` with `TENODERA_BIND_ADDR=0.0.0.0` and `TENODERA_ALLOW_UNENCRYPTED=1`** so the panel is reachable right after install — i.e. **plain HTTP on all interfaces**. Configure TLS (or a reverse proxy) and remove `TENODERA_ALLOW_UNENCRYPTED=1` before exposing the panel anywhere untrusted
- **Use a reverse proxy** (nginx, Caddy) in front of the gateway for TLS termination, access logging, and DDoS mitigation — and when you do, set `TENODERA_BIND_ADDR=127.0.0.1` so the plain-HTTP backend is reachable only via the proxy. Leaving the shipped `0.0.0.0` bind with `TENODERA_ALLOW_UNENCRYPTED=1` exposes the unencrypted backend directly on `:9090`, bypassing the proxy's TLS, access control and logging
- **Restrict network access** — expose the panel port only to trusted networks or via VPN, and block direct access to `9090` at the firewall when fronted by a proxy; the agent connects outbound and needs no inbound port
- **Use strong system passwords** — authentication relies on PAM/system accounts; password strength is determined by the OS PAM configuration
- **Rotate TLS certificates** — the installer can generate a self-signed cert for testing, but use a CA-signed certificate in production
- **Review sudo configuration** — this is your primary access control, not a formality. Most privileged operations run as the logged-in user under `sudo`, so `/etc/sudoers` (or your FreeIPA/LDAP sudo rules) is what actually decides who may do what on each host. The `admin` role in the UI is only granted to users with unrestricted sudo, but for those operations it merely unhides actions — the host still adjudicates every one of them. Grant per-command rules where you want fine-grained control
- **Grant the admin role sparingly** — a few subsystems (SSH access management, the Security page, host enrollment) act as root gated *only* by the admin role, without a second `sudo` check on the host. For those, the role is the boundary — treat admin-role membership as equivalent to root on every managed host
- **Audit agent enrollment** — review the pending host queue regularly; revoke bootstrap tokens after use or set single-use mode

---

## Scope

This project is provided "AS IS" without warranties. The user is responsible for deployment, configuration, and securing their environment. A security audit is recommended before using in production.
