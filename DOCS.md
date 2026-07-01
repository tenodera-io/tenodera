# Tenodera Documentation

## Table of Contents

1. [Overview](#1-overview)
2. [Requirements](#2-requirements)
3. [Installation](#3-installation)
   - 3.1 [Panel (gateway + UI)](#31-panel-gateway--ui)
   - 3.2 [Agent (managed hosts)](#32-agent-managed-hosts)
   - 3.3 [Build from source](#33-build-from-source)
4. [Panel Configuration](#4-panel-configuration)
   - 4.1 [Gateway config reference](#41-gateway-config-reference)
   - 4.2 [TLS setup](#42-tls-setup)
   - 4.3 [Reverse proxy (nginx / Caddy)](#43-reverse-proxy-nginx--caddy)
5. [Agent Configuration](#5-agent-configuration)
   - 5.1 [Agent config reference](#51-agent-config-reference)
   - 5.2 [HTTPS / TLS for agents](#52-https--tls-for-agents)
6. [Authentication & Access Control](#6-authentication--access-control)
7. [Multi-Host Management](#7-multi-host-management)
8. [Feature Reference](#8-feature-reference)
9. [Service Management](#9-service-management)
10. [Health & Monitoring](#10-health--monitoring)
11. [Architecture](#11-architecture)
12. [Security](#12-security)
13. [Uninstall](#13-uninstall)
14. [Troubleshooting](#14-troubleshooting)

---

## 1. Overview

Tenodera is a self-hosted Linux server administration panel. It provides a real-time web interface for managing local and remote Linux servers — terminal access, service control, user management, package management, networking, storage, containers, logs, and more.

```
Browser ──WSS──> Gateway (:9090) <──WS── tenodera-agent (remote host)
                                 <──WS── tenodera-agent (localhost)
```

**Key design principles:**

- **No inbound ports on managed hosts** — agents connect outbound to the gateway via WebSocket
- **No extra daemon required** — the agent is a single binary managed by systemd
- **PAM authentication** — uses existing system accounts (local, LDAP, SSSD, FreeIPA)
- **Role-based access** — admin vs. read-only, based on sudo group membership

---

## 2. Requirements

### Panel host

| Requirement | Details |
|-------------|---------|
| OS | Linux (Debian, Ubuntu, RHEL, Fedora, Arch — tested on Debian 12, Fedora 43) |
| CPU | x86_64 |
| RAM | 512 MB minimum (1 GB recommended during build) |
| Disk | ~500 MB for build toolchain + binaries |
| Network | Port 9090 accessible from browsers and managed hosts |
| Build deps | Rust (installed automatically), Node.js ≥ 18 (installed automatically), gcc, pkg-config, libssl-dev, libpam0g-dev, libclang-dev |

### Managed hosts (agent only)

| Requirement | Details |
|-------------|---------|
| OS | Linux (any distribution with systemd) |
| CPU | x86_64 |
| RAM | ~20 MB for agent process |
| Network | Outbound TCP to panel host port 9090 |
| Build deps | Rust, gcc, pkg-config (installed automatically by agent installer) |

---

## 3. Installation

### 3.1 Panel (gateway + UI)

Run on the host that will serve the web interface:

```bash
curl -sSfL https://raw.githubusercontent.com/ultherego/Tenodera/main/tenodera.sh | sudo bash
```

The installer:
1. Installs system build dependencies (Rust, Node.js, gcc, libssl-dev, libpam0g-dev, libclang-dev)
2. Downloads Tenodera source from GitHub
3. Compiles the gateway and PAM helper (`cargo build --release`)
4. Builds the React UI (`npm ci && npm run build`)
5. Installs binaries to `/usr/local/bin/`
6. Creates the `tenodera-gw` service account
7. Writes `/etc/tenodera/tenodera.cnf` (gateway config)
8. Installs and enables `tenodera.service` (systemd)
9. Compiles and installs the local agent (`tenodera-agent`)
10. Writes `/etc/tenodera/agent.cnf` and enables `tenodera-agent.service`

After install, log in at `http://<host>:9090` with any PAM system user.

> **Note:** The panel starts in HTTP mode by default. Configure TLS before exposing to untrusted networks — see [§4.2 TLS setup](#42-tls-setup).

### 3.2 Agent (managed hosts)

Install on each Linux server you want to manage:

```bash
curl -sSfL https://raw.githubusercontent.com/ultherego/Tenodera/main/tenodera-agent.sh \
  | sudo bash -s -- --gateway http://<panel-host>:9090
```

Replace `<panel-host>` with the IP address or hostname of your panel server.

**On the panel host itself** (agent already installed by panel installer, but if reinstalling separately):

```bash
curl -sSfL https://raw.githubusercontent.com/ultherego/Tenodera/main/tenodera-agent.sh | sudo bash
```

No `--gateway` argument needed — defaults to `http://127.0.0.1:9090`.

The installer:
1. Installs build dependencies (Rust, gcc, pkg-config)
2. Compiles `tenodera-agent` from source
3. Installs the binary with setuid root (`-m 4755`)
4. Writes `/etc/tenodera/agent.cnf`
5. Installs and enables `tenodera-agent.service`

The host appears in the panel UI automatically within seconds of the agent starting. No manual registration, no tokens, no SSH keys required.

### 3.3 Build from source

```bash
git clone https://github.com/ultherego/Tenodera
cd Tenodera

# Panel (on the gateway host):
cd panel && sudo make all

# Agent (on each managed host):
cd agent && sudo make all
```

---

## 4. Panel Configuration

### 4.1 Gateway config reference

The gateway reads its configuration from `/etc/tenodera/tenodera.cnf` at startup. The file uses `KEY=VALUE` format. After editing, restart the service:

```bash
sudo systemctl restart tenodera
```

**Full config reference:**

```bash
# ── Network ──────────────────────────────────────────────────────────────────
TENODERA_BIND_ADDR=0.0.0.0      # Listen address (default: 0.0.0.0)
TENODERA_BIND_PORT=9090          # Listen port (default: 9090)

# ── External URL ──────────────────────────────────────────────────────────────
# Used to generate agent install commands shown in the UI.
# Set this if the panel is behind a reverse proxy or has a public hostname.
# Without it, the gateway falls back to the HTTP Host header, then the bind address.
# TENODERA_EXTERNAL_URL=https://panel.example.com

# ── TLS ──────────────────────────────────────────────────────────────────────
TENODERA_TLS_CERT=/etc/tenodera/tls/cert.pem   # Path to TLS certificate (PEM)
TENODERA_TLS_KEY=/etc/tenodera/tls/key.pem     # Path to TLS private key (PEM)
# TENODERA_ALLOW_UNENCRYPTED=1   # Allow plain HTTP — development only!

# ── Paths ─────────────────────────────────────────────────────────────────────
TENODERA_AGENT_BIN=/usr/local/bin/tenodera-agent  # Agent binary (used by readiness probe)
TENODERA_UI_DIR=/usr/share/tenodera/ui            # Built UI assets directory

# ── Security ──────────────────────────────────────────────────────────────────
TENODERA_IDLE_TIMEOUT=900        # Session idle timeout in seconds (default: 900 = 15 min)
TENODERA_MAX_STARTUPS=20         # Max failed logins per IP per 5-min window (default: 20)

# ── Logging ───────────────────────────────────────────────────────────────────
RUST_LOG=tenodera_gateway=info   # Log filter: error | warn | info | debug | trace
```

### 4.2 TLS setup

The gateway requires TLS by default and refuses to start without a certificate unless `TENODERA_ALLOW_UNENCRYPTED=1` is set.

#### Self-signed certificate (development / testing)

```bash
cd panel && sudo make tls-selfsigned
```

Generates a 10-year self-signed certificate in `/etc/tenodera/tls/`, sets correct ownership (`root:tenodera-gw`) and permissions (`640`), and restarts the gateway automatically.

When using a self-signed cert, agents must be installed with `--accept-insecure`:

```bash
curl -sSfL https://raw.githubusercontent.com/ultherego/Tenodera/main/tenodera-agent.sh \
  | sudo bash -s -- --gateway https://<panel-host>:9090 --accept-insecure
```

Or edit `/etc/tenodera/agent.cnf` on the managed host:

```bash
TENODERA_GATEWAY_URL=https://<panel-host>:9090
TENODERA_AGENT_ACCEPT_INSECURE=1
```

#### CA-signed certificate (production)

Set the paths in `/etc/tenodera/tenodera.cnf`:

```bash
TENODERA_TLS_CERT=/etc/ssl/your-domain/fullchain.pem
TENODERA_TLS_KEY=/etc/ssl/your-domain/privkey.pem
```

The gateway starts as root, reads the cert and key, then drops privileges to the `tenodera-gw` service user — the same pattern as nginx and Apache. No permission changes to your existing certificates are required.

Restart after editing:

```bash
sudo systemctl restart tenodera
```

#### Let's Encrypt (Certbot)

```bash
sudo certbot certonly --standalone -d panel.example.com
```

Then set in `tenodera.cnf`:

```bash
TENODERA_TLS_CERT=/etc/letsencrypt/live/panel.example.com/fullchain.pem
TENODERA_TLS_KEY=/etc/letsencrypt/live/panel.example.com/privkey.pem
```

Add a Certbot renewal hook to restart Tenodera after renewal:

```bash
echo 'systemctl restart tenodera' | sudo tee /etc/letsencrypt/renewal-hooks/deploy/tenodera.sh
sudo chmod +x /etc/letsencrypt/renewal-hooks/deploy/tenodera.sh
```

### 4.3 Reverse proxy (nginx / Caddy)

When running behind a reverse proxy, set `TENODERA_EXTERNAL_URL` in `tenodera.cnf` so the gateway generates correct agent install commands:

```bash
TENODERA_EXTERNAL_URL=https://panel.example.com
```

**nginx example:**

```nginx
server {
    listen 443 ssl;
    server_name panel.example.com;

    ssl_certificate     /etc/letsencrypt/live/panel.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/panel.example.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:9090;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_read_timeout 3600s;
    }
}
```

**Caddy example:**

```
panel.example.com {
    reverse_proxy localhost:9090 {
        header_up Host {host}
    }
}
```

With a reverse proxy handling TLS, you can run the gateway in plain HTTP mode:

```bash
TENODERA_ALLOW_UNENCRYPTED=1
```

---

## 5. Agent Configuration

### 5.1 Agent config reference

The agent reads `/etc/tenodera/agent.cnf` at startup (if environment variables are not already set by systemd).

```bash
# Gateway WebSocket endpoint
# http://  → plain WebSocket (ws://)
# https:// → encrypted WebSocket (wss://)
TENODERA_GATEWAY_URL=http://<panel-host>:9090

# Skip TLS certificate verification.
# Uncomment ONLY when using https:// with a self-signed certificate.
# Not needed for http:// or for https:// with a CA-signed certificate.
# TENODERA_AGENT_ACCEPT_INSECURE=1

# Host roles — used to group hosts in the Management page.
# Can also be set from the Management page in the UI (no restart required).
# role=web
# role=db,backup
```

After editing, restart the agent:

```bash
sudo systemctl restart tenodera-agent
```

### 5.2 HTTPS / TLS for agents

HTTPS/WSS is controlled by the URL scheme in `TENODERA_GATEWAY_URL`, not by `TENODERA_AGENT_ACCEPT_INSECURE`.

| Scenario | Config |
|----------|--------|
| Plain HTTP (default) | `TENODERA_GATEWAY_URL=http://...` |
| HTTPS with CA-signed cert | `TENODERA_GATEWAY_URL=https://...` |
| HTTPS with self-signed cert | `TENODERA_GATEWAY_URL=https://...` + `TENODERA_AGENT_ACCEPT_INSECURE=1` |

`TENODERA_AGENT_ACCEPT_INSECURE=1` disables TLS certificate verification — it does **not** enable HTTPS. Use it only when the panel has a self-signed certificate.

---

## 6. Authentication & Access Control

Tenodera uses **PAM authentication** — the same credentials as the system. No separate user database.

| Role | Who | Permissions |
|------|-----|-------------|
| **Admin** | Users in `sudo`, `wheel`, or `admin` group | Full read/write access to all features |
| **Read-only** | All other authenticated PAM users | Monitor only — cannot execute write operations |

Role is determined at login by running `sudo -l -U <user>` on the panel host. LDAP/SSSD/FreeIPA users work transparently if PAM is configured for them.

**Session limits:**

| Setting | Default | Config key |
|---------|---------|------------|
| Idle timeout | 15 minutes | `TENODERA_IDLE_TIMEOUT` |
| Max session lifetime | 4 hours | — |
| Brute-force protection | 20 attempts / 5 min / IP | `TENODERA_MAX_STARTUPS` |

---

## 7. Multi-Host Management

Tenodera is designed to manage multiple servers from a single panel. Each managed host runs `tenodera-agent` which connects outbound to the gateway.

**Adding a host:**

```bash
curl -sSfL https://raw.githubusercontent.com/ultherego/Tenodera/main/tenodera-agent.sh \
  | sudo bash -s -- --gateway http://<panel-host>:9090
```

The host appears in the panel immediately when the agent connects — no pre-registration needed.

**Switching between hosts:**

Use the host selector in the top-left of the UI. Click **Manage hosts…** to see all connected hosts, assign roles, restart or remove hosts (admin only).

**Host roles:**

Roles are labels used to group hosts (e.g. `web`, `db`, `backup`). They can be set:
- At install time via `role=` in `/etc/tenodera/agent.cnf`
- At runtime from the **Management** page in the UI (no restart required)

**Agent reconnect:**

Agents reconnect automatically with exponential backoff if the connection to the gateway is lost. A host appears offline in the UI until it reconnects.

---

## 8. Feature Reference

### Dashboard

Real-time streaming charts for CPU usage, RAM and swap, disk I/O (read/write), and network I/O (in/out). Data is streamed over WebSocket — no polling.

### Terminal

Full PTY terminal in the browser using xterm.js. Opens a shell as the authenticated user. Supports terminal resize. The agent drops to the user's UID/GID before spawning the shell — no root shell is exposed.

### Services

Lists all systemd units. Actions: start, stop, restart, enable, disable. Requires admin role for write operations. Reads unit status and journal output.

### Users & Groups

View and manage local system users and groups. Actions: create user, delete user, lock/unlock account, change password, assign groups. NSS-aware — works with LDAP/SSSD users.

### Packages

Shows installed packages. Package manager detected automatically (apt, dnf, pacman). Actions: search, install, update, remove. Repository management for apt (sources.list) and dnf (repo files).

### Storage

Block devices, mount points, partition usage. Real-time I/O charts per device. SMART status where available.

### Networking

Network interfaces with traffic charts. Firewall management supporting ufw, firewalld, and nftables. Interface up/down control. Bridges and VLANs.

### Containers

Lists Docker and Podman containers (user and root namespaces). Actions: start, stop, remove, create. Image browser. Container logs streamed in real time.

### Files

Remote file browser. Navigate directories, view files, upload/download. Falls back to sudo for root-owned files when the user has sudo access.

### Logs (journald)

Streams systemd journal entries. Filter by unit name, priority, and time range.

### Log Files

Browses `/var/log` directory. Keyword search with context lines. Date and time range filtering.

### Cron Jobs

Lists all crontab sources: `/etc/crontab`, `/etc/cron.d/`, and per-user crontabs. View entries and edit raw crontab content.

### Kernel Dump (kdump)

Shows kdump service status, crash kernel configuration. Browses existing crash dump files.

### DNS

Edit `/etc/resolv.conf` and `/etc/hosts`. DNS lookup tool (wraps `dig`). systemd-resolved status and configuration.

### Certificates

TLS certificate scanning (installed certs, expiry dates). System trust store management. Self-signed certificate generation. Let's Encrypt integration status.

### Management (admin only)

Manage connected agents: view all hosts, assign roles, restart agent service, remove host from registry. Admin-only panel.

---

## 9. Service Management

### Panel host

```bash
# Status
sudo systemctl status tenodera
sudo systemctl status tenodera-agent

# Restart
sudo systemctl restart tenodera
sudo systemctl restart tenodera-agent

# Logs (live)
journalctl -u tenodera -f
journalctl -u tenodera-agent -f

# Config
/etc/tenodera/tenodera.cnf    # gateway config
/etc/tenodera/agent.cnf       # local agent config
```

### Managed hosts

```bash
sudo systemctl status tenodera-agent
sudo systemctl restart tenodera-agent
journalctl -u tenodera-agent -f

# Config
/etc/tenodera/agent.cnf
```

### Installed files

| Path | Description |
|------|-------------|
| `/usr/local/bin/tenodera-gateway` | Gateway binary |
| `/usr/local/bin/tenodera-pam-helper` | PAM helper (setuid root) |
| `/usr/local/bin/tenodera-agent` | Agent binary (setuid root) |
| `/usr/share/tenodera/ui/` | Built UI assets |
| `/etc/tenodera/tenodera.cnf` | Gateway configuration |
| `/etc/tenodera/agent.cnf` | Agent configuration |
| `/etc/tenodera/tls/` | TLS certificates |
| `/etc/tenodera/hosts.json` | Agent registry (connected hosts) |
| `/etc/systemd/system/tenodera.service` | Gateway systemd service |
| `/etc/systemd/system/tenodera-agent.service` | Agent systemd service |
| `/etc/pam.d/tenodera` | PAM service config |
| `/var/log/tenodera_audit.log` | Audit log |
| `/etc/logrotate.d/tenodera` | Log rotation config |

---

## 10. Health & Monitoring

The gateway exposes two HTTP endpoints for health checks:

```
GET /api/health
```

Returns:

```json
{
  "status": "ok",
  "sessions": 2,
  "uptime_secs": 3600,
  "version": "0.1.0"
}
```

```
GET /api/health/ready
```

Returns `200 OK` when the agent binary exists and is executable, `503 Service Unavailable` otherwise. Use this as a **readiness probe** in load balancers or container orchestration (e.g. Kubernetes).

---

## 11. Architecture

```
                  [ Browser ]
                       |
                       | HTTPS / WSS  (channel-multiplexed JSON)
                       |
                  [ Gateway ]   Axum HTTP/WS · PAM auth · session management
                 /      |      \
   outbound WS  /       |       \  outbound WS
               /        |        \
        [ Agent ]  [ Agent ]  [ Agent ]   ...
          host-1      host-2     localhost
```

### Components

**Gateway** (`panel/crates/gateway/`)
- Rust, Axum 0.8 framework
- Serves the React UI over HTTP/HTTPS
- Authenticates users via PAM (via `tenodera-pam-helper` subprocess)
- Maintains a WebSocket registry of connected agents
- Routes channel-multiplexed JSON messages between browser sessions and agents
- Starts as root, drops to `tenodera-gw` unprivileged user after binding the TLS socket

**Agent** (`agent/`)
- Rust, Tokio async runtime
- Lightweight systemd service (~20 MB resident memory)
- Connects outbound to the gateway via WebSocket
- Handles 39 operation types across 28 handler modules
- Announces itself via `Hello/HelloAck` handshake on connect
- Reconnects automatically with exponential backoff on disconnect
- Installed as setuid root; drops to the authenticated user's UID/GID for terminal sessions

**Protocol** (`protocol/`)
- Shared Rust library crate
- Defines the `Message` enum used by both gateway and agent
- Serde JSON serialization with type-tagged messages

### Wire protocol

Messages are JSON objects with a `type` field:

| Type | Direction | Description |
|------|-----------|-------------|
| `hello` | agent → gateway | Agent announces hostname and protocol version |
| `hello_ack` | gateway → agent | Gateway acknowledges, optionally warns on version mismatch |
| `open` | browser → gateway | Open a named channel (e.g. `system_info`, `terminal_pty`) |
| `ready` | agent → browser | Agent acknowledges streaming channel |
| `data` | bidirectional | Channel payload |
| `control` | bidirectional | Signals (PTY resize, etc.) |
| `close` | bidirectional | Clean or error channel close |
| `auth` / `authresult` | browser → gateway | Session authentication phase |
| `ping` / `pong` | bidirectional | Keepalive |

Current protocol version: **1**

### Project structure

```
panel/                   Central server (gateway + UI)
  crates/gateway/        Axum HTTP/WS gateway, PAM auth, agent registry
  ui/                    React 19 + TypeScript SPA (Vite 6)
  Makefile               Build & install
  systemd/               tenodera.service

agent/                   Agent binary (deployed to managed hosts)
  src/handlers/          28 handler modules (39 registered handlers)
  Makefile               Build & install
  systemd/               tenodera-agent.service

protocol/                Shared message types (Rust library crate)

packaging/               RPM spec files (tenodera.spec, tenodera-agent.spec)
```

---

## 12. Security

See [SECURITY.md](SECURITY.md) for the full security model.

**Summary:**

- PAM authentication via isolated `tenodera-pam-helper` subprocess — gateway never handles PAM directly
- Role-based access: admin vs. read-only, determined by `sudo -l` at login
- Rate limiting: 20 failed logins per IP per 5-minute window (configurable)
- Sessions: UUID v4 tokens, idle timeout (default 15 min), max lifetime 4 hours
- Passwords stored as `Zeroizing<String>`, overwritten on drop; core dumps disabled
- TLS required by default; WebSocket Origin validation; CSRF protection on mutating requests
- Security headers: CSP, X-Frame-Options, X-Content-Type-Options, Referrer-Policy, Permissions-Policy
- Gateway injects `_user` and `_role` into every message — agent never trusts client-supplied identity
- Audit log: all logins, logouts, and privilege escalations → `/var/log/tenodera_audit.log`
- systemd hardening: `NoNewPrivileges`, `PrivateTmp`, `ProtectSystem=strict`, `ProtectHome`

---

## 13. Uninstall

### Panel host (removes everything)

```bash
curl -sSfL https://raw.githubusercontent.com/ultherego/Tenodera/main/tenodera.sh \
  | sudo bash -s -- --uninstall
```

Removes: gateway and agent binaries, PAM helper, UI assets, systemd services, `/etc/tenodera/`, logrotate config, PAM config, `tenodera-gw` user.

### Managed hosts (agent only)

```bash
curl -sSfL https://raw.githubusercontent.com/ultherego/Tenodera/main/tenodera-agent.sh \
  | sudo bash -s -- --uninstall
```

Removes: agent binary, systemd service, `/etc/tenodera/`.

### From source

```bash
cd panel && sudo make uninstall
cd agent && sudo make uninstall
```

---

## 14. Troubleshooting

### Panel not starting

```bash
journalctl -u tenodera -e
```

Common causes:
- **TLS certificate not found** — set `TENODERA_ALLOW_UNENCRYPTED=1` in `tenodera.cnf` for development, or generate a cert with `cd panel && sudo make tls-selfsigned`
- **Port 9090 already in use** — change `TENODERA_BIND_PORT` in `tenodera.cnf`

### Agent not connecting to gateway

```bash
journalctl -u tenodera-agent -e
```

Common causes:
- **Wrong gateway URL** — check `TENODERA_GATEWAY_URL` in `/etc/tenodera/agent.cnf`
- **Firewall blocking port 9090** — the managed host must be able to reach the panel host on port 9090 (outbound TCP)
- **TLS cert verification failing** — if the panel uses a self-signed cert, set `TENODERA_AGENT_ACCEPT_INSECURE=1` in `agent.cnf`

After editing `agent.cnf`, always restart:

```bash
sudo systemctl restart tenodera-agent
```

### Login fails

- Verify the user exists on the **panel host** (not the managed host)
- Verify PAM is configured: `pamtester tenodera <username> authenticate`
- Check audit log: `sudo tail -f /var/log/tenodera_audit.log`

### Host not appearing in UI

- Check agent is running: `sudo systemctl status tenodera-agent`
- Check agent logs: `journalctl -u tenodera-agent -f`
- Look for `Hello` handshake message in the logs — if it's there, the gateway is connected
- Verify `TENODERA_GATEWAY_URL` points to the correct panel host

### Gateway logs

```bash
# Increase verbosity (edit tenodera.cnf):
RUST_LOG=tenodera_gateway=debug

sudo systemctl restart tenodera
journalctl -u tenodera -f
```
