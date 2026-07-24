-- Tenodera v2 — core control-plane schema (Phase 1: data foundation).
--
-- Minimal ~16-table core per docs/architecture/TENODERA_V2.md, implementing the
-- foundation ADRs. Deliberately conservative: organization_id everywhere (single
-- org today, RLS/multi-tenant later), allow-only RBAC, no partitioning yet.
--
-- ADR map: 0002 (storage/secrets), 0003 (ssh_host_keys), 0004 (identity/sessions),
-- 0006 (RBAC), 0007 (audit hash-chain). Secrets are NEVER stored here in plaintext.

-- ── Organizations ────────────────────────────────────────────────────────────
-- One row today (fixed UUID); the column exists on every table so multi-tenant is
-- a later migration, not a rewrite. (ADR-0002)
CREATE TABLE organizations (
    id          UUID PRIMARY KEY,
    name        TEXT NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── Users & identities (ADR-0004) ────────────────────────────────────────────
-- The panel identity resolves to a local Unix principal used as the SSH cert
-- principal (ADR-0003) and the user the bridge runs as. No password is stored:
-- PAM/LDAP/SSSD/FreeIPA/OIDC authenticate; we keep only the binding.
CREATE TABLE users (
    id                UUID PRIMARY KEY,
    organization_id   UUID NOT NULL REFERENCES organizations(id),
    username          TEXT NOT NULL,          -- panel login name
    local_principal   TEXT NOT NULL,          -- Unix user = SSH cert principal (ADR-0003)
    display_name      TEXT,
    status            TEXT NOT NULL DEFAULT 'active',  -- active | disabled
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_login_at     TIMESTAMPTZ,
    failed_logins     INTEGER NOT NULL DEFAULT 0,
    UNIQUE (organization_id, username)
);

-- Explicit (issuer, subject) → user mapping for federated login (ADR-0004).
-- No email/display-name default mapping; JIT/group mapping deferred.
CREATE TABLE external_identities (
    id               UUID PRIMARY KEY,
    organization_id  UUID NOT NULL REFERENCES organizations(id),
    user_id          UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    issuer           TEXT NOT NULL,           -- OIDC issuer / "pam" / "sssd"
    subject          TEXT NOT NULL,           -- OIDC sub / local uid
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (issuer, subject)
);

-- Sessions: store only a SHA-256 of the bearer token; idle + absolute expiry;
-- server-side revocation. (ADR-0002/0004)
CREATE TABLE sessions (
    id                    UUID PRIMARY KEY,
    organization_id       UUID NOT NULL REFERENCES organizations(id),
    user_id               UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_sha256          BYTEA NOT NULL UNIQUE,   -- never the raw token
    created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    idle_expires_at       TIMESTAMPTZ NOT NULL,
    absolute_expires_at   TIMESTAMPTZ NOT NULL,
    client_ip             INET,
    user_agent            TEXT,
    revoked_at            TIMESTAMPTZ,
    revocation_reason     TEXT
);

-- ── RBAC (ADR-0006) ──────────────────────────────────────────────────────────
-- permissions.key == the operation namespace of ADR-0005 (fine keys + coarse
-- groups) so the two taxonomies cannot drift.
CREATE TABLE permissions (
    key          TEXT PRIMARY KEY,            -- e.g. 'service.restart', 'service.manage'
    description  TEXT
);

CREATE TABLE roles (
    id               UUID PRIMARY KEY,
    organization_id  UUID NOT NULL REFERENCES organizations(id),
    name             TEXT NOT NULL,
    builtin          BOOLEAN NOT NULL DEFAULT false,
    UNIQUE (organization_id, name)
);

CREATE TABLE role_permissions (
    role_id      UUID NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
    permission   TEXT NOT NULL REFERENCES permissions(key),
    PRIMARY KEY (role_id, permission)
);

-- A role grant scoped to a target. scope_kind: global | host | host_group | tag.
-- scope_value: host id / group id / 'key=value' tag selector / NULL for global.
CREATE TABLE user_roles (
    id            UUID PRIMARY KEY,
    user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role_id       UUID NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
    scope_kind    TEXT NOT NULL DEFAULT 'global',
    scope_value   TEXT
);

-- ── Hosts (ADR-0003) ─────────────────────────────────────────────────────────
CREATE TABLE hosts (
    id                UUID PRIMARY KEY,
    organization_id   UUID NOT NULL REFERENCES organizations(id),
    display_name      TEXT NOT NULL,
    hostname          TEXT NOT NULL,           -- ssh target
    port              INTEGER NOT NULL DEFAULT 22,
    enabled           BOOLEAN NOT NULL DEFAULT true,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen_at      TIMESTAMPTZ,
    status            TEXT NOT NULL DEFAULT 'unknown',
    tags              JSONB NOT NULL DEFAULT '{}'   -- {"environment":"production", ...}
);

CREATE TABLE host_groups (
    id               UUID PRIMARY KEY,
    organization_id  UUID NOT NULL REFERENCES organizations(id),
    name             TEXT NOT NULL,
    UNIQUE (organization_id, name)
);

CREATE TABLE host_group_members (
    host_group_id  UUID NOT NULL REFERENCES host_groups(id) ON DELETE CASCADE,
    host_id        UUID NOT NULL REFERENCES hosts(id) ON DELETE CASCADE,
    PRIMARY KEY (host_group_id, host_id)
);

-- SSH host-key history — source of truth for known_hosts; change requires explicit
-- admin approval (ADR-0003). A host can have prior (revoked) keys recorded.
CREATE TABLE ssh_host_keys (
    id                  UUID PRIMARY KEY,
    host_id             UUID NOT NULL REFERENCES hosts(id) ON DELETE CASCADE,
    algorithm           TEXT NOT NULL,
    fingerprint_sha256  TEXT NOT NULL,
    public_key          TEXT NOT NULL,
    first_seen_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    trusted_at          TIMESTAMPTZ,
    trusted_by          UUID REFERENCES users(id),
    revoked_at          TIMESTAMPTZ
);

-- ── Jobs & results (ADR-0005 / TENODERA_V2) ──────────────────────────────────
-- Every privileged operation is a durable job, so a restart never erases that it
-- ran. Durable queue via SELECT … FOR UPDATE SKIP LOCKED (no external broker).
CREATE TABLE jobs (
    id                UUID PRIMARY KEY,
    organization_id   UUID NOT NULL REFERENCES organizations(id),
    actor_user_id     UUID REFERENCES users(id),
    host_id           UUID REFERENCES hosts(id),
    operation         TEXT NOT NULL,           -- ADR-0005 op key
    args              JSONB NOT NULL DEFAULT '{}',
    args_hash         BYTEA,                   -- canonical(op,args) — grant binding (ADR-0004/0005)
    state             TEXT NOT NULL DEFAULT 'created',  -- created|authorized|queued|running|succeeded|failed|cancelled|timed_out
    idempotency_key   TEXT,
    attempt_count     INTEGER NOT NULL DEFAULT 0,
    max_attempts      INTEGER NOT NULL DEFAULT 1,
    locked_by         TEXT,                    -- server instance id (multi-instance leasing)
    locked_at         TIMESTAMPTZ,
    deadline          TIMESTAMPTZ,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX jobs_queue_idx ON jobs (state, created_at);

CREATE TABLE job_results (
    id            UUID PRIMARY KEY,
    job_id        UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    exit_code     INTEGER,
    success       BOOLEAN,
    started_at    TIMESTAMPTZ,
    finished_at   TIMESTAMPTZ,
    error_code    TEXT,
    response      JSONB,                       -- structured result
    stdout_meta   JSONB,                       -- size/hash; large payloads → object store later (ADR-0002)
    truncated     BOOLEAN NOT NULL DEFAULT false
);

-- ── Audit (ADR-0007) ─────────────────────────────────────────────────────────
-- Hash-chained, tamper-evident. Records allowed AND denied actions plus security
-- events. previous_hash/event_hash verified against signed off-DB checkpoints.
CREATE TABLE audit_events (
    event_id         UUID PRIMARY KEY,
    organization_id  UUID NOT NULL REFERENCES organizations(id),
    ts               TIMESTAMPTZ NOT NULL DEFAULT now(),
    actor_user_id    UUID REFERENCES users(id),
    actor_identity   TEXT,
    session_id       UUID,
    source_ip        INET,
    host_id          UUID REFERENCES hosts(id),
    action           TEXT NOT NULL,            -- op key or security event (login_failed, …)
    resource         TEXT,
    decision         TEXT,                     -- allowed | denied
    result           TEXT,                     -- succeeded | failed | error
    request_id       UUID,
    job_id           UUID REFERENCES jobs(id),
    error_code       TEXT,
    metadata         JSONB NOT NULL DEFAULT '{}',
    previous_hash    BYTEA,
    event_hash       BYTEA NOT NULL
);
CREATE INDEX audit_events_ts_idx ON audit_events (organization_id, ts);

-- ── Settings + version history (TENODERA_V2) ─────────────────────────────────
CREATE TABLE settings (
    organization_id  UUID NOT NULL REFERENCES organizations(id),
    key              TEXT NOT NULL,
    value            JSONB NOT NULL,
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_by       UUID REFERENCES users(id),
    PRIMARY KEY (organization_id, key)
);

-- Seed the single default organization (ADR-0002: fixed UUID until multi-tenant).
INSERT INTO organizations (id, name)
VALUES ('00000000-0000-0000-0000-000000000001', 'default');
