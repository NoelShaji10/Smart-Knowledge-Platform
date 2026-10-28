import crypto from 'crypto';
import { getEnv } from '@knowledge/config';

/**
 * Standard versioned encrypted payload structure for persisting sensitive tokens
 * inside pg-boss job payloads without plaintext exposure.
 */
export interface EncryptedPayload {
  version: 1;
  algorithm: 'aes-256-gcm';
  iv: string; // base64
  tag: string; // base64
  ciphertext: string; // base64
  keyId?: string;
  hasAad?: boolean;
}

export class TokenCryptoError extends Error {
  public readonly code: string;

  constructor(message: string, options: { code: string; cause?: unknown }) {
    super(message);
    this.name = 'TokenCryptoError';
    this.code = options.code;
    if (options.cause !== undefined) {
      this.cause = options.cause;
    }
  }
}

const STRICT_HEX_KEY_REGEX = /^[0-9a-fA-F]{64}$/;
const STRICT_BASE64_KEY_REGEX = /^[A-Za-z0-9+/]{43}=$/;

/**
 * Constructs authoritative Authenticated Additional Data (AAD) for binding an invitation token
 * ciphertext to its specific invitation record and preventing cross-invitation tampering.
 */
export function buildInvitationAad(invitationId: string): Buffer {
  if (!invitationId || typeof invitationId !== 'string' || invitationId.trim().length === 0) {
    throw new TokenCryptoError('invitationId is required to construct invitation AAD context', {
      code: 'INVALID_AAD_INPUT',
    });
  }
  return Buffer.from(`invitation-delivery:v1:${invitationId.trim()}`, 'utf8');
}

/**
 * Normalizes and strictly validates a 32-byte AES-256 key from a Buffer, base64 string, or hex string.
 * Fails closed without padding or truncating. Rejects permissive non-canonical base64 strings.
 */
export function normalizeEncryptionKey(keyInput?: Buffer | string): Buffer {
  let raw = keyInput;

  if (raw === undefined) {
    try {
      raw = getEnv().EMAIL_ENCRYPTION_KEY;
    } catch {
      // Fallback if environment is not loaded
    }
  }

  if (raw === undefined || raw === null) {
    throw new TokenCryptoError('Encryption key is required but was not provided or configured', {
      code: 'MISSING_KEY',
    });
  }

  if (Buffer.isBuffer(raw)) {
    if (raw.length !== 32) {
      throw new TokenCryptoError(`Invalid key length: key must be exactly 32 bytes, received ${raw.length} bytes`, {
        code: 'INVALID_KEY_LENGTH',
      });
    }
    return raw;
  }

  if (typeof raw !== 'string' || raw.trim().length === 0) {
    throw new TokenCryptoError('Encryption key must be a non-empty string or Buffer', {
      code: 'INVALID_KEY_FORMAT',
    });
  }

  const trimmed = raw.trim();
  let keyBuf: Buffer;

  if (STRICT_HEX_KEY_REGEX.test(trimmed)) {
    keyBuf = Buffer.from(trimmed, 'hex');
  } else if (STRICT_BASE64_KEY_REGEX.test(trimmed)) {
    keyBuf = Buffer.from(trimmed, 'base64');
  } else {
    throw new TokenCryptoError(
      'Invalid key format: key must be strictly-encoded 44-character base64 with "=" padding or 64-character hex string',
      {
        code: 'INVALID_KEY_FORMAT',
      },
    );
  }

  if (keyBuf.length !== 32) {
    throw new TokenCryptoError(`Invalid key length: decoded key must be exactly 32 bytes, received ${keyBuf.length} bytes`, {
      code: 'INVALID_KEY_LENGTH',
    });
  }

  return keyBuf;
}

export type KeyResolver = (keyId?: string) => Buffer | string;

/**
 * Resolves a key from the environment key ring (active key or previous rotation keys).
 */
export function resolveKeyFromEnvRing(keyId?: string): Buffer {
  let env: any;
  try {
    env = getEnv();
  } catch {
    throw new TokenCryptoError('Environment configuration unavailable to resolve encryption key', {
      code: 'MISSING_KEY',
    });
  }

  const activeKeyId = env.EMAIL_ENCRYPTION_KEY_ID || 'v1';
  const activeKey = env.EMAIL_ENCRYPTION_KEY;

  if (!keyId || keyId === activeKeyId) {
    return normalizeEncryptionKey(activeKey);
  }

  // Look up in previous keys
  if (env.EMAIL_PREVIOUS_ENCRYPTION_KEYS) {
    try {
      const parsed = JSON.parse(env.EMAIL_PREVIOUS_ENCRYPTION_KEYS);
      if (parsed && typeof parsed === 'object' && parsed[keyId]) {
        return normalizeEncryptionKey(parsed[keyId]);
      }
    } catch {
      // Ignored: env validation guarantees format
    }
  }

  throw new TokenCryptoError(
    `Unknown encryption keyId "${keyId}". Required key is not present in active or previous key ring`,
    {
      code: 'UNKNOWN_KEY_ID',
    },
  );
}

export interface EncryptInvitationTokenOptions {
  keyId?: string;
  associatedData?: string | Buffer;
}

/**
 * Encrypts an invitation token using AES-256-GCM with a unique 12-byte random IV.
 * Optionally binds authenticated additional data (AAD) to ensure context isolation.
 */
export function encryptInvitationToken(
  rawToken: string,
  keyInput?: Buffer | string,
  options?: EncryptInvitationTokenOptions,
): EncryptedPayload {
  if (typeof rawToken !== 'string' || rawToken.trim().length === 0) {
    throw new TokenCryptoError('rawToken must be a non-empty string', {
      code: 'INVALID_TOKEN_INPUT',
    });
  }

  let activeKeyId = options?.keyId;
  if (!activeKeyId && !keyInput) {
    try {
      activeKeyId = getEnv().EMAIL_ENCRYPTION_KEY_ID || 'v1';
    } catch {
      activeKeyId = 'v1';
    }
  }

  const key = normalizeEncryptionKey(keyInput);
  const iv = crypto.randomBytes(12);

  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const hasAad = options?.associatedData !== undefined;
  if (hasAad) {
    const aadBuf = Buffer.isBuffer(options!.associatedData)
      ? options!.associatedData
      : Buffer.from(options!.associatedData!, 'utf8');
    cipher.setAAD(aadBuf);
  }

  const ciphertext = Buffer.concat([cipher.update(rawToken, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return {
    version: 1,
    algorithm: 'aes-256-gcm',
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    ciphertext: ciphertext.toString('base64'),
    keyId: activeKeyId,
    hasAad,
  };
}

/**
 * Serializes an EncryptedPayload into a compact JSON string suitable for pg-boss job data.
 */
export function serializeEncryptedPayload(payload: EncryptedPayload): string {
  return JSON.stringify(payload);
}

/**
 * Deserializes and validates a JSON string into a structured EncryptedPayload.
 */
export function deserializeEncryptedPayload(serialized: string): EncryptedPayload {
  if (typeof serialized !== 'string' || serialized.trim().length === 0) {
    throw new TokenCryptoError('Serialized encrypted payload must be a non-empty string', {
      code: 'MALFORMED_PAYLOAD',
    });
  }

  let parsed: any;
  try {
    parsed = JSON.parse(serialized);
  } catch (err) {
    throw new TokenCryptoError('Failed to parse serialized encrypted payload JSON', {
      code: 'MALFORMED_PAYLOAD',
      cause: err,
    });
  }

  if (!parsed || typeof parsed !== 'object') {
    throw new TokenCryptoError('Encrypted payload must be an object', {
      code: 'MALFORMED_PAYLOAD',
    });
  }

  if (
    typeof parsed.iv !== 'string' ||
    typeof parsed.tag !== 'string' ||
    typeof parsed.ciphertext !== 'string' ||
    parsed.algorithm === undefined
  ) {
    throw new TokenCryptoError('Encrypted payload missing required cryptographic fields', {
      code: 'MALFORMED_PAYLOAD',
    });
  }

  if (parsed.version !== 1) {
    throw new TokenCryptoError(`Unsupported encrypted payload version: ${parsed.version}`, {
      code: 'UNSUPPORTED_VERSION',
    });
  }

  if (parsed.algorithm !== 'aes-256-gcm') {
    throw new TokenCryptoError(`Unsupported encryption algorithm: ${parsed.algorithm}`, {
      code: 'UNSUPPORTED_ALGORITHM',
    });
  }

  if (parsed.keyId !== undefined && typeof parsed.keyId !== 'string') {
    throw new TokenCryptoError('Invalid keyId format in encrypted payload: must be a string', {
      code: 'MALFORMED_PAYLOAD',
    });
  }

  if (parsed.hasAad !== undefined && typeof parsed.hasAad !== 'boolean') {
    throw new TokenCryptoError('Invalid hasAad format in encrypted payload: must be a boolean', {
      code: 'MALFORMED_PAYLOAD',
    });
  }

  return {
    version: 1,
    algorithm: 'aes-256-gcm',
    iv: parsed.iv,
    tag: parsed.tag,
    ciphertext: parsed.ciphertext,
    keyId: parsed.keyId,
    hasAad: parsed.hasAad,
  };
}

export interface DecryptInvitationTokenOptions {
  associatedData?: string | Buffer;
}

/**
 * Decrypts an invitation token using AES-256-GCM and verifies the authentication tag.
 * Verifies authenticated additional data (AAD) if bound.
 * Fails closed if the payload has been tampered with or corrupted.
 */
export function decryptInvitationToken(
  payloadInput: EncryptedPayload | string,
  keyOrResolver?: Buffer | string | KeyResolver,
  options?: DecryptInvitationTokenOptions,
): string {
  const payload: EncryptedPayload =
    typeof payloadInput === 'string'
      ? deserializeEncryptedPayload(payloadInput)
      : payloadInput;

  if (!payload || typeof payload !== 'object') {
    throw new TokenCryptoError('Invalid encrypted payload input', {
      code: 'INVALID_PAYLOAD',
    });
  }

  if (payload.version !== 1) {
    throw new TokenCryptoError(`Unsupported encrypted payload version: ${payload.version}`, {
      code: 'UNSUPPORTED_VERSION',
    });
  }

  if (payload.algorithm !== 'aes-256-gcm') {
    throw new TokenCryptoError(`Unsupported encryption algorithm: ${payload.algorithm}`, {
      code: 'UNSUPPORTED_ALGORITHM',
    });
  }

  let resolvedKey: Buffer;
  if (typeof keyOrResolver === 'function') {
    resolvedKey = normalizeEncryptionKey(keyOrResolver(payload.keyId));
  } else if (keyOrResolver !== undefined) {
    resolvedKey = normalizeEncryptionKey(keyOrResolver);
  } else {
    resolvedKey = resolveKeyFromEnvRing(payload.keyId);
  }

  let iv: Buffer;
  let tag: Buffer;
  let ciphertext: Buffer;

  try {
    iv = Buffer.from(payload.iv, 'base64');
    tag = Buffer.from(payload.tag, 'base64');
    ciphertext = Buffer.from(payload.ciphertext, 'base64');
  } catch (err) {
    throw new TokenCryptoError('Failed to decode base64 payload components', {
      code: 'MALFORMED_PAYLOAD',
      cause: err,
    });
  }

  if (iv.length !== 12) {
    throw new TokenCryptoError(`Invalid IV length: expected 12 bytes, received ${iv.length}`, {
      code: 'INVALID_IV_LENGTH',
    });
  }

  if (tag.length !== 16) {
    throw new TokenCryptoError(`Invalid auth tag length: expected 16 bytes, received ${tag.length}`, {
      code: 'INVALID_TAG_LENGTH',
    });
  }

  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', resolvedKey, iv);
    if (options?.associatedData !== undefined) {
      const aadBuf = Buffer.isBuffer(options.associatedData)
        ? options.associatedData
        : Buffer.from(options.associatedData, 'utf8');
      decipher.setAAD(aadBuf);
    } else if (payload.hasAad) {
      throw new TokenCryptoError(
        'Payload was encrypted with required authenticated context (AAD) but none was provided',
        {
          code: 'MISSING_AAD_CONTEXT',
        },
      );
    }

    decipher.setAuthTag(tag);
    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return decrypted.toString('utf8');
  } catch (err: any) {
    if (err instanceof TokenCryptoError) {
      throw err;
    }
    // Fail closed: do not expose ciphertext, key, or internal OpenSSL errors
    throw new TokenCryptoError('Token decryption failed: authentication tag verification failed or corrupted payload', {
      code: 'AUTH_FAILED',
      cause: err,
    });
  }
}
