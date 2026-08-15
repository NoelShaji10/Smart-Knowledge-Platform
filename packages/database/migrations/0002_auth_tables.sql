-- Add password_hash to users (nullable for OAuth-only users)
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash TEXT;

-- Refresh tokens table with token family support for rotation & reuse detection
CREATE TABLE IF NOT EXISTS refresh_tokens (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    family_id       UUID NOT NULL,
    token_hash      TEXT NOT NULL UNIQUE,
    expires_at      TIMESTAMPTZ NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    revoked_at      TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user ON refresh_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_hash ON refresh_tokens(token_hash) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_family ON refresh_tokens(family_id) WHERE revoked_at IS NULL;

-- Allow NULL workspace_id for global/account-level audit events
-- (auth.register, auth.login, auth.logout, auth.token.refreshed)
ALTER TABLE audit_events ALTER COLUMN workspace_id DROP NOT NULL;
