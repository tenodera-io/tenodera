# systemd Service

systemd unit file for running the Tenodera gateway as a system service.

## tenodera-gateway.service

Installed to `/etc/systemd/system/tenodera-gateway.service` by `make install`.

### Security Hardening

The service file includes the following hardening directives:

| Directive | Description |
|-----------|-------------|
| `ProtectSystem=strict` | Entire filesystem read-only except explicit write paths |
| `ReadWritePaths=/etc/tenodera /var/log` | Allow writes to config and audit logs |
| `PrivateTmp=yes` | Isolated `/tmp` namespace |
| `NoNewPrivileges=yes` | Prevent privilege escalation via setuid/setgid |
| `ProtectKernelTunables=yes` | Block writes to `/proc/sys` and `/sys` |
| `ProtectKernelModules=yes` | Prevent kernel module loading |
| `ProtectControlGroups=yes` | Block writes to `/sys/fs/cgroup` |
| `RestrictNamespaces=yes` | Prevent namespace creation |
| `LockPersonality=yes` | Block execution domain changes |
| `MemoryDenyWriteExecute=yes` | Prevent W+X memory mappings |
| `RestrictSUIDSGID=yes` | Block creation of SUID/SGID files |

### Configuration

Override environment variables without editing the service file:

```bash
sudo systemctl edit tenodera-gateway
```

```ini
[Service]
Environment=TENODERA_TLS_CERT=/etc/tenodera/tls/cert.pem
Environment=TENODERA_TLS_KEY=/etc/tenodera/tls/key.pem
Environment=TENODERA_BIND_ADDR=0.0.0.0
```

```bash
sudo systemctl restart tenodera-gateway
```

### Logs

```bash
journalctl -u tenodera-gateway -f
```
