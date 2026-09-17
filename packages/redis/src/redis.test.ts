import { describe, it, expect } from 'vitest';
import { getDocChannel } from './pubsub';
import { AsyncKeyedMutex, withDistributedLock } from './lock';

describe('redis pubsub channel helpers', () => {
  it('formats document channel names correctly', () => {
    expect(getDocChannel('doc-123')).toBe('doc:doc-123');
  });
});

describe('AsyncKeyedMutex and withDistributedLock', () => {
  it('serializes concurrent executions for the same key', async () => {
    const mutex = new AsyncKeyedMutex();
    const executionOrder: number[] = [];

    const op1 = async () => {
      const release = await mutex.acquire('key1');
      await new Promise((r) => setTimeout(r, 50));
      executionOrder.push(1);
      release();
    };

    const op2 = async () => {
      const release = await mutex.acquire('key1');
      executionOrder.push(2);
      release();
    };

    await Promise.all([op1(), op2()]);
    expect(executionOrder).toEqual([1, 2]);
  });

  it('allows parallel executions for different keys', async () => {
    const mutex = new AsyncKeyedMutex();
    const executionOrder: string[] = [];

    const opA = async () => {
      const release = await mutex.acquire('keyA');
      await new Promise((r) => setTimeout(r, 30));
      executionOrder.push('A');
      release();
    };

    const opB = async () => {
      const release = await mutex.acquire('keyB');
      executionOrder.push('B');
      release();
    };

    await Promise.all([opA(), opB()]);
    expect(executionOrder).toEqual(['B', 'A']);
  });

  it('executes withDistributedLock and releases correctly', async () => {
    let completed = false;
    const result = await withDistributedLock('test-doc-1', async () => {
      await new Promise((r) => setTimeout(r, 20));
      completed = true;
      return 'success';
    });

    expect(result).toBe('success');
    expect(completed).toBe(true);
  });
});

