import { startWorkers } from './main';
import { logger } from '@knowledge/config';

startWorkers().catch((err) => {
  logger.error('Fatal: Failed to start background workers', err);
  process.exit(1);
});
