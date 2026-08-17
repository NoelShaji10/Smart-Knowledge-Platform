-- Migration 0006: Add 'restore' trigger to document_versions CHECK constraint

ALTER TABLE document_versions DROP CONSTRAINT IF EXISTS document_versions_trigger_check;

ALTER TABLE document_versions ADD CONSTRAINT document_versions_trigger_check
  CHECK (trigger IN ('manual', 'auto_interval', 'session_end', 'restore'));
