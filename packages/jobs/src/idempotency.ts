const processedKeys = new Set<string>();

export async function executeIdempotentJob<T>(
  idempotencyKey: string,
  handler: () => Promise<T>,
): Promise<{ executed: boolean; result?: T }> {
  if (processedKeys.has(idempotencyKey)) {
    return { executed: false };
  }

  const result = await handler();
  processedKeys.add(idempotencyKey);
  return { executed: true, result };
}

export function clearIdempotencyCache(): void {
  processedKeys.clear();
}
