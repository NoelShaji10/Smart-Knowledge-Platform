export const QUEUE_INDEX_DOCUMENT = 'index.document';
export const QUEUE_EMBED_DOCUMENT = 'embed.document';
export const QUEUE_AI_SUGGEST = 'ai.suggest';
export const QUEUE_PERMISSIONS_SYNC = 'permissions.sync';
export const QUEUE_SNAPSHOT_COMPACT = 'snapshot.compact';
export const QUEUE_SEND_INVITATION_EMAIL = 'invitation.send_email';
export const QUEUE_RECONCILE_INVITATIONS = 'invitation.reconcile';

export type JobQueueName =
  | typeof QUEUE_INDEX_DOCUMENT
  | typeof QUEUE_EMBED_DOCUMENT
  | typeof QUEUE_AI_SUGGEST
  | typeof QUEUE_PERMISSIONS_SYNC
  | typeof QUEUE_SNAPSHOT_COMPACT
  | typeof QUEUE_SEND_INVITATION_EMAIL
  | typeof QUEUE_RECONCILE_INVITATIONS;
