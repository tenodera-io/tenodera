# ADR-0004 — User identity & credential model

- **Status:** **Proposed** — core decisions need the product owner's sign-off (marked ⚑).
- **Date:** 2026-07-24
- **Depends on:** [ADR-0003](0003-host-enrollment-ssh-ca.md) (SSH cert principals),
  [ADR-0002](0002-postgresql-control-plane.md) (session/RBAC storage).

## Context

v0.x: an operator logs in with a **system/PAM account**; the role is derived from
group membership (`sudo`/`wheel`/…). For every *privileged host operation* the UI
sends the operator's **sudo password**, which the browser keeps (AES-GCM in a secure
context) and the agent feeds to `sudo -S`.

Two forces pull on v2:

1. **"Don't hold the sudo password, even encrypted."** The audit (§8.2) and both
   external reviews want the password out of browser storage and off the wire on
   every request. A short-lived **grant** after one authentication is the pattern.
2. **The host's `sudo` still demands proof.** In the SSH-cert model (ADR-0003) the
   operator is authenticated *to the host as themselves* by the certificate. But
   `sudo` on that host will still ask for a password **unless** a `NOPASSWD` rule
   applies. So "stop sending the password" only works if the host's sudo policy
   doesn't need one — otherwise the password has to reach `sudo` somehow.

This is the crux of v2's security/UX. Being honest about it now avoids designing a
grant system that still secretly needs the password everywhere.

## Decision (proposed)

**Identity**
- The operator authenticates to the control plane via **PAM** (local, LDAP, SSSD,
  FreeIPA). **OIDC/SAML/MFA are later** (ADR/TENODERA_V2 "Później").
- The panel identity maps to a **Unix username**, which becomes the SSH certificate
  **principal** (ADR-0003) and the user the bridge runs as. When the panel identity
  differs from the local username (federated login), an explicit
  **identity → local-user mapping** is required and stored in PostgreSQL. ⚑
- Sessions are stored in PostgreSQL as **hashed tokens** (SHA-256), with idle and
  absolute TTLs and server-side revocation (ADR-0002).

**Authorization to act on a host — the host decides, not Tenodera**
- The boundary for *what an operator may do* on a host is that host's **`sudo`
  policy** (local sudoers, or FreeIPA/LDAP sudo rules / HBAC via SSSD). Tenodera's
  own RBAC (ADR-0006, forthcoming) is a **second gate for the UI/API surface**, not
  a replacement for the host's decision. Both must pass.

**Credential for `sudo` — two modes, `NOPASSWD` preferred** ⚑
- **Mode A (recommended default): passwordless, per-command sudoers.** Fleets grant
  the operator (or a Tenodera principal) `NOPASSWD` rules scoped to specific commands
  / the bridge's file-helper. Then **no sudo password exists in Tenodera at all** —
  the password never enters the browser, the control plane, or the wire. This is the
  cleanest realisation of "don't hold the password", and it makes the host's sudoers
  the single, auditable source of truth. Managed via config management / FreeIPA.
- **Mode B (fallback): just-in-time re-auth.** For hosts/operations without a
  `NOPASSWD` rule, prompt for the password **at the moment of the operation**, use it
  for that one `sudo`, and **discard it** — never persist it, not even encrypted, not
  across operations. A short-lived server-side **grant** (MAC-signed: user + host +
  scope + nonce + minutes TTL) can authorise *further* operations within the window
  **only when Mode A applies** (i.e. the grant carries authorization, never the
  password). Where a real password is required, each such operation re-prompts.

The net effect: **Tenodera stores no long-lived credential.** Either the host is
`NOPASSWD` (nothing to store) or the password is used once and dropped.

## Rejected alternatives

- **Keep "encrypt the sudo password in the browser and send it every request"**
  (v0.x). Password lives in browser storage and on the wire repeatedly; a per-op
  secret in a control plane is exactly what the audit flagged. Rejected as the
  default; retained only as the Mode-B fallback *for a single operation*, never
  persisted.
- **Cache the password server-side for the grant TTL.** Removes it from the browser
  but re-creates a plaintext-secret store on the server — the thing we're avoiding.
  Rejected.
- **Tenodera-defined roles as the sole authorization** (ignore host sudo). Would make
  the control plane the security boundary and let a compromised server act as any
  operator on any host. Rejected — the host must remain the final arbiter.

## Consequences

- **Mode A raises an operational requirement:** admins must provision `NOPASSWD`
  sudo rules (ideally per-command, centrally). This is standard for managed fleets
  and is *more* auditable, but it is a deployment step Tenodera must document and
  ideally help generate (a suggested sudoers/HBAC snippet per enabled feature).
- **Federated identity needs a mapping** to a local user before it can drive an SSH
  principal and `sudo` — OIDC "jan.kowalski" must resolve to a Unix account on the
  target host. This constrains how/when OIDC can be enabled.
- **UX:** Mode A is seamless (no prompts). Mode B re-prompts for genuinely
  password-required operations — acceptable, and arguably desirable for high-risk
  actions (proof of presence).
- Removing the persistent password removes the v0.x `secureStorage`/`su_plain` class
  of problem entirely on the v2 line.

## Open questions ⚑ (product owner)

1. **Is `NOPASSWD` (Mode A) the supported default**, with Mode B as fallback — or must
   Tenodera support password-required sudo as a first-class path? (Determines whether
   the grant ever carries a real secret.)
2. **Federated identity → local user mapping**: manual table, naming convention, or
   deferred until OIDC lands?
3. **Grant scope granularity**: per (host, operation-type) vs per (host, resource)?
4. **Re-auth policy for high-risk operations** even under Mode A (e.g. user deletion,
   disk format) — always re-prompt regardless of `NOPASSWD`?
5. **MFA** at control-plane login for the first commercial release, or "Później"?

## Acceptance criteria

- No sudo/PAM password is ever written to storage (browser, server, or DB) — verified
  by test and review. (Mode A: none exists; Mode B: used once, then dropped.)
- A privileged operation succeeds on a `NOPASSWD` host with **no password prompt** and
  **no secret on the wire**.
- On a password-required host, the operation prompts once, succeeds, and leaves no
  residual secret anywhere afterwards.
- The authorization decision is demonstrably the **host's** (`sudo` denies → operation
  denied) even when Tenodera RBAC would allow it.
- A federated identity with no local-user mapping is refused with a clear error, not
  silently run as the wrong user.
