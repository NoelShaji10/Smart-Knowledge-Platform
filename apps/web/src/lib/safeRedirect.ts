/**
 * Validates and sanitizes internal application return destinations to prevent
 * open redirects, protocol injection, and path confusion attacks.
 */
export function getSafeReturnUrl(target: string | null | undefined): string | null {
  if (!target || typeof target !== 'string') {
    return null;
  }

  const trimmed = target.trim();

  // Must begin with a single slash '/'
  if (!trimmed.startsWith('/')) {
    return null;
  }

  // Reject protocol-relative URLs (e.g. '//evil.com' or '/\evil.com')
  if (trimmed.startsWith('//') || trimmed.startsWith('/\\')) {
    return null;
  }

  // Reject any backslashes anywhere in the path to prevent bypasses or path confusion
  if (trimmed.includes('\\')) {
    return null;
  }

  // Reject ASCII control characters
  for (let i = 0; i < trimmed.length; i++) {
    if (trimmed.charCodeAt(i) < 32 || trimmed.charCodeAt(i) === 127) {
      return null;
    }
  }

  // Extract path part before any query ('?') or fragment ('#')
  const pathPart = trimmed.split(/[?#]/)[0];

  // Disallow colon ':' in path part to prevent scheme confusion (e.g., '/http://evil.com')
  if (pathPart.includes(':')) {
    return null;
  }

  // Disallow directory traversal segments ('/../' or '/..')
  const segments = pathPart.split('/');
  if (segments.some((seg) => seg === '..')) {
    return null;
  }

  return trimmed;
}
