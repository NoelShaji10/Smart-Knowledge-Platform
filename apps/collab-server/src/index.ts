import { getEnv } from '@knowledge/config';
import { createCollabServer } from './server';

const env = getEnv();
const port = parseInt(env.COLLAB_PORT || '3001', 10);

const { server } = createCollabServer();

server.listen(port, () => {
  console.log(`[collab-server] Listening on port ${port}`);
});
