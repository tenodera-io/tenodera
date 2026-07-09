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
install -D -m 4755 -o root -g root %{_builddir}/tenodera-agent %{buildroot}%{_bindir}/tenodera-agent
install -D -m 644 %{_builddir}/agent/systemd/tenodera-agent.service %{buildroot}%{_unitdir}/tenodera-agent.service

%post
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
