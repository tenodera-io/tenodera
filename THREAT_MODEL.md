# Threat Model

This document describes what Tenodera defends against, what it deliberately
does not, and — importantly — which mitigations are **implemented today** versus
**planned**. It is meant to be read alongside [SECURITY.md](SECURITY.md), which
covers the concrete security controls in more detail.

Tenodera is a young project. It has **not** had an external security audit. The
claims below are grounded in the source tree (file references are given so they
can be checked), not in aspiration. If you find something here that no longer
matches the code, that is a bug — please report it (see
[Reporting](#reporting-a-vulnerability)).

---

## 1. Architecture and trust boundaries

Three components:

| Component | Runs on | Privilege | Network |
|-----------|---------|-----------|---------|
| **Gateway** (`panel/crates/gateway`) | panel host | starts as root, drops to `tenodera-gw` | listens on `:9090` (inbound, browser-facing) |
| **Agent** (`agent/`) | every managed host | runs as root under systemd | **outbound only** — dials the gateway, no listener |
| **UI** (`panel/ui`) | browser | none | talks to gateway over HTTP(S)/WS(S) |

The defining property is **outbound-only agents**: managed hosts open no inbound
ports, need no firewall exceptions, and hold no inbound credentials. The gateway
never initiates a connection to a host; the agent dials out and the gateway
multiplexes all traffic for that host over the single authenticated WebSocket.

Trust boundaries, from least to most trusted:

1. **Browser ↔ Gateway** — an authenticated human operator. Crosses the network.
2. **Agent ↔ Gateway** — a managed host and the control plane. Crosses the network.
3. **Gateway → PAM helper** — privilege escalation boundary on the panel host.
4. **Agent → sudo / setuid** — privilege escalation boundary on a managed host.

---

## 2. Assets we protect

- **Operator credentials** — PAM passwords and sudo passwords. Never written to
  disk; piped straight to PAM and zeroized in memory after use
  (`Zeroizing<String>` in Rust; encrypted in browser `sessionStorage` via Web
  Crypto). There is no separate user/credential database to steal.
- **Session tokens** — UUIDv4, stored in `sessionStorage` (not `localStorage`),
  subject to idle timeout and a maximum lifetime (`session.rs`).
- **The gateway** — see the blast-radius discussion in §5.
- **Agent identity keys** — each agent holds an Ed25519 private key at
  `/var/lib/tenodera/agent.key` (dir mode `0700`), used to authenticate to the
  gateway.

---

## 3. Adversaries considered

- **Network attacker** (passive eavesdropper / active MITM) between browser and
  gateway, or between agent and gateway.
- **Unprivileged local user** on a managed host attempting privilege escalation.
- **Unauthenticated remote party** attempting to enroll a rogue agent or brute
  force operator login.
- **A malicious or compromised gateway** attempting to attack the hosts it
  brokers (this is the highest-impact case; see §5).

Explicitly **out of scope**: a root-level attacker already present on a host
(they have already won on that host); supply-chain compromise of upstream
dependencies (mitigated only partially — see §6); physical attacks.

---

## 4. Mitigations — implemented today

Each item below is present in the current `main` tree.

### Authentication is bilateral

- **Gateway authenticates the agent** via an Ed25519 challenge–response
  handshake: the gateway sends a 32-byte nonce, the agent signs
  `nonce ‖ hostname ‖ gateway_id`, and the gateway verifies with
  `verify_strict` (rejects non-canonical / malleable signatures)
  (`gateway/src/agent_auth.rs`). Nonce binding prevents replay; tests cover
  wrong-nonce and attacker-key cases.
- **Agent authenticates the gateway** via trust-on-first-use pinning: on first
  enrollment the agent records the gateway's `gateway_id`
  (`/var/lib/tenodera/gateway-id`); on every later connection a mismatch is
  refused as a possible MITM (`agent/src/main.rs`, "Bilateral TOFU"). The first
  connection is the trust-establishing one — see the residual risk in §6.

### Enrollment is gated

- A newly seen agent enters a **pending** state and requires an explicit **admin
  approval** action (`gateway/src/main.rs`, `pending_approve`) — approval is not
  automatic.
- Alternatively, **bootstrap tokens** skip manual approval. They are bearer
  secrets with a TTL and an optional `max_uses` (one-time or reusable), and can
  be bound to a hostname (`agent_auth.rs`, `BootstrapToken`). Treat them like
  passwords.

### Privilege separation

- The **gateway** starts as root only long enough to bind and read config, then
  drops privileges: `setgid`, `setuid` to the unprivileged `tenodera-gw` user,
  and clears supplementary groups (`gateway/src/main.rs`).
- The **PAM helper** (`tenodera-pam-helper`) is a dedicated setuid-root binary
  installed `4750 root:tenodera-gw` — only the gateway's group can execute it,
  and it escalates to root only for the duration of a single PAM call. PAM runs
  in an isolated subprocess, not in the gateway address space.
- The **agent** is installed `0755` root-owned **without a setuid bit**; it runs
  as root because systemd starts it. For terminal sessions it drops to the
  authenticated user's UID/GID via `setuid()`/`setgid()` before spawning a shell
  — no root shell is ever exposed, and shells are restricted to an allowlist.
- State-changing operations invoked on behalf of an operator do **not** run as
  the agent's root. The agent forks, drops to the operator's UID/GID
  (`initgroups` → `setgid` → `setuid`, so group-based rules apply), and only then
  execs `sudo -S -k` with the operator's own password. The managed host therefore
  decides what is permitted, per command and per host.

### Authorization

The **managed host is the authority**. There is no Tenodera-side permission store.

- **The host decides.** Because privileged writes execute as the operator under
  `sudo`, the host's own rules are enforced: local `/etc/sudoers`, or centrally
  managed FreeIPA/LDAP sudo rules resolved through SSSD. `NOPASSWD`, per-command
  restrictions and host-based rules all apply exactly as the host defines them.
- **The operator must exist on each managed host** with the rights they intend to
  use. A user unknown to a host (`getpwnam_r` miss) is denied there, even if they
  hold an admin session on the panel. This is the per-host gate.
- **RBAC is a UX filter, not the security boundary.** Sessions carry an `admin`
  or `readonly` role, derived from group membership on the panel host, and the
  gateway injects it so the UI can hide destructive actions. A user without sudo
  is downgraded to read-only rather than rejected. Bypassing this filter gains an
  attacker nothing: the host still refuses the command.
- **Privileged reads are brokered per-user.** Every read that exposes
  non-world-readable state runs *as the logged-in user* — the journal, log files,
  the process list, listening-port owners, container reads, user crontabs, kdump
  crash-dump content, and the certificate listing — with an optional `sudo`
  escalation, so the host decides what they may see, exactly as for writes. Only the
  world-readable baseline introspection stays at the agent's privilege — see §6.
- **A few write subsystems are an exception where the role *is* the boundary.**
  SSH access management, the Security page (fail2ban / SELinux / AppArmor), and
  host enrollment run as the agent (root) after only the `require_admin` role
  check — the host's `sudo` is not consulted for them. For these the injected role
  is load-bearing rather than a mere filter, so gateway compromise (§5) or a too-
  freely-granted admin role reaches them as root. See the residual risk in §6.

### Transport

- **TLS is the secure default.** The gateway refuses to start without TLS unless
  `TENODERA_ALLOW_UNENCRYPTED=1` is set explicitly for development
  (`config.rs`, `allow_unencrypted` defaults to `false`). With TLS enabled the
  browser↔gateway and agent↔gateway links are HTTPS/WSS.

### Hardening and accountability

- **Rate limiting** with brute-force protection on authentication, **CSRF**
  protection (Origin/Referer validation on state-changing requests,
  `security_headers.rs`), a strict **Content-Security-Policy** and other
  security headers.
- Every privileged action is written to an **audit log**
  (`/var/log/tenodera_audit.log`).
- **Config validation at startup** fails fast with clear errors (missing/invalid
  agent binary, half-configured TLS) instead of starting silently broken.
- The gateway runs under a hardened systemd unit (`ProtectHome`, dedicated
  service user, etc.).

---

## 5. The central trade-off, stated honestly

### Persistent agent vs. on-demand activation

Some management tools activate on demand — consuming no resources when idle and
exposing no long-running privileged process. Tenodera instead keeps a
**persistent agent** with a standing outbound connection.

This is an inherent cost of the outbound-only model, not a defect to be fixed:
**a connection that dials out and stays reachable requires a process that is
always running.** You cannot socket-activate a component whose entire job is to
maintain an outbound link through NAT. The upside (no inbound ports, works
behind NAT/CGNAT/cloud private networks without a VPN) is bought with a
continuously present process as attack surface. We accept this trade-off and
mitigate it with privilege separation (the agent's privileged escalation paths
are the PTY drop-to-user and per-user sudo, not an always-open root RPC), but we
do not claim to eliminate it.

### Gateway compromise: blast radius

The gateway is a high-value target. If it is compromised, an attacker can
potentially reach every host it brokers, over the multiplexed WebSocket.

This is **not unique to Tenodera** — it is the nature of any central management
plane. Any system where a single control point can reach an entire fleet — a
configuration-management controller, an orchestration server, or a bastion that
holds keys to every host — has the same property: compromise the center, and the
fleet is at risk. Acknowledging this does not make Tenodera worse than the
alternatives; hiding it would make this document dishonest.

We reduce, but do not remove, this risk:

- The gateway runs unprivileged (`tenodera-gw`) after startup; it is not root.
- It cannot forge an operator's sudo password — privileged operations require the
  operator's own credential, brokered per action.
- RBAC limits what a given session can do; read-only sessions cannot mutate.
- Every privileged action is audit-logged.
- Bilateral TOFU means a *different* gateway cannot silently take over an
  *already-enrolled* agent.

The correct operational posture is to treat the panel host as a
security-critical asset: isolate it, enable TLS, restrict who can reach `:9090`,
and monitor the audit log.

---

## 6. Known limitations and residual risk

These are real and not yet closed. Listing them is the point of this document.

- **No external audit.** The controls above are implemented and tested, but have
  not been independently reviewed. Release artifacts *are* checksummed and signed
  (`SHA256SUMS` + minisign — see SECURITY.md); **reproducible builds and an SBOM**
  are still on the roadmap (see the supply-chain item below).
- **First-connection trust (TOFU).** The agent pins the gateway on first
  contact. An active MITM present at that exact first connection could pin
  itself. Mitigate by performing first enrollment over a trusted network and/or
  using bootstrap tokens delivered out-of-band.
- **A few write subsystems run as root gated only by role.** Most state-changing
  operations run as the operator under `sudo`, so the host authorizes them — but
  SSH access management, the Security page (fail2ban/SELinux/AppArmor), and host
  enrollment/token management run at the agent's privilege (root) after only the
  `require_admin` check. For these the injected `_role` is the boundary: forging
  it (only possible by compromising the gateway, §5) or granting the admin role
  too freely yields root-equivalent control of them. Treat admin-role membership
  as root on every managed host. Moving these behind per-user `sudo` is on the
  roadmap.
- **Every privileged read is brokered per-user.** All reads that expose
  non-world-readable state now run *as the logged-in user*: the journal
  (`journalctl`), log files under `/var/log` (tail / search / date-filter), the
  process list (`ps`, honouring `hidepid`), the process owning each listening socket
  (`ss -p`), container reads (list / inspect / logs / stats / volumes / networks),
  user crontabs, kdump crash-dump content, and the certificate listing. Without a
  password these run under the user's own file and group permissions; with the
  superuser password they escalate via `sudo` as that user, so the host adjudicates.
  A user with no account on a host — or lacking the relevant group — sees a
  "restricted" placeholder (or only their own resources) instead of privileged data.
  **What remains at the agent's privilege (root) is deliberately only the baseline,
  world-readable introspection** (metrics, disk usage, network stats, hardware and
  system info, DNS, packages, systemd timers, cron *system* files, and public
  certificate metadata) — it exposes nothing a normal user couldn't already read, so
  brokering it would add cost without changing what anyone can see.
- **Bootstrap tokens are bearer secrets, and persist on the agent.** Anyone
  holding a valid, unexpired, non-exhausted token can enroll an agent. The token
  is written to `/etc/tenodera/agent.cnf` by the installer and is **not** removed
  after enrollment (the agent only needs it once — its key is pinned on first
  connect). A leftover *multi-use* token therefore stays usable. Scope them
  tightly (short TTL, `max_uses=1`, hostname binding), delete the line after the
  host is enrolled, and revoke after use.
- **Dependency supply chain.** Rust and npm dependencies are trusted transitively.
  An SBOM and reproducible builds are planned to narrow this.

---

## 7. Implemented vs. planned — summary

| Control | Status |
|---------|--------|
| Outbound-only agents, no inbound ports | **Implemented** |
| Ed25519 agent authentication (challenge–response, anti-replay) | **Implemented** |
| Bilateral gateway authentication (TOFU pinning) | **Implemented** |
| Pending-approval enrollment + bootstrap tokens (TTL / max-uses) | **Implemented** |
| Gateway privilege drop to `tenodera-gw` | **Implemented** |
| PAM helper isolated subprocess, setuid `4750` | **Implemented** |
| Agent installed without setuid bit (`0755`) | **Implemented** |
| Host-enforced authorization for privileged writes (local sudoers, or FreeIPA/LDAP sudo rules via SSSD) | **Implemented** |
| Per-user sudo brokering for privileged operations (most write handlers) | **Implemented** |
| RBAC (admin / read-only) — UX filter for sudo-brokered ops; the boundary for a few root subsystems | **Implemented** |
| Per-user brokering for **all** privileged reads — journal, log files, process list, listening-port owners, containers, user crontabs, kdump crash-dump content, cert listing (run as the user, `sudo` escalation); baseline world-readable introspection stays root by design | **Implemented** |
| Per-user sudo brokering for SSH-access / Security / enrollment (today: root gated by admin role) | **Planned** |
| TLS mandatory in **code** (gateway refuses to start unencrypted, binds `127.0.0.1`) | **Implemented** |
| ⚠️ but the **package installer** ships `TENODERA_ALLOW_UNENCRYPTED=1` + bind `0.0.0.0` for first-run reachability — so a fresh package install is plain HTTP on all interfaces until hardened | **Shipped opt-out — harden before exposing** |
| Rate limiting, CSRF, CSP, security headers, audit log | **Implemented** |
| External security audit | **Planned** |
| Signed release checksums (`SHA256SUMS` + minisign) | **Implemented** |
| Reproducible builds + SBOM | **Planned** |
| Per-host session scoping / full gateway→agent authorization | **Planned** |
| arm64 / aarch64 packages (`.deb` arm64, `.rpm` aarch64) | **Implemented** — built by release CI alongside amd64/x86_64 |

---

## Reporting a vulnerability

Please report security issues privately rather than in public issues. See
[SECURITY.md](SECURITY.md) for the disclosure process and contact.
