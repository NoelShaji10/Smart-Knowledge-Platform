import { Kysely, Transaction } from 'kysely';
import { Database, withSystemContext } from '@knowledge/database';

export interface AuditEventParams {
  workspaceId: string | null;
  actorId: string | null;
  action: string;
  resourceType: string;
  resourceId: string;
  metadata?: Record<string, unknown>;
  ipAddress?: string;
  userAgent?: string;
}

export async function emitAuditEvent(
  db: Kysely<Database> | Transaction<Database>,
  params: AuditEventParams,
): Promise<void> {
  const doInsert = async (targetDb: Kysely<Database> | Transaction<Database>) => {
    await targetDb
      .insertInto('audit_events')
      .values({
        workspace_id: params.workspaceId,
        actor_id: params.actorId,
        action: params.action,
        resource_type: params.resourceType,
        resource_id: params.resourceId,
        metadata: JSON.stringify(params.metadata || {}),
        ip_address: params.ipAddress || null,
        user_agent: params.userAgent || null,
      })
      .execute();
  };

  if (params.workspaceId === null) {
    await withSystemContext(async (sysDb) => {
      await doInsert(sysDb);
    });
  } else {
    await doInsert(db);
  }
}
