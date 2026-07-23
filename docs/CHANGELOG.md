# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Each tagged release also has auto-generated notes on the
[Releases page](https://github.com/tenodera-io/tenodera/releases).

## [Unreleased]

### Security
- **Releases ship a signed SBOM.** Every release now includes a CycloneDX
  software bill of materials (`tenodera-sbom.cdx.json`) enumerating every Rust and
  npm dependency, generated from source in CI and **checksummed + signed** in the
  same `SHA256SUMS` as the packages. Feed it to Grype / Trivy / Dependency-Track
  to audit what a release contains. (`cargo-deny` advisory/licence scanning already
  runs on every push.)
- **Bootstrap tokens are scrubbed from the agent after enrollment.** Once an agent
  has enrolled and its Ed25519 key is pinned on the gateway, the token is never
  needed again. The agent now removes the `TENODERA_BOOTSTRAP_TOKEN` line from
  `/etc/tenodera/agent.cnf` on its first successful handshake, so a leftover —
  possibly multi-use — token can't be replayed later to enroll a rogue agent.
  Commented lines and the rest of the config are left untouched; the removal is
  best-effort and never fatal. Closes the "bootstrap tokens persist on the agent"
  residual risk in THREAT_MODEL §6.

## [0.2.13] - 2026-07-23

### Performance
- **Lighter footprint for weak hardware (small vCenter VMs etc.).** The gateway now
  **gzip/brotli-compresses** the static UI assets it serves — the recharts and xterm
  chunks are hundreds of KB uncompressed, and a fresh package install serves them
  over plain HTTP with no proxy to compress. The Rust **gateway and agent binaries
  are built with thin LTO + symbol stripping** (~18–27% smaller). The live
  dashboard / storage / networking **charts no longer animate on every update**
  (recharts ran a ~1.5 s requestAnimationFrame loop per tick — wasted CPU on
  constrained guests). The **host-list refresh dropped from every 8 s to every 20 s**.
- **Build/runtime tidying.** The frontend now splits recharts, xterm and React into
  **stable vendor chunks**, so those heavy libraries stay browser-cached across app
  updates (and pair with the gzip/brotli compression above). The unused
  `metrics.stream` agent handler — a dead 1 s-default streaming channel no client
  ever opened — was removed.

### Documentation
- THREAT_MODEL: tightened the RBAC summary-table row — after the per-user
  brokering below, the admin role is the boundary only for gateway
  host-enrollment, not "a few root subsystems".

## [0.2.12] - 2026-07-22

### Changed
- **Command palette** now groups entries per page with thin dividers (a page and
  its sub-tabs stay together) instead of one flat list — the grouping is derived
  dynamically from each entry's route.
- **Storage → Disk usage** is now offered only in Administrative mode. The scanner
  walks the tree as root, so in Limited access the tab is hidden from the Storage
  page, the sidebar, and the command palette (via a `superuser` flag on the nav
  entry).

### Security
- **SSH access & Security-page actions are now brokered per-user.** The two
  remaining write subsystems that ran as the agent (root) gated only by the admin
  role now execute on the host under the operator's own `sudo` with their
  superuser password — exactly like every other write. SSH key changes and
  `sshd_config` edits, and the Security page's fail2ban / SELinux / AppArmor
  actions, are all adjudicated by the host's sudoers/HBAC now, so gateway
  compromise or a too-freely-granted admin role no longer reaches them as root.
  authorized_keys files are still written with the target account's owner and
  `0600`/`0700` modes. The only role-gated operation left is host enrollment /
  token approval, which is a gateway control-plane action with no per-host `sudo`
  to consult. (Both pages already required Administrative access, so there is no
  new prompt.)

## [0.2.11] - 2026-07-19

### Added
- **Command palette (`Ctrl`/`Cmd`+`K`)** — a quick-jump palette to reach any page
  or sub-tab: press the shortcut or click **Search** in the top bar, type to filter
  (e.g. `ports`, `updates`, `trust`), then `↑`/`↓` + `Enter` to navigate (`Esc`
  closes). Entries are built from the shared nav, so they stay in sync with the
  sidebar; admin pages appear only when superuser mode is active. Navigation-only
  for now — UI-only, no agent/gateway changes.

### Documentation
- Repository docs reorganised: the root now holds only `README.md`,
  `CONTRIBUTING.md` and `LICENSE`; community-health files moved to `.github/`
  (`SECURITY.md`, `CODE_OF_CONDUCT.md`) and the manual, threat model and this
  changelog to `docs/`. `SECURITY.md` was de-duplicated against `THREAT_MODEL.md`
  (which is now the single source for the authorization model), and the `protocol`
  and `systemd` READMEs were folded into the gateway README.

## [0.2.10] - 2026-07-19

### Added
- **Kdump → editable settings table** — the kdump configuration is now shown as a
  parsed key/value table (instead of a raw file dump), and each setting can be edited
  or a new one added. Works on both **Debian kdump-tools** (`/etc/default/kdump-tools`,
  `KEY=value`; validated with `kdump-config test`, restarts the service only if it
  passes) and **Fedora/RHEL kdump** (`/etc/kdump.conf`, `key value`; applied with
  `kdumpctl reload`). Admin + superuser gated, audit-logged (`kdump.set_config`).
- **Certificates → Edit PEM** — with Administrative access the PEM shown in the cert
  detail view becomes editable and can be saved back (`save_pem`): the new content is
  validated as an X.509 certificate before the file is overwritten (sudo),
  admin-gated, audit-logged (`cert.save_pem`).

## [0.2.9] - 2026-07-19

### Added
- **Per-user read brokering completed** for the remaining privileged reads, so
  every read that exposes non-world-readable state now runs as the logged-in user
  (superuser escalates via `sudo`), matching writes:
  - **cron** — you see the system cron files plus *your own* crontab; superuser
    reveals every user's crontab (others' live under root-only `/var/spool/cron`).
  - **kdump** — crash-dump content (`read_dmesg` / `read_dump`) is read as you, so a
    kernel-memory dump is only shown to someone who may read it.
  - **certs** — the certificate listing is parsed as you, so a cert file in a
    root-only directory is only listed for users who can actually read it.
- **Certificates → View PEM** — the cert detail view has a *View PEM* button that
  shows the certificate's full PEM (read as the logged-in user; superuser reveals
  certs in root-only directories, via a `read_pem` action on `certs.list`).
- **Packages → cache cleanup** — buttons to free disk from cached / orphaned
  packages: *Clean cache* (`apt-get clean` / `dnf clean all` / `pacman -Sc`),
  *Autoclean* (apt only), and *Autoremove* (`apt-get`/`dnf autoremove`). Superuser-
  gated, run as the user via sudo, audit-logged (`pkg.cleanup`).

### Fixed
- **kdump** dump-content requests were silently dropped after the 0.2.6 channel
  fix (the info channel closed before the follow-up `data()` arrived); they now run
  as one-shot requests and work again.

### Documentation
- SECURITY / THREAT_MODEL / DOCS: read brokering is now complete for all privileged
  reads; only the baseline world-readable introspection remains at agent privilege
  by design.

## [0.2.8] - 2026-07-19

No functional changes — re-tagged from 0.2.7 to re-run the release pipeline.

## [0.2.7] - 2026-07-18

### Added
- **Per-user brokering of container reads.** Container/image listing, inspect,
  logs, stats, and volume/network reads now run **as the logged-in user** on the
  host — they see only their own container-runtime resources (via `docker` group
  membership or a rootless podman socket) instead of everything as root. The
  superuser password still escalates via `sudo` to reveal root's resources, exactly
  matching the existing "your resources / root resources" toggle on the Containers
  page. This completes per-user read brokering for the command-based handlers
  (journal, log files, process list, listening-port owners, containers).

### Documentation
- Updated SECURITY, THREAT_MODEL and DOCS: container reads are now brokered; the
  remaining root reads are the world-readable baseline introspection plus a few
  borderline file reads (cron, kdump, cert keys).

## [0.2.6] - 2026-07-18

### Added
- **Per-user brokering of privileged reads.** The journal, log files under
  `/var/log` (tail / search / date-filter), the process list, and the process
  owning each listening socket now run **as the logged-in user** on the host —
  their own file and group permissions decide what they may see. With the superuser
  password active, reads escalate via `sudo` as that user, exactly like writes.
  When your account isn't present on a host, or lacks the relevant group, a calm
  "restricted" note is shown instead of privileged data or a red error.

### Fixed
- **Log Files:** excluded binary databases (`lastlog`, `wtmp`, `btmp`, `faillog`)
  that were wrongly listed as text logs. On hosts with high UIDs (e.g. FreeIPA),
  `/var/log/lastlog` is a ~200 GB sparse file; reading it as text could exhaust the
  agent's memory (OOM). Brokered reads are now bounded — a 64 MiB output cap and a
  30 s deadline — as defense-in-depth against any pathological file.
- **Agent:** one-shot request channels now free their per-channel tracking
  immediately instead of waiting for a client close that never arrives, preventing
  a slow memory creep over long-lived sessions.

### Documentation
- Updated SECURITY, THREAT_MODEL and DOCS to reflect that read brokering is now
  partial (journal, log files, process list, listening-port owners done; container
  reads and the baseline world-readable introspection still run as root).
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

[Unreleased]: https://github.com/tenodera-io/tenodera/compare/v0.2.8...HEAD
[0.2.8]: https://github.com/tenodera-io/tenodera/compare/v0.2.7...v0.2.8
[0.2.7]: https://github.com/tenodera-io/tenodera/compare/v0.2.6...v0.2.7
[0.2.6]: https://github.com/tenodera-io/tenodera/compare/v0.2.5...v0.2.6
[0.2.5]: https://github.com/tenodera-io/tenodera/compare/v0.2.4...v0.2.5
[0.2.4]: https://github.com/tenodera-io/tenodera/compare/v0.2.3...v0.2.4
[0.2.3]: https://github.com/tenodera-io/tenodera/compare/v0.2.2...v0.2.3
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
