import { getEnv } from '@knowledge/config';
import { EmailMessage } from '../types';
import { escapeHtml } from './invitation';

export interface EmailVerificationOptions {
  recipientEmail: string;
  displayName?: string;
  rawToken: string;
  expiresAt: Date | string | number;
  webAppUrl?: string;
  from?: string;
  nodeEnv?: 'development' | 'test' | 'production';
}

/**
 * Asserts that a header value does not contain CRLF characters to prevent header injection.
 */
function assertNoHeaderInjection(value: string, fieldName: string): void {
  if (/[\r\n]/.test(value)) {
    throw new Error(`Header injection attempt rejected in ${fieldName}`);
  }
}

/**
 * Safely constructs the canonical email verification URL.
 */
export function buildEmailVerificationUrl(
  rawToken: string,
  baseUrlInput?: string,
  nodeEnvInput?: 'development' | 'test' | 'production',
): string {
  if (!rawToken || typeof rawToken !== 'string' || rawToken.trim().length === 0) {
    throw new Error('rawToken is required to build email verification URL');
  }

  let baseUrl = baseUrlInput;
  let currentEnv = nodeEnvInput;

  try {
    const env = getEnv();
    if (!baseUrl) baseUrl = env.WEB_APP_URL;
    if (!currentEnv) currentEnv = env.NODE_ENV;
  } catch {
    // If env is not loaded, fall back to passed values
  }

  if (!baseUrl) {
    baseUrl = 'http://localhost:3000';
  }

  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch (err) {
    throw new Error(`Invalid base URL for email verification: ${baseUrl}`);
  }

  if (currentEnv === 'production' && parsed.protocol !== 'https:') {
    throw new Error('In production, verification URLs must use HTTPS');
  }

  const cleanBase = baseUrl.replace(/\/+$/, '');
  return `${cleanBase}/verify-email?token=${encodeURIComponent(rawToken.trim())}`;
}

/**
 * Generates both plain text and secure HTML email bodies for account email verification.
 */
export function generateEmailVerificationEmail(options: EmailVerificationOptions): EmailMessage {
  const {
    recipientEmail,
    displayName,
    rawToken,
    expiresAt,
    webAppUrl,
    from,
    nodeEnv,
  } = options;

  if (!recipientEmail || typeof recipientEmail !== 'string' || recipientEmail.trim().length === 0) {
    throw new Error('recipientEmail is required');
  }

  assertNoHeaderInjection(recipientEmail, 'recipientEmail');

  const verificationUrl = buildEmailVerificationUrl(rawToken, webAppUrl, nodeEnv);

  const parsedExpires = expiresAt instanceof Date ? expiresAt : new Date(expiresAt);
  const formattedExpiry = isNaN(parsedExpires.getTime())
    ? 'in 24 hours'
    : parsedExpires.toUTCString();

  const safeRecipientName = escapeHtml(displayName || 'there');
  const safeRecipientEmail = escapeHtml(recipientEmail);
  const safeVerificationUrl = escapeHtml(verificationUrl);
  const safeExpiry = escapeHtml(formattedExpiry);

  const subject = 'Verify your email address for Smart Knowledge Platform';
  assertNoHeaderInjection(subject, 'subject');

  const sender = from || 'noreply@smartknowledge.platform';
  assertNoHeaderInjection(sender, 'from');

  const text = `
Hello ${displayName || 'there'},

Please verify your email address for your Smart Knowledge Platform account.

Click the link below to verify your email address:
${verificationUrl}

This verification link will expire on: ${formattedExpiry}.
If you did not create an account or request this verification, you can safely ignore this email.
`.trim();

  const html = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Verify your email address</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      margin: 0;
      padding: 0;
      background-color: #f8fafc;
      color: #1e293b;
    }
    .wrapper {
      padding: 32px 16px;
    }
    .container {
      max-width: 580px;
      margin: 0 auto;
      background-color: #ffffff;
      border-radius: 12px;
      overflow: hidden;
      box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.05), 0 2px 4px -1px rgba(0, 0, 0, 0.03);
      border: 1px solid #e2e8f0;
    }
    .header {
      background: linear-gradient(135deg, #4f46e5 0%, #3b82f6 100%);
      padding: 32px 24px;
      text-align: center;
      color: #ffffff;
    }
    .header h1 {
      margin: 0;
      font-size: 22px;
      font-weight: 700;
      letter-spacing: -0.02em;
    }
    .content {
      padding: 32px 28px;
      line-height: 1.6;
    }
    .content p {
      margin: 0 0 16px;
      font-size: 15px;
    }
    .cta-container {
      text-align: center;
      margin: 32px 0;
    }
    .cta-button {
      display: inline-block;
      background-color: #4f46e5;
      color: #ffffff !important;
      text-decoration: none;
      font-weight: 600;
      font-size: 15px;
      padding: 12px 28px;
      border-radius: 8px;
    }
    .footer {
      background-color: #f8fafc;
      padding: 20px 24px;
      font-size: 13px;
      color: #64748b;
      border-top: 1px solid #e2e8f0;
      text-align: center;
    }
    .break-url {
      word-break: break-all;
      color: #4f46e5;
      font-size: 13px;
    }
  </style>
</head>
<body>
  <div class="wrapper">
    <div class="container">
      <div class="header">
        <h1>Smart Knowledge Platform</h1>
      </div>
      <div class="content">
        <p>Hello <strong>${safeRecipientName}</strong>,</p>
        <p>Please verify your email address (<strong>${safeRecipientEmail}</strong>) to complete your account setup and unlock workspace collaboration features.</p>
        <div class="cta-container">
          <a href="${safeVerificationUrl}" class="cta-button" target="_blank" rel="noopener noreferrer">Verify Email Address</a>
        </div>
        <p>This verification link expires on <strong>${safeExpiry}</strong>.</p>
        <p>If you're having trouble clicking the button, copy and paste this URL into your browser:</p>
        <p><a href="${safeVerificationUrl}" class="break-url">${safeVerificationUrl}</a></p>
      </div>
      <div class="footer">
        <p style="margin: 0;">If you did not request this email, no action is needed and you can safely ignore it.</p>
      </div>
    </div>
  </div>
</body>
</html>
`.trim();

  return {
    to: recipientEmail,
    from: sender,
    subject,
    text,
    html,
  };
}
