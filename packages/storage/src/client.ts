import { S3Client } from '@aws-sdk/client-s3';
import { getEnv } from '@knowledge/config';

let s3Instance: S3Client | null = null;

export const BUCKET_SNAPSHOTS = 'snapshots';
export const BUCKET_VERSIONS = 'versions';

export function getS3Client(): S3Client {
  if (!s3Instance) {
    const env = getEnv();
    s3Instance = new S3Client({
      endpoint: env.MINIO_ENDPOINT,
      region: 'us-east-1',
      credentials: {
        accessKeyId: env.MINIO_ACCESS_KEY,
        secretAccessKey: env.MINIO_SECRET_KEY,
      },
      forcePathStyle: true, // required for MinIO
    });
  }
  return s3Instance;
}
