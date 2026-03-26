# tenodera-gateway

HTTP/WebSocket server with PAM authentication, session management,
TLS support, and SSH-based remote host management.

## Role in Architecture

The gateway is the central server accessible from the browser. It handles:

1. **Login** -- PAM authentication via `unix_chkpwd`
2. **WebSocket** -- channel-multiplexed transport to bridge processes
3. **UI serving** -- static React SPA
4. **TLS** -- optional encryption (rustls)
5. **Multi-host** -- routing channels to local or remote bridge via SSH

```
Browser --> HTTPS/WSS --> Gateway (:9090) --> stdin/stdout --> Bridge (localhost)
                                          --> SSH --> Bridge (remote host)
```

## Modules

| Module | Description |
|--------|-------------|
| `main.rs` | Axum server setup, routing, shared state |
| `auth.rs` | `POST /api/auth/login` and `POST /api/auth/logout` |
| `ws.rs` | WebSocket upgrade, channel routing to local/remote bridges |
| `session.rs` | In-memory session store with idle timeout and reaper |
| `bridge_transport.rs` | Bridge process spawning (local and remote via SSH) |
| `pam.rs` | PAM authentication via `unix_chkpwd` subprocess |
| `config.rs` | Configuration from environment variables |
| `tls.rs` | TLS acceptor setup (tokio-rustls) |
| `hosts_config.rs` | Remote host config (`/etc/tenodera/hosts.json`) |
| `audit.rs` | Structured audit logging to `/var/log/tenodera_audit.log` |
| `rate_limit.rs` | Per-IP sliding-window login rate limiter |
| `security_headers.rs` | HTTP security headers middleware |

## HTTP Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/auth/login` | POST | Login (user/password via PAM) |
| `/api/auth/logout` | POST | Logout (invalidate session) |
| `/api/ws` | GET | WebSocket upgrade (`?session_id=...`) |
| `/api/health` | GET | Health check |
| `/*` | GET | UI file serving (SPA fallback) |

## WebSocket Channel Routing

When a client opens a channel:

- **No `host` field** -- routed to the local bridge (spawned at WS connect)
- **With `host` field** -- looked up in `hosts.json`, remote bridge spawned
  via SSH on first use, then reused for the session

The gateway injects `_user` from the authenticated session into every
message before forwarding to the bridge. The `host` field is stripped.

## Remote Bridge Spawning

```
sshpass -e ssh -o StrictHostKeyChecking=accept-new user@host tenodera-bridge
```

- Password passed via `SSHPASS` environment variable (not visible in process list)
- Bridge communicates over SSH stdin/stdout using newline-delimited JSON
- One remote bridge per host per WebSocket session

## Security

- PAM authentication with login rate limiting (per-IP sliding window)
- Session idle timeout (default 900s) with background reaper
- TLS required by default (`TENODERA_ALLOW_UNENCRYPTED=false`)
- HTTP security headers (CSP, X-Frame-Options, HSTS, etc.)
- WebSocket Origin validation against Host header
- Hardened systemd service (`ProtectSystem=strict`, `NoNewPrivileges=yes`, etc.)
- Structured audit logging with file permission enforcement
- All privileged operations (user management, package operations,
  service control) require superuser password re-verification

## Dependencies

- `axum 0.8` -- HTTP/WebSocket framework
- `tokio` -- async runtime
- `tokio-rustls` + `rustls` -- TLS
- `tower-http` -- static file serving
- `serde` + `serde_json` -- JSON
- `uuid` -- session ID generation
- `tracing` + `tracing-subscriber` -- structured logging
- `tenodera-protocol` -- shared message types
