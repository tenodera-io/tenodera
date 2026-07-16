# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Each tagged release also has auto-generated notes on the
[Releases page](https://github.com/tenodera-io/tenodera/releases).

## [Unreleased]

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

[Unreleased]: https://github.com/tenodera-io/tenodera/compare/v0.2.0...HEAD
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
