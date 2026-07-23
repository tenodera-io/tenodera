Name:           tenodera-agent
Version:        %{version}
Release:        1%{?dist}
Summary:        Tenodera Agent — runs on managed hosts
License:        MIT
URL:            https://github.com/tenodera-io/tenodera

BuildRequires:  rust cargo

%description
The tenodera-agent binary is installed on managed Linux servers.
It connects outbound to the Tenodera gateway over a persistent WebSocket
to perform system administration tasks — no inbound ports required.

%install
install -D -m 0755 %{_sourcedir}/tenodera-agent %{buildroot}%{_bindir}/tenodera-agent
install -D -m 644 %{_sourcedir}/tenodera-agent.service %{buildroot}%{_unitdir}/tenodera-agent.service

%post
# Default agent config — never overwrite an existing one. Default points at a
# local gateway; on a managed host, edit TENODERA_GATEWAY_URL to your panel.
mkdir -p %{_sysconfdir}/tenodera
if [ ! -f %{_sysconfdir}/tenodera/agent.cnf ]; then
    cat > %{_sysconfdir}/tenodera/agent.cnf <<'CFG'
# Tenodera Agent Configuration
# On a managed host, set this to your panel host, e.g. http://panel:9090
TENODERA_GATEWAY_URL=http://127.0.0.1:9090

# Uncomment if the gateway uses a self-signed TLS certificate:
# TENODERA_AGENT_ACCEPT_INSECURE=1

# Optional bootstrap token to skip pending-approval on first connect:
# TENODERA_BOOTSTRAP_TOKEN=<token>

# Optional: pin the gateway id to verify it on first connect (closes the TOFU
# window). Read it on the panel host: sudo cat /var/lib/tenodera-gw/gateway-id
# TENODERA_GATEWAY_ID=<gateway-id>
CFG
    chmod 640 %{_sysconfdir}/tenodera/agent.cnf
fi

# Enable but do not start: the gateway URL is host-specific, so leave starting
# to the operator (or to the panel package on a panel host).
%systemd_post tenodera-agent.service

%preun
%systemd_preun tenodera-agent.service

%postun
%systemd_postun_with_restart tenodera-agent.service

%files
%{_bindir}/tenodera-agent
%{_unitdir}/tenodera-agent.service

%changelog
* %(date "+%%a %%b %%d %%Y") Tenodera <noreply@tenodera> - %{version}-1
- Automated package build
