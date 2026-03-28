# Tenodera

A self-hosted Linux server administration panel with real-time monitoring,
terminal access, and multi-host management -- all from a single web interface.

```
Browser ──WS──> Gateway (:9090) ──SSH──> tenodera-bridge (remote host)
                                 ──spawn──> tenodera-bridge (localhost)
```

No daemon, no open ports, no API keys on managed hosts.
The gateway connects via SSH and spawns the bridge process on demand.

![MIT License](https://img.shields.io/badge/license-MIT-blue)

## Features

| Category | Capabilities |
|----------|-------------|
| **Dashboard** | CPU, RAM, swap, disk I/O, network I/O -- real-time streaming charts |
| **Terminal** | Full PTY shell in the browser (xterm.js) |
| **Services** | systemd unit management -- start / stop / restart / enable / disable |
| **Users & Groups** | User account CRUD, group management, lock/unlock, password policy |
| **Packages** | Installed packages, search, install, update, repository management (apt, dnf, pacman) |
| **Storage** | Block devices, mount points, partition usage, I/O charts |
| **Networking** | Interfaces, traffic, firewall (ufw/firewalld/nftables), bridges, VLANs, VPN |
| **Containers** | Docker / Podman -- containers, images, create, logs |
| **Files** | Remote file browser with sudo fallback |
| **Logs** | journald viewer with unit/priority filters and timestamps |
| **Log Files** | Browse `/var/log` with keyword search, context lines, date/time range |
| **Kernel Dump** | kdump status, crash kernel config, crash dump browser |
| **Multi-host** | Manage multiple servers from one panel with SSH host key verification |

## Quick Start

### Prerequisites

- Linux (Debian/Ubuntu, Fedora/RHEL, Arch)
- `make` and `sudo`
- `sshpass` on the gateway host (for remote host management)

```bash
sudo apt install make sshpass    # Debian/Ubuntu
sudo dnf install make sshpass    # Fedora/RHEL
sudo pacman -S make sshpass      # Arch
```

Everything else (Rust, Node.js, system libraries) is installed automatically
by `make deps`.

### One-Command Install (Panel)

```bash
cd panel
make all    # deps + build + install — full setup in one step
```

`make all` runs the following targets in order:

1. **`make deps`** -- installs Rust, Node.js, and system libraries
   (`build-essential`, `pkg-config`, `libssl-dev`, `libpam0g-dev`, etc.)
2. **`make build`** -- compiles the Rust gateway (`cargo build --release`)
   and builds the React frontend (`npm ci && npm run build`)
3. **`make install`** -- installs the gateway binary to `/usr/local/bin`,
   UI assets to `/usr/share/tenodera/ui`, systemd service, logrotate
   config, and starts the service

After `make all`, the panel is running and listening on port 9090.

### One-Command Install (Bridge)

On each managed host, copy the `bridge/` and `protocol/` directories, then:

```bash
cd bridge
make all    # deps + build + install
```

No service or daemon -- the gateway spawns the bridge over SSH when needed.

### Step-by-Step Install

If you prefer more control, run each target separately:

```bash
# Panel (gateway + UI):
cd panel
make deps             # Install Rust + Node.js + system libraries
make build            # Compile backend + frontend
sudo make install     # Install binaries, UI, systemd service

# Bridge (each managed host):
cd bridge
make deps             # Install Rust + system libraries
make build            # Compile bridge binary
sudo make install     # Install to /usr/local/bin/tenodera-bridge
```

### Make Targets Reference

#### Panel (`panel/Makefile`)

| Target | Description |
|--------|-------------|
| `make all` | Full setup: deps + build + install |
| `make deps` | Install all build dependencies (Rust, Node.js, system libs) |
| `make deps-system` | Install system packages only (`build-essential`, `libssl-dev`, etc.) |
| `make deps-rust` | Install Rust toolchain only (via rustup) |
| `make deps-node` | Install Node.js only (via nodesource) |
| `make build` | Build backend + frontend |
| `make build-backend` | Build gateway only (`cargo build --release`) |
| `make build-frontend` | Build UI only (`npm ci && npm run build`) |
| `make install` | Install gateway, UI, systemd service, logrotate config |
| `make uninstall` | Stop service, remove all installed files (keeps nothing) |
| `make clean` | Remove local build artifacts (`target/`, `node_modules/`, `dist/`) |

#### Bridge (`bridge/Makefile`)

| Target | Description |
|--------|-------------|
| `make all` | Full setup: deps + build + install |
| `make deps` | Install build dependencies (Rust, system libs) |
| `make build` | Build bridge binary (`cargo build --release`) |
| `make install` | Install to `/usr/local/bin/tenodera-bridge` |
| `make uninstall` | Remove bridge binary |
| `make clean` | Remove local build artifacts (`target/`) |

## Post-Install Configuration

### TLS or Plaintext

The gateway **requires TLS by default**. Choose one of the two options below.

#### Option A: TLS (recommended for production)

Generate or obtain a certificate and key, then configure:

```bash
# Place certificate and key
sudo mkdir -p /etc/tenodera/tls
sudo cp fullchain.pem /etc/tenodera/tls/cert.pem
sudo cp privkey.pem   /etc/tenodera/tls/key.pem
sudo chmod 600 /etc/tenodera/tls/key.pem

# Edit gateway config
sudo nano /etc/tenodera/gateway.env
```

Uncomment the TLS lines and remove the unencrypted option:

```
TENODERA_TLS_CERT=/etc/tenodera/tls/cert.pem
TENODERA_TLS_KEY=/etc/tenodera/tls/key.pem
#TENODERA_ALLOW_UNENCRYPTED=1
```

```bash
sudo systemctl restart tenodera-gateway
```

The panel is now running at `https://<your-ip>:9090`.

To generate a self-signed certificate for testing:

```bash
openssl req -x509 -newkey rsa:4096 -nodes -days 365 \
  -keyout /etc/tenodera/tls/key.pem \
  -out /etc/tenodera/tls/cert.pem \
  -subj "/CN=$(hostname)"
```

#### Option B: Plaintext HTTP (development only)

On first install, `make install` creates a default `gateway.env` with
plaintext enabled. If you need to re-enable it later, edit the config:

```bash
sudo nano /etc/tenodera/gateway.env
```

Set:

```
TENODERA_ALLOW_UNENCRYPTED=1
```

```bash
sudo systemctl restart tenodera-gateway
```

The panel is now running at `http://<your-ip>:9090`.

> **Warning:** Without TLS, passwords and session tokens are transmitted in
> cleartext. Only use this on trusted networks or for local development.

### Log In

Open the panel URL in your browser and log in with any PAM user
(system credentials on the gateway host). The user **must have sudo
privileges** -- login is rejected otherwise, since most panel operations
(package management, service control, user management) require root access.

### Add Remote Hosts

Open the panel UI, navigate to the **Hosts** page, and add a host by
IP or hostname. The panel scans the SSH host key fingerprint and asks
for confirmation before adding. The gateway will SSH to it and run
`tenodera-bridge` automatically.

**Requirement:** the PAM user you logged in with must be able to SSH into
the managed host with password authentication, and `tenodera-bridge` must
be installed on the remote host.

## Architecture

```
[ Browser ]
     |
     | WebSocket (channel-multiplexed JSON)
     v
[ Gateway ]   Axum HTTP/WS server, PAM auth, session management
     |
     |--- localhost: spawns tenodera-bridge directly
     |--- remote:    ssh user@host tenodera-bridge  (via sshpass)
     v
[ Bridge ]    stdin/stdout newline-delimited JSON, per-user process
     |
     |--- 21 handler modules (system, services, packages, users, terminal, ...)
```

- **Gateway** authenticates users via PAM, manages sessions, serves the
  React UI, and routes WebSocket channels to bridge processes.
- **Bridge** is a stateless binary that handles system operations.
  It communicates via newline-delimited JSON over stdin/stdout -- the same
  protocol for local and remote hosts.
- **Protocol** is a shared Rust crate defining the message types used by
  both gateway and bridge.

No agent daemon runs on managed hosts. No ports need to be opened.
The bridge binary just needs to exist at `/usr/local/bin/tenodera-bridge`.

## Configuration

All gateway settings live in a single file:

```
/etc/tenodera/gateway.env
```

Edit the file, then restart the service:

```bash
sudo nano /etc/tenodera/gateway.env
sudo systemctl restart tenodera-gateway
```

`make install` creates a default `gateway.env` with HTTP enabled. Subsequent
installs preserve your existing config.

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `TENODERA_BIND_ADDR` | `0.0.0.0` | Listen address |
| `TENODERA_BIND_PORT` | `9090` | Listen port |
| `TENODERA_BRIDGE_BIN` | `/usr/local/bin/tenodera-bridge` | Path to bridge binary |
| `TENODERA_UI_DIR` | `/usr/share/tenodera/ui` | Path to built UI assets |
| `TENODERA_TLS_CERT` | *(none)* | TLS certificate path (PEM) |
| `TENODERA_TLS_KEY` | *(none)* | TLS private key path (PEM) |
| `TENODERA_ALLOW_UNENCRYPTED` | `false` | Allow HTTP without TLS |
| `TENODERA_IDLE_TIMEOUT` | `900` | Session idle timeout (seconds) |
| `TENODERA_MAX_STARTUPS` | `20` | Max failed login attempts per IP (5-min window) |
| `RUST_LOG` | *(none)* | Log filter (e.g. `tenodera_gateway=debug`) |

### Managed Hosts

Hosts are stored in `/etc/tenodera/hosts.json` (managed via the panel UI).

To build `hosts.json` manually (e.g. for automation), each host entry
requires three generated values:

```bash
# id — random UUID v4
uuidgen

# added_at — RFC 3339 timestamp
date -u +"%Y-%m-%dT%H:%M:%S.%N+00:00"

# host_key — full SSH public key line (ed25519 preferred)
ssh-keyscan -p 22 -T 5 -- <address> 2>/dev/null | grep ssh-ed25519 | head -1
```

Example `hosts.json`:

```json
{
  "hosts": [
    {
      "id": "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d",
      "name": "web-server-01",
      "address": "192.168.56.11",
      "user": "",
      "ssh_port": 22,
      "added_at": "2026-03-28T12:00:00.000000000+00:00",
      "host_key": "192.168.56.11 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5..."
    }
  ]
}
```

Set `user` to an empty string to use the logged-in panel user for SSH.
The file should be owned by root with mode `0600`.

## Security

### Authentication

- **PAM authentication** via `unix_chkpwd` -- any valid Linux user
- **Sudo privilege check** at login -- users without sudo are rejected
- **Per-IP rate limiting** on login attempts (sliding window)
- **Session idle timeout** (default 15 minutes) with background reaper
- **Maximum session lifetime** (4 hours) regardless of activity
- **Password zeroization** -- session passwords stored as `Zeroizing<String>`,
  overwritten with zeros on drop

### Transport Security

- **TLS required by default** (rustls) -- plaintext must be explicitly enabled
- **SSH host key verification** -- fingerprint confirmed on first connect,
  `StrictHostKeyChecking=yes` enforced on all subsequent connections
- **CSRF Origin check** on all state-changing REST requests (POST/PUT/DELETE/PATCH)
- **WebSocket Origin validation** against Host header (prevents CSWSH)

### Session Management

- **Authenticated logout** requires `Authorization: Bearer <session_id>` header
- **WebSocket terminated on logout** -- 5-second polling detects session
  invalidation and sends close frame
- Core dumps disabled at startup to protect session passwords in memory

### Infrastructure

- **Hardened systemd service** (`NoNewPrivileges=yes`,
  `MemoryDenyWriteExecute=yes`, etc.)
- **HTTP security headers**: CSP, X-Frame-Options, X-Content-Type-Options,
  Referrer-Policy, Permissions-Policy
- **Structured audit logging** to `/var/log/tenodera_audit.log` -- login/logout,
  WebSocket sessions, host management, bridge spawning, superuser verification
- **Superuser rate limiting** -- 6 attempts per 15 minutes, reset on success
- **Firewall input validation** -- IP/CIDR, service names, port/protocol
  validated before passing to ufw/firewalld
- **Symlink-safe file listing** -- `symlink_metadata()` prevents traversal

### Audit Logging

All security-relevant actions are logged to `/var/log/tenodera_audit.log`
with structured JSON entries: login/logout, WebSocket sessions,
host management, bridge spawning, superuser verification, and
user/group management operations.

## Service Management

```bash
sudo systemctl status tenodera-gateway
sudo systemctl restart tenodera-gateway
journalctl -u tenodera-gateway -f
```

## Uninstall

```bash
# Panel (on the gateway host)
cd panel && sudo make uninstall

# Bridge (on each managed host)
cd bridge && sudo make uninstall
```

## Development

```bash
# Gateway
cd panel
cargo clippy && cargo build

# Frontend (dev server with HMR, proxies /api to :9090)
cd panel/ui
npm ci && npm run dev

# Bridge
cd bridge
cargo clippy && cargo build
```

## Project Structure

```
panel/                   Central server (gateway + UI)
  crates/gateway/        Axum HTTP/WS gateway, PAM auth, SSH transport
  ui/                    React 19 + TypeScript SPA (Vite 6)
  systemd/               systemd service file
  logrotate/             Log rotation config
  Makefile               Build & install

bridge/                  Standalone bridge binary (deployed to managed hosts)
  src/handlers/          21 handler modules
  Makefile               Build & install

protocol/                Shared message types (Rust library crate)
```

## License

[MIT](LICENSE)
