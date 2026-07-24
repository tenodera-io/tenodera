# ADR-0002 — PostgreSQL as the durable control plane

- **Status:** Accepted (direction). Scope boundaries and sub-decisions marked *Open*.
- **Date:** 2026-07-24
- **Context source:** [`../architecture/TENODERA_V2.md`](../architecture/TENODERA_V2.md)
- **Supersedes:** `hosts.json` on disk and in-memory sessions.

## Context

v0.x keeps control-plane state in process memory (sessions) and a JSON file
(`hosts.json`). A restart loses session state; there is no durable audit, no
operation history, no RBAC store, no inventory, and no path to running more than one
server instance. For the v2 target — **many users, multiple administrators, B2B
sale, durable tamper-evident audit** — that is insufficient.

## Decision

Use **PostgreSQL as the single supported backend** and source of truth for all
durable control-plane state: users/identities, sessions (hashed tokens), RBAC,
hosts + host groups + tags, SSH host-key history, jobs + attempts + results,
inventory snapshots, settings history, and the audit log.

**Secrets are never stored in plaintext.** Sudo/SSH/PAM passwords and ephemeral
secrets live only in memory. Where a secret must persist (e.g. an OIDC client
secret, or an SSH-CA key per ADR-0001), use **envelope encryption** with the data
key held **outside the database** (systemd credentials / TPM / external KMS / Vault).

Schema tables carry an **`organization_id`** column from day one (single org =
fixed UUID) so a later move to multi-tenant does not require a full-system migration.

Migrations are **explicit** (`sqlx` migrations; `tenodera migrate status|apply|verify`),
not silently applied at startup in production.

## Rejected alternatives

- **SQLite / embedded store.** Simpler to ship, but no concurrent multi-instance
  access, weaker for large audit/history, and would need replacing at exactly the
  scale v2 targets. Rejected for v2's stated goals (hundreds of users, B2B).
- **Keep JSON files + in-memory sessions.** No durability, no audit, no RBAC, no HA.
  Rejected.
- **External message broker (RabbitMQ/Kafka) for the job queue now.** Unnecessary
  early: `SELECT … FOR UPDATE SKIP LOCKED` on a `jobs` table gives a correct durable
  queue for multiple workers. Deferred until scale demands it.
- **Redis for sessions now.** In-DB sessions suffice until multiple server instances
  are actually run; add Redis only if session read volume demands it. Deferred.

## Consequences

**Positive**
- State survives restarts and enables multiple server instances (with per-instance
  connection leases — ADR-0001 §6).
- Durable, queryable **audit** and **operation history** — a core B2B requirement and
  a primary justification for the DB.
- Central **RBAC** replaces the coarse admin/readonly split with granular permissions.
- Central **host-key history** enables "refuse on change, approve explicitly".

**Negative / costs**
- PostgreSQL becomes an **operational dependency** for a product that today is a
  couple of binaries: install, connection config, **backups + tested restore**, WAL /
  PITR, upgrades, and migration discipline all become part of the product.
- Raises the bar for the "simple self-hosted" story (goal #1). Mitigation: ship a
  batteries-included default (bundled/managed local PostgreSQL for single-node) while
  keeping "bring your own PostgreSQL" for larger deployments.
- A tamper-evident audit needs more than a table: a **hash chain** (`event_hash =
  SHA-256(previous_hash || canonical_payload)`) plus periodic **minisign/Ed25519
  checkpoints stored outside the DB**, or a DBA can delete rows undetectably.

## Open questions (resolve before Phase 1 schema is frozen)

1. **Bundled vs. external PostgreSQL** for the default single-node install, and how
   backups/restore are packaged and *tested* (a backup without a tested restore is
   not a backup).
2. **Data-key custody** for envelope encryption: systemd credentials vs. TPM vs.
   external KMS/Vault — and key-rotation/versioning (`key_version` column).
3. **Result/output storage:** inline `JSONB`/`TEXT` with a hard size cap (1–4 MiB,
   `truncated=true`) now; object storage (S3/MinIO) later — confirm the cap and the
   later hook.
4. **Audit integrity level** for the first release: hash chain only, or hash chain +
   signed checkpoints + optional SIEM export (`syslog`/`journald`/Loki/Splunk).
5. **RLS** (row-level security) on `organization_id`: adopt at first multi-tenant
   step, not before.

## Risks

- Scope creep: the full table set in `TENODERA_V2.md` is large; building it all
  before the first vertical slice would stall the project. Mitigation: Phase 1 ships
  the **minimal ~15-table core** (users, sessions, roles/permissions, hosts,
  host-keys, jobs, results, audit, inventory, settings, migrations) and nothing else.
- PostgreSQL as a single point of failure for a sold product. Mitigation: documented
  backup/PITR from day one; HA deferred but schema/queries kept HA-compatible (no
  reliance on process-local state as truth).
- Premature multi-tenancy complexity. Mitigation: `organization_id` column only; no
  tenant isolation machinery until a real second tenant exists.

## Acceptance criteria

- Server restart loses **no** durable state (sessions, hosts, jobs, audit persist).
- Every privileged operation writes a **job** and an **audit event**; audit rows are
  chained and a broken chain is detectable.
- No plaintext password or ephemeral secret is ever written to the database (checked
  by test + review); persisted secrets are envelope-encrypted with an out-of-DB key.
- `tenodera migrate verify` confirms the running schema matches the app's expected
  range; startup refuses to run against an unknown schema.
- A documented `pg_dump` + **restore-and-boot** procedure is verified in CI or a
  release checklist.
