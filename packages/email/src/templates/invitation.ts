import { getEnv } from '@knowledge/config';
import { EmailMessage } from '../types';

export interface InvitationEmailOptions {
  recipientEmail: string;
  recipientName?: string;
  workspaceName: string;
  inviterName?: string;
  role: 'admin' | 'editor' | 'viewer';
  rawToken: string;
  expiresAt: Date | string | number;
  webAppUrl?: string;
  from?: string;
  nodeEnv?: 'development' | 'test' | 'production';
}

/**
 * Escapes untrusted user input before embedding into HTML templates.
 */
export function escapeHtml(str: string): string {
  if (!str) return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
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
 * Safely constructs the canonical invitation acceptance URL.
 */
export function buildInvitationAcceptanceUrl(
  rawToken: string,
  baseUrlInput?: string,
  nodeEnvInput?: 'development' | 'test' | 'production',
): string {
  if (!rawToken || typeof rawToken !== 'string' || rawToken.trim().length === 0) {
    throw new Error('rawToken is required to build invitation acceptance URL');
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
  } catch {
    throw new Error(`Invalid base URL: "${baseUrl}". Must be an absolute URL.`);
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Invalid base URL protocol: "${parsed.protocol}". Must use http: or https:.`);
  }

  if (parsed.username || parsed.password) {
    throw new Error('Base URL must not contain embedded user credentials');
  }
  parsed.username = '';
  parsed.password = '';

  if (currentEnv === 'production' && parsed.protocol !== 'https:') {
    throw new Error('Invitation links in production must use HTTPS protocol');
  }

  // Ensure encoded token occupies exactly one path segment
  const encodedToken = encodeURIComponent(rawToken.trim());
  const pathPrefix = parsed.pathname.replace(/\/+$/, '');
  parsed.pathname = `${pathPrefix}/invitations/${encodedToken}`;
  parsed.search = '';
  parsed.hash = '';

  return parsed.toString();
}

function getRoleDescription(role: 'admin' | 'editor' | 'viewer'): string {
  switch (role) {
    case 'admin':
      return 'Admin access: manage workspace members, settings, and documents.';
    case 'editor':
      return 'Editor access: create, edit, organize, and collaborate on documents.';
    case 'viewer':
    default:
      return 'Viewer access: view published documents and comments.';
  }
}

function formatRoleLabel(role: 'admin' | 'editor' | 'viewer'): string {
  switch (role) {
    case 'admin':
      return 'Admin';
    case 'editor':
      return 'Editor';
    case 'viewer':
    default:
      return 'Viewer';
  }
}

function formatExpirationDate(expiresAt: Date | string | number): string {
  try {
    const d = new Date(expiresAt);
    if (isNaN(d.getTime())) {
      return String(expiresAt);
    }
    return d.toUTCString();
  } catch {
    return String(expiresAt);
  }
}

/**
 * Generates an EmailMessage with accessible HTML and plain text for workspace invitations.
 */
export function generateInvitationEmail(options: InvitationEmailOptions): EmailMessage {
  const {
    recipientEmail,
    recipientName,
    workspaceName,
    inviterName,
    role,
    rawToken,
    expiresAt,
    webAppUrl,
    from,
    nodeEnv,
  } = options;

  if (!recipientEmail || typeof recipientEmail !== 'string') {
    throw new Error('recipientEmail is required');
  }

  if (!workspaceName || typeof workspaceName !== 'string') {
    throw new Error('workspaceName is required');
  }

  // Header injection prevention
  assertNoHeaderInjection(recipientEmail, 'recipientEmail');
  assertNoHeaderInjection(workspaceName, 'workspaceName');
  if (from) assertNoHeaderInjection(from, 'from');

  const acceptanceUrl = buildInvitationAcceptanceUrl(rawToken, webAppUrl, nodeEnv);

  const cleanWorkspace = workspaceName.trim();
  const rawInviter = inviterName && inviterName.trim().length > 0 ? inviterName.trim() : 'A team member';
  // Normalize CR/LF and control characters in display names to prevent visual spoofing in plaintext bodies
  const cleanInviter = rawInviter.replace(/[\r\n\t\x00-\x1F\x7F]+/g, ' ').trim();
  const cleanRecipientName = recipientName ? recipientName.trim().replace(/[\r\n\t\x00-\x1F\x7F]+/g, ' ').trim() : undefined;
  const roleLabel = formatRoleLabel(role);
  const roleDescription = getRoleDescription(role);
  const formattedExpiry = formatExpirationDate(expiresAt);

  const subject = `You're invited to join ${cleanWorkspace}`;
  assertNoHeaderInjection(subject, 'subject');

  let defaultFrom = 'no-reply@knowledgeplatform.local';
  try {
    defaultFrom = getEnv().EMAIL_FROM;
  } catch {
    // Fall back to default
  }
  const fromAddress = from?.trim() || defaultFrom;

  // Escaped strings for HTML
  const escapedWorkspace = escapeHtml(cleanWorkspace);
  const escapedInviter = escapeHtml(cleanInviter);
  const escapedGreeting = cleanRecipientName ? `Hello ${escapeHtml(cleanRecipientName)},` : 'Hello,';
  const escapedRoleLabel = escapeHtml(roleLabel);
  const escapedRoleDescription = escapeHtml(roleDescription);
  const escapedExpiry = escapeHtml(formattedExpiry);
  const escapedUrl = escapeHtml(acceptanceUrl);

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(subject)}</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; line-height: 1.6; color: #1e293b; background-color: #f8fafc; margin: 0; padding: 24px; }
    .container { max-width: 580px; margin: 0 auto; background: #ffffff; border-radius: 8px; border: 1px solid #e2e8f0; overflow: hidden; }
    .header { background: #0f172a; padding: 24px 32px; color: #ffffff; }
    .header h1 { margin: 0; font-size: 20px; font-weight: 600; letter-spacing: -0.01em; }
    .content { padding: 32px; }
    .content p { margin: 0 0 16px 0; font-size: 15px; }
    .role-badge { display: inline-block; background: #f1f5f9; border: 1px solid #cbd5e1; border-radius: 4px; padding: 4px 8px; font-weight: 600; font-size: 13px; color: #0f172a; margin-top: 4px; }
    .btn-container { text-align: center; margin: 32px 0; }
    .btn { display: inline-block; background: #2563eb; color: #ffffff !important; font-weight: 600; font-size: 15px; text-decoration: none; padding: 12px 28px; border-radius: 6px; }
    .fallback-url { font-size: 12px; color: #64748b; word-break: break-all; margin-top: 24px; padding-top: 16px; border-top: 1px solid #e2e8f0; }
    .footer { background: #f8fafc; padding: 20px 32px; font-size: 12px; color: #64748b; border-top: 1px solid #e2e8f0; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>Smart Knowledge Platform</h1>
    </div>
    <div class="content">
      <p>${escapedGreeting}</p>
      <p><strong>${escapedInviter}</strong> has invited you to join the <strong>${escapedWorkspace}</strong> workspace as a <strong>${escapedRoleLabel}</strong>.</p>
      <p class="role-badge">${escapedRoleDescription}</p>
      <div class="btn-container">
        <a href="${escapedUrl}" class="btn" target="_blank" rel="noopener noreferrer">Accept Invitation</a>
      </div>
      <p>This invitation link expires on <strong>${escapedExpiry}</strong>.</p>
      <div class="fallback-url">
        If the button above does not work, copy and paste this link into your browser:<br>
        <a href="${escapedUrl}">${escapedUrl}</a>
      </div>
    </div>
    <div class="footer">
      If you were not expecting this invitation, you can safely ignore this email.
    </div>
  </div>
</body>
</html>`;

  const text = `Smart Knowledge Platform
========================================

${cleanRecipientName ? `Hello ${cleanRecipientName},` : 'Hello,'}

${cleanInviter} has invited you to join the "${cleanWorkspace}" workspace as a ${roleLabel}.
${roleDescription}

To accept your invitation, visit:
${acceptanceUrl}

This invitation link expires on ${formattedExpiry}.

If you were not expecting this invitation, you can safely ignore this email.
`;

  return {
    to: recipientEmail.trim(),
    from: fromAddress,
    subject,
    html,
    text,
  };
}
