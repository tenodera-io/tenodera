# ADR-0003 — Host enrollment & SSH certificate authority

- **Status:** Accepted (direction), transport path **validated by spike** (below).
- **Date:** 2026-07-24
- **Depends on:** [ADR-0001](0001-ssh-bridge-transport.md) (resolves its open
  question #1), [ADR-0002](0002-postgresql-control-plane.md) (host/key storage).
- **Context source:** [SSH_BRIDGE_RETROSPECTIVE.md](../architecture/SSH_BRIDGE_RETROSPECTIVE.md) §1, §5.

## Context

The stated reason v0.x abandoned SSH transport was **key distribution at scale**:
one gateway Ed25519 key had to be copied into every host's `authorized_keys`, and
rotating it or onboarding hundreds of hosts was painful. Any SSH-transport rebuild
must not reintroduce that. We also need a durable, auditable **host-key trust**
lifecycle (v0.x used TOFU, then a per-session `known_hosts` tempfile — fiddly).

## Decision

Use an **SSH certificate authority** held by the control plane.

- **User authentication:** the control plane holds a **User CA**. When it needs to
  reach a host, it signs a **short-lived user certificate** (principal = the
  operator's system username, TTL in minutes) and connects with it. Hosts trust the
  CA **once** (at enrollment) via `TrustedUserCAKeys`; **no per-host `authorized_keys`**
  and no long-lived key on disk.
- **Host authentication:** host identity is recorded in PostgreSQL (`ssh_host_keys`,
  ADR-0002) — either the host's raw key captured at enrollment or, preferably, a
  **host certificate** signed by a Host CA. The connection manager pins the expected
  key/CA as `known_hosts`; a **changed host key is refused until an admin approves it**,
  and the change is audited.
- **Enrollment:** a one-time bootstrap step (token or root installer) installs the
  User-CA public key into the host's `sshd_config.d/` drop-in and registers the
  host + its key in PostgreSQL. From then on the host needs no further key material.
- **Authorization boundary stays the host:** the bridge runs as the operator's own
  user; `sudo`/PAM/SSSD/HBAC decides what they may do (unchanged from v0.x).

## Validation (spike on .10 → .11, 2026-07-24)

Real evidence, not theory. Control plane = .10, managed host = .11 (Debian 13):

- Generated a User CA on .10; installed **only** its public key on .11
  (`TrustedUserCAKeys` drop-in); created operator `spikeop` with **no
  `authorized_keys` at all**.
- Signed a **5-minute** user cert (principal `spikeop`) and connected .10 → .11:
  - login succeeded as `uid=1002(spikeop)` — authenticated **solely by the
    CA-signed cert**, zero per-host key;
  - `sudo -S` as spikeop escalated to `uid=0(root)` — the operator's own rules
    applied;
  - the session was a plain `spikeop` process — **no root daemon** anywhere.
- Inbound `:22` from .10 → .11 was reachable (confirms ADR-0001's inbound requirement
  in a datacenter-style network).
- Environment torn down afterwards (operator, CA trust, temp keys all removed).

This resolves **ADR-0001 open question #1** in favour of the SSH-CA model: onboarding
becomes "trust one CA once", not "distribute N keys".

> Caveat: the expired-cert rejection test was inconclusive due to a filename slip in
> the spike script (the valid path is fully proven). sshd enforces cert validity
> windows by design; add an explicit expired/not-yet-valid negative test in Phase 1.

## Rejected alternatives

- **Per-host `authorized_keys`** (raw keys). The exact thing that didn't scale and
  drove the v0.x abandonment. Rejected.
- **Single long-lived gateway key** (v0.x SSH era). One high-value credential, no
  built-in expiry, manual rotation everywhere. Rejected.
- **No expiry / long-TTL certs.** Loses the main benefit (short blast radius of a
  leaked cert). Rejected; TTL stays in minutes, signed per session/connection.

## Consequences

- The **CA private key is now the crown jewel.** A CA compromise = access to every
  host as any principal. Must be protected far more than a normal secret: envelope
  encryption with an out-of-DB data key (ADR-0002), ideally **offline/HSM/TPM-backed
  signing**, and never stored alongside its ciphertext.
- **Clock sync becomes load-bearing** — cert validity is time-based, so control plane
  and hosts need NTP; large skew breaks auth. Document as a requirement.
- **Principal mapping:** the cert principal must match the target Unix user. When the
  panel identity (OIDC/SSSD/FreeIPA) differs from the local username, a mapping is
  required (see open questions).
- Short-TTL certs mean a leaked cert self-expires, but **pre-expiry revocation**
  needs a KRL (SSH key revocation list) distributed to hosts, or short enough TTLs
  that revocation is unnecessary.

## Open questions

1. **Host identity:** host certificates (Host CA) vs. raw keys recorded in PostgreSQL.
   Certs scale better (hosts trust one Host CA) but add host-cert issuance/rotation.
2. **CA key custody & signing:** in-process signing with an envelope-encrypted key
   vs. a separate signer service / HSM / TPM. Rotation and `key_version`.
3. **Principal mapping** for non-local identities (OIDC/SAML → Unix user). Ties into
   the identity/credential ADR (next).
4. **Revocation:** KRL vs. "TTL short enough that revocation is moot" (e.g. ≤5 min).
5. **Enrollment bootstrap:** token-based (like v0.x bootstrap tokens, reused) vs.
   root-installer-writes-directly for local/first host.

## Acceptance criteria

- A new host is onboarded with **no per-host key copied** — only one-time CA trust +
  a PostgreSQL host record.
- An operator session authenticates with a **minutes-TTL** cert; an **expired** and a
  **not-yet-valid** cert are both rejected (explicit negative tests).
- Host-key change is **refused** until admin approval; the event is audited.
- CA private key is never stored in plaintext and never beside its ciphertext.
- Losing the control plane and rebuilding it does **not** silently re-trust hosts:
  host-key state is restored from PostgreSQL, not re-TOFU'd.
