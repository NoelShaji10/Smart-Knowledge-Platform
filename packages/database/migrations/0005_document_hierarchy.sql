-- Migration 0005: Document Hierarchy, Archiving & Versioning Foundation

-- 1. Add unique constraint on documents(id, workspace_id) to allow composite foreign key reference
ALTER TABLE documents ADD CONSTRAINT documents_id_workspace_id_key UNIQUE (id, workspace_id);

-- 2. Add parent_id for document hierarchy (adjacency list)
ALTER TABLE documents ADD COLUMN parent_id UUID;

-- 3. Add is_archived for soft deletion
ALTER TABLE documents ADD COLUMN is_archived BOOLEAN NOT NULL DEFAULT false;

-- 4. Add composite foreign key enforcing same-workspace parent relationship at DB engine level
ALTER TABLE documents
  ADD CONSTRAINT fk_documents_parent_workspace
  FOREIGN KEY (parent_id, workspace_id)
  REFERENCES documents(id, workspace_id)
  ON DELETE SET NULL;

-- 5. Make snapshot_key nullable in document_versions for Phase 2 plaintext versioning
ALTER TABLE document_versions ALTER COLUMN snapshot_key DROP NOT NULL;

-- 6. Add partial indexes for performance
CREATE INDEX IF NOT EXISTS idx_documents_parent ON documents(parent_id) WHERE parent_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_documents_workspace_active ON documents(workspace_id) WHERE is_archived = false;

-- 7. Ensure knowledge_app runtime role has privileges on modified tables
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO knowledge_app;
