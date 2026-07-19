# tenodera-gateway

HTTP/WebSocket server with PAM authentication, session management,
TLS support, and reverse-WebSocket agent registry.

## Role in Architecture

The gateway is the central server accessible from the browser. It handles:

1. **Login** -- PAM authentication via `tenodera-pam-helper` subprocess, sudo privilege check
2. **WebSocket** -- channel-multiplexed transport to agent connections
3. **UI serving** -- static React SPA
4. **TLS** -- optional encryption (rustls)
5. **Multi-host** -- `AgentRegistry` routes channels to the correct agent by `host` field

```
Browser --> HTTPS/WSS --> Gateway (:9090) <-- outbound WS -- tenodera-agent (each host)
```

Agents connect outbound to `GET /api/agent`. The gateway performs an Ed25519
TOFU handshake (`Hello` → `Challenge` → `ChallengeResponse` → `HelloAck`).
New hosts enter **pending** state until approved by an admin, or auto-enroll
via a bootstrap token or loopback connection. Known hosts authenticate via
their stored public key with no manual approval. Multiple browser sessions
share the same agent connection via `AgentRegistry`.

## Modules

| Module | Description |
|--------|-------------|
| `main.rs` | Axum server setup, routing, shared state, core dump prevention |
| `auth.rs` | Login (PAM + sudo check), logout (Bearer auth required) |
| `ws.rs` | WebSocket upgrade, Origin validation, channel routing via AgentRegistry |
| `agent_ws.rs` | `GET /api/agent` endpoint — TOFU handshake + auth path resolution |
| `agent_auth.rs` | Ed25519 signature verification, bootstrap/pending registries, nonce generation |
| `agent_registry.rs` | In-memory registry of active agent WebSocket connections |
| `session.rs` | In-memory session store with idle timeout, max lifetime, and reaper |
| `pam.rs` | PAM authentication via `tenodera-pam-helper` subprocess, sudo privilege check via `sudo -l -U` |
| `config.rs` | Configuration from environment variables |
| `tls.rs` | TLS acceptor setup (tokio-rustls) |
| `hosts_config.rs` | Enrolled host registry (`/var/lib/tenodera-gw/hosts.json`) |
| `audit.rs` | Structured audit logging to `/var/log/tenodera_audit.log` |
| `rate_limit.rs` | Per-IP sliding-window login rate limiter |
| `security_headers.rs` | CSRF Origin check on mutating requests + HTTP security headers |

## HTTP Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/auth/login` | POST | Login (PAM auth + sudo check, rate-limited per IP) |
| `/api/auth/logout` | POST | Logout (requires `Authorization: Bearer <session_id>`) |
| `/api/ws` | GET | WebSocket upgrade for browser sessions (`?session_id=...`, Origin validated) |
| `/api/agent` | GET | WebSocket upgrade for agent connections (TOFU handshake) |
| `/api/hosts` | GET | List all registered hosts with status |
| `/api/hosts/{id}` | DELETE | Remove a host from the registry |
| `/api/hosts/{id}` | PATCH | Update host metadata (e.g. name) |
| `/api/agent/pending` | GET | List hosts awaiting admin approval |
| `/api/agent/pending/{fp}/approve` | POST | Approve a pending host by fingerprint |
| `/api/agent/tokens` | GET | List active bootstrap tokens |
| `/api/agent/tokens` | POST | Create a bootstrap token (TTL, single-use, re-enroll) |
| `/api/agent/tokens/{id}` | DELETE | Revoke a bootstrap token |
| `/api/health` | GET | Health check: `{ status, sessions, uptime_secs, version }` |
| `/api/health/ready` | GET | Readiness probe (200 OK \| 503) |
| `/*` | GET | UI file serving (SPA fallback) |

## WebSocket Channel Routing

When a browser client opens a channel:

- **No `host` field** -- returns a `host-required` error; all channels must specify a target host
- **With `host` field** -- host ID looked up in `AgentRegistry`; message forwarded to the
  appropriate agent connection. The `host` field is stripped before forwarding.

The gateway injects `_user` and `_role` from the authenticated session into every
channel's `ChannelOpenOptions` before forwarding to the agent. Handlers use `_role`
to enforce admin-only operations via `require_admin()`.

A background task polls for session existence every 5 seconds. When a session is
invalidated (logout or reaper), the WebSocket is terminated with a close frame.

## Security

### Authentication & Authorization

- PAM authentication via `tenodera-pam-helper` subprocess with login rate limiting (per-IP sliding window)
- Sudo privilege check at login (`sudo -l -U <user>`): sudo/wheel/admin users get `admin` role;
  non-sudo users are granted `readonly` role and can log in with restricted access
- Authenticated logout requires `Authorization: Bearer <session_id>` matching the body

### Session Security

- Session idle timeout (default 900s) with background reaper
- Maximum session lifetime (4 hours) regardless of activity
- Passwords stored as `Zeroizing<String>` -- overwritten with zeros on drop
- Core dumps disabled at startup to protect session passwords in memory

### Transport Security

- TLS required by default (`TENODERA_ALLOW_UNENCRYPTED=false`)
- CSRF Origin check on POST/PUT/DELETE/PATCH requests
- WebSocket Origin validation against Host header (prevents CSWSH)

### Headers & Hardening

- HTTP security headers (CSP, X-Frame-Options, X-Content-Type-Options,
  Referrer-Policy, Permissions-Policy)
- Hardened systemd service (`NoNewPrivileges=yes`, etc.)
- Structured audit logging with file permission enforcement

## Protocol (`tenodera-protocol`)

The gateway speaks the channel-multiplexed JSON protocol defined by the
`tenodera-protocol` **library crate** (`protocol/`, no binary) — the same format
on both hops it bridges: WebSocket (browser ↔ gateway) and stdin/stdout
(gateway ↔ agent).

### Message types

| Variant | Direction | Description |
|---------|-----------|-------------|
| `Open` | Client → Agent | Open a new channel (payload type + options) |
| `Ready` | Agent → Client | Channel is ready |
| `Data` | Bidirectional | Payload data (`serde_json::Value`) |
| `Control` | Bidirectional | Control signal on a channel |
| `Close` | Bidirectional | Channel close (`problem: None` = clean) |
| `Ping` / `Pong` | Bidirectional | Heartbeat |
| `AuthResult` | Agent → Client | Authentication result (used internally) |

### Wire format

Each message is a single newline-terminated JSON object with a `type`
discriminator:

```json
{"type":"open","channel":"ch1","payload":"system.info"}
{"type":"ready","channel":"ch1"}
{"type":"data","channel":"ch1","data":{"hostname":"server1"}}
{"type":"close","channel":"ch1"}
```

The `Open` message `#[serde(flatten)]`s `ChannelOpenOptions`, which itself
flattens an `extra: Map`, so fields like `host`, `path`, `unit`, `lines` appear
at the top level alongside `type`, `channel`, and `payload`.

Protocol modules: `message.rs` (the `Message` frame enum), `channel.rs`
(`ChannelOpenOptions`, `ChannelState`, `SuperuserMode`), `auth.rs` (Ed25519 TOFU
handshake types). The concrete payload types (`system.info`, `journal.query`,
…) are registered per-handler in the agent — see the agent's handler registry
for the current set.

## systemd Service

The gateway runs as `tenodera.service` (`panel/systemd/tenodera.service`,
installed to `/etc/systemd/system/` by `make install` / the package). It loads
`/etc/tenodera/tenodera.cnf` via `EnvironmentFile=`, so config changes take
effect on `sudo systemctl restart tenodera`; follow logs with
`journalctl -u tenodera -f`. TLS and bind-address settings are documented in
[DOCS.md](../../../DOCS.md); the application-level controls are in
[SECURITY.md](../../../SECURITY.md).

### Hardening directives

| Directive | Description |
|-----------|-------------|
| `ProtectSystem=strict` | Entire filesystem read-only except explicit write paths |
| `ReadWritePaths=/etc /var/log /home /var/mail` | Allow writes for user management, config, logs, and home dirs |
| `PrivateTmp=yes` | Isolated `/tmp` namespace |
| `NoNewPrivileges=yes` | Prevent privilege escalation via setuid/setgid |
| `ProtectKernelTunables=yes` | Block writes to `/proc/sys` and `/sys` |
| `ProtectKernelModules=yes` | Prevent kernel module loading |
| `ProtectControlGroups=yes` | Block writes to `/sys/fs/cgroup` |
| `RestrictNamespaces=yes` | Prevent namespace creation |
| `LockPersonality=yes` | Block execution domain changes |
| `MemoryDenyWriteExecute=yes` | Prevent W+X memory mappings |
| `RestrictSUIDSGID=no` | Required for `useradd`/`groupadd` lock file management |

**Note:** `ReadWritePaths` includes `/etc` because the agent (spawned as a child
of the gateway on the panel host) writes to `/etc/passwd`, `/etc/shadow`,
`/etc/group`, `/etc/gshadow`, and lock files like `/etc/.pwd.lock` for user and
group management; `/home` is needed to create home directories for new users.

## Dependencies

- `axum 0.8` -- HTTP/WebSocket framework
- `tokio` -- async runtime
- `tokio-rustls` + `rustls` -- TLS
- `tower-http` -- static file serving, CORS
- `serde` + `serde_json` -- JSON
- `uuid` -- session ID generation
- `zeroize` -- password memory safety
- `tracing` + `tracing-subscriber` -- structured logging
- `tenodera-protocol` -- shared message types
