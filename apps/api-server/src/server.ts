import { createApiApp } from './app';
import { getEnv } from '@knowledge/config';

export function startApiServer() {
  const app = createApiApp();
  const rawPort = process.env.API_PORT || process.env.PORT || '3002';
  // Default API server to port 3002 so Next.js frontend uses 3000 and collab-server uses 3001
  const port = (rawPort === '3000' || rawPort === '3001') ? 3002 : Number(rawPort);

  const server = app.listen(port, () => {
    console.log(`API server listening on port ${port}`);
  });

  return server;
}
