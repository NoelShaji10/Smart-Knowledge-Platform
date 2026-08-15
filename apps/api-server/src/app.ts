import express, { Express } from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { healthRouter } from './routes/health';
import { authRouter } from './routes/auth';
import { workspaceRouter } from './routes/workspaces';
import { wsTicketRouter } from './routes/ws-ticket';
import { errorHandler } from './middleware/error-handler';

export function createApiApp(): Express {
  const app = express();

  app.use(cors());
  app.use(express.json());
  app.use(cookieParser());

  app.use(healthRouter);
  app.use(authRouter);
  app.use(workspaceRouter);
  app.use(wsTicketRouter);

  app.use(errorHandler);

  return app;
}
