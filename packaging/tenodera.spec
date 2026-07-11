Name:           tenodera
Version:        %{version}
Release:        1%{?dist}
Summary:        Tenodera Panel — web administration panel (gateway + UI)
License:        MIT
URL:            https://github.com/tenodera-io/tenodera

BuildRequires:  rust cargo nodejs npm clang-devel pam-devel openssl-devel
Requires(pre):  shadow-utils

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
install -D -m 755 %{_builddir}/tenodera-gateway %{buildroot}%{_bindir}/tenodera-gateway
install -D -m 4750 %{_builddir}/tenodera-pam-helper %{buildroot}%{_bindir}/tenodera-pam-helper
install -D -m 644 %{_builddir}/panel/systemd/tenodera.service %{buildroot}%{_unitdir}/tenodera.service
install -D -m 644 %{_builddir}/panel/logrotate/tenodera %{buildroot}%{_sysconfdir}/logrotate.d/tenodera
install -D -m 644 %{_builddir}/panel/pam.d/tenodera %{buildroot}%{_sysconfdir}/pam.d/tenodera
# UI assets
install -d %{buildroot}%{_datadir}/tenodera/ui
cp -r %{_builddir}/panel/ui/dist/. %{buildroot}%{_datadir}/tenodera/ui/

%post
%systemd_post tenodera.service

%preun
%systemd_preun tenodera.service

%postun
%systemd_postun_with_restart tenodera.service

%files
%{_bindir}/tenodera-gateway
%attr(4750,root,tenodera-gw) %{_bindir}/tenodera-pam-helper
%{_unitdir}/tenodera.service
%{_sysconfdir}/logrotate.d/tenodera
%{_sysconfdir}/pam.d/tenodera
%{_datadir}/tenodera/ui/

%changelog
* %(date "+%%a %%b %%d %%Y") Tenodera <noreply@tenodera> - %{version}-1
- Automated package build
