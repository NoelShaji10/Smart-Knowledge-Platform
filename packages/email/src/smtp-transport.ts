import nodemailer from 'nodemailer';
import { EmailMessage, EmailTransport, SendEmailResult, SmtpConfig } from './types';
import { SmtpConfigError, SmtpDeliveryError, isSmtpRetryable, sanitizeErrorMessage } from './errors';

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type TransporterFactory = (config: SmtpConfig) => nodemailer.Transporter;

function defaultTransporterFactory(config: SmtpConfig): nodemailer.Transporter {
  const requireTLS = config.requireTLS ?? (config.port === 587 && !config.secure);
  return nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    requireTLS: requireTLS ? true : undefined,
    auth: config.auth?.user
      ? {
          user: config.auth.user,
          pass: config.auth.pass,
        }
      : undefined,
  });
}

/**
 * Production SMTP Email Transport.
 *
 * NOTE ON DELIVERY GUARANTEES:
 * Successfully completing a send() operation confirms that the configured SMTP relay/server
 * accepted the message envelope. It does NOT guarantee that the downstream recipient server
 * or inbox provider will place the message in the user's primary inbox (due to potential
 * spam filtering, IP reputation, or downstream bounce handling).
 */
export class SmtpEmailTransport implements EmailTransport {
  public readonly providerName = 'smtp' as const;
  private readonly config: SmtpConfig;
  private readonly transporter: nodemailer.Transporter;

  constructor(config: SmtpConfig, transporterFactory: TransporterFactory = defaultTransporterFactory) {
    this.validateConfig(config);
    this.config = { ...config };
    this.transporter = transporterFactory(config);
  }

  private validateConfig(config: SmtpConfig): void {
    if (!config.host || config.host.trim().length === 0) {
      throw new SmtpConfigError('SMTP host is required and cannot be empty');
    }

    if (!config.port || isNaN(config.port) || config.port <= 0 || config.port > 65535) {
      throw new SmtpConfigError(`Invalid SMTP port: ${config.port}. Port must be between 1 and 65535`);
    }

    if (!config.from || !EMAIL_REGEX.test(config.from.trim())) {
      throw new SmtpConfigError(`Invalid SMTP sender address: "${config.from}"`);
    }

    if (config.auth) {
      if (!config.auth.user || config.auth.user.trim().length === 0) {
        throw new SmtpConfigError('SMTP authentication username cannot be empty when auth is specified');
      }
      if (config.auth.pass === undefined || config.auth.pass === null) {
        throw new SmtpConfigError('SMTP authentication password cannot be null or undefined when auth is specified');
      }
    }
  }

  async send(message: EmailMessage): Promise<SendEmailResult> {
    const to = message.to?.trim();
    if (!to || !EMAIL_REGEX.test(to)) {
      throw new SmtpDeliveryError(`Invalid recipient email address: "${message.to}"`, {
        isRetryable: false,
        originalCode: 'INVALID_RECIPIENT',
      });
    }

    if (!message.subject || message.subject.trim().length === 0) {
      throw new SmtpDeliveryError('Email subject is required', {
        isRetryable: false,
        originalCode: 'EMPTY_SUBJECT',
      });
    }

    if ((!message.html || message.html.trim().length === 0) && (!message.text || message.text.trim().length === 0)) {
      throw new SmtpDeliveryError('Email must have non-empty html or text body', {
        isRetryable: false,
        originalCode: 'EMPTY_BODY',
      });
    }

    const fromAddress = message.from?.trim() || this.config.from;

    const mailOptions: nodemailer.SendMailOptions = {
      from: fromAddress,
      to,
      subject: message.subject.trim(),
      html: message.html,
      text: message.text,
      replyTo: message.replyTo?.trim(),
    };

    try {
      const info = await this.transporter.sendMail(mailOptions);

      const acceptedList = Array.isArray(info.accepted) ? info.accepted.map(String) : [];
      const rejectedList = Array.isArray(info.rejected) ? info.rejected.map(String) : [];

      const accepted = acceptedList.length > 0;
      const messageId = info.messageId || `<smtp-${Date.now()}@knowledgeplatform.local>`;

      return {
        messageId,
        provider: 'smtp',
        accepted,
        rejectedRecipients: rejectedList,
      };
    } catch (err: any) {
      const sensitiveTokens = [this.config.auth?.pass || ''];
      const rawMessage = err?.message || 'Unknown SMTP transmission error';
      const sanitizedMessage = sanitizeErrorMessage(rawMessage, sensitiveTokens);
      const isRetryable = isSmtpRetryable(err);
      const code = err?.code || err?.responseCode?.toString();

      throw new SmtpDeliveryError(`SMTP transmission failed: ${sanitizedMessage}`, {
        isRetryable,
        originalCode: code,
        cause: err,
      });
    }
  }
}
