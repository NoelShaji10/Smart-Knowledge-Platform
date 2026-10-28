import crypto from 'crypto';
import { EmailMessage, EmailTransport, SendEmailResult } from './types';
import { EmailTransportError } from './errors';

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Mock email transport for development and test environments.
 * Strictly operates in-memory with zero network calls.
 */
export class MockEmailTransport implements EmailTransport {
  public readonly providerName = 'mock' as const;
  private sentMessages: EmailMessage[] = [];
  private nextError: Error | null = null;

  async send(message: EmailMessage): Promise<SendEmailResult> {
    if (this.nextError) {
      const err = this.nextError;
      this.nextError = null;
      throw err;
    }

    // Basic message contract validation
    if (!message.to || !EMAIL_REGEX.test(message.to.trim())) {
      throw new EmailTransportError('Invalid recipient email address', {
        provider: 'mock',
        isRetryable: false,
        originalCode: 'INVALID_RECIPIENT',
      });
    }

    if (!message.subject || message.subject.trim().length === 0) {
      throw new EmailTransportError('Email subject is required', {
        provider: 'mock',
        isRetryable: false,
        originalCode: 'EMPTY_SUBJECT',
      });
    }

    if ((!message.html || message.html.trim().length === 0) && (!message.text || message.text.trim().length === 0)) {
      throw new EmailTransportError('Email must have non-empty html or text body', {
        provider: 'mock',
        isRetryable: false,
        originalCode: 'EMPTY_BODY',
      });
    }

    // Capture clone of sent message
    this.sentMessages.push({
      ...message,
      to: message.to.trim(),
      from: message.from?.trim(),
      subject: message.subject.trim(),
    });

    const messageId = `<mock-${crypto.randomUUID()}@knowledgeplatform.local>`;

    return {
      messageId,
      provider: 'mock',
      accepted: true,
      rejectedRecipients: [],
    };
  }

  /**
   * Retrieves an immutable snapshot of all captured messages.
   */
  getSentMessages(): EmailMessage[] {
    return this.sentMessages.map((msg) => ({ ...msg }));
  }

  /**
   * Clears all captured messages.
   */
  clearSentMessages(): void {
    this.sentMessages = [];
    this.nextError = null;
  }

  /**
   * Schedules an error to be thrown on the next send() call.
   * Useful for testing worker retry and failure handling.
   */
  failNext(error: Error): void {
    this.nextError = error;
  }
}
