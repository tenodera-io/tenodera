# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Each tagged release also has auto-generated notes on the
[Releases page](https://github.com/tenodera-io/tenodera/releases).

## [Unreleased]

### Documentation
- Brought README, DOCS, SECURITY and THREAT_MODEL up to date with the features
  added in 0.2.1–0.2.5 (System, SSH access, Security, Audit log, disk-usage
  browser, container exec/inspect, listening ports, auto-updates, storage mounts,
  table-based /etc/hosts, Services status-on-failure).
- Documented honestly that a few administrative subsystems (SSH access, the
  Security page, host enrollment) run as the agent (root) gated only by the admin
  role rather than the host's sudo — so the admin role must be treated as root on
  every managed host, and this is listed as a residual risk / planned change.

## [0.2.5] - 2026-07-18

### Added
- **Security** page (Admin) — status and basic actions for host hardening,
  auto-detecting whichever subsystems are present on the host:
  - *fail2ban* — jails with banned/failed counts, unban/ban an IP, reload.
  - *SELinux* — enforcing/permissive toggle (runtime, optional persist to config);
    plus **booleans** (filter + on/off, persistent `-P`), recent **AVC denials**,
    loaded policy **modules**, and **restorecon** to relabel a path.
  - *AppArmor* — profile modes with per-profile enforce/complain (when
    apparmor-utils is present).
- **Storage → Disk usage** — a "what's using space" browser: drill down one
  directory level at a time (`du -x`, one filesystem), listing subdirectory sizes
  and the level's largest files. Runs at idle I/O priority with a 60s cap and is
  cancellable, so it stays safe on large disks.

### Changed
- Services: when a start/stop/restart/enable/etc. action fails, the service row
  now expands automatically to show its `systemctl status` (why it failed), and
  the redundant "See … for details" boilerplate is dropped from the error banner.

## [0.2.4] - 2026-07-18

### Changed
- Audit log: larger, bolder column headers; the page now fills the available
  viewport height with a sticky header row — only the table body scrolls.
- SSH → Add key: renamed the section to "Add Public Key" and removed the
  redundant helper caption.
- DNS → /etc/hosts: removed the redundant helper caption.

## [0.2.3] - 2026-07-18

### Added
- **SSH access** management (Admin → SSH access):
  - *Authorized keys* — manage `authorized_keys` per user; add, edit and remove
    keys (validated with `ssh-keygen`, correct `~/.ssh` ownership/permissions
    restored on write). The user field is free text with local-user suggestions,
    so directory users (FreeIPA/AD) can be entered too, and defaults to the
    logged-in user.
  - *Server config* — edit `sshd_config` as a table of directives (add / edit /
    remove; comments preserved). Changes are validated with `sshd -t` before they
    are applied and are rejected if invalid; a backup is kept as
    `sshd_config.tenodera.bak` and the service is reloaded.
- **Audit log** viewer (Admin → Audit log) — a filterable table of actions taken
  through the panel (time, user, action, target, result, details), newest first.

## [0.2.2] - 2026-07-17

### Added
- Containers: **exec into a container** — open an interactive shell in a running
  container (superuser-gated; auto-selects bash, else ash/sh). Plus **Inspect** —
  a details view with image, command, status/health, ports, mounts, networks and
  environment.

### Changed
- DNS: the **/etc/hosts** editor is now a table (add / edit / remove entries)
  instead of raw text; comment lines are preserved on save.

## [0.2.1] - 2026-07-17

### Added
- **System page** — clock & timezone, time synchronization, hostname, locale &
  keyboard, and power (reboot/shutdown with an optional delay or scheduled time).
  A per-host **Time sync** tab manages whichever daemon is active: chrony (rich
  tracking/sources/config view) or a generic status+config view for
  systemd-timesyncd, ntpd/NTPsec, OpenNTPD and PTP (ptp4l/phc2sys).
- **Automatic updates** management (Packages → Auto-updates) — enable/disable,
  apply mode (install vs. download-only), scope (security-only vs. all), schedule,
  automatic reboot and unused-package cleanup, for `unattended-upgrades` (apt) and
  `dnf-automatic` (dnf).
- **Listening ports** (Networking → Ports) — sockets in LISTEN/UNCONN state with
  process and PID, a filter, and the ability to kill a process (SIGTERM/SIGKILL).
- **Storage mounts** (Storage → Mounts) — mount/unmount block devices and edit
  `/etc/fstab` (with a backup).
- Sidebar sub-navigation for the new and updated pages.

### Fixed
- Containers: short image names (e.g. `nginx`) are auto-qualified to Docker Hub
  (`docker.io/library/nginx`) so podman — which has no unqualified-search
  registries by default — resolves them like Docker.

## [0.2.0] - 2026-07-16

### Added
- Sidebar sub-navigation: pages that have sub-tabs (Services, Containers,
  Networking, Packages, Users, DNS, Certificates, Management) now expand their
  sub-views directly in the sidebar. The active sub-view is reflected in the URL
  (`?tab=…`), so views are linkable and survive a page refresh.
- The top bar now shows the host's IP address and labels the panel host as
  "Panel" (versus "remote" for managed hosts).
- Responsive layout: on narrow screens the sidebar collapses into a toggleable
  drawer.

### Changed
- Reworked the UI with a wider sidebar, a consistent SVG icon set, hover/active
  states, and a distinct accent for the Admin section.
- Sub-tabs across all pages now use a unified segmented-control component instead
  of the previous underline tabs.
- Standardized page headers (matching icon + title, consistent spacing) on every
  page.
- Enlarged the top bar and the session/help menus for readability.
- All new UI honours the active theme (Catppuccin / Tokyo Night, light and dark).

## [0.1.9] - 2026-07-16

### Fixed
- Packaging: the panel pinned the agent to an exact version
  (`tenodera-agent (= <version>)` / `Requires: tenodera-agent = %{version}`), so
  upgrading the agent on its own left the dependency unsatisfiable and the
  package manager offered to remove the panel to resolve it. The panel now
  requires `>= <version>`, so a newer agent satisfies an older panel.

## [0.1.8] - 2026-07-15

### Security
- **Privileged operations are now authorized by the managed host.** Every
  state-changing operation runs *as the logged-in user*: the agent drops to their
  UID/GID (`initgroups` → `setgid` → `setuid`) and execs `sudo -S -k` with their
  own password. The host's own rules decide what is permitted — local
  `/etc/sudoers`, or FreeIPA/LDAP sudo rules resolved via SSSD — per command and
  per host.
- **Fixed: Administrative access accepted any password.** The agent runs as root,
  and root is exempt from `sudo`, so the previous `superuser.verify` check
  (`sudo -S -k true` executed as root) always succeeded. The password prompt was
  effectively a no-op. It now authenticates the real user against PAM/SSS and
  confirms they actually hold sudo on that host.
- **Fixed: privileged operations ignored host rules.** The `am_root` branch in the
  agent's sudo helpers skipped `sudo` entirely and ran commands directly as root,
  so local sudoers and FreeIPA rules were never consulted. The bypass is removed.
- **Fixed: unverified-password escalation on privileged reads** — `file_ops`
  read/list let any authenticated user read root-only files with an arbitrary
  password.
- Migrated handlers: users, files, services, packages, cron, host config,
  networking, certificates, DNS, and containers.

### Changed
- **Breaking:** operators must now exist, with the rights they intend to use, on
  **every managed host** — via local accounts/groups or FreeIPA/LDAP through
  SSSD. A user unknown to a host is denied there, and a user without the relevant
  sudo rule now gets `sudo access denied` where the operation previously
  succeeded as root. The panel's admin/read-only role is only a UI filter; the
  host is authoritative.
- Read operations (dashboards, logs, system introspection) deliberately still run
  as root and are not per-user brokered — see `THREAT_MODEL.md` §6.

### Added
- Continuous integration: `fmt` / `clippy` / `test` for every crate, UI build,
  and `cargo-deny` (advisories + license policy) on every push and PR.
- Dependabot for Cargo, npm, and GitHub Actions.
- `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, issue/PR templates, and this changelog.

### Removed
- Dead `util::sudo_action` / `util::sudo_stdin_write` (the root-bypass helpers),
  now that every caller runs as the logged-in user.

## [0.1.7]

### Changed
- Release artifacts use version-less filenames, so
  `releases/latest/download/<file>` always fetches the newest release.
- README and docs install instructions restructured (packages primary, curl
  optional) and switched to `latest/download`.

## [0.1.6]

### Added
- The panel and login page display the running version.

### Changed
- The crate version is stamped from the release tag at build time — the tag is
  the single source of truth.

## [0.1.5]

### Changed
- Solid login background with a green accent (dropped the photo).

## [0.1.4]

### Changed
- Removed the redundant Tokens tab from the Manage-hosts dropdown view.

## [0.1.3]

### Added
- Token dialog shows the token plus both enrollment methods (package and curl).

## [0.1.2]

### Fixed
- RPM: no longer reference `%macros` inside spec comments, which caused bogus
  `systemctl` invocations and spurious restarts on upgrade/remove.

## [0.1.1]

### Fixed
- Debian/Ubuntu login: the `.deb` now ships a Debian-native PAM config
  (`common-auth`/`common-account`) instead of the Fedora `system-auth` include,
  which had broken every panel login on Debian.

## [0.1.0]

Initial public release.

### Added
- Web panel: dashboard, terminal, services, users/groups, packages, storage,
  networking, containers, files, logs, cron, DNS, certificates.
- Reverse-WebSocket agent — no inbound ports on managed hosts.
- Bilateral Ed25519 authentication (gateway verifies agent; agent pins gateway).
- PAM authentication with admin/read-only roles; secure-by-default TLS.
- Signed `.deb`/`.rpm` packages (amd64 + arm64), SHA256SUMS + minisign signature.
- `THREAT_MODEL.md` and a documented security model.

[Unreleased]: https://github.com/tenodera-io/tenodera/compare/v0.2.2...HEAD
[0.2.2]: https://github.com/tenodera-io/tenodera/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/tenodera-io/tenodera/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/tenodera-io/tenodera/compare/v0.1.9...v0.2.0
[0.1.9]: https://github.com/tenodera-io/tenodera/compare/v0.1.8...v0.1.9
[0.1.8]: https://github.com/tenodera-io/tenodera/compare/v0.1.7...v0.1.8
[0.1.7]: https://github.com/tenodera-io/tenodera/compare/v0.1.6...v0.1.7
[0.1.6]: https://github.com/tenodera-io/tenodera/compare/v0.1.5...v0.1.6
[0.1.5]: https://github.com/tenodera-io/tenodera/compare/v0.1.4...v0.1.5
[0.1.4]: https://github.com/tenodera-io/tenodera/compare/v0.1.3...v0.1.4
[0.1.3]: https://github.com/tenodera-io/tenodera/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/tenodera-io/tenodera/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/tenodera-io/tenodera/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/tenodera-io/tenodera/releases/tag/v0.1.0
