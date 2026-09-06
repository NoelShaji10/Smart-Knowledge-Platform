import { PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { Readable } from 'stream';
import { getS3Client, BUCKET_SNAPSHOTS, BUCKET_VERSIONS } from './client';

export async function saveRecoverySnapshot(documentId: string, data: Uint8Array): Promise<string> {
  const client = getS3Client();
  const key = `${documentId}/latest.yjs`;
  await client.send(
    new PutObjectCommand({
      Bucket: BUCKET_SNAPSHOTS,
      Key: key,
      Body: Buffer.from(data),
      ContentType: 'application/octet-stream',
    })
  );
  return key;
}

export async function loadRecoverySnapshot(documentId: string): Promise<Uint8Array | null> {
  const client = getS3Client();
  const key = `${documentId}/latest.yjs`;
  try {
    const response = await client.send(
      new GetObjectCommand({
        Bucket: BUCKET_SNAPSHOTS,
        Key: key,
      })
    );
    if (!response.Body) return null;

    if (typeof (response.Body as any).transformToByteArray === 'function') {
      return await (response.Body as any).transformToByteArray();
    }

    const stream = response.Body as Readable;
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return new Uint8Array(Buffer.concat(chunks));
  } catch (err: any) {
    const isNotFound =
      err.name === 'NoSuchKey' ||
      err.name === 'NotFound' ||
      err.code === 'NoSuchKey' ||
      err.$metadata?.httpStatusCode === 404;

    if (isNotFound) {
      return null;
    }
    throw err;
  }
}

export async function saveVersionSnapshot(
  documentId: string,
  versionNumber: number,
  data: Uint8Array
): Promise<string> {
  const client = getS3Client();
  const key = `${documentId}/${versionNumber}.yjs`;
  await client.send(
    new PutObjectCommand({
      Bucket: BUCKET_VERSIONS,
      Key: key,
      Body: Buffer.from(data),
      ContentType: 'application/octet-stream',
    })
  );
  return key;
}
