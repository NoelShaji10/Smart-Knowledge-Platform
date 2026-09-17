import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BUCKET_SNAPSHOTS, BUCKET_VERSIONS, getS3Client } from './client';
import { ensureBucketsExist } from './init-buckets';

describe('storage package', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('defines snapshots and versions bucket names', () => {
    expect(BUCKET_SNAPSHOTS).toBe('snapshots');
    expect(BUCKET_VERSIONS).toBe('versions');
  });

  it('ensureBucketsExist creates missing buckets', async () => {
    const s3 = getS3Client();
    const sendCalls: string[] = [];

    vi.spyOn(s3, 'send').mockImplementation(async (command: any) => {
      const commandName = command.constructor.name;
      sendCalls.push(`${commandName}:${command.input.Bucket}`);
      if (commandName === 'HeadBucketCommand') {
        const err = new Error('NotFound');
        (err as any).name = 'NotFound';
        throw err;
      }
      return {};
    });

    await ensureBucketsExist();

    expect(sendCalls).toContain('HeadBucketCommand:snapshots');
    expect(sendCalls).toContain('CreateBucketCommand:snapshots');
    expect(sendCalls).toContain('HeadBucketCommand:versions');
    expect(sendCalls).toContain('CreateBucketCommand:versions');
  });

  it('ensureBucketsExist skips creation if buckets already exist', async () => {
    const s3 = getS3Client();
    const sendCalls: string[] = [];

    vi.spyOn(s3, 'send').mockImplementation(async (command: any) => {
      const commandName = command.constructor.name;
      sendCalls.push(`${commandName}:${command.input.Bucket}`);
      return {}; // HeadBucket succeeds
    });

    await ensureBucketsExist();

    expect(sendCalls).toEqual([
      'HeadBucketCommand:snapshots',
      'HeadBucketCommand:versions',
    ]);
  });

  it('ensureBucketsExist throws fatal error if bucket creation fails unexpectedly', async () => {
    const s3 = getS3Client();

    vi.spyOn(s3, 'send').mockImplementation(async (command: any) => {
      const commandName = command.constructor.name;
      if (commandName === 'HeadBucketCommand') {
        const err = new Error('NotFound');
        (err as any).name = 'NotFound';
        throw err;
      }
      if (commandName === 'CreateBucketCommand') {
        const err = new Error('AccessDenied: Invalid credentials');
        (err as any).name = 'AccessDenied';
        throw err;
      }
      return {};
    });

    await expect(ensureBucketsExist()).rejects.toThrow('AccessDenied');
  });
});

