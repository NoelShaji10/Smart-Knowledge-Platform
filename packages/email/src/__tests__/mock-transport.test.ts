import { describe, it, expect, beforeEach } from 'vitest';
import { MockEmailTransport } from '../mock-transport';
import { EmailMessage } from '../types';
import { EmailTransportError } from '../errors';

describe('MockEmailTransport', () => {
  let transport: MockEmailTransport;

  beforeEach(() => {
    transport = new MockEmailTransport();
  });

  it('captures sent messages in memory with full payload fidelity', async () => {
    const message: EmailMessage = {
      to: 'invitee@example.com',
      from: 'inviter@knowledgeplatform.local',
      subject: 'You have been invited to Engineering',
      html: '<p>Click <a href="http://localhost:3000/invitations/token123">here</a></p>',
      text: 'Click here: http://localhost:3000/invitations/token123',
    };

    const result = await transport.send(message);

    expect(result.provider).toBe('mock');
    expect(result.accepted).toBe(true);
    expect(result.messageId).toMatch(/^<mock-.*@knowledgeplatform\.local>$/);

    const sent = transport.getSentMessages();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toEqual({
      to: 'invitee@example.com',
      from: 'inviter@knowledgeplatform.local',
      subject: 'You have been invited to Engineering',
      html: '<p>Click <a href="http://localhost:3000/invitations/token123">here</a></p>',
      text: 'Click here: http://localhost:3000/invitations/token123',
    });
  });

  it('resets sent messages state when clearSentMessages is invoked', async () => {
    await transport.send({
      to: 'user1@example.com',
      subject: 'Subject 1',
      html: '<p>Body 1</p>',
      text: 'Body 1',
    });
    await transport.send({
      to: 'user2@example.com',
      subject: 'Subject 2',
      html: '<p>Body 2</p>',
      text: 'Body 2',
    });

    expect(transport.getSentMessages()).toHaveLength(2);

    transport.clearSentMessages();
    expect(transport.getSentMessages()).toHaveLength(0);
  });

  it('returns defensive clones to prevent external mutation of captured messages', async () => {
    await transport.send({
      to: 'original@example.com',
      subject: 'Original Subject',
      html: '<p>Body</p>',
      text: 'Body',
    });

    const messages = transport.getSentMessages();
    messages[0].to = 'tampered@example.com';

    expect(transport.getSentMessages()[0].to).toBe('original@example.com');
  });

  it('rejects invalid recipient email formats with a non-retryable error', async () => {
    await expect(
      transport.send({
        to: 'invalid-email',
        subject: 'Valid Subject',
        html: '<p>Body</p>',
        text: 'Body',
      }),
    ).rejects.toThrow(EmailTransportError);

    await expect(
      transport.send({
        to: 'not an email@domain',
        subject: 'Valid Subject',
        html: '<p>Body</p>',
        text: 'Body',
      }),
    ).rejects.toThrow(/Invalid recipient/);

    expect(transport.getSentMessages()).toHaveLength(0);
  });

  it('rejects empty subject and body', async () => {
    await expect(
      transport.send({
        to: 'user@example.com',
        subject: '   ',
        html: '<p>Body</p>',
        text: 'Body',
      }),
    ).rejects.toThrow(/subject is required/i);

    await expect(
      transport.send({
        to: 'user@example.com',
        subject: 'Subject',
        html: '  ',
        text: '  ',
      }),
    ).rejects.toThrow(/non-empty html or text/i);
  });

  it('supports simulated failure via failNext without capturing message', async () => {
    transport.failNext(new Error('Simulated network timeout'));

    await expect(
      transport.send({
        to: 'user@example.com',
        subject: 'Subject',
        html: '<p>Body</p>',
        text: 'Body',
      }),
    ).rejects.toThrow('Simulated network timeout');

    // Message must not be captured if send failed
    expect(transport.getSentMessages()).toHaveLength(0);

    // Subsequent call succeeds
    await transport.send({
      to: 'user@example.com',
      subject: 'Subject',
      html: '<p>Body</p>',
      text: 'Body',
    });
    expect(transport.getSentMessages()).toHaveLength(1);
  });
});
