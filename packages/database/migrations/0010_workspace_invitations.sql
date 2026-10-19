-- 0010_workspace_invitations.sql
-- Workspace Invitations foundation, indexes, and Row Level Security

CREATE TABLE IF NOT EXISTS workspace_invitations (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id    UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    inviter_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    invitee_email   TEXT,
    role            TEXT NOT NULL CHECK (role IN ('admin', 'editor', 'viewer')),
    token_hash      TEXT NOT NULL UNIQUE,
    status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'revoked', 'expired')),
    expires_at      TIMESTAMPTZ NOT NULL,
    accepted_by     UUID REFERENCES users(id) ON DELETE SET NULL,
    accepted_at     TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Performance & lookup indexes
CREATE INDEX IF NOT EXISTS idx_workspace_invitations_workspace ON workspace_invitations(workspace_id);
CREATE INDEX IF NOT EXISTS idx_workspace_invitations_token_hash ON workspace_invitations(token_hash);
CREATE INDEX IF NOT EXISTS idx_workspace_invitations_pending ON workspace_invitations(workspace_id, status) WHERE status = 'pending';

-- Row Level Security
ALTER TABLE workspace_invitations ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_invitations FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS workspace_invitations_select_policy ON workspace_invitations;
DROP POLICY IF EXISTS workspace_invitations_insert_policy ON workspace_invitations;
DROP POLICY IF EXISTS workspace_invitations_update_policy ON workspace_invitations;
DROP POLICY IF EXISTS workspace_invitations_delete_policy ON workspace_invitations;

CREATE POLICY workspace_invitations_select_policy ON workspace_invitations
    FOR SELECT USING (is_system_context() OR is_admin_of_workspace(workspace_id));

CREATE POLICY workspace_invitations_insert_policy ON workspace_invitations
    FOR INSERT WITH CHECK (is_system_context() OR is_admin_of_workspace(workspace_id));

CREATE POLICY workspace_invitations_update_policy ON workspace_invitations
    FOR UPDATE USING (is_system_context() OR is_admin_of_workspace(workspace_id));

CREATE POLICY workspace_invitations_delete_policy ON workspace_invitations
    FOR DELETE USING (is_system_context() OR is_admin_of_workspace(workspace_id));

-- Grant table privileges to runtime application role
GRANT SELECT, INSERT, UPDATE, DELETE ON workspace_invitations TO knowledge_app;
