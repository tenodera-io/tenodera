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
| **Packages** | Installed packages, search, install, update (apt, dnf, pacman) |
| **Storage** | Block devices, mount points, partition usage, I/O charts |
| **Networking** | Interfaces, traffic, firewall (ufw/firewalld/nftables), bridges, VLANs, VPN |
| **Containers** | Docker / Podman -- containers, images, create, logs |
| **Files** | Remote file browser with sudo fallback |
| **Logs** | Live journald viewer with unit/priority filters |
| **Log Files** | Browse `/var/log` with keyword search, context lines, date/time range |
| **Kernel Dump** | kdump status, crash kernel config, crash dump browser |
| **Multi-host** | Manage multiple servers from one panel |

## Installation

### Prerequisites

- Linux (Debian/Ubuntu, Fedora/RHEL, Arch)
- `make` and `sudo`
- `sshpass` on the gateway host (for remote host management)

```bash
sudo apt install make sshpass    # Debian/Ubuntu
sudo dnf install make sshpass    # Fedora/RHEL
```

Everything else (Rust, Node.js, system libraries) is installed automatically
by `make deps`.

### Step 1: Install the Panel (central server)

```bash
cd panel
make deps
make build
sudo make install
```

This installs the gateway binary, the UI assets, and the systemd service.

### Step 2: Configure TLS or Plaintext

The gateway **requires TLS by default**. Choose one of the two options below.

#### Option A: TLS (recommended for production)

Generate or obtain a certificate and key, then configure:

```bash
# Place certificate and key
sudo mkdir -p /etc/tenodera/tls
sudo cp fullchain.pem /etc/tenodera/tls/cert.pem
sudo cp privkey.pem   /etc/tenodera/tls/key.pem
sudo chmod 600 /etc/tenodera/tls/key.pem

# Configure the gateway
sudo systemctl edit tenodera-gateway
```

Add the following to the editor:

```ini
[Service]
Environment=TENODERA_TLS_CERT=/etc/tenodera/tls/cert.pem
Environment=TENODERA_TLS_KEY=/etc/tenodera/tls/key.pem
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

```bash
sudo systemctl edit tenodera-gateway
```

Add:

```ini
[Service]
Environment=TENODERA_ALLOW_UNENCRYPTED=1
```

```bash
sudo systemctl restart tenodera-gateway
```

The panel is now running at `http://<your-ip>:9090`.

> **Warning:** Without TLS, passwords and session tokens are transmitted in
> cleartext. Only use this on trusted networks or for local development.

### Step 3: Log In

Open the panel URL in your browser and log in with any PAM user
(system credentials on the gateway host).

### Step 4: Install the Bridge (each managed host)

Copy the `bridge/` and `protocol/` directories to each target host, then:

```bash
cd bridge
make deps
make build
sudo make install
```

No service to configure -- the gateway spawns the bridge over SSH when needed.

### Step 5: Add Remote Hosts

Open the panel UI, navigate to the **Hosts** page, and add the host by
IP or hostname. The gateway will SSH to it and run `tenodera-bridge`
automatically.

**Requirement:** the PAM user you logged in with must be able to SSH into
the managed host with password authentication.

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
     |--- 19 handler modules (system, services, packages, users, terminal, ...)
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

### Environment Variables

Set via `systemctl edit tenodera-gateway`:

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
| `TENODERA_MAX_STARTUPS` | `20` | Max concurrent unauthenticated connections |
| `RUST_LOG` | *(none)* | Log filter (e.g. `tenodera_gateway=debug`) |

### Managed Hosts

Hosts are stored in `/etc/tenodera/hosts.json` (managed via the panel UI).

## Authentication & Permissions

The panel authenticates against **PAM** -- you log in with any valid
Linux user credentials on the gateway host.

| Action | Permission |
|--------|-----------|
| Dashboard, metrics, logs, terminal | Any authenticated user |
| Start/stop/restart systemd services | Superuser verification (password re-entry) |
| Install/update packages | Superuser verification |
| Create/modify/delete users and groups | Superuser verification |
| Container operations (remove, pull, create) | Superuser verification |
| Browse files | Read permissions on the target host |

### How it Works

1. User logs in via PAM on the gateway
2. Gateway spawns a per-user bridge for localhost operations
3. For remote hosts, gateway connects via SSH using the session password
   and spawns `tenodera-bridge`
4. Privileged operations require password re-verification via `sudo`

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

# Frontend
cd panel/ui
npm ci && npm run dev       # dev server on :3000, proxies /api to :9090

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
  src/handlers/          19 handler modules
  Makefile               Build & install

protocol/                Shared message types (Rust library crate)
```

## License

[MIT](LICENSE)
