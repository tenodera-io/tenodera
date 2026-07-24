-- Enforce the documented enums + uniqueness that were only comments before
-- (external-review step 7: many states were plain TEXT with no CHECK, and
-- idempotency_key / host-key fingerprint had no uniqueness).

ALTER TABLE hosts
    ADD CONSTRAINT hosts_status_chk
    CHECK (status IN ('unknown', 'enrolled', 'disabled', 'unreachable'));

ALTER TABLE users
    ADD CONSTRAINT users_status_chk
    CHECK (status IN ('active', 'disabled'));

ALTER TABLE jobs
    ADD CONSTRAINT jobs_state_chk
    CHECK (state IN ('created', 'authorized', 'queued', 'running', 'succeeded',
                     'failed', 'cancelled', 'timed_out', 'outcome_unknown'));

ALTER TABLE audit_events
    ADD CONSTRAINT audit_decision_chk CHECK (decision IN ('allowed', 'denied')),
    ADD CONSTRAINT audit_result_chk   CHECK (result   IN ('succeeded', 'failed', 'error', 'unknown'));

-- At most one in-flight job per idempotency key, per organization.
CREATE UNIQUE INDEX jobs_idempotency_uk
    ON jobs (organization_id, idempotency_key)
    WHERE idempotency_key IS NOT NULL;

-- A host cannot have the same key fingerprint trusted (un-revoked) twice.
CREATE UNIQUE INDEX ssh_host_keys_active_fp_uk
    ON ssh_host_keys (host_id, fingerprint_sha256)
    WHERE revoked_at IS NULL;
