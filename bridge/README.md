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

### One-shot (open -> ready + data + close)

| Handler | Payload | Description |
|---------|---------|-------------|
| `SystemInfoHandler` | `system.info` | Hostname, OS, uptime, kernel |
| `HardwareInfoHandler` | `hardware.info` | CPU, cores, MHz, temperature sensors |
| `TopProcessesHandler` | `top.processes` | Top 15 processes by CPU usage |
| `DiskUsageHandler` | `disk.usage` | Partition usage (total/used/free) |
| `NetworkStatsHandler` | `network.stats` | Interface stats, IPs, MAC, speed |
| `JournalQueryHandler` | `journal.query` | journald entries with filters |
| `FileListHandler` | `file.list` | Directory listing (sudo fallback) |
| `SuperuserVerifyHandler` | `superuser.verify` | Password verification via `unix_chkpwd` |

### Streaming (open -> ready, then continuous data until close)

| Handler | Payload | Description |
|---------|---------|-------------|
| `MetricsStreamHandler` | `metrics.stream` | CPU, memory, swap, load, disk/net I/O |
| `StorageStreamHandler` | `storage.stream` | Block device tree + I/O rates |
| `NetworkStreamHandler` | `networking.stream` | Per-interface TX/RX rates |
| `TerminalPtyHandler` | `terminal.pty` | Interactive PTY (fork + openpty) |

### Bidirectional (open -> ready, then data commands)

| Handler | Payload | Description |
|---------|---------|-------------|
| `SystemdManageHandler` | `systemd.manage` | systemd service management |
| `ContainersHandler` | `container.manage` | Docker/Podman operations |
| `NetworkManageHandler` | `networking.manage` | Firewall, bridges, VLANs, VPN |
| `PackagesHandler` | `packages.manage` | Package management (apt/dnf/pacman) |
| `HostsManageHandler` | `hosts.manage` | Remote host CRUD |
| `LogFilesHandler` | `log.files` | Log file browsing + search |
| `KdumpHandler` | `kdump.info` | Kernel dump status + crash dumps |

## Building

```bash
make deps     # install Rust toolchain + system libraries
make build    # cargo build --release
sudo make install   # install to /usr/local/bin/tenodera-bridge
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
- `libc` -- raw syscalls (statvfs, ioctl, fcntl)
- `async-trait` -- async trait methods
- `chrono` -- timestamps
- `tracing` -- structured logging
