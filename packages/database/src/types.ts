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
  password_hash: string | null;
  email_verified: Generated<boolean>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface EmailVerificationTokensTable {
  id: Generated<string>;
  sequence_number: Generated<number>;
  user_id: string;
  email: string;
  token_hash: string;
  expires_at: Date;
  created_at: Generated<Date>;
  consumed_at: Date | null;
}

export interface RefreshTokensTable {
  id: Generated<string>;
  user_id: string;
  family_id: string;
  token_hash: string;
  expires_at: Date;
  created_at: Generated<Date>;
  revoked_at: Date | null;
}

export interface WorkspaceMembersTable {
  workspace_id: string;
  user_id: string;
  role: 'owner' | 'admin' | 'editor' | 'viewer';
  created_at: Generated<Date>;
}

export interface WorkspaceInvitationsTable {
  id: Generated<string>;
  workspace_id: string;
  inviter_id: string;
  invitee_email: string | null;
  role: 'admin' | 'editor' | 'viewer';
  token_hash: string;
  status: 'pending' | 'accepted' | 'revoked' | 'expired';
  expires_at: Date;
  accepted_by: string | null;
  accepted_at: Date | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
  email_delivery_status: Generated<'not_requested' | 'queued' | 'processing' | 'accepted_by_provider' | 'failed' | 'permanently_failed'>;
  email_queued_at: Date | null;
  email_sent_at: Date | null;
  email_last_attempt_at: Date | null;
  email_delivery_attempts: Generated<number>;
  email_failure_reason: string | null;
  claim_id: string | null;
  claim_expires_at: Date | null;
  encrypted_token: ColumnType<Record<string, unknown> | null, string | Record<string, unknown> | null, string | Record<string, unknown> | null>;
}

export interface DocumentsTable {
  id: Generated<string>;
  workspace_id: string;
  parent_id: string | null;
  is_archived: Generated<boolean>;
  title: string;
  content_text: string;
  content_tsv: Generated<unknown>;
  snapshot_key: string | null;
  snapshot_version: Generated<number>;
  fencing_token: Generated<number>;
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
  snapshot_key: string | null;
  content_text: string | null;
  title: string | null;
  created_by: string | null;
  trigger: 'manual' | 'auto_interval' | 'session_end' | 'restore';
  fencing_token: Generated<number>;
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
  workspace_id: string | null;
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
  refresh_tokens: RefreshTokensTable;
  workspace_members: WorkspaceMembersTable;
  workspace_invitations: WorkspaceInvitationsTable;
  documents: DocumentsTable;
  document_permissions: DocumentPermissionsTable;
  document_versions: DocumentVersionsTable;
  ai_suggestions: AISuggestionsTable;
  comments: CommentsTable;
  audit_events: AuditEventsTable;
  email_verification_tokens: EmailVerificationTokensTable;
}

