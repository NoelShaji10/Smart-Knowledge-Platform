import { ColumnType, Generated } from 'kysely';

export interface WorkspacesTable {
  id: Generated<string>;
  name: string;
  slug: string;
  settings: ColumnType<Record<string, unknown>, string, string>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface UsersTable {
  id: Generated<string>;
  email: string;
  display_name: string;
  avatar_url: string | null;
  auth_provider: string;
  auth_subject: string;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface WorkspaceMembersTable {
  workspace_id: string;
  user_id: string;
  role: 'owner' | 'admin' | 'editor' | 'viewer';
  created_at: Generated<Date>;
}

export interface DocumentsTable {
  id: Generated<string>;
  workspace_id: string;
  title: string;
  content_text: string;
  content_tsv: Generated<unknown>;
  snapshot_key: string | null;
  snapshot_version: Generated<number>;
  created_by: string;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface DocumentPermissionsTable {
  document_id: string;
  user_id: string;
  role: 'editor' | 'viewer' | 'none';
  granted_by: string;
  created_at: Generated<Date>;
}

export interface DocumentVersionsTable {
  id: Generated<string>;
  document_id: string;
  version_number: number;
  snapshot_key: string;
  content_text: string | null;
  title: string | null;
  created_by: string | null;
  trigger: 'manual' | 'auto_interval' | 'session_end';
  created_at: Generated<Date>;
}

export interface AISuggestionsTable {
  id: Generated<string>;
  document_id: string;
  workspace_id: string;
  type: 'summary' | 'tags' | 'rewrite' | 'other';
  content: ColumnType<Record<string, unknown>, string, string>;
  status: 'pending' | 'accepted' | 'rejected' | 'expired';
  model_id: string;
  provider: string;
  prompt_hash: string | null;
  resolved_by: string | null;
  resolved_at: Date | null;
  created_at: Generated<Date>;
}

export interface CommentsTable {
  id: Generated<string>;
  document_id: string;
  workspace_id: string;
  author_id: string;
  content: string;
  anchor_position: Buffer;
  resolved: boolean;
  parent_id: string | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface AuditEventsTable {
  id: Generated<string>;
  workspace_id: string;
  actor_id: string | null;
  action: string;
  resource_type: string;
  resource_id: string;
  metadata: ColumnType<Record<string, unknown>, string, string>;
  ip_address: string | null;
  user_agent: string | null;
  created_at: Generated<Date>;
}

export interface Database {
  workspaces: WorkspacesTable;
  users: UsersTable;
  workspace_members: WorkspaceMembersTable;
  documents: DocumentsTable;
  document_permissions: DocumentPermissionsTable;
  document_versions: DocumentVersionsTable;
  ai_suggestions: AISuggestionsTable;
  comments: CommentsTable;
  audit_events: AuditEventsTable;
}
