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
