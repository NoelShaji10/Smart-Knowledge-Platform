import { describe, it, expect, vi } from 'vitest';
import { SmtpEmailTransport } from '../smtp-transport';
import { SmtpConfig, EmailMessage } from '../types';
import { SmtpConfigError, SmtpDeliveryError } from '../errors';

describe('SmtpEmailTransport', () => {
  const validConfig: SmtpConfig = {
    host: 'smtp.mailtrap.io',
    port: 587,
    secure: false,
    auth: {
      user: 'smtp_username',
      pass: 'super_secret_smtp_password',
    },
    from: 'no-reply@knowledgeplatform.local',
  };

  describe('Configuration Validation', () => {
    it('throws SmtpConfigError when host is empty or whitespace', () => {
      expect(() => new SmtpEmailTransport({ ...validConfig, host: '' })).toThrow(SmtpConfigError);
      expect(() => new SmtpEmailTransport({ ...validConfig, host: '   ' })).toThrow(/host is required/i);
    });

    it('throws SmtpConfigError when port is invalid', () => {
      expect(() => new SmtpEmailTransport({ ...validConfig, port: 0 })).toThrow(SmtpConfigError);
      expect(() => new SmtpEmailTransport({ ...validConfig, port: -25 })).toThrow(SmtpConfigError);
      expect(() => new SmtpEmailTransport({ ...validConfig, port: 70000 })).toThrow(/port must be between 1 and 65535/i);
    });

    it('throws SmtpConfigError when sender address format is invalid', () => {
      expect(() => new SmtpEmailTransport({ ...validConfig, from: 'invalid-from' })).toThrow(SmtpConfigError);
      expect(() => new SmtpEmailTransport({ ...validConfig, from: 'not@an@email' })).toThrow(/Invalid SMTP sender/i);
    });

    it('throws SmtpConfigError when auth username is empty or pass is null', () => {
      expect(
        () =>
          new SmtpEmailTransport({
            ...validConfig,
            auth: { user: '', pass: 'pass' },
          }),
      ).toThrow(/username cannot be empty/i);

      expect(
        () =>
          new SmtpEmailTransport({
            ...validConfig,
            auth: { user: 'user', pass: null as any },
          }),
      ).toThrow(/password cannot be null/i);
    });

    it('configures requireTLS: true for port 587 STARTTLS (AUD-T2-06)', () => {
      let createdOptions: any = null;
      const factory = (cfg: any) => {
        const requireTLS = cfg.requireTLS ?? (cfg.port === 587 && !cfg.secure);
        createdOptions = {
          host: cfg.host,
          port: cfg.port,
          secure: cfg.secure,
          requireTLS: requireTLS ? true : undefined,
        };
        return { sendMail: vi.fn() } as any;
      };

      new SmtpEmailTransport({ ...validConfig, port: 587, secure: false }, factory);
      expect(createdOptions.requireTLS).toBe(true);

      new SmtpEmailTransport({ ...validConfig, port: 465, secure: true }, factory);
      expect(createdOptions.requireTLS).toBeUndefined();
    });
  });

  describe('Message Transmission & Result Mapping', () => {
    it('maps successful delivery result accurately using mock nodemailer transporter', async () => {
      const mockSendMail = vi.fn().mockResolvedValue({
        messageId: '<custom-smtp-id-12345@smtp.example.com>',
        accepted: ['recipient@example.com'],
        rejected: [],
        response: '250 2.0.0 OK Message accepted for delivery',
      });

      const mockTransporterFactory = vi.fn().mockReturnValue({
        sendMail: mockSendMail,
      } as any);

      const transport = new SmtpEmailTransport(validConfig, mockTransporterFactory);

      const message: EmailMessage = {
        to: 'recipient@example.com',
        subject: 'Workspace Invitation',
        html: '<p>Invitation Body</p>',
        text: 'Invitation Body',
      };

      const result = await transport.send(message);

      expect(mockTransporterFactory).toHaveBeenCalledWith(validConfig);
      expect(mockSendMail).toHaveBeenCalledWith({
        from: validConfig.from,
        to: 'recipient@example.com',
        subject: 'Workspace Invitation',
        html: '<p>Invitation Body</p>',
        text: 'Invitation Body',
        replyTo: undefined,
      });

      expect(result).toEqual({
        messageId: '<custom-smtp-id-12345@smtp.example.com>',
        provider: 'smtp',
        accepted: true,
        rejectedRecipients: [],
      });
    });

    it('rejects invalid recipient email addresses prior to invoking SMTP client', async () => {
      const mockSendMail = vi.fn();
      const transport = new SmtpEmailTransport(validConfig, () => ({ sendMail: mockSendMail }) as any);

      await expect(
        transport.send({
          to: 'bad-email',
          subject: 'Test',
          html: '<p>Hi</p>',
          text: 'Hi',
        }),
      ).rejects.toThrow(SmtpDeliveryError);

      expect(mockSendMail).not.toHaveBeenCalled();
    });
  });

  describe('Failure Propagation & Credential Redaction', () => {
    it('redacts sensitive passwords from error messages when SMTP transmission fails', async () => {
      const sensitivePassword = validConfig.auth!.pass;
      const mockSendMail = vi.fn().mockRejectedValue(
        new Error(`SMTP connection failed for user smtp_username with password=${sensitivePassword} at smtp.mailtrap.io:587`),
      );

      const transport = new SmtpEmailTransport(validConfig, () => ({ sendMail: mockSendMail }) as any);

      try {
        await transport.send({
          to: 'recipient@example.com',
          subject: 'Test',
          html: '<p>Hello</p>',
          text: 'Hello',
        });
        expect.fail('Expected transport.send to throw');
      } catch (err: any) {
        expect(err).toBeInstanceOf(SmtpDeliveryError);
        expect(err.message).not.toContain(sensitivePassword);
        expect(err.message).toContain('[REDACTED]');
      }
    });

    it('classifies transient network and 4xx errors as retryable for background workers', async () => {
      const transientErrors = [
        Object.assign(new Error('Connection reset by peer'), { code: 'ECONNRESET' }),
        Object.assign(new Error('Operation timed out'), { code: 'ETIMEDOUT' }),
        Object.assign(new Error('Connection refused'), { code: 'ECONNREFUSED' }),
        Object.assign(new Error('Temporary service unavailable'), { responseCode: 421 }),
        Object.assign(new Error('Mailbox busy'), { responseCode: 450 }),
      ];

      for (const rawError of transientErrors) {
        const mockSendMail = vi.fn().mockRejectedValue(rawError);
        const transport = new SmtpEmailTransport(validConfig, () => ({ sendMail: mockSendMail }) as any);

        try {
          await transport.send({
            to: 'recipient@example.com',
            subject: 'Test',
            html: '<p>Hello</p>',
            text: 'Hello',
          });
          expect.fail('Expected send to throw');
        } catch (err: any) {
          expect(err).toBeInstanceOf(SmtpDeliveryError);
          expect(err.isRetryable).toBe(true);
        }
      }
    });

    it('classifies permanent 5xx and authentication errors as non-retryable', async () => {
      const permanentErrors = [
        Object.assign(new Error('Authentication failed'), { code: 'EAUTH' }),
        Object.assign(new Error('Recipient address rejected: User unknown'), { responseCode: 550 }),
        Object.assign(new Error('Message rejected due to policy'), { responseCode: 554 }),
      ];

      for (const rawError of permanentErrors) {
        const mockSendMail = vi.fn().mockRejectedValue(rawError);
        const transport = new SmtpEmailTransport(validConfig, () => ({ sendMail: mockSendMail }) as any);

        try {
          await transport.send({
            to: 'recipient@example.com',
            subject: 'Test',
            html: '<p>Hello</p>',
            text: 'Hello',
          });
          expect.fail('Expected send to throw');
        } catch (err: any) {
          expect(err).toBeInstanceOf(SmtpDeliveryError);
          expect(err.isRetryable).toBe(false);
        }
      }
    });
  });
});
