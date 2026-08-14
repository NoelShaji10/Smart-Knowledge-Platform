import { createApiApp } from './app';
import { getEnv } from '@knowledge/config';

export function startApiServer() {
  const app = createApiApp();
  const port = getEnv().PORT;

  const server = app.listen(port, () => {
    console.log(`API server listening on port ${port}`);
  });

  return server;
}
