import { ListBucketsCommand } from '@aws-sdk/client-s3';
import { getS3Client } from './client';

export async function checkStorageHealth(): Promise<{ healthy: boolean; error?: string }> {
  try {
    const client = getS3Client();
    await client.send(new ListBucketsCommand({}));
    return { healthy: true };
  } catch (err: any) {
    return { healthy: false, error: err?.message || 'Storage ping failed' };
  }
}
