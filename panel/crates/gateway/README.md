# tenodera-gateway

HTTP/WebSocket server with PAM authentication, session management,
TLS support, and reverse-WebSocket bridge registry.

## Role in Architecture

The gateway is the central server accessible from the browser. It handles:

1. **Login** -- PAM authentication via `tenodera-pam-helper` subprocess, sudo privilege check
2. **WebSocket** -- channel-multiplexed transport to bridge connections
3. **UI serving** -- static React SPA
4. **TLS** -- optional encryption (rustls)
5. **Multi-host** -- `BridgeRegistry` routes channels to the correct bridge by `host` field

```
Browser --> HTTPS/WSS --> Gateway (:9090) <-- outbound WS -- tenodera-bridge (each host)
```

Bridges connect outbound to `GET /api/bridge`. The gateway auto-registers each host
on first connect using the hostname from the `Hello` handshake (Zabbix-style). Multiple
user WebSocket sessions share the same bridge connection via `BridgeRegistry`.

## Modules

| Module | Description |
|--------|-------------|
| `main.rs` | Axum server setup, routing, shared state, core dump prevention |
| `auth.rs` | Login (PAM + sudo check), logout (Bearer auth required) |
| `ws.rs` | WebSocket upgrade, Origin validation, channel routing via BridgeRegistry |
| `bridge_ws.rs` | `GET /api/bridge` endpoint — Hello/HelloAck handshake, bridge auto-registration |
| `bridge_registry.rs` | In-memory registry of active bridge WebSocket connections |
| `session.rs` | In-memory session store with idle timeout, max lifetime, and reaper |
| `bridge_transport.rs` | Declared but unused — dead code from a previous SSH-based architecture |
| `pam.rs` | PAM authentication via `tenodera-pam-helper` subprocess, sudo privilege check via `sudo -l -U` |
| `config.rs` | Configuration from environment variables |
| `tls.rs` | TLS acceptor setup (tokio-rustls) |
| `hosts_config.rs` | Remote host config (`/etc/tenodera/hosts.json`) |
| `audit.rs` | Structured audit logging to `/var/log/tenodera_audit.log` |
| `rate_limit.rs` | Per-IP sliding-window login rate limiter |
| `security_headers.rs` | CSRF Origin check on mutating requests + HTTP security headers |

## HTTP Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/auth/login` | POST | Login (PAM auth + sudo check, rate-limited per IP) |
| `/api/auth/logout` | POST | Logout (requires `Authorization: Bearer <session_id>`) |
| `/api/ws` | GET | WebSocket upgrade for browser sessions (`?session_id=...`, Origin validated) |
| `/api/bridge` | GET | WebSocket upgrade for bridge connections (Hello/HelloAck handshake) |
| `/api/hosts` | GET | List all registered hosts with status |
| `/api/hosts/{id}` | DELETE | Remove a host from the registry |
| `/api/hosts/{id}` | PATCH | Update host metadata (e.g. name) |
| `/api/health` | GET | Health check: `{ status, sessions, uptime_secs, version }` |
| `/api/health/ready` | GET | Readiness probe (200 OK \| 503) |
| `/*` | GET | UI file serving (SPA fallback) |

## WebSocket Channel Routing

When a browser client opens a channel:

- **No `host` field** -- returns a `host-required` error; all channels must specify a target host
- **With `host` field** -- host ID looked up in `BridgeRegistry`; message forwarded to the
  appropriate bridge connection. The `host` field is stripped before forwarding.

The gateway injects `_user` and `_role` from the authenticated session into every
channel's `ChannelOpenOptions` before forwarding to the bridge. Handlers use `_role`
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
