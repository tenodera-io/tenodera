# tenodera-protocol

Shared type library defining the channel-based communication protocol
between the gateway and bridge.

## Role in Architecture

`tenodera-protocol` is a **library crate** -- it produces no binary.
Both `tenodera-gateway` and `tenodera-bridge` depend on it. It defines
the message format for channel-multiplexed JSON communication over
WebSocket (browser <-> gateway) and stdin/stdout (gateway <-> bridge).

## Message Types

| Variant | Direction | Description |
|---------|-----------|-------------|
| `Open` | Client -> Bridge | Open a new channel (payload type + options) |
| `Ready` | Bridge -> Client | Channel is ready |
| `Data` | Bidirectional | Payload data (`serde_json::Value`) |
| `Control` | Bidirectional | Control signal on a channel |
| `Close` | Bidirectional | Channel close (`problem: None` = clean) |
| `Ping` | Bidirectional | Heartbeat |
| `Pong` | Bidirectional | Heartbeat response |

## Payload Types

Known payload types registered in the `Payload` enum:

| Payload | Handler | Description |
|---------|---------|-------------|
| `system.info` | `SystemInfoHandler` | System overview |
| `systemd.units` | `SystemdUnitsHandler` | List systemd units |
| `systemd.manage` | `SystemdManageHandler` | Manage systemd services |
| `journal.query` | `JournalQueryHandler` | Query journald |
| `file.list` | `FileListHandler` | Directory listing |
| `terminal.pty` | `TerminalPtyHandler` | Interactive PTY |
| `metrics.stream` | `MetricsStreamHandler` | Real-time system metrics |
| `disk.usage` | `DiskUsageHandler` | Partition usage |
| `network.stats` | `NetworkStatsHandler` | Interface statistics |
| `networking.stream` | `NetworkStreamHandler` | Network I/O streaming |
| `networking.manage` | `NetworkManageHandler` | Firewall, bridges, VPN |
| `storage.stream` | `StorageStreamHandler` | Block device I/O streaming |
| `container.manage` | `ContainersHandler` | Docker/Podman operations |
| `packages.manage` | `PackagesHandler` | Package management |
| `users.manage` | `UsersManageHandler` | User/group management |
| `hosts.manage` | `HostsManageHandler` | Remote host CRUD |
| `log.files` | `LogFilesHandler` | Log file browsing |
| `kdump.info` | `KdumpInfoHandler` | Kernel dump status |
| `superuser.verify` | `SuperuserVerifyHandler` | Password verification |
| `hardware.info` | `HardwareInfoHandler` | Hardware details |
| `top.processes` | `TopProcessesHandler` | Top processes by CPU |

## Wire Format

Each message is a single JSON object with a `type` field:

```json
{"type":"open","channel":"ch1","payload":"system.info"}
{"type":"ready","channel":"ch1"}
{"type":"data","channel":"ch1","data":{"hostname":"server1"}}
{"type":"close","channel":"ch1"}
{"type":"ping"}
{"type":"pong"}
```

## Modules

| Module | Description |
|--------|-------------|
| `message.rs` | `Message` enum -- all protocol frames |
| `channel.rs` | `ChannelOpenOptions`, `ChannelState`, `SuperuserMode` |
| `payload.rs` | `Payload` enum -- known payload type registry |
| `error.rs` | `ProtocolError` -- typed error variants |

## Dependencies

- `serde` + `serde_json` -- JSON serialization
- `thiserror` -- declarative error types
