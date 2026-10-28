-- 0011_invitation_email_delivery.sql
-- Tracking email delivery status, timestamps, attempt counters, and failure codes for workspace invitations

ALTER TABLE workspace_invitations
    ADD COLUMN IF NOT EXISTS email_delivery_status TEXT NOT NULL DEFAULT 'not_requested'
        CHECK (email_delivery_status IN ('not_requested', 'queued', 'processing', 'accepted_by_provider', 'failed', 'permanently_failed')),
    ADD COLUMN IF NOT EXISTS email_queued_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS email_sent_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS email_last_attempt_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS email_delivery_attempts INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS email_failure_reason TEXT;

-- Index for worker queries to monitor in-progress/queued invitation delivery
CREATE INDEX IF NOT EXISTS idx_workspace_invitations_delivery_status
    ON workspace_invitations(workspace_id, email_delivery_status)
    WHERE email_delivery_status IN ('queued', 'processing');

