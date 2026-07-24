-- Reliable per-org ordering for the audit hash chain (ADR-0007): a monotonic
-- sequence so "the previous event" is unambiguous under concurrent appends.
ALTER TABLE audit_events ADD COLUMN seq BIGSERIAL;
CREATE INDEX audit_events_org_seq_idx ON audit_events (organization_id, seq);
