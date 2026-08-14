import { getRedisClient, getRedisSubscriber } from './client';

export function getDocChannel(documentId: string): string {
  return `doc:${documentId}`;
}

export async function publishMessage<T>(channel: string, message: T): Promise<number> {
  const client = getRedisClient();
  const payload = typeof message === 'string' ? message : JSON.stringify(message);
  return client.publish(channel, payload);
}

export async function subscribeToChannel<T>(
  channel: string,
  onMessage: (message: T) => void,
): Promise<void> {
  const subscriber = getRedisSubscriber();
  await subscriber.subscribe(channel);
  subscriber.on('message', (ch, msg) => {
    if (ch === channel) {
      try {
        const parsed = JSON.parse(msg) as T;
        onMessage(parsed);
      } catch {
        onMessage(msg as unknown as T);
      }
    }
  });
}
