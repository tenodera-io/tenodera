# tenodera-bridge

Per-session system management backend for the Tenodera panel.

## Role in Architecture

For each user session, the gateway spawns a separate `tenodera-bridge`
process. On the local host it runs directly; on remote hosts it runs
over SSH. The bridge communicates via stdin/stdout using newline-delimited
JSON -- the same protocol in both cases.

```
Browser <-> WebSocket <-> Gateway <-> stdin/stdout <-> Bridge (per user)
```

The bridge is a **standalone binary** with no network listener.
It reads JSON messages from stdin, routes them to handler modules,
and writes responses to stdout.

## Handler Modules

21 handler structs across 19 source modules.

### One-shot (open -> ready + data + close)

| Handler | Payload | Description |
|---------|---------|-------------|
| `SystemInfoHandler` | `system.info` | Hostname, OS, uptime, kernel |
| `SystemdUnitsHandler` | `systemd.units` | List all systemd units |
| `HardwareInfoHandler` | `hardware.info` | CPU, cores, MHz, temperature sensors |
| `TopProcessesHandler` | `top.processes` | Top 15 processes by CPU usage |
| `DiskUsageHandler` | `disk.usage` | Partition usage (total/used/free) |
| `NetworkStatsHandler` | `network.stats` | Interface stats, IPs, MAC, speed |
| `JournalQueryHandler` | `journal.query` | journald entries with unit/priority/lines filters |
| `FileListHandler` | `file.list` | Directory listing (sudo fallback, symlink-safe) |
| `SuperuserVerifyHandler` | `superuser.verify` | Password verification with rate limiting (6/15min) |

### Streaming (open -> ready, then continuous data until close)

| Handler | Payload | Description |
|---------|---------|-------------|
| `MetricsStreamHandler` | `metrics.stream` | CPU, memory, swap, load, disk/net I/O |
| `StorageStreamHandler` | `storage.stream` | Block device tree + I/O rates |
| `NetworkStreamHandler` | `networking.stream` | Per-interface TX/RX rates |

### Bidirectional (open -> ready, then data commands)

| Handler | Payload | Description |
|---------|---------|-------------|
| `SystemdManageHandler` | `systemd.manage` | systemd service management (via D-Bus) |
| `ContainersHandler` | `container.manage` | Docker/Podman operations |
| `NetworkManageHandler` | `networking.manage` | Firewall (ufw/firewalld), bridges, VLANs, VPN |
| `PackagesHandler` | `packages.manage` | Package + repository management (apt/dnf/pacman) |
| `UsersManageHandler` | `users.manage` | User/group CRUD, lock/unlock, passwords |
| `HostsManageHandler` | `hosts.manage` | Remote host CRUD, SSH key scanning |
| `LogFilesHandler` | `log.files` | Log file browsing + keyword search |
| `KdumpInfoHandler` | `kdump.info` | Kernel dump status + crash dumps |

### Bidirectional + Streaming (open -> ready, stream + input)

| Handler | Payload | Description |
|---------|---------|-------------|
| `TerminalPtyHandler` | `terminal.pty` | Interactive PTY (fork + openpty) |

## Privilege Model

The bridge detects whether it runs as root (`euid == 0`) or as a normal
user. When running as root (local bridge spawned by the gateway systemd
service), privileged commands like `useradd` are executed directly.
When running as a non-root user (remote bridge spawned via SSH), the
bridge uses `sudo -S` and pipes the user's password via stdin.

## Security Features

- **File listing**: uses `symlink_metadata()` to prevent symlink traversal
- **Superuser verification**: rate-limited to 6 attempts per 15-minute
  window, reset on success
- **Firewall input validation**: IP/CIDR addresses, service names, and
  port/protocol validated before passing to ufw/firewalld
- **Repository management**: supports DEB822 `.sources` format, proper
  system/drop-in section separation for apt

## Building

```bash
make deps     # install Rust toolchain + system libraries
make build    # cargo build --release
sudo make install   # install to /usr/local/bin/tenodera-bridge
```

Or all at once:

```bash
make all      # deps + build + install
```

## Testing Manually

```bash
echo '{"type":"ping"}' | tenodera-bridge
# {"type":"pong"}

echo '{"type":"open","channel":"ch1","payload":"system.info"}' | tenodera-bridge
# {"type":"ready","channel":"ch1"}
# {"type":"data","channel":"ch1","data":{...}}
# {"type":"close","channel":"ch1"}
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
