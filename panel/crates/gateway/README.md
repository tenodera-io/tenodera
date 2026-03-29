# tenodera-gateway

HTTP/WebSocket server with PAM authentication, session management,
TLS support, and SSH-based remote host management.

## Role in Architecture

The gateway is the central server accessible from the browser. It handles:

1. **Login** -- PAM authentication via `tenodera-pam-helper` subprocess, sudo privilege check
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
| `main.rs` | Axum server setup, routing, shared state, core dump prevention |
| `auth.rs` | Login (PAM + sudo check), logout (Bearer auth required) |
| `ws.rs` | WebSocket upgrade, Origin validation, channel routing, session polling |
| `session.rs` | In-memory session store with idle timeout, max lifetime, and reaper |
| `bridge_transport.rs` | Bridge spawning (local + remote via SSH with host key verification) |
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
| `/api/ws` | GET | WebSocket upgrade (`?session_id=...`, Origin validated) |
| `/api/health` | GET | Health check |
| `/*` | GET | UI file serving (SPA fallback) |

## WebSocket Channel Routing

When a client opens a channel:

- **No `host` field** -- routed to the local bridge (spawned at WS connect)
- **With `host` field** -- looked up in `hosts.json`, remote bridge spawned
  via SSH on first use, then reused for the session

The gateway injects `_user` from the authenticated session into every
message before forwarding to the bridge. The `host` field is stripped.

A background task polls for session existence every 5 seconds. When a
session is invalidated (logout or reaper), the WebSocket is terminated
with a close frame.

## Remote Bridge Spawning

```
sshpass -e ssh -o StrictHostKeyChecking=yes -o UserKnownHostsFile=<tempfile> user@host tenodera-bridge
```

- SSH host key verified against fingerprint confirmed during host enrollment
- Known hosts stored in a per-connection tempfile (kept alive for session duration)
- Password passed via `SSHPASS` environment variable (not visible in process list)
- Bridge communicates over SSH stdin/stdout using newline-delimited JSON
- One remote bridge per host per WebSocket session

## Security

### Authentication & Authorization

- PAM authentication via `tenodera-pam-helper` subprocess with login rate limiting (per-IP sliding window)
- Sudo privilege check at login (`sudo -l -U <user>`) -- users without sudo are rejected
- Authenticated logout requires `Authorization: Bearer <session_id>` matching the body

### Session Security

- Session idle timeout (default 900s) with background reaper
- Maximum session lifetime (4 hours) regardless of activity
- Passwords stored as `Zeroizing<String>` -- overwritten with zeros on drop
- Core dumps disabled at startup to protect session passwords in memory

### Transport Security

- TLS required by default (`TENODERA_ALLOW_UNENCRYPTED=false`)
- SSH host key verification with `StrictHostKeyChecking=yes`
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
- `tempfile` -- SSH known hosts per-connection
- `tracing` + `tracing-subscriber` -- structured logging
- `tenodera-protocol` -- shared message types
