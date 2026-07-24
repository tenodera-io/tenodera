# ADR-0007 — Audit & event storage

- **Status:** Accepted (direction). Chain scope, checkpoint cadence and retention
  mechanics are iterative.
- **Date:** 2026-07-24
- **Depends on:** [ADR-0002](0002-postgresql-control-plane.md) (storage, secrets),
  [ADR-0005](0005-typed-operation-protocol.md) (operations & jobs),
  [ADR-0006](0006-rbac.md) (authorization decisions to record).

## Context

v0.x writes audit lines to a flat file (`/var/log/tenodera_audit.log`, `622 root:root`)
— not durable across a rebuild, not queryable, and trivially editable. For a B2B
product, **tamper-evident, queryable, exportable audit** is a primary reason for
PostgreSQL (ADR-0002) and often a compliance requirement.

## Decision

### One durable, structured audit event per meaningful action
Record every security-relevant event in PostgreSQL with the full context needed to
answer "who did what, where, when, and was it allowed":

```
audit_events(
  event_id, organization_id, ts,
  actor_id, actor_identity, session_id, source_ip,
  host_id, action, resource,
  decision,            -- allowed | denied  (RBAC + host)
  result,              -- succeeded | failed | error
  request_id, job_id, error_code, metadata JSONB,
  previous_hash, event_hash )
```

- **Both allowed and denied actions are logged**, plus non-operation security events:
  `login_failed`, `authorization_denied`, `ssh_host_key_changed`, `sudo_failed`,
  `operation_timed_out`, `session_revoked`, `permission_changed`, `host_deleted`,
  `stepup_required`/`stepup_satisfied`.
- Every privileged operation produces a **job** (ADR-0005 / TENODERA_V2) and at least
  one audit event linked by `job_id` — a server restart never erases the record that
  an operation happened.

### Tamper-evidence: hash chain + signed checkpoints
- Each event stores `event_hash = SHA-256(previous_hash || canonical(event))`, where
  `canonical(event)` is a deterministic serialization of the event's fields. A deleted
  or altered row **breaks the chain**, which is detectable on verification.
- Periodically (time- or count-based) the latest hash is written as a **checkpoint,
  signed with Ed25519/minisign, and stored OUTSIDE the database** (the signing key is
  never in the DB — ADR-0002 secrets rule). A DBA can still delete rows, but cannot
  do so **undetectably**.
- Verification tooling (`tenodera audit verify`) recomputes the chain and checks it
  against the signed checkpoints.

### Export, not lock-in
The DB is the queryable source of truth; audit is **also** streamed to external sinks
so it survives and integrates: `syslog`/`journald` first, then `Splunk`/`Elastic`/`Loki`
/generic SIEM. Export is a first-class sink, configured per deployment.

### Canonicalization
The hash and any signature operate over a **canonical form** (fixed field order,
canonical JSON/CBOR, UTC timestamps) so the same event always hashes identically —
shared with the operation argument-hash definition (ADR-0005).

## Rejected alternatives

- **Flat file (v0.x).** No durability across rebuild, no query, editable. Rejected.
- **Plain table, no chain.** Durable and queryable but a DBA/attacker can delete rows
  undetectably. Rejected — tamper-*evidence* is the point.
- **External SIEM only (no local table).** Loses the local queryable truth and couples
  audit availability to an external system. Rejected; SIEM is an additional sink.
- **Full cryptographic ledger / blockchain.** Overkill; a hash chain + signed
  checkpoints gives detectable tamper-evidence without the machinery. Rejected.

## Consequences

- **Append-only discipline.** Events are never updated; the chain insert must compute
  `previous_hash` deterministically under contention — a per-(org) serialization point
  (advisory lock or a monotonic sequence) at insert time. This is a hot path; design
  it to not serialize all writes globally more than necessary.
- **Retention vs. the chain is a real tension.** Retention requires deleting or
  archiving old events, but a naïve delete breaks the chain. Resolution: truncate/
  archive only **up to a signed checkpoint**, keep the checkpoint (and an archived,
  signed segment) so the remaining chain still verifies from a trusted anchor. Must be
  designed, not bolted on.
- **Another signing key** (the checkpoint key) to protect — envelope-encrypted /
  KMS/TPM, rotated with `key_version` (ADR-0002).
- Large `metadata`/output follows ADR-0002's result-storage rule (inline with a size
  cap, object storage later); audit rows stay lean.

## Open questions

1. **Chain scope:** one global chain vs **per-organization** chains (per-org scales
   and isolates tenants; likely the right call given `organization_id` everywhere).
2. **Checkpoint cadence & signing-key custody** (in-process signer vs separate/HSM).
3. **Retention/archival mechanism** that preserves verifiability (checkpoint-anchored
   truncation + signed archived segments).
4. **v1 export sinks** — syslog/journald only at first, or a generic HTTP/SIEM sink too.
5. **Clock trust** for `ts` — DB time vs event-origin time; skew handling.

## Acceptance criteria

- Every privileged operation (allowed or denied) yields a linked `job` + audit event;
  a control-plane restart loses none of them.
- Altering or deleting any audit row is **detected** by `tenodera audit verify`
  against the signed checkpoints.
- Denied authorizations, failed logins, host-key changes and permission changes appear
  as audit/security events with distinct actions.
- The checkpoint signing key is never stored in the database or beside its ciphertext.
- Applying the retention policy leaves the remaining chain verifiable from a signed
  checkpoint anchor.
