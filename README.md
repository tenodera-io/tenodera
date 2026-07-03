# Tenodera

<p align="center">
  <img src="src/tenodera.webp" alt="Tenodera" width="400" />
</p>

A self-hosted Linux server administration panel with real-time monitoring,
terminal access, and multi-host management — all from a single web interface.

```
Browser ──WSS──> Gateway (:9090) <──WS── tenodera-agent (remote host)
                                 <──WS── tenodera-agent (localhost)
```

No open inbound ports on managed hosts.
Each agent connects outbound to the gateway over a persistent WebSocket.

![MIT License](https://img.shields.io/badge/license-MIT-blue)

## Features

| Category | Capabilities |
|----------|-------------|
| **Dashboard** | CPU, RAM, swap, disk I/O, network I/O — real-time streaming charts |
| **Terminal** | Full PTY shell in the browser (xterm.js) |
| **Services** | systemd unit management — start / stop / restart / enable / disable |
| **Users & Groups** | User account CRUD, group management, lock/unlock, password policy |
| **Packages** | Installed packages, search, install, update, repository management (apt, dnf, pacman) |
| **Storage** | Block devices, mount points, partition usage, I/O charts |
| **Networking** | Interfaces, traffic, firewall (ufw / firewalld / nftables), bridges, VLANs |
| **Containers** | Docker / Podman — containers, images, create, logs |
| **Files** | Remote file browser with sudo fallback |
| **Logs** | journald viewer with unit/priority filters |
| **Log Files** | Browse `/var/log` with keyword search and date/time range |
| **Cron Jobs** | List all crontab sources, view entries, edit raw crontab |
| **Kernel Dump** | kdump status, crash kernel config, crash dump browser |
| **DNS** | `/etc/resolv.conf` and `/etc/hosts` editing, DNS lookup, systemd-resolved |
| **Certificates** | TLS certificate scanning, trust store, self-signed generation, Let's Encrypt |
| **Multi-host** | Manage multiple servers from one panel via reverse-WebSocket agent |
| **Access control** | Admin (sudo/wheel users) — full access; other users — read-only |

## Install

### 1. Panel host

Run on the machine that will host the panel:

```bash
curl -sSfL https://raw.githubusercontent.com/ultherego/Tenodera/main/tenodera.sh | sudo bash
```

Installs build dependencies, compiles from source (~3–4 min), installs systemd services, and starts the panel on port 9090. The local agent is installed and enrolled automatically.

Open `http://<host>:9090` and log in with any PAM system user that has `sudo` privileges.

### 2. Remote hosts

Run on each host you want to manage:

```bash
curl -sSfL https://raw.githubusercontent.com/ultherego/Tenodera/main/tenodera-agent.sh \
  | sudo bash -s -- --gateway http://<panel-host>:9090
```

The agent connects outbound — no inbound ports needed. On first connect it waits for approval; go to **Management → Pending** in the panel and click **Approve**.

### 3. Unattended installs (optional)

To skip the approval step, generate a bootstrap token first (**Management → Tokens**), then pass it to the installer:

```bash
curl -sSfL https://raw.githubusercontent.com/ultherego/Tenodera/main/tenodera-agent.sh \
  | sudo bash -s -- --gateway http://<panel-host>:9090 --token <token>
```

The host enrolls immediately without manual approval.

> See [DOCS.md](DOCS.md) for TLS setup, configuration reference, and more.

## Uninstall

```bash
# Panel host (removes gateway, agent, UI, config, services):
curl -sSfL https://raw.githubusercontent.com/ultherego/Tenodera/main/tenodera.sh \
  | sudo bash -s -- --uninstall

# Managed hosts (agent only):
curl -sSfL https://raw.githubusercontent.com/ultherego/Tenodera/main/tenodera-agent.sh \
  | sudo bash -s -- --uninstall
```

## Screenshots

<details>
<summary>Click to expand</summary>

### Dashboard
![Dashboard](src/dashboard.webp)

### Terminal
![Terminal](src/term.webp)

### Services
![Services](src/services.webp)

### Networking
![Networking](src/net_overview.webp)

### Packages
![Packages](src/packages.webp)

### Users
![Users](src/users.webp)

</details>

## License

[MIT](LICENSE)
