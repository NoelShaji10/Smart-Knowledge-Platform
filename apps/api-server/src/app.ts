import express, { Express } from 'express';
import cors from 'cors';
import { healthRouter } from './routes/health';
import { wsTicketRouter } from './routes/ws-ticket';
import { errorHandler } from './middleware/error-handler';

export function createApiApp(): Express {
  const app = express();

  app.use(cors());
  app.use(express.json());

  app.use(healthRouter);
  app.use(wsTicketRouter);

  app.use(errorHandler);

  return app;
}
