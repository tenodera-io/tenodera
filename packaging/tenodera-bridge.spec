Name:           tenodera-bridge
Version:        %{version}
Release:        1%{?dist}
Summary:        Tenodera bridge agent — runs on managed hosts
License:        MIT
URL:            https://github.com/ultherego/Tenodera_Admin_Panel

BuildRequires:  rust cargo
Requires:       openssh-server

%description
The tenodera-bridge binary is installed on managed Linux servers.
The Tenodera gateway connects to it via SSH and communicates over
a JSON stdio protocol to perform system administration tasks.

%install
install -D -m 755 %{_builddir}/tenodera-bridge %{buildroot}%{_bindir}/tenodera-bridge
install -D -m 644 %{_builddir}/bridge/bridge.service %{buildroot}%{_unitdir}/tenodera-bridge.service

%files
%{_bindir}/tenodera-bridge

%changelog
* %(date "+%%a %%b %%d %%Y") Tenodera <noreply@tenodera> - %{version}-1
- Automated package build
