-- Phase 5: Allow workspace members to view profiles of fellow members in shared workspaces
-- Ensures getWorkspaceMembers, document_permissions, and member dropdowns return all active members under RLS

CREATE OR REPLACE FUNCTION shares_workspace_with_user(target_user_id UUID)
RETURNS BOOLEAN AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.workspace_members m1
    JOIN public.workspace_members m2 ON m1.workspace_id = m2.workspace_id
    WHERE m1.user_id = NULLIF(current_setting('app.current_user_id', true), '')::UUID
      AND m2.user_id = target_user_id
  );
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION shares_workspace_with_user(UUID) TO knowledge_app;

CREATE INDEX IF NOT EXISTS idx_workspace_members_user ON workspace_members(user_id);

DROP POLICY IF EXISTS users_select_policy ON users;
CREATE POLICY users_select_policy ON users
    FOR SELECT USING (
        is_system_context()
        OR id = get_current_user_id()
        OR shares_workspace_with_user(id)
    );
