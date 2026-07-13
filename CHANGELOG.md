# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Each tagged release also has auto-generated notes on the
[Releases page](https://github.com/tenodera-io/tenodera/releases).

## [Unreleased]

### Added
- Continuous integration: `fmt` / `clippy` / `test` for every crate, UI build,
  and `cargo-deny` (advisories + license policy) on every push and PR.
- Dependabot for Cargo, npm, and GitHub Actions.
- `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, issue/PR templates, and this changelog.

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

[Unreleased]: https://github.com/tenodera-io/tenodera/compare/v0.1.7...HEAD
[0.1.7]: https://github.com/tenodera-io/tenodera/compare/v0.1.6...v0.1.7
[0.1.6]: https://github.com/tenodera-io/tenodera/compare/v0.1.5...v0.1.6
[0.1.5]: https://github.com/tenodera-io/tenodera/compare/v0.1.4...v0.1.5
[0.1.4]: https://github.com/tenodera-io/tenodera/compare/v0.1.3...v0.1.4
[0.1.3]: https://github.com/tenodera-io/tenodera/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/tenodera-io/tenodera/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/tenodera-io/tenodera/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/tenodera-io/tenodera/releases/tag/v0.1.0
