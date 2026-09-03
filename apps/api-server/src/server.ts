import { createApiApp } from './app';
import { getEnv } from '@knowledge/config';

export function startApiServer() {
  const app = createApiApp();
  const rawPort = process.env.API_PORT || getEnv().PORT;
  // If rawPort is 3000, default API server to port 3001 so Next.js frontend can use 3000
  const port = rawPort === '3000' ? 3001 : Number(rawPort);

  const server = app.listen(port, () => {
    console.log(`API server listening on port ${port}`);
  });

  return server;
}
