import { executeIdempotentJob } from '@knowledge/jobs';

export interface PermissionsSyncJobPayload {
  documentId: string;
  userIds: string[];
  action: 'grant' | 'revoke';
}

export async function handlePermissionsSync(payload: PermissionsSyncJobPayload): Promise<void> {
  const sortedUsers = [...payload.userIds].sort().join(',');
  const idempotencyKey = `permissions.sync:${payload.documentId}:${sortedUsers}:${payload.action}`;
  await executeIdempotentJob(idempotencyKey, async () => {
    // Phase 0 handler stub
    return { synced: true };
  });
}
