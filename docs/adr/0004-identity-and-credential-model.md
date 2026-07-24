# ADR-0004 — User identity & credential model

- **Status:** **Accepted** (2026-07-24).
- **Depends on:** [ADR-0003](0003-host-enrollment-ssh-ca.md) (SSH cert principals),
  [ADR-0002](0002-postgresql-control-plane.md) (session/RBAC storage).
- **Drives:** [ADR-0005](0005-typed-operation-protocol.md) (the typed operations the
  root-owned helper executes) and the forthcoming RBAC ADR.

## Context

v0.x: an operator logs in with a **system/PAM account**; the role is derived from
group membership. For every *privileged host operation* the UI sends the operator's
**sudo password**, which the browser keeps (AES-GCM) and the agent feeds to `sudo -S`.

Two forces pull on v2: (1) **don't hold the sudo password, even encrypted**;
(2) **the host's `sudo` still demands proof** — in the SSH-cert model the operator is
authenticated to the host as themselves, but `sudo` asks for a password unless a
`NOPASSWD` rule applies. The design below resolves this without a broad `NOPASSWD`
(which would recreate the v0.x "sudo may run `/bin/sh`" problem) and without a
password store.

## Decision

### Identity
- Authenticate to the control plane via **PAM** (local, LDAP, SSSD, FreeIPA) now.
  **OIDC ships in the first commercial release** with an **explicit
  `(issuer, subject) → local principal` mapping** stored in PostgreSQL. **No** default
  mapping from email or display name. Automatic JIT / group-based mapping is deferred.
- The resolved local username is the SSH certificate **principal** (ADR-0003) and the
  user the bridge runs as.
- **MFA ships in the first commercial release but is delegated to OIDC / PAM /
  FreeIPA** — Tenodera builds **no** TOTP store of its own. Privileged operations
  require MFA to have been satisfied; the highest-risk operations require a **fresh
  MFA step-up** (below).
- Sessions are stored as **hashed tokens** (SHA-256) with idle + absolute TTLs and
  server-side revocation; any cached credential is **revoked at session end**.

### Authorization: the host decides
- What an operator may do on a host is decided by that host's **`sudo` policy** and,
  where used, **FreeIPA rules**. Tenodera RBAC (forthcoming ADR) is a **second gate**
  on the UI/API surface — both must pass; RBAC never substitutes for the host.

> **FreeIPA terminology (precise):**
> **Sudo Rules** define *which commands* a user may run and *as whom* (`RunAs`).
> **HBAC** (Host-Based Access Control) governs *access to hosts and PAM services*,
> including `sshd` and `sudo`. In v2: HBAC gates whether the operator may reach the
> host and use `sudo`/`sshd` at all; Sudo Rules gate the specific commands — i.e. the
> Tenodera operation helper — and their `RunAs` target.

### Credential model
**Mode A — recommended default: `NOPASSWD` only for a narrow, root-owned Tenodera
operation helper.**
- The single `NOPASSWD` grant an operator (or Tenodera principal) receives is to run
  **one root-owned helper** (`/usr/lib/tenodera/tenodera-op-helper`, working name)
  that accepts a **typed, validated operation** (ADR-0005) and constructs the concrete
  privileged action itself.
- **No wildcard `NOPASSWD`** for `systemctl`, package managers, `tee`, or any shell.
  There is **no `sh -c`**. The helper is the only thing sudo may run without a
  password, and the helper does not take arbitrary commands.
- Result: with Mode A, **no sudo password exists anywhere in Tenodera**, *and* a leaked
  or misused sudo grant only reaches the helper's typed operations — not a root shell.

**Mode B — first-class, fully supported: just-in-time sudo re-auth.**
- For hosts/operations where even the helper is not `NOPASSWD`, prompt for the
  password **at the moment of the operation**, use it once, and **discard it** — never
  persisted, not encrypted, not cached across operations; any transient credential is
  revoked at session end. Mode B is a supported path in the first commercial release,
  not a degraded fallback.

**Step-up for high-risk operations (independent of `NOPASSWD`).**
- High-risk operations require **Tenodera step-up authentication** *even under Mode A*
  — re-auth is a Tenodera control that does not depend on the host's `NOPASSWD`.
- The authorization it produces is a **grant** that is **short-lived, single-use (or
  narrowly limited), and bound to `(user, host, exact operation, hash of arguments)`**.
  A grant authorizes *that one action*, cannot be replayed against a different
  argument, and never carries a password.

## Rejected alternatives

- **Broad `NOPASSWD` (e.g. `NOPASSWD: /usr/bin/systemctl *`, package managers, or a
  shell).** Convenient but recreates the v0.x "sudo may run `/bin/sh`" hole — a
  misused grant becomes arbitrary root. Rejected in favour of helper-only `NOPASSWD`.
- **Store the sudo password server-side for a grant window.** Removes it from the
  browser but rebuilds a plaintext-secret store. Rejected.
- **Tenodera-defined roles as the sole authorization.** Makes a compromised control
  plane able to act as any operator. Rejected — the host stays the final arbiter.
- **A custom TOTP/MFA store.** Duplicates identity-provider function and adds a secret
  store. Rejected; MFA is delegated to OIDC/PAM/FreeIPA.

## Consequences

- The **root-owned operation helper becomes a central component** — it is where "typed
  operation → concrete privileged action" happens, with `O_NOFOLLOW`/path/argument
  validation and no shell. It subsumes the v0.x A2 file-helper and is defined by
  ADR-0005. Its operation set is the real privilege surface and must be reviewed as
  carefully as sudoers once was.
- **Provisioning simplifies**: admins grant **one** narrow sudoers rule (the helper)
  or one FreeIPA Sudo Rule, instead of many per-command rules — Tenodera should ship a
  suggested sudoers/HBAC+Sudo-Rule snippet.
- **UX**: Mode A privileged operations are seamless; Mode B and high-risk step-up
  prompt (proof of presence) — acceptable and desirable for dangerous actions.
- **OIDC** cannot drive a host action until its identity is mapped to a local
  principal; unmapped identities are refused, not guessed.
- The v0.x persistent-password class of problem (`su_plain`, browser storage) does
  **not** exist on the v2 line.

## Open questions (implementation detail, not blocking)

1. Exact **classification of "high-risk"** operations that trigger step-up + fresh
   MFA (candidate list: user/group deletion, disk format/partition, `sshd_config`
   and authorized_keys changes, firewall flush, package removal of core packages).
2. Helper's **operation taxonomy and argument schemas** — defined in ADR-0005.
3. Grant **binding format** and the canonical **argument-hash** definition (which
   fields, canonicalization) — specified alongside ADR-0005 / the audit ADR.

## Acceptance criteria

- No sudo/PAM password is ever written to storage (browser, server, DB) — verified by
  test and review. Mode A: none exists. Mode B: used once, then dropped; nothing
  survives session end.
- On a Mode-A host, a privileged operation runs via the helper with **no password
  prompt**, and `sudo` may run **only** the helper (verified: `sudo -l` shows the
  helper and nothing broader; no shell, no wildcard).
- A high-risk operation is **refused without step-up** even on a Mode-A host, and the
  issued grant is rejected if replayed with different arguments (argument-hash bound).
- OIDC login without an explicit `(issuer, subject) → local principal` mapping is
  refused with a clear error.
- The authorization decision is demonstrably the **host's** (`sudo`/HBAC denies →
  operation denied) even when Tenodera RBAC would allow it.
- MFA is enforced for privileged operations via the external IdP; Tenodera stores no
  MFA secret.
