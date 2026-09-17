import { getEnv } from '@knowledge/config';
import { ensureBucketsExist } from '@knowledge/storage';
import { createCollabServer } from './server';

async function main() {
  const env = getEnv();
  const port = parseInt(env.COLLAB_PORT || '3001', 10);

  // Initialize required storage buckets before accepting traffic
  try {
    await ensureBucketsExist();
    console.log('[collab-server] Required storage buckets verified');
  } catch (err) {
    console.error('[collab-server] Fatal: Failed to initialize storage buckets:', err);
    process.exit(1);
  }

  const { server } = createCollabServer();

  server.listen(port, () => {
    console.log(`[collab-server] Listening on port ${port}`);
  });
}

main().catch((err) => {
  console.error('[collab-server] Unhandled startup error:', err);
  process.exit(1);
});
