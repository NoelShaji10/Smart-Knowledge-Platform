-- 0012_invitation_delivery_claims_and_recovery.sql
-- Add claim_id and claim_expires_at for worker lease management (AUD-T3-06)
-- Add encrypted_token for commit-to-enqueue crash recovery (AUD-T3-05)

ALTER TABLE workspace_invitations
    ADD COLUMN IF NOT EXISTS claim_id TEXT,
    ADD COLUMN IF NOT EXISTS claim_expires_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS encrypted_token JSONB;

-- Index for worker claim lookups
CREATE INDEX IF NOT EXISTS idx_workspace_invitations_claim
    ON workspace_invitations(claim_id)
    WHERE claim_id IS NOT NULL;

-- Index for reconciliation queries finding stale queued invitations
CREATE INDEX IF NOT EXISTS idx_workspace_invitations_reconcile
    ON workspace_invitations(email_delivery_status, email_queued_at)
    WHERE email_delivery_status = 'queued';
