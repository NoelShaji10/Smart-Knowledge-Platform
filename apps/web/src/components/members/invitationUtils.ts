/**
 * Canonical URL builder for invitation acceptance links.
 * Task 4 contract: path-based route /invitations/[token]
 */
export function buildInvitationUrl(rawToken: string): string {
  const encodedToken = encodeURIComponent(rawToken.trim());
  if (typeof window !== 'undefined' && window.location?.origin) {
    try {
      const url = new URL(`/invitations/${encodedToken}`, window.location.origin);
      return url.toString();
    } catch {
      return `${window.location.origin}/invitations/${encodedToken}`;
    }
  }
  return `/invitations/${encodedToken}`;
}

const DEFAULT_DELIVERY_ERROR_MESSAGE =
  'Delivery could not be completed. Please try again later.';

/**
 * Pure presentation helper that maps technical, internal, or raw SMTP delivery error
 * reasons to safe, user-friendly messages.
 *
 * Invariants:
 * - Never reflects arbitrary backend or raw SMTP error strings into the UI.
 * - Unknown, null, undefined, or malformed inputs return DEFAULT_DELIVERY_ERROR_MESSAGE.
 * - Preserves security: prevents exposing SMTP server responses, internal provider diagnostics,
 *   stack traces, infrastructure details, or sensitive metadata.
 */
export function formatDeliveryError(reason?: string | null): string {
  if (!reason || typeof reason !== 'string') {
    return DEFAULT_DELIVERY_ERROR_MESSAGE;
  }

  const trimmed = reason.trim();
  if (!trimmed) {
    return DEFAULT_DELIVERY_ERROR_MESSAGE;
  }

  const upper = trimmed.toUpperCase();

  // 1. Exact match on known internal worker & system codes
  switch (upper) {
    case 'QUEUE_ENQUEUE_FAILED':
      return 'Delivery could not be scheduled';
    case 'CRYPTO_DECRYPTION_FAILED':
    case 'CORRUPT_ENCRYPTED_PAYLOAD':
      return 'Internal delivery issue';
    case 'INVITATION_EXPIRED':
      return 'Invitation has expired';
    case 'INVITATION_REVOKED':
      return 'Invitation was revoked';
    case 'INVITATION_ACCEPTED':
      return 'Invitation has already been accepted';
    case 'TOKEN_SUPERSEDED':
      return 'Invitation was replaced';
  }

  // 2. Exact match on common network/connection failure codes
  if (
    upper === 'ETIMEDOUT' ||
    upper === 'ECONNREFUSED' ||
    upper === 'ECONNRESET' ||
    upper === 'ENOTFOUND' ||
    upper === 'EHOSTUNREACH' ||
    upper === 'ENETUNREACH' ||
    upper === 'SEND_ERROR'
  ) {
    return 'Mail server could not be reached';
  }

  // 3. SMTP 550 family (550, 551, 552, 553): recipient / mailbox rejections
  // Pattern: starts with 550/551/552/553 followed by word boundary, whitespace, or end of string
  if (/^55[0-3](\b|\s|$)/.test(trimmed)) {
    return 'Recipient address was rejected';
  }

  // 4. SMTP 554 / 500-504 family: transaction or permanent mail server rejections
  if (/^(554|50[0-4])(\b|\s|$)/.test(trimmed)) {
    return 'The mail server rejected the delivery';
  }

  // 5. Network / timeout patterns (e.g. "ETIMEDOUT: ...", "connection timed out")
  if (
    /^(ETIMEDOUT|ECONNREFUSED|ECONNRESET)(\b|\s|:|$)/i.test(trimmed) ||
    /timed?\s*out/i.test(trimmed)
  ) {
    return 'Mail server could not be reached';
  }

  // 6. Any other unknown, unexpected, or arbitrary diagnostic string returns safe fallback
  return DEFAULT_DELIVERY_ERROR_MESSAGE;
}
