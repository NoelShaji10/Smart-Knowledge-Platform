-- Phase 5 T4: Fencing token support for cross-instance concurrency protection
ALTER TABLE documents
    ADD COLUMN IF NOT EXISTS fencing_token BIGINT NOT NULL DEFAULT 0;

ALTER TABLE document_versions
    ADD COLUMN IF NOT EXISTS fencing_token BIGINT NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_documents_fencing_token ON documents(id, fencing_token);
