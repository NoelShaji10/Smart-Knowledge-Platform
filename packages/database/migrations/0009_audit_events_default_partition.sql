-- 0009_audit_events_default_partition.sql
-- Ensure audit_events has partitions for current/future dates so inserts never fail with
-- "no partition of relation 'audit_events' found for row"

CREATE TABLE IF NOT EXISTS audit_events_2026_10 PARTITION OF audit_events
    FOR VALUES FROM ('2026-10-01') TO ('2026-11-01');

CREATE TABLE IF NOT EXISTS audit_events_default PARTITION OF audit_events
    DEFAULT;
