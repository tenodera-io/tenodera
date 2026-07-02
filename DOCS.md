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
   - 8.1 [Dashboard](#81-dashboard)
   - 8.2 [Terminal (admin only)](#82-terminal-admin-only)
   - 8.3 [Services](#83-services)
   - 8.4 [Users & Groups](#84-users--groups)
   - 8.5 [Packages](#85-packages)
   - 8.6 [Storage](#86-storage)
   - 8.7 [Networking](#87-networking)
   - 8.8 [Containers](#88-containers)
   - 8.9 [Files](#89-files)
   - 8.10 [Logs (Journal)](#810-logs-journal)
   - 8.11 [Log Files](#811-log-files)
   - 8.12 [Cron Jobs](#812-cron-jobs)
   - 8.13 [Kernel Dump (kdump)](#813-kernel-dump-kdump)
   - 8.14 [DNS](#814-dns)
   - 8.15 [Certificates](#815-certificates)
   - 8.16 [Management](#816-management-admin-only)
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

This section describes every page and sub-tab available in the Tenodera UI. Write operations (marked **admin only**) require the user to be a member of the `sudo`, `wheel`, or `admin` group on the panel host.

Many write operations also require entering the **superuser password** — this is the password of the currently logged-in user (used for `sudo -S` on the managed host). A padlock button in the top bar opens the superuser password prompt; the password is stored encrypted in browser `sessionStorage` for the duration of the session.

---

### 8.1 Dashboard

The Dashboard provides a live overview of the selected host's system state. All metrics are streamed over WebSocket — no page refresh needed.

**System information panel**

- Hostname, operating system (name, version, ID)
- Uptime, boot time, current host time and timezone
- CPU model, core count, thread count, frequency (MHz), architecture
- Kernel version
- CPU temperatures (per sensor, with critical threshold if available)

**Real-time charts** (90-point rolling history, configurable interval)

| Chart | Metrics |
|-------|---------|
| CPU | User %, system % — stacked area chart |
| Load average | 1-minute, 5-minute, 15-minute load |
| Memory | Used % (from MemTotal − MemAvailable) |
| Disk I/O | Read KB/s, write KB/s |
| Network I/O | RX bytes/s, TX bytes/s (aggregated) |

**Disk partitions table**

Device, mount point, filesystem type, total size, used, free, use %.

**Network interfaces table**

Interface name, state (up/down), MAC address, speed (Mbps), IPv4 and IPv6 addresses, RX/TX bytes and packets, error counts.

**Top processes table**

PID, process name, CPU %, memory %, user, state — sorted by CPU usage descending.

---

### 8.2 Terminal (admin only)

A full PTY (pseudo-terminal) running in the browser, powered by xterm.js. Visible only to admin users; hidden from read-only accounts.

- Opens a shell as the **authenticated user** (the agent drops to the user's UID/GID via `setuid()`/`setgid()` before spawning the shell — no root shell is exposed)
- 10 000-line scrollback buffer
- Font: JetBrains Mono → Fira Code → Cascadia Code → monospace fallback, 14 px
- Tokyo Night color theme (matches the rest of the UI)
- **Auto-copy**: selecting text automatically copies it to the clipboard (requires HTTPS or localhost — browser Clipboard API restriction)
- **Resize**: the terminal resizes automatically with the browser window (xterm.js FitAddon)
- The connection is a WebSocket channel multiplexed through the gateway — no direct SSH to the managed host

> **Note:** The Terminal works per-host. Use the host selector (top-left) to open a terminal on a different managed host.

---

### 8.3 Services

Manage systemd units on the selected host.

**Services tab**

Lists all loaded systemd units (services, sockets, mounts, etc.) with:

| Column | Description |
|--------|-------------|
| Unit | Unit filename (e.g. `sshd.service`) |
| Description | Unit description string |
| Active | `active` / `activating` / `deactivating` / `inactive` / `failed` |
| State | `running` / `exited` / `dead` / `waiting` / `mounted` |
| Load | `loaded` / `not-found` / `masked` |

- **Filter** by unit name (text search)
- **Sort** by Active or State column (click column header to cycle: desc → asc → unsorted)
- Color coding: green = active/running, red = failed, gray = inactive
- **Actions** (admin only): Start, Stop, Restart, Enable, Disable

**Timers tab**

Lists all systemd timer units with:
- Unit name and description
- Active/sub state
- Next scheduled run time
- Last run time
- Enabled state
- Triggered unit (the service the timer activates)

---

### 8.4 Users & Groups

Manage system users and groups on the selected host.

**Users tab**

Lists all users visible through NSS (local `/etc/passwd`, LDAP, SSSD, FreeIPA) with:

| Field | Description |
|-------|-------------|
| Username | Login name |
| UID / GID | Numeric user and primary group ID |
| Full name | GECOS field |
| Home | Home directory path |
| Shell | Login shell |
| Groups | All groups the user belongs to |
| Status | Active or Locked |
| Last login | Timestamp of most recent login |
| Source | `local` or LDAP/SSSD source |

- **Filter** by username (text search)
- **Sort** by username, UID, or status (click column header)
- **Actions** (admin only): Lock account, Unlock account, Delete user, Change password

**Groups tab**

Lists all groups visible through NSS with:
- Group name, GID
- Member list
- System group flag

**Create Account tab** (admin only)

Create a new local user account:
- Username, password
- Full name (GECOS)
- Home directory (auto-generated or custom)
- Login shell (from allowed shell list)
- Initial group memberships

---

### 8.5 Packages

Manage software packages on the selected host. The package manager is **auto-detected** (apt for Debian/Ubuntu, dnf for RHEL/Fedora, pacman for Arch). The detected backend and distribution name are shown at the top of the page.

**Installed tab**

Lists all installed packages:
- Name, version, repository source
- Filter by name (text search)
- Total package count shown

**Search tab** (admin only for install)

Search available packages in configured repositories:
- Enter search query → results show name, version, description, repository
- Install a package from search results

**Updates tab** (admin only)

Lists available package updates:
- Package name, current installed version, available version
- **Update all** — runs the full system upgrade (`apt upgrade`, `dnf upgrade`, `pacman -Syu`)
- Live output streamed to the UI during update

**Repositories tab** (admin only)

View and manage configured repositories:

| Backend | Fields shown |
|---------|-------------|
| apt | Repository line, file path, format (one-line / deb822), Types, URIs, Suites, Components |
| dnf | Repo name, description, enabled state |
| pacman | Server URL, Include path, SigLevel |

- Enable / disable repositories (admin only)

---

### 8.6 Storage

Monitor block devices and disk I/O on the selected host.

**Block device tree**

Displayed as a hierarchical tree (similar to `lsblk`):
- Device name, size, type (disk / part / lvm / raid / etc.)
- Mount points
- Used / free space and use % (for mounted devices)
- Tree connectors (├─ / └─) for child partitions and LVM volumes

**Disk I/O chart**

Real-time area chart showing read KB/s and write KB/s:
- Configurable polling interval: 1 s, 5 s, 10 s, 30 s, 1 min, 5 min, 10 min, 30 min
- 90-point rolling history
- Interval preference saved in browser `localStorage`

---

### 8.7 Networking

Monitor and manage network configuration on the selected host.

**Overview tab**

Real-time traffic charts per network interface:
- Separate RX and TX lines per interface (up to 8 interfaces, color-coded)
- Configurable polling interval: 1 s to 30 min
- 90-point rolling history

**Firewall tab** (write operations — admin only)

Shows status and rules for all detected firewall backends (ufw, firewalld, nftables):
- Primary active backend highlighted
- Per-backend: active state, rule list
- **Add rule**: port/protocol, source IP/CIDR, action (allow/deny)
- **Remove rule**: by rule number or specification
- Supports mixed environments (e.g. firewalld active alongside nftables)

**Interfaces tab** (write operations — admin only)

Detailed view of all network interfaces:
- State (up/down), MAC address, MTU, link type, interface type, flags
- IPv4 and IPv6 address list
- **Bring interface up / down** (via `ip link set dev <iface> up/down` or nmcli)
- VPN connections listed separately (type, device, state)

**Logs tab**

Network-related log entries from the system journal.

---

### 8.8 Containers

Manage Docker and Podman containers on the selected host.

**Containers tab**

Lists all containers from both **user namespace** (rootless) and **root namespace**:

| Column | Description |
|--------|-------------|
| Name | Container name |
| Image | Image the container was created from |
| State | `running` / `paused` / `restarting` / `created` / `exited` / `dead` |
| Status | Human-readable status string |
| Ports | Exposed port mappings |
| Owner | `user` (rootless) or `root` |

- Sorted by state (running first), then by owner (user before root)
- **Actions** (admin only): Start, Stop, Remove

**Images tab** (admin only)

Lists all container images:
- Repository, tags, size, creation date, owner (user/root)
- **Remove image** (fails with a friendly error if the image is in use by a running container)

**Create tab** (admin only)

Create a new container from an image.

---

### 8.9 Files

A file manager for the selected host. Supports browsing, viewing, editing, creating, and deleting files. Access level depends on whether the superuser password is active.

**Access modes**

| Mode | When | Scope |
|------|------|-------|
| **Limited** | No superuser password active | Home directory only (`/home/<user>`) — cannot navigate above it |
| **Administrative** | Superuser password active (padlock in top bar) | Full filesystem — root-owned paths accessible via sudo |

The restriction is enforced at the agent level, not only in the browser. The agent rejects any file operation (list, read, write, delete) whose resolved path falls outside `/home/<user>` when no password is provided.

**Navigation**

- Opens at the authenticated user's home directory (`/home/<user>`)
- **↑ button** — navigate to parent directory; disabled in Limited mode when already at home directory root
- **Path bar** — shows current path; read-only with a `Limited` badge in Limited mode; editable in Administrative mode
- **Autocomplete** (Administrative mode) — typing a path suggests matching subdirectories (up to 12); navigate with arrow keys, Tab to complete, Enter to go
- Entries sorted directories first, then alphabetically within each group

**File listing**

| Column | Description |
|--------|-------------|
| Name | 📁 directory / 📄 file / 🔗 symlink icon plus filename; click directory to navigate, click file to view |
| Permissions | `drwxr-xr-x` permission string in monospace, followed by `owner:group` |
| Size | Human-readable (B / KB / MB / GB) |
| Actions | View (files only), Delete |

**Viewing files**

- Opens in a modal with line numbers
- 200 lines per page; Prev / Next navigation for large files; shows current line range and page count
- Binary files detected automatically via `file --mime-type` — shown as "Binary file — cannot display" with MIME type
- **Edit** button in the viewer opens the inline editor

**Editing files**

- Inline textarea editor opens the current file content
- Save writes back to the file; the viewer reopens with updated content on success
- Error shown inline if the write is rejected (e.g. permission denied or outside home directory in Limited mode)

**Creating files**

- **+ New File** button opens the Create modal
- Path field (pre-filled with current directory) and content textarea
- In Limited mode the path must resolve within `/home/<user>`; the agent rejects paths outside it

**Deleting files**

- **Delete** button on any row opens a confirmation modal before action
- In Limited mode only files within `/home/<user>` can be deleted; the agent enforces this after resolving symlinks
- Admin delete uses `sudo rm` with the superuser password

**Symlink safety**

Symlink targets are resolved (canonicalized) before applying the home-directory restriction — a symlink inside `/home/<user>` pointing outside is blocked in Limited mode. Linux filesystem permissions provide a second layer of defence regardless.

> **Note:** Directory deletion is not yet implemented — only files can be deleted from the UI. Use the Terminal for recursive directory removal.

---

### 8.10 Logs (Journal)

Query the systemd journal on the selected host.

- **Unit filter**: filter by unit name (e.g. `sshd`, `nginx`) — filter is debounced 400 ms after typing stops
- **Line count**: configurable number of entries to fetch (default: 100)
- Each entry shows: timestamp, unit name, priority, message text
- **Refresh**: re-fetch with current filters
- Superuser password enables access to protected journal entries

---

### 8.11 Log Files

Browse and search plain-text log files in `/var/log` on the selected host.

**File list**

- Lists all files in `/var/log` recursively
- Shows filename, full path, size, last-modified time
- Filter list by filename
- Files owned by root that are not world-readable require the superuser password to be active

**Tail view**

Shows the last N lines of the selected file (default: 100, configurable).

**Search view**

Full-text search within the selected file:

| Option | Description |
|--------|-------------|
| Query | Search keyword or phrase |
| Before | Context lines before each match (default: 3) |
| After | Context lines after each match (default: 3) |
| Max results | Maximum number of matching lines returned (default: 100) |
| Date from / to | Filter entries by date range |
| Time from / to | Filter entries by time range within the selected dates |

Results show matched lines highlighted with surrounding context. Total match count displayed.

When a date/time range is set without a keyword the page switches to **date filter** mode — all lines within the time window are returned without a keyword match requirement.

**Common log files in `/var/log`**

| File / Directory | Description |
|-----------------|-------------|
| `syslog` or `messages` | General system messages (Debian/Ubuntu: `syslog`; RHEL/Fedora: `messages`) |
| `auth.log` or `secure` | Authentication events: SSH logins, sudo usage, PAM (Debian: `auth.log`; RHEL: `secure`) |
| `kern.log` | Kernel messages: hardware events, module loads, OOM killer |
| `dmesg` | Kernel ring buffer from boot |
| `boot.log` | Boot-time service startup messages |
| `journal/` | systemd journal binary files — use the **Logs** page to read these, not Log Files |
| `nginx/access.log`, `nginx/error.log` | nginx web server logs |
| `apache2/access.log`, `apache2/error.log` | Apache web server logs |
| `mysql/error.log` or `mariadb/error.log` | Database error log |
| `audit/audit.log` | Linux Audit daemon log (auditd) |
| `tenodera_audit.log` | Tenodera panel audit log (see below) |

**Tenodera audit log** (`/var/log/tenodera_audit.log`)

Tenodera writes its own structured audit log with one entry per line.

Events logged:
- **Login attempt** — username, source IP, success or failure reason
- **Logout** — username, session duration
- **Privilege escalation** — superuser password activation (username, host)

Log rotation is configured at `/etc/logrotate.d/tenodera`:

| Setting | Value |
|---------|-------|
| Frequency | Daily |
| Rotations kept | 3 |
| Max size | 1 GB (rotated early if exceeded) |
| Compression | gzip (`delaycompress` — previous rotation is compressed on the next run) |
| Method | `copytruncate` — file is copied then truncated; no service restart required after rotation |

---

### 8.12 Cron Jobs

View and manage cron jobs on the selected host.

**Sources**

Tenodera reads all crontab sources:
- `/etc/crontab` — system crontab
- `/etc/cron.d/*` — drop-in system cron files
- Per-user crontabs (`crontab -l -u <user>` for all users with a crontab)

**Entry list**

Each entry shows:
- **Source** — file path or "User: \<username\>" for user crontabs
- **Schedule** — raw cron expression (e.g. `0 3 * * *`) with a human-readable description:
  - `@reboot` → "At boot"
  - `@daily` / `@midnight` → "Daily"
  - `0 3 * * *` → "Daily at 03:00"
  - `*/6 * * * *` → "Every 6h"
  - etc.
- **User** — the user the command runs as
- **Command** — the command executed
- **Comment** — inline comment from the crontab file

**Edit** (admin only)

Click a source to open its raw content in an editor. Save writes the new crontab back to the file.

---

### 8.13 Kernel Dump (kdump)

Monitor kernel crash dump configuration on the selected host.

**Status panel**

| Field | Description |
|-------|-------------|
| Installed | Whether kdump is installed (`kdump-tools` on Debian, `kexec-tools` on RHEL/Fedora) |
| Service | Service name (`kdump` / `kdump-tools`), active state, enabled state |
| Crash kernel loaded | Whether a secondary kernel is loaded in reserved memory |
| Reserved memory | Bytes reserved for the crash kernel |
| Kernel version | Running kernel version |

**CrashKernel parameter**

- Current `crashkernel=` boot parameter value
- Whether it is configured (present in boot config)

**Config file**

- Path to the kdump config file
- Full file content displayed

**Crash dumps browser**

Lists existing crash dump directories (typically under `/var/crash`):

| Field | Description |
|-------|-------------|
| Name | Directory name |
| Type | Dump type |
| Size | Total size of dump directory |
| Has vmcore | Whether the vmcore file is present |
| Has dmesg | Whether a dmesg capture is present |
| Timestamp | Creation time |

- Expand a dump to see individual files (name, size, timestamp)
- **View dmesg**: reads and displays the dmesg capture inline

---

### 8.14 DNS

Manage DNS configuration on the selected host.

**Resolver tab** (write — admin only)

Displays and edits `/etc/resolv.conf`:
- Nameserver list
- Search domain list
- Edit mode: modify content and save

**`/etc/hosts` tab** (write — admin only)

Displays and edits `/etc/hosts`:
- Full file content in editable text area
- Save writes back to the file

**Lookup tab**

Interactive DNS lookup tool (wraps `dig`):

- Enter a hostname or IP address
- Select query type: A, AAAA, MX, NS, TXT, CNAME, PTR, SOA, SRV
- Results displayed as returned by `dig`

**systemd-resolved tab** (write — admin only)

- Shows whether `systemd-resolved` is active
- Displays resolved configuration
- Allows restarting the resolved service

---

### 8.15 Certificates

Manage TLS certificates on the selected host.

**Certificates tab**

Scans common certificate locations and lists installed certificates:

| Field | Description |
|-------|-------------|
| Common Name (CN) | Certificate subject CN |
| Issuer | Issuer CN and organization |
| Valid from | `notBefore` date |
| Valid until | `notAfter` date |
| Days remaining | Days until expiry (highlighted red when close) |
| SANs | Subject Alternative Names |
| Is CA | Whether this is a CA certificate |
| Source | File path where the certificate was found |

- Click a certificate to view full details
- **Import certificate** (admin only): paste PEM-encoded certificate and private key → validated before saving
- **Remove certificate** (admin only): requires superuser password

**Trust Store tab** (admin only)

Manage the system certificate trust store:
- List trusted CA certificates
- Add / remove trusted CAs

**Let's Encrypt tab**

Lists certificates managed by Certbot:
- Domain name, covered domains, expiry date, days remaining
- Paths to certificate and key files

**Self-Signed tab** (admin only)

Generate a self-signed TLS certificate:
- Common Name, validity period
- Generated certificate and key saved to specified paths

---

### 8.16 Management (admin only)

An admin-only panel for managing all connected agents from a single view.

**Host list**

Shows all hosts that have ever connected to this gateway:

| Column | Description |
|--------|-------------|
| Hostname | Agent hostname as reported in the `Hello` handshake |
| Display name | Custom label (editable inline) |
| Roles | Roles assigned to the host |
| Status | Online / offline, with last-seen timestamp |
| Uptime | Agent process uptime (online hosts only) |
| IP | Remote IP address of the agent connection |

- **Filter** by hostname or display name
- The panel host itself is labeled **Panel / Local** automatically

**Actions per host**

| Action | Description |
|--------|-------------|
| Edit display name | Set a custom label shown in the host selector |
| Edit roles | Add or remove role labels (comma-separated) |
| Restart agent | Sends a restart command to the agent service |
| Remove host | Removes the host from the registry (it will re-register on next connect) |

> **Note:** All actions on offline hosts (except Remove) are disabled.

**Host selector** (top bar, all users)

The host selector dropdown (top-left, showing the current hostname) is available to all logged-in users. Click it to:
- See all online and offline hosts
- Switch the active host — all pages then show data from the selected host
- Open **Manage hosts…** (Management page)

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
