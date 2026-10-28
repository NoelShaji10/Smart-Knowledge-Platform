import { getEnv, Env } from '@knowledge/config';
import { EmailTransport } from './types';
import { MockEmailTransport } from './mock-transport';
import { SmtpEmailTransport, TransporterFactory } from './smtp-transport';

/**
 * Creates and returns the configured EmailTransport based on validated environment configuration.
 *
 * In tests and development (NODE_ENV !== 'production' with EMAIL_PROVIDER='mock'),
 * strictly returns MockEmailTransport to prevent unintended network transmissions.
 */
export function createEmailTransport(
  customEnv?: Env,
  transporterFactory?: TransporterFactory,
): EmailTransport {
  const env = customEnv || getEnv();

  if (env.EMAIL_PROVIDER === 'smtp') {
    return new SmtpEmailTransport(
      {
        host: env.SMTP_HOST || '',
        port: env.SMTP_PORT || 587,
        secure: Boolean(env.SMTP_SECURE),
        from: env.EMAIL_FROM,
        auth: env.SMTP_USER
          ? {
              user: env.SMTP_USER,
              pass: env.SMTP_PASS || '',
            }
          : undefined,
      },
      transporterFactory,
    );
  }

  return new MockEmailTransport();
}

export const getEmailTransport = createEmailTransport;
