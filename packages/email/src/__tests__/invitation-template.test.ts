import { describe, it, expect } from 'vitest';
import {
  generateInvitationEmail,
  buildInvitationAcceptanceUrl,
  escapeHtml,
  InvitationEmailOptions,
} from '../templates/invitation';

describe('Invitation Email Template Generator', () => {
  const baseOptions: InvitationEmailOptions = {
    recipientEmail: 'colleague@example.com',
    recipientName: 'Alex Rivera',
    workspaceName: 'Acme Research Lab',
    inviterName: 'Dr. Jane Smith',
    role: 'editor',
    rawToken: 'secure_sample_token_xyz123',
    expiresAt: new Date('2026-11-01T12:00:00Z'),
    webAppUrl: 'http://localhost:3000',
    nodeEnv: 'test',
  };

  describe('HTML Escaping & Content Sanitization', () => {
    it('escapes &, <, >, ", and \' characters in user-controlled strings', () => {
      const malicious = '<script>alert("XSS")</script> & "quotes" \'apostrophe\'';
      const escaped = escapeHtml(malicious);

      expect(escaped).not.toContain('<script>');
      expect(escaped).toContain('&lt;script&gt;');
      expect(escaped).toContain('&amp;');
      expect(escaped).toContain('&quot;quotes&quot;');
      expect(escaped).toContain('&#39;apostrophe&#39;');
    });

    it('sanitizes malicious workspace, inviter, and recipient names in rendered HTML', () => {
      const email = generateInvitationEmail({
        ...baseOptions,
        workspaceName: '<b onmouseover="alert(1)">Hacked Workspace</b>',
        inviterName: '<img src=x onerror=alert(2)>',
        recipientName: 'Eve <script>bad()</script>',
      });

      expect(email.html).not.toContain('<script>bad()</script>');
      expect(email.html).not.toContain('<img src=x');
      expect(email.html).toContain('&lt;b onmouseover=&quot;alert(1)&quot;&gt;Hacked Workspace&lt;/b&gt;');
      expect(email.html).toContain('&lt;img src=x onerror=alert(2)&gt;');
      expect(email.html).toContain('Eve &lt;script&gt;bad()&lt;/script&gt;');
    });
  });

  describe('URL Construction & Token Encoding', () => {
    it('constructs absolute acceptance URL using configured base URL', () => {
      const url = buildInvitationAcceptanceUrl('token123', 'https://app.knowledgeplatform.com', 'production');
      expect(url).toBe('https://app.knowledgeplatform.com/invitations/token123');
    });

    it('correctly encodes tokens with special characters as a single path segment', () => {
      const specialToken = 'tok/with+special=chars?and&query#hash';
      const url = buildInvitationAcceptanceUrl(specialToken, 'http://localhost:3000', 'test');

      const parsed = new URL(url);
      expect(parsed.pathname).toBe('/invitations/tok%2Fwith%2Bspecial%3Dchars%3Fand%26query%23hash');
      expect(parsed.search).toBe('');
      expect(parsed.hash).toBe('');
    });

    it('rejects invalid or non-absolute base URLs', () => {
      expect(() => buildInvitationAcceptanceUrl('token123', 'not-a-url', 'test')).toThrow(/Invalid base URL/);
      expect(() => buildInvitationAcceptanceUrl('token123', '/relative/path', 'test')).toThrow(/Invalid base URL/);
      expect(() => buildInvitationAcceptanceUrl('token123', 'ftp://files.example.com', 'test')).toThrow(/Must use http: or https:/);
    });

    it('rejects non-HTTPS URLs in production environment', () => {
      expect(() =>
        buildInvitationAcceptanceUrl('token123', 'http://insecure.example.com', 'production'),
      ).toThrow(/must use HTTPS protocol/);

      const validProdUrl = buildInvitationAcceptanceUrl('token123', 'https://secure.example.com', 'production');
      expect(validProdUrl).toBe('https://secure.example.com/invitations/token123');
    });

    it('rejects base URLs with embedded user credentials (AUD-T2-04)', () => {
      expect(() =>
        buildInvitationAcceptanceUrl('token123', 'https://admin:secret@app.knowledgeplatform.com', 'test'),
      ).toThrow(/Base URL must not contain embedded user credentials/);
    });
  });

  describe('Header Injection Defense', () => {
    it('rejects CRLF newline characters in workspace name to prevent subject header injection', () => {
      expect(() =>
        generateInvitationEmail({
          ...baseOptions,
          workspaceName: 'Acme\r\nBcc: evil@attacker.com',
        }),
      ).toThrow(/Header injection attempt rejected/);

      expect(() =>
        generateInvitationEmail({
          ...baseOptions,
          workspaceName: 'Acme\nInjectedHeader: value',
        }),
      ).toThrow(/Header injection attempt rejected/);
    });

    it('rejects CRLF characters in recipient and from addresses', () => {
      expect(() =>
        generateInvitationEmail({
          ...baseOptions,
          recipientEmail: 'user@example.com\r\nCc: spy@example.com',
        }),
      ).toThrow(/Header injection attempt rejected/);

      expect(() =>
        generateInvitationEmail({
          ...baseOptions,
          from: 'no-reply@example.com\r\nContent-Type: text/html',
        }),
      ).toThrow(/Header injection attempt rejected/);
    });

    it('normalizes newlines and control characters in inviter and recipient display names (AUD-T2-05)', () => {
      const email = generateInvitationEmail({
        ...baseOptions,
        inviterName: 'Alice\r\nSpoofed System Message',
        recipientName: 'Bob\n\tAttacker Injected Line',
      });

      // Plaintext must not contain raw CRLF inside the interpolated names
      expect(email.text).toContain('Alice Spoofed System Message has invited you');
      expect(email.text).toContain('Hello Bob Attacker Injected Line,');
      expect(email.text).not.toContain('Alice\r\n');
    });
  });

  describe('Full Email Message Output Structure', () => {
    it('produces both HTML and plaintext messages containing all required invitation details', () => {
      const email = generateInvitationEmail(baseOptions);

      expect(email.to).toBe('colleague@example.com');
      expect(email.subject).toBe("You're invited to join Acme Research Lab");

      // HTML assertions
      expect(email.html).toContain('Acme Research Lab');
      expect(email.html).toContain('Dr. Jane Smith');
      expect(email.html).toContain('Editor');
      expect(email.html).toContain('create, edit, organize, and collaborate on documents');
      expect(email.html).toContain('http://localhost:3000/invitations/secure_sample_token_xyz123');
      expect(email.html).toContain('Sun, 01 Nov 2026 12:00:00 GMT');
      expect(email.html).toContain('Accept Invitation');

      // Plaintext assertions
      expect(email.text).toContain('Acme Research Lab');
      expect(email.text).toContain('Dr. Jane Smith');
      expect(email.text).toContain('Editor access');
      expect(email.text).toContain('http://localhost:3000/invitations/secure_sample_token_xyz123');
      expect(email.text).toContain('Sun, 01 Nov 2026 12:00:00 GMT');
    });

    it('correctly handles omitted inviterName with default fallback', () => {
      const email = generateInvitationEmail({
        ...baseOptions,
        inviterName: undefined,
        recipientName: undefined,
      });

      expect(email.html).toContain('A team member');
      expect(email.text).toContain('A team member has invited you');
      expect(email.html).toContain('Hello,');
    });

    it('correctly describes Admin, Editor, and Viewer roles', () => {
      const adminEmail = generateInvitationEmail({ ...baseOptions, role: 'admin' });
      expect(adminEmail.html).toContain('manage workspace members, settings, and documents');

      const editorEmail = generateInvitationEmail({ ...baseOptions, role: 'editor' });
      expect(editorEmail.html).toContain('create, edit, organize, and collaborate on documents');

      const viewerEmail = generateInvitationEmail({ ...baseOptions, role: 'viewer' });
      expect(viewerEmail.html).toContain('view published documents and comments');
    });
  });
});
