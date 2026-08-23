-- Security Definer helper function to retrieve workspace_id of a document without triggering RLS recursion
CREATE OR REPLACE FUNCTION get_document_workspace_id(doc_id UUID)
RETURNS UUID AS $$
  SELECT workspace_id FROM public.documents WHERE id = doc_id;
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

-- Re-create document_permissions policies using SECURITY DEFINER helper to prevent policy recursion
DROP POLICY IF EXISTS document_permissions_select_policy ON document_permissions;
DROP POLICY IF EXISTS document_permissions_insert_policy ON document_permissions;
DROP POLICY IF EXISTS document_permissions_update_policy ON document_permissions;
DROP POLICY IF EXISTS document_permissions_delete_policy ON document_permissions;

CREATE POLICY document_permissions_select_policy ON document_permissions
    FOR SELECT USING (is_system_context() OR is_member_of_workspace(get_document_workspace_id(document_id)));
CREATE POLICY document_permissions_insert_policy ON document_permissions
    FOR INSERT WITH CHECK (is_system_context() OR is_member_of_workspace(get_document_workspace_id(document_id)));
CREATE POLICY document_permissions_update_policy ON document_permissions
    FOR UPDATE USING (is_system_context() OR is_member_of_workspace(get_document_workspace_id(document_id)));
CREATE POLICY document_permissions_delete_policy ON document_permissions
    FOR DELETE USING (is_system_context() OR is_member_of_workspace(get_document_workspace_id(document_id)));

-- Re-create document_versions policies using SECURITY DEFINER helper
DROP POLICY IF EXISTS document_versions_select_policy ON document_versions;
DROP POLICY IF EXISTS document_versions_insert_policy ON document_versions;

CREATE POLICY document_versions_select_policy ON document_versions
    FOR SELECT USING (is_system_context() OR is_member_of_workspace(get_document_workspace_id(document_id)));
CREATE POLICY document_versions_insert_policy ON document_versions
    FOR INSERT WITH CHECK (is_system_context() OR is_member_of_workspace(get_document_workspace_id(document_id)));

-- Fix composite foreign key ON DELETE SET NULL to target parent_id specifically
ALTER TABLE documents DROP CONSTRAINT IF EXISTS fk_documents_parent_workspace;
ALTER TABLE documents
  ADD CONSTRAINT fk_documents_parent_workspace
  FOREIGN KEY (parent_id, workspace_id)
  REFERENCES documents(id, workspace_id)
  ON DELETE SET NULL (parent_id);
