# tenodera-agent

Standalone system management agent deployed on each managed host.

## Role in Architecture

The agent is a **long-running systemd service** that connects outbound to the
gateway over a persistent WebSocket. It is never spawned per-session and does
not communicate over stdin/stdout.

```
Gateway (:9090) <──WS── tenodera-agent (each managed host)
```

On startup the agent performs an Ed25519 TOFU handshake with the gateway
(`Hello` → `Challenge` → `ChallengeResponse` → `HelloAck`). On first connect
the host enters **pending** state until an admin approves it, or a bootstrap
token is provided to auto-enroll. Subsequent reconnects authenticate via the
stored public key with no further approval. Multiple user sessions share the
same agent connection via `AgentRegistry`.

## Handler Modules

39 handlers across 28 source modules.

### One-shot (open → ready + data + close)

| Handler | Payload | Description |
|---------|---------|-------------|
| `SystemInfoHandler` | `system.info` | Hostname, OS, uptime, kernel |
| `SystemPubkeyHandler` | `system.pubkey` | Host SSH public key |
| `HostConfigHandler` | `host.config` | Host roles, hostname, uptime from agent.cnf |
| `HostActionHandler` | `host.action` | Set role or restart host (admin only) |
| `SystemdUnitsHandler` | `systemd.units` | List all systemd units |
| `HardwareInfoHandler` | `hardware.info` | CPU, cores, MHz, temperature sensors |
| `TopProcessesHandler` | `top.processes` | Top 15 processes by CPU usage |
| `DiskUsageHandler` | `disk.usage` | Partition usage (total/used/free) |
| `NetworkStatsHandler` | `network.stats` | Interface stats, IPs, MAC, speed |
| `JournalQueryHandler` | `journal.query` | journald entries with unit/priority/lines filters |
| `FileListHandler` | `file.list` | Directory listing (sudo fallback, symlink-safe) |
| `SuperuserVerifyHandler` | `superuser.verify` | Password verification with rate limiting (6/15 min) |
| `MetricsSnapshotHandler` | `metrics.snapshot` | Single-shot CPU/RAM/disk/net snapshot |
| `NetworkingSnapshotHandler` | `networking.snapshot` | Single-shot network interfaces snapshot |
| `StorageSnapshotHandler` | `storage.snapshot` | Single-shot block device snapshot |
| `CronListHandler` | `cron.list` | All crontab sources (/etc/crontab, cron.d, user crontabs) |
| `CronManageHandler` | `cron.manage` | Edit raw crontab content |
| `SystemdTimersHandler` | `systemd.timers` | List systemd timers |
| `DnsInfoHandler` | `dns.info` | Contents of /etc/resolv.conf and /etc/hosts |
| `DnsManageHandler` | `dns.manage` | Write resolv.conf, hosts, flush cache (admin only) |
| `DnsLookupHandler` | `dns.lookup` | DNS query via `dig` |
| `DnsResolvedInfoHandler` | `dns.resolved.info` | systemd-resolved status and config |
| `DnsResolvedManageHandler` | `dns.resolved.manage` | Manage systemd-resolved settings (admin only) |
| `CertsListHandler` | `certs.list` | Scan TLS certificates from common system paths |
| `KdumpInfoHandler` | `kdump.info` | Kernel dump status and crash dump list |

### Streaming (open → ready, then continuous data until close)

| Handler | Payload | Description |
|---------|---------|-------------|
| `MetricsStreamHandler` | `metrics.stream` | CPU, memory, swap, load, disk/net I/O |
| `StorageStreamHandler` | `storage.stream` | Block device tree + I/O rates |
| `NetworkStreamHandler` | `networking.stream` | Per-interface TX/RX rates |

### Bidirectional (open → ready, then data commands)

| Handler | Payload | Description |
|---------|---------|-------------|
| `SystemdManageHandler` | `systemd.manage` | systemd service management (via D-Bus) |
| `ContainersHandler` | `container.manage` | Docker/Podman operations |
| `NetworkManageHandler` | `networking.manage` | Firewall (ufw/firewalld), bridges, VLANs, VPN |
| `PackagesHandler` | `packages.manage` | Package + repository management (apt/dnf/pacman) |
| `UsersManageHandler` | `users.manage` | User/group CRUD, lock/unlock, passwords |
| `HostsManageHandler` | `hosts.manage` | SSH key scanning |
| `LogFilesHandler` | `log.files` | Log file browsing + keyword search |
| `CertsManageHandler` | `certs.manage` | Trust store management, cert verify/save (admin only) |
| `CertsSelfSignedHandler` | `certs.selfsigned` | Self-signed certificate generation (admin only) |
| `CertsLetsEncryptHandler` | `certs.letsencrypt` | Let's Encrypt certificate management (admin only) |

### Bidirectional + Streaming (open → ready, stream + input)

| Handler | Payload | Description |
|---------|---------|-------------|
| `TerminalPtyHandler` | `terminal.pty` | Interactive PTY (fork + openpty) |

## Configuration

The agent reads `/etc/tenodera/agent.cnf` at startup:

```bash
TENODERA_GATEWAY_URL=https://<panel-host>:9090   # Gateway WebSocket endpoint (required)
# TENODERA_AGENT_ACCEPT_INSECURE=1              # Allow self-signed TLS (dev only)

# Optional: one or more roles for this host (comma or space separated).
# Roles group hosts in the Management page of the panel.
# role=web
# role=db,backup
```

Roles can be changed at runtime from the panel's **Management** page (admin only)
via the `host.action` / `set_role` handler — this rewrites the `role=` lines in
`agent.cnf` using `sudo tee` without restarting the agent.

## Privilege Model

The agent runs as root under systemd (installed root-owned, mode `0755`, with no
setuid bit). Privileged operations
use `sudo -S` with the password piped from the superuser context — the user
authenticates once via `superuser.verify`, and that password is used for
subsequent sudo calls within the session.

Admin-only operations check the `_role` field injected by the gateway into
channel options. Non-admin requests receive an error response without
attempting the privileged action.

## Security Features

- **File listing**: uses `symlink_metadata()` to prevent symlink traversal
- **Superuser verification**: rate-limited to 6 attempts per 15-minute
  window, reset on success
- **Admin guard**: `require_admin()` checks `_role` from gateway-injected
  session context before any privileged operation
- **Firewall input validation**: IP/CIDR addresses, service names, and
  port/protocol validated before passing to ufw/firewalld
- **Repository management**: supports DEB822 `.sources` format, proper
  system/drop-in section separation for apt

## Building

```bash
make deps     # install Rust toolchain + system libraries
make build    # cargo build --release
sudo make install   # install to /usr/local/bin/tenodera-agent
```

Or all at once:

```bash
make all      # deps + build + install
```

## Dependencies

- `tenodera-protocol` -- shared message types
- `tokio` -- async runtime
- `serde` + `serde_json` -- JSON serialization
- `nix` -- PTY, fork, setsid, ioctl
- `libc` -- raw syscalls (statvfs, ioctl, geteuid)
- `zbus` -- D-Bus client (systemd management)
- `async-trait` -- async trait methods
- `chrono` -- timestamps
- `tracing` -- structured logging
