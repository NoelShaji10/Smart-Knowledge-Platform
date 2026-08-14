import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

describe('database schema & migrations', () => {
  it('reads initial migration file and contains required tables and RLS policies', () => {
    const migrationPath = path.join(__dirname, '../migrations/0001_initial_schema.sql');
    expect(fs.existsSync(migrationPath)).toBe(true);

    const sql = fs.readFileSync(migrationPath, 'utf8');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS workspaces');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS users');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS workspace_members');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS documents');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS document_permissions');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS document_versions');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS ai_suggestions');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS comments');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS audit_events');
    expect(sql).toContain('ALTER TABLE documents ENABLE ROW LEVEL SECURITY');
    expect(sql).toContain('CREATE POLICY documents_workspace_member');
    expect(sql).toContain('CREATE POLICY documents_not_denied');
    expect(sql).toContain('CREATE POLICY audit_admin_only');
  });
});
