# systemd Service

systemd unit file for running the Tenodera gateway as a system service.

## tenodera-gateway.service

Installed to `/etc/systemd/system/tenodera-gateway.service` by `make install`.

### Security Hardening

The service file includes the following hardening directives:

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

**Note:** `ReadWritePaths` includes `/etc` because the bridge (spawned as a
child of the gateway) needs to write to `/etc/passwd`, `/etc/shadow`,
`/etc/group`, `/etc/gshadow`, and create lock files like `/etc/.pwd.lock`
for user and group management operations. The `/home` path is needed for
creating home directories when adding new users.

### Application-Level Security

Beyond systemd hardening, the gateway enforces:

- **TLS required by default** -- plaintext must be explicitly enabled
- **CSRF Origin check** on all state-changing HTTP requests
- **WebSocket Origin validation** against Host header
- **HTTP security headers** (CSP, X-Frame-Options, X-Content-Type-Options,
  Referrer-Policy, Permissions-Policy)
- **Session idle timeout** (15 min default) and maximum lifetime (4 hours)
- **Password zeroization** in memory on session drop
- **Core dumps disabled** at startup to protect secrets in memory
- **Audit logging** to `/var/log/tenodera_audit.log`

### Configuration

Override environment variables without editing the service file:

```bash
sudo systemctl edit tenodera-gateway
```

#### TLS (recommended for production)

```ini
[Service]
Environment=TENODERA_TLS_CERT=/etc/tenodera/tls/cert.pem
Environment=TENODERA_TLS_KEY=/etc/tenodera/tls/key.pem
```

#### Plaintext HTTP (development only)

```ini
[Service]
Environment=TENODERA_ALLOW_UNENCRYPTED=1
```

#### Custom bind address

```ini
[Service]
Environment=TENODERA_BIND=0.0.0.0:9090
```

Then restart:

```bash
sudo systemctl restart tenodera-gateway
```

### Logs

```bash
journalctl -u tenodera-gateway -f
```

### Audit Log

```bash
tail -f /var/log/tenodera_audit.log
```
