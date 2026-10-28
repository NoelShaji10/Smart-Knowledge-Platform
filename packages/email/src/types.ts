/**
 * Canonical email transport contract and message specifications.
 */

export interface EmailMessage {
  to: string;
  from?: string;
  subject: string;
  html: string;
  text: string;
  replyTo?: string;
}

export interface SendEmailResult {
  messageId: string;
  provider: 'mock' | 'smtp';
  /**
   * Indicates that the provider or SMTP relay accepted the message.
   * NOTE: Relay acceptance does NOT guarantee final inbox placement (e.g. spam filtering, remote delivery failure).
   */
  accepted: boolean;
  rejectedRecipients?: string[];
}

export interface EmailTransport {
  readonly providerName: 'mock' | 'smtp';
  send(message: EmailMessage): Promise<SendEmailResult>;
}

export interface SmtpConfig {
  host: string;
  port: number;
  secure: boolean;
  requireTLS?: boolean;
  auth?: {
    user: string;
    pass: string;
  };
  from: string;
}
