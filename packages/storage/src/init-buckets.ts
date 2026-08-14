import { CreateBucketCommand, HeadBucketCommand } from '@aws-sdk/client-s3';
import { getS3Client, BUCKET_SNAPSHOTS, BUCKET_VERSIONS } from './client';

export async function ensureBucketsExist(): Promise<void> {
  const client = getS3Client();
  const buckets = [BUCKET_SNAPSHOTS, BUCKET_VERSIONS];

  for (const bucket of buckets) {
    try {
      await client.send(new HeadBucketCommand({ Bucket: bucket }));
    } catch {
      try {
        await client.send(new CreateBucketCommand({ Bucket: bucket }));
      } catch (err: any) {
        console.error(`Failed to create bucket ${bucket}:`, err?.message);
      }
    }
  }
}
