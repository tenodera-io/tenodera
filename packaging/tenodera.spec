Name:           tenodera
Version:        %{version}
Release:        1%{?dist}
Summary:        Tenodera Panel — web administration panel (gateway + UI)
License:        MIT
URL:            https://github.com/tenodera-io/tenodera

BuildRequires:  rust cargo nodejs npm clang-devel pam-devel openssl-devel
Requires(pre):  shadow-utils
Requires:       tenodera-agent >= %{version}

%description
Tenodera gateway serves the web administration panel and routes
requests to Tenodera agents on managed hosts via WebSocket.

%pre
getent group tenodera-gw >/dev/null || groupadd -r tenodera-gw
getent passwd tenodera-gw >/dev/null || \
    useradd -r -s /sbin/nologin -M -d /nonexistent -g tenodera-gw \
            -c "Tenodera Gateway" tenodera-gw
exit 0

%install
install -D -m 755 %{_sourcedir}/tenodera-gateway %{buildroot}%{_bindir}/tenodera-gateway
install -D -m 4750 %{_sourcedir}/tenodera-pam-helper %{buildroot}%{_bindir}/tenodera-pam-helper
install -D -m 644 %{_sourcedir}/tenodera.service %{buildroot}%{_unitdir}/tenodera.service
# One-shot Caddy reverse-proxy setup (installs Caddy + Caddyfile post-install).
install -D -m 755 %{_sourcedir}/tenodera-setup-caddy.sh %{buildroot}%{_bindir}/tenodera-setup-caddy
install -D -m 644 %{_sourcedir}/tenodera-caddy-setup.service %{buildroot}%{_unitdir}/tenodera-caddy-setup.service
install -D -m 644 %{_sourcedir}/tenodera.logrotate %{buildroot}%{_sysconfdir}/logrotate.d/tenodera
install -D -m 644 %{_sourcedir}/tenodera.pam %{buildroot}%{_sysconfdir}/pam.d/tenodera
# UI assets
install -d %{buildroot}%{_datadir}/tenodera/ui
cp -r %{_sourcedir}/ui-dist/. %{buildroot}%{_datadir}/tenodera/ui/

%post
# The pam-helper ships root:root (the tenodera-gw group does not exist at build
# time). The group now exists, so fix ownership: the gateway runs
# as tenodera-gw and must be able to execute the setuid helper (4750).
if [ -e %{_bindir}/tenodera-pam-helper ]; then
    chgrp tenodera-gw %{_bindir}/tenodera-pam-helper
    chmod 4750 %{_bindir}/tenodera-pam-helper
fi

# Config and TLS directory, owned by the gateway group.
mkdir -p %{_sysconfdir}/tenodera/tls
chown root:tenodera-gw %{_sysconfdir}/tenodera %{_sysconfdir}/tenodera/tls
chmod 750 %{_sysconfdir}/tenodera %{_sysconfdir}/tenodera/tls

# Data directory the gateway writes to after dropping privileges.
mkdir -p /var/lib/tenodera-gw
chown tenodera-gw:tenodera-gw /var/lib/tenodera-gw
chmod 750 /var/lib/tenodera-gw

# Audit log.
touch /var/log/tenodera_audit.log
chown root:root /var/log/tenodera_audit.log
chmod 622 /var/log/tenodera_audit.log

# Default gateway config (HTTP mode) — never overwrite an existing one.
if [ ! -f %{_sysconfdir}/tenodera/tenodera.cnf ]; then
    cat > %{_sysconfdir}/tenodera/tenodera.cnf <<'CFG'
# Tenodera Panel Configuration
# Bound to loopback by default — the gateway is reachable only from this host.
# The installer fronts it with a Caddy HTTPS reverse proxy (see DOCS 4.3), so the
# panel is served on the network at https://<host> while this stays on 127.0.0.1.
# Without a proxy, reach it via SSH tunnel (ssh -L 9090:127.0.0.1:9090 <host>);
# only set 0.0.0.0 here if you enable TLS below and serve it directly.
TENODERA_BIND_ADDR=127.0.0.1
TENODERA_BIND_PORT=9090
TENODERA_AGENT_BIN=/usr/bin/tenodera-agent
TENODERA_UI_DIR=/usr/share/tenodera/ui

# TLS — optional. Uncomment and set cert/key paths to enable HTTPS,
# then remove TENODERA_ALLOW_UNENCRYPTED below.
#TENODERA_TLS_CERT=/etc/tenodera/tls/cert.pem
#TENODERA_TLS_KEY=/etc/tenodera/tls/key.pem

# HTTP mode (plain, no TLS) — enabled by default.
TENODERA_ALLOW_UNENCRYPTED=1

RUST_LOG=info
CFG
    chown root:tenodera-gw %{_sysconfdir}/tenodera/tenodera.cnf
    chmod 640 %{_sysconfdir}/tenodera/tenodera.cnf
fi

%systemd_post tenodera.service
if [ -d /run/systemd/system ]; then
    # `restart` covers both fresh install and upgrade — on upgrade it reloads the
    # new binary, which a plain `start` would not.
    systemctl enable tenodera.service || :
    systemctl restart tenodera.service || :
    # On a panel host the local agent's default config points here; the agent
    # package leaves it untouched, so enable and start it from here.
    systemctl enable tenodera-agent.service || :
    systemctl restart tenodera-agent.service || :
    # Install Caddy + a basic Caddyfile after this transaction releases the rpm
    # lock (a scriptlet can't install packages itself). Runs async and disables
    # itself on success; safe to re-run with `systemctl start tenodera-caddy-setup`.
    systemctl enable tenodera-caddy-setup.service || :
    systemctl start --no-block tenodera-caddy-setup.service || :
fi

%preun
%systemd_preun tenodera.service
if [ "$1" = 0 ] && [ -d /run/systemd/system ]; then
    # Full uninstall: drop the one-shot Caddy-setup unit's enablement (Caddy and
    # any Caddyfile are left in place — they are the operator's proxy).
    systemctl disable tenodera-caddy-setup.service || :
fi

%postun
# Plain postun (daemon-reload); the post scriptlet already restarts on upgrade,
# so avoid the double restart the with-restart variant would cause. (Do not name
# rpm macros in comments here — rpm expands them even inside shell comments.)
%systemd_postun tenodera.service
if [ "$1" = 0 ]; then
    # Full uninstall (not an upgrade): drop leftover package-owned UI content —
    # rpm removes the files it tracks but leaves the directory if anything else
    # ended up there. Configuration and state (/etc/tenodera, /var/lib/tenodera-gw)
    # are deliberately kept so a reinstall keeps working; rpm has no purge, so
    # remove those by hand or with: tenodera.sh --uninstall
    rm -rf /usr/share/tenodera
fi

%files
%{_bindir}/tenodera-gateway
# Packaged root:root 4750; the post scriptlet re-groups it to tenodera-gw once
# the group exists (declaring the group as an owner here would add an
# install-time Requires on the group, which is only created later).
%{_bindir}/tenodera-pam-helper
%{_bindir}/tenodera-setup-caddy
%{_unitdir}/tenodera.service
%{_unitdir}/tenodera-caddy-setup.service
%{_sysconfdir}/logrotate.d/tenodera
%{_sysconfdir}/pam.d/tenodera
%{_datadir}/tenodera/ui/

%changelog
* %(date "+%%a %%b %%d %%Y") Tenodera <noreply@tenodera> - %{version}-1
- Automated package build
