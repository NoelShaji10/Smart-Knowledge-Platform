export type WorkspaceRole = 'owner' | 'admin' | 'editor' | 'viewer';
export type InvitationRole = 'admin' | 'editor' | 'viewer';
export type InvitationStatus = 'pending' | 'accepted' | 'revoked' | 'expired';
export type DocumentRole = 'editor' | 'viewer' | 'none';
export type SuggestionType = 'summary' | 'tags' | 'rewrite' | 'other';
export type SuggestionStatus = 'pending' | 'accepted' | 'rejected' | 'expired';
export type VersionTrigger = 'manual' | 'auto_interval' | 'session_end' | 'restore';

export class StaleFencingTokenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StaleFencingTokenError';
  }
}

