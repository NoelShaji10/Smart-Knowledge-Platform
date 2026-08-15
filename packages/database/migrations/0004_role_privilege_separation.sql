-- 1. Create runtime application role knowledge_app if it does not exist
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'knowledge_app') THEN
        CREATE ROLE knowledge_app WITH LOGIN PASSWORD 'knowledge_app' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
    ELSE
        ALTER ROLE knowledge_app WITH NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
    END IF;
END
$$;

-- 2. Refine RLS Policies to allow INSERT / SELECT / UPDATE / DELETE for runtime role under RLS

-- users
DROP POLICY IF EXISTS users_policy ON users;
CREATE POLICY users_select_policy ON users
    FOR SELECT USING (is_system_context() OR id = get_current_user_id());
CREATE POLICY users_insert_policy ON users
    FOR INSERT WITH CHECK (is_system_context() OR id = get_current_user_id());
CREATE POLICY users_update_policy ON users
    FOR UPDATE USING (is_system_context() OR id = get_current_user_id());

-- workspaces
DROP POLICY IF EXISTS workspaces_policy ON workspaces;
DROP POLICY IF EXISTS workspaces_select_policy ON workspaces;
DROP POLICY IF EXISTS workspaces_insert_policy ON workspaces;
DROP POLICY IF EXISTS workspaces_update_policy ON workspaces;
DROP POLICY IF EXISTS workspaces_delete_policy ON workspaces;
CREATE POLICY workspaces_select_policy ON workspaces
    FOR SELECT USING (is_system_context() OR is_member_of_workspace(id));
CREATE POLICY workspaces_insert_policy ON workspaces
    FOR INSERT WITH CHECK (is_system_context() OR get_current_user_id() IS NOT NULL);
CREATE POLICY workspaces_update_policy ON workspaces
    FOR UPDATE USING (is_system_context() OR is_admin_of_workspace(id));
CREATE POLICY workspaces_delete_policy ON workspaces
    FOR DELETE USING (is_system_context() OR is_admin_of_workspace(id));

-- workspace_members
DROP POLICY IF EXISTS workspace_members_policy ON workspace_members;
DROP POLICY IF EXISTS workspace_members_select_policy ON workspace_members;
DROP POLICY IF EXISTS workspace_members_insert_policy ON workspace_members;
DROP POLICY IF EXISTS workspace_members_update_policy ON workspace_members;
DROP POLICY IF EXISTS workspace_members_delete_policy ON workspace_members;
CREATE POLICY workspace_members_select_policy ON workspace_members
    FOR SELECT USING (is_system_context() OR is_member_of_workspace(workspace_id));
CREATE POLICY workspace_members_insert_policy ON workspace_members
    FOR INSERT WITH CHECK (is_system_context() OR user_id = get_current_user_id() OR is_admin_of_workspace(workspace_id));
CREATE POLICY workspace_members_update_policy ON workspace_members
    FOR UPDATE USING (is_system_context() OR is_admin_of_workspace(workspace_id));
CREATE POLICY workspace_members_delete_policy ON workspace_members
    FOR DELETE USING (is_system_context() OR user_id = get_current_user_id() OR is_admin_of_workspace(workspace_id));

-- documents
DROP POLICY IF EXISTS documents_policy ON documents;
DROP POLICY IF EXISTS documents_select_policy ON documents;
DROP POLICY IF EXISTS documents_insert_policy ON documents;
DROP POLICY IF EXISTS documents_update_policy ON documents;
DROP POLICY IF EXISTS documents_delete_policy ON documents;
CREATE POLICY documents_select_policy ON documents
    FOR SELECT USING (
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
CREATE POLICY documents_insert_policy ON documents
    FOR INSERT WITH CHECK (is_system_context() OR is_member_of_workspace(workspace_id));
CREATE POLICY documents_update_policy ON documents
    FOR UPDATE USING (is_system_context() OR is_member_of_workspace(workspace_id));
CREATE POLICY documents_delete_policy ON documents
    FOR DELETE USING (is_system_context() OR is_member_of_workspace(workspace_id));

-- document_permissions
DROP POLICY IF EXISTS document_permissions_policy ON document_permissions;
DROP POLICY IF EXISTS document_permissions_select_policy ON document_permissions;
DROP POLICY IF EXISTS document_permissions_insert_policy ON document_permissions;
DROP POLICY IF EXISTS document_permissions_update_policy ON document_permissions;
DROP POLICY IF EXISTS document_permissions_delete_policy ON document_permissions;
CREATE POLICY document_permissions_select_policy ON document_permissions
    FOR SELECT USING (is_system_context() OR is_member_of_workspace((SELECT workspace_id FROM documents WHERE id = document_id)));
CREATE POLICY document_permissions_insert_policy ON document_permissions
    FOR INSERT WITH CHECK (is_system_context() OR is_member_of_workspace((SELECT workspace_id FROM documents WHERE id = document_id)));
CREATE POLICY document_permissions_update_policy ON document_permissions
    FOR UPDATE USING (is_system_context() OR is_member_of_workspace((SELECT workspace_id FROM documents WHERE id = document_id)));
CREATE POLICY document_permissions_delete_policy ON document_permissions
    FOR DELETE USING (is_system_context() OR is_member_of_workspace((SELECT workspace_id FROM documents WHERE id = document_id)));

-- document_versions
DROP POLICY IF EXISTS document_versions_policy ON document_versions;
DROP POLICY IF EXISTS document_versions_select_policy ON document_versions;
DROP POLICY IF EXISTS document_versions_insert_policy ON document_versions;
CREATE POLICY document_versions_select_policy ON document_versions
    FOR SELECT USING (is_system_context() OR is_member_of_workspace((SELECT workspace_id FROM documents WHERE id = document_id)));
CREATE POLICY document_versions_insert_policy ON document_versions
    FOR INSERT WITH CHECK (is_system_context() OR is_member_of_workspace((SELECT workspace_id FROM documents WHERE id = document_id)));

-- ai_suggestions
DROP POLICY IF EXISTS ai_suggestions_policy ON ai_suggestions;
DROP POLICY IF EXISTS ai_suggestions_select_policy ON ai_suggestions;
DROP POLICY IF EXISTS ai_suggestions_insert_policy ON ai_suggestions;
DROP POLICY IF EXISTS ai_suggestions_update_policy ON ai_suggestions;
CREATE POLICY ai_suggestions_select_policy ON ai_suggestions
    FOR SELECT USING (is_system_context() OR is_member_of_workspace(workspace_id));
CREATE POLICY ai_suggestions_insert_policy ON ai_suggestions
    FOR INSERT WITH CHECK (is_system_context() OR is_member_of_workspace(workspace_id));
CREATE POLICY ai_suggestions_update_policy ON ai_suggestions
    FOR UPDATE USING (is_system_context() OR is_member_of_workspace(workspace_id));

-- comments
DROP POLICY IF EXISTS comments_policy ON comments;
DROP POLICY IF EXISTS comments_select_policy ON comments;
DROP POLICY IF EXISTS comments_insert_policy ON comments;
DROP POLICY IF EXISTS comments_update_policy ON comments;
DROP POLICY IF EXISTS comments_delete_policy ON comments;
CREATE POLICY comments_select_policy ON comments
    FOR SELECT USING (is_system_context() OR is_member_of_workspace(workspace_id));
CREATE POLICY comments_insert_policy ON comments
    FOR INSERT WITH CHECK (is_system_context() OR is_member_of_workspace(workspace_id));
CREATE POLICY comments_update_policy ON comments
    FOR UPDATE USING (is_system_context() OR is_member_of_workspace(workspace_id));
CREATE POLICY comments_delete_policy ON comments
    FOR DELETE USING (is_system_context() OR is_member_of_workspace(workspace_id));

-- audit_events
DROP POLICY IF EXISTS audit_events_policy ON audit_events;
DROP POLICY IF EXISTS audit_events_select_policy ON audit_events;
DROP POLICY IF EXISTS audit_events_insert_policy ON audit_events;
CREATE POLICY audit_events_select_policy ON audit_events
    FOR SELECT USING (is_system_context() OR (workspace_id IS NOT NULL AND is_admin_of_workspace(workspace_id)));
CREATE POLICY audit_events_insert_policy ON audit_events
    FOR INSERT WITH CHECK (is_system_context() OR workspace_id IS NULL OR is_member_of_workspace(workspace_id));

-- refresh_tokens
DROP POLICY IF EXISTS refresh_tokens_policy ON refresh_tokens;
CREATE POLICY refresh_tokens_policy ON refresh_tokens
    FOR ALL USING (is_system_context() OR user_id = get_current_user_id());

-- 3. Grant schema usage and runtime table privileges to knowledge_app
GRANT USAGE ON SCHEMA public TO knowledge_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO knowledge_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO knowledge_app;

-- 4. Set default privileges for future schema objects created by schema owner
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO knowledge_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO knowledge_app;
