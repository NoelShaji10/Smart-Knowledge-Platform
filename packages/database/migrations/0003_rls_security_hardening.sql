-- Helper functions for PostgreSQL Row Level Security (RLS)
CREATE OR REPLACE FUNCTION get_current_user_id()
RETURNS UUID AS $$
  SELECT NULLIF(current_setting('app.current_user_id', true), '')::UUID;
$$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION is_system_context()
RETURNS BOOLEAN AS $$
  SELECT current_setting('app.is_system', true) = 'true';
$$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION is_member_of_workspace(ws_id UUID)
RETURNS BOOLEAN AS $$
  SELECT EXISTS (
    SELECT 1 FROM workspace_members
    WHERE workspace_id = ws_id
      AND user_id = NULLIF(current_setting('app.current_user_id', true), '')::UUID
  );
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION is_admin_of_workspace(ws_id UUID)
RETURNS BOOLEAN AS $$
  SELECT EXISTS (
    SELECT 1 FROM workspace_members
    WHERE workspace_id = ws_id
      AND user_id = NULLIF(current_setting('app.current_user_id', true), '')::UUID
      AND role IN ('owner', 'admin')
  );
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

-- Enable RLS and FORCE ROW LEVEL SECURITY on all protected tables

-- 1. users
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE users FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS users_policy ON users;
CREATE POLICY users_policy ON users
    FOR ALL
    USING (is_system_context() OR id = get_current_user_id());

-- 2. workspaces
ALTER TABLE workspaces ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspaces FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS workspaces_policy ON workspaces;
CREATE POLICY workspaces_policy ON workspaces
    FOR ALL
    USING (is_system_context() OR is_member_of_workspace(id));

-- 3. workspace_members
ALTER TABLE workspace_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_members FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS workspace_members_policy ON workspace_members;
CREATE POLICY workspace_members_policy ON workspace_members
    FOR ALL
    USING (is_system_context() OR is_member_of_workspace(workspace_id));

-- 4. documents
ALTER TABLE documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE documents FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS documents_workspace_member ON documents;
DROP POLICY IF EXISTS documents_not_denied ON documents;
DROP POLICY IF EXISTS documents_policy ON documents;
CREATE POLICY documents_policy ON documents
    FOR ALL
    USING (
        is_system_context() OR (
            is_member_of_workspace(workspace_id)
            AND NOT EXISTS (
                SELECT 1 FROM document_permissions
                WHERE document_id = documents.id
                  AND user_id = get_current_user_id()
                  AND role = 'none'
            )
        )
    );

-- 5. document_permissions
ALTER TABLE document_permissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_permissions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS document_permissions_policy ON document_permissions;
CREATE POLICY document_permissions_policy ON document_permissions
    FOR ALL
    USING (
        is_system_context() OR is_member_of_workspace(
            (SELECT workspace_id FROM documents WHERE id = document_id)
        )
    );

-- 6. document_versions
ALTER TABLE document_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_versions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS document_versions_policy ON document_versions;
CREATE POLICY document_versions_policy ON document_versions
    FOR ALL
    USING (
        is_system_context() OR is_member_of_workspace(
            (SELECT workspace_id FROM documents WHERE id = document_id)
        )
    );

-- 7. ai_suggestions
ALTER TABLE ai_suggestions ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_suggestions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ai_suggestions_policy ON ai_suggestions;
CREATE POLICY ai_suggestions_policy ON ai_suggestions
    FOR ALL
    USING (is_system_context() OR is_member_of_workspace(workspace_id));

-- 8. comments
ALTER TABLE comments ENABLE ROW LEVEL SECURITY;
ALTER TABLE comments FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS comments_policy ON comments;
CREATE POLICY comments_policy ON comments
    FOR ALL
    USING (is_system_context() OR is_member_of_workspace(workspace_id));

-- 9. audit_events
ALTER TABLE audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_events FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS audit_admin_only ON audit_events;
DROP POLICY IF EXISTS audit_events_policy ON audit_events;
CREATE POLICY audit_events_policy ON audit_events
    FOR ALL
    USING (is_system_context() OR (workspace_id IS NOT NULL AND is_admin_of_workspace(workspace_id)));

-- 10. refresh_tokens
ALTER TABLE refresh_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE refresh_tokens FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS refresh_tokens_policy ON refresh_tokens;
CREATE POLICY refresh_tokens_policy ON refresh_tokens
    FOR ALL
    USING (is_system_context() OR user_id = get_current_user_id());
