import crypto from 'crypto';
import { describe, it, expect } from 'vitest';
import {
  encryptInvitationToken,
  decryptInvitationToken,
  normalizeEncryptionKey,
  serializeEncryptedPayload,
  deserializeEncryptedPayload,
  buildInvitationAad,
  TokenCryptoError,
  EncryptedPayload,
} from '../crypto';

describe('Token Encryption & Decryption Utility (AES-256-GCM)', () => {
  // Generate a valid 32-byte key for testing
  const validKeyBuffer = crypto.randomBytes(32);
  const validKeyBase64 = validKeyBuffer.toString('base64');
  const validKeyHex = validKeyBuffer.toString('hex');

  const sampleToken = 'inv_tok_32bytesecurerandomentropy_abcdef123456';

  describe('Key Normalization and Validation', () => {
    it('accepts valid 32-byte Buffer, base64, and hex strings', () => {
      const fromBuf = normalizeEncryptionKey(validKeyBuffer);
      const fromB64 = normalizeEncryptionKey(validKeyBase64);
      const fromHex = normalizeEncryptionKey(validKeyHex);

      expect(fromBuf.length).toBe(32);
      expect(fromB64.equals(validKeyBuffer)).toBe(true);
      expect(fromHex.equals(validKeyBuffer)).toBe(true);
    });

    it('rejects keys that are not strictly 32 bytes or contain invalid characters (AUD-T2-03)', () => {
      // 16-byte key (AES-128)
      const shortBuffer = crypto.randomBytes(16);
      expect(() => normalizeEncryptionKey(shortBuffer)).toThrow(TokenCryptoError);
      expect(() => normalizeEncryptionKey(shortBuffer)).toThrow(/Invalid key length/);

      // 64-byte key (512-bit)
      const longBuffer = crypto.randomBytes(64);
      expect(() => normalizeEncryptionKey(longBuffer)).toThrow(TokenCryptoError);

      // Short string
      expect(() => normalizeEncryptionKey('short-password')).toThrow(TokenCryptoError);

      // Non-canonical base64 with punctuation
      expect(() => normalizeEncryptionKey('invalid-base64-string!@#$1234567890abcdef====')).toThrow(/Invalid key format/);
    });

    it('rejects empty or whitespace-only keys', () => {
      expect(() => normalizeEncryptionKey('')).toThrow(TokenCryptoError);
      expect(() => normalizeEncryptionKey('   ')).toThrow(TokenCryptoError);
    });
  });

  describe('Encryption and Decryption Round-Trip', () => {
    it('encrypts and decrypts raw token returning exact original plaintext', () => {
      const encrypted = encryptInvitationToken(sampleToken, validKeyBase64);

      expect(encrypted.version).toBe(1);
      expect(encrypted.algorithm).toBe('aes-256-gcm');
      expect(encrypted.iv).toBeTruthy();
      expect(encrypted.tag).toBeTruthy();
      expect(encrypted.ciphertext).toBeTruthy();

      const decrypted = decryptInvitationToken(encrypted, validKeyBase64);
      expect(decrypted).toBe(sampleToken);
    });

    it('works with Buffer keys and hex keys', () => {
      const encrypted = encryptInvitationToken(sampleToken, validKeyBuffer);
      const decrypted = decryptInvitationToken(encrypted, validKeyHex);
      expect(decrypted).toBe(sampleToken);
    });

    it('produces different IVs and ciphertexts for subsequent encryptions of identical tokens', () => {
      const enc1 = encryptInvitationToken(sampleToken, validKeyBase64);
      const enc2 = encryptInvitationToken(sampleToken, validKeyBase64);

      expect(enc1.iv).not.toBe(enc2.iv);
      expect(enc1.ciphertext).not.toBe(enc2.ciphertext);

      expect(decryptInvitationToken(enc1, validKeyBase64)).toBe(sampleToken);
      expect(decryptInvitationToken(enc2, validKeyBase64)).toBe(sampleToken);
    });

    it('supports JSON string serialization and deserialization seamlessly', () => {
      const encrypted = encryptInvitationToken(sampleToken, validKeyBase64);
      const serialized = serializeEncryptedPayload(encrypted);

      expect(typeof serialized).toBe('string');
      const deserialized = deserializeEncryptedPayload(serialized);
      expect(deserialized).toEqual(encrypted);

      // decrypt directly from string
      const decrypted = decryptInvitationToken(serialized, validKeyBase64);
      expect(decrypted).toBe(sampleToken);
    });
  });

  describe('Adversarial Tampering & Authentication Verification', () => {
    it('fails closed when ciphertext is modified', () => {
      const encrypted = encryptInvitationToken(sampleToken, validKeyBase64);

      // Flip byte in ciphertext
      const rawCt = Buffer.from(encrypted.ciphertext, 'base64');
      rawCt[0] ^= 0xff;
      const tampered: EncryptedPayload = {
        ...encrypted,
        ciphertext: rawCt.toString('base64'),
      };

      expect(() => decryptInvitationToken(tampered, validKeyBase64)).toThrow(TokenCryptoError);
      expect(() => decryptInvitationToken(tampered, validKeyBase64)).toThrow(/authentication tag verification failed/i);
    });

    it('fails closed when IV is modified', () => {
      const encrypted = encryptInvitationToken(sampleToken, validKeyBase64);

      const rawIv = Buffer.from(encrypted.iv, 'base64');
      rawIv[0] ^= 0xff;
      const tampered: EncryptedPayload = {
        ...encrypted,
        iv: rawIv.toString('base64'),
      };

      expect(() => decryptInvitationToken(tampered, validKeyBase64)).toThrow(TokenCryptoError);
    });

    it('fails closed when authentication tag is modified', () => {
      const encrypted = encryptInvitationToken(sampleToken, validKeyBase64);

      const rawTag = Buffer.from(encrypted.tag, 'base64');
      rawTag[0] ^= 0xff;
      const tampered: EncryptedPayload = {
        ...encrypted,
        tag: rawTag.toString('base64'),
      };

      expect(() => decryptInvitationToken(tampered, validKeyBase64)).toThrow(TokenCryptoError);
    });

    it('fails closed when decrypted with a different 32-byte key', () => {
      const encrypted = encryptInvitationToken(sampleToken, validKeyBase64);
      const differentKey = crypto.randomBytes(32);

      expect(() => decryptInvitationToken(encrypted, differentKey)).toThrow(TokenCryptoError);
      expect(() => decryptInvitationToken(encrypted, differentKey)).toThrow(/authentication tag verification failed/i);
    });

    it('fails closed on unsupported version or algorithm', () => {
      const encrypted = encryptInvitationToken(sampleToken, validKeyBase64);

      const invalidVersion = { ...encrypted, version: 2 as any };
      expect(() => decryptInvitationToken(invalidVersion, validKeyBase64)).toThrow(/Unsupported encrypted payload version/);

      const invalidAlgorithm = { ...encrypted, algorithm: 'aes-128-cbc' as any };
      expect(() => decryptInvitationToken(invalidAlgorithm, validKeyBase64)).toThrow(/Unsupported encryption algorithm/);
    });

    it('fails closed on malformed serialized payload strings', () => {
      expect(() => deserializeEncryptedPayload('')).toThrow(TokenCryptoError);
      expect(() => deserializeEncryptedPayload('not json')).toThrow(TokenCryptoError);
      expect(() => deserializeEncryptedPayload('{"version": 1}')).toThrow(/missing required cryptographic fields/);
    });

    it('rejects empty or whitespace-only token inputs', () => {
      expect(() => encryptInvitationToken('', validKeyBase64)).toThrow(TokenCryptoError);
      expect(() => encryptInvitationToken('   ', validKeyBase64)).toThrow(TokenCryptoError);
      expect(() => encryptInvitationToken(null as any, validKeyBase64)).toThrow(TokenCryptoError);
    });
  });

  describe('Secrecy & Key Rotation', () => {
    it('does not leak plaintext tokens, ciphertext, or keys in error messages', () => {
      const secretToken = 'secret-token-value-should-never-appear-in-errors-12345';
      const secretKey = validKeyBase64;

      try {
        const encrypted = encryptInvitationToken(secretToken, secretKey);
        // Tamper to cause decryption error
        const tampered = { ...encrypted, tag: Buffer.from(encrypted.tag, 'base64').reverse().toString('base64') };
        decryptInvitationToken(tampered, secretKey);
        expect.fail('Expected decrypt to throw');
      } catch (err: any) {
        expect(err.message).not.toContain(secretToken);
        expect(err.message).not.toContain(secretKey);
      }
    });

    it('supports key rotation via keyId and resolver function', () => {
      const oldKey = crypto.randomBytes(32);
      const newKey = crypto.randomBytes(32);

      const keyRing: Record<string, Buffer> = {
        'key-2026-v1': oldKey,
        'key-2026-v2': newKey,
      };

      const keyResolver = (keyId?: string) => {
        if (!keyId || !keyRing[keyId]) {
          throw new TokenCryptoError(`Unknown keyId: ${keyId}`, { code: 'UNKNOWN_KEY_ID' });
        }
        return keyRing[keyId];
      };

      // Encrypt with v1
      const payloadV1 = encryptInvitationToken(sampleToken, oldKey, { keyId: 'key-2026-v1' });
      // Encrypt with v2
      const payloadV2 = encryptInvitationToken(sampleToken, newKey, { keyId: 'key-2026-v2' });

      expect(decryptInvitationToken(payloadV1, keyResolver)).toBe(sampleToken);
      expect(decryptInvitationToken(payloadV2, keyResolver)).toBe(sampleToken);
    });
  });

  describe('Authenticated Additional Data (AAD) Context Binding (AUD-T2-07)', () => {
    it('successfully encrypts and decrypts with matching invitation AAD', () => {
      const invitationId = '550e8400-e29b-41d4-a716-446655440000';
      const aad = buildInvitationAad(invitationId);

      const encrypted = encryptInvitationToken(sampleToken, validKeyBase64, {
        associatedData: aad,
      });

      expect(encrypted.hasAad).toBe(true);

      const decrypted = decryptInvitationToken(encrypted, validKeyBase64, {
        associatedData: aad,
      });

      expect(decrypted).toBe(sampleToken);
    });

    it('fails closed when decrypting with mismatched invitation AAD', () => {
      const invitationId1 = '550e8400-e29b-41d4-a716-446655440001';
      const invitationId2 = '550e8400-e29b-41d4-a716-446655440002';

      const encrypted = encryptInvitationToken(sampleToken, validKeyBase64, {
        associatedData: buildInvitationAad(invitationId1),
      });

      // Decrypting with wrong invitationId must fail authentication tag check
      expect(() =>
        decryptInvitationToken(encrypted, validKeyBase64, {
          associatedData: buildInvitationAad(invitationId2),
        }),
      ).toThrow(TokenCryptoError);

      expect(() =>
        decryptInvitationToken(encrypted, validKeyBase64, {
          associatedData: buildInvitationAad(invitationId2),
        }),
      ).toThrow(/authentication tag verification failed/i);
    });

    it('fails closed when decrypting without AAD if payload required AAD', () => {
      const invitationId = '550e8400-e29b-41d4-a716-446655440000';
      const encrypted = encryptInvitationToken(sampleToken, validKeyBase64, {
        associatedData: buildInvitationAad(invitationId),
      });

      expect(() => decryptInvitationToken(encrypted, validKeyBase64)).toThrow(TokenCryptoError);
      expect(() => decryptInvitationToken(encrypted, validKeyBase64)).toThrow(/required authenticated context \(AAD\)/i);
    });
  });
});
