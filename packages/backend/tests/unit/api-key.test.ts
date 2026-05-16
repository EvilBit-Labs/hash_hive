import { describe, expect, test } from 'bun:test';
import {
  API_KEY_PREFIX,
  generateApiKey,
  parseApiKey,
  verifyApiKey,
} from '../../src/lib/api-key.js';

describe('generateApiKey', () => {
  test('returns a token with the cst prefix and the userId hint', async () => {
    // Arrange / Act
    const { token, hash } = await generateApiKey(42);

    // Assert
    expect(token.startsWith(`${API_KEY_PREFIX}_42_`)).toBe(true);
    expect(hash.length).toBeGreaterThan(0);
    expect(hash).not.toContain(token);
  });

  test('produces a verifiable hash for the issued token', async () => {
    const { token, hash } = await generateApiKey(7);
    expect(await verifyApiKey(token, hash)).toBe(true);
  });

  test('produces fresh randomness across calls', async () => {
    const a = await generateApiKey(1);
    const b = await generateApiKey(1);
    expect(a.token).not.toBe(b.token);
    expect(a.hash).not.toBe(b.hash);
  });
});

describe('parseApiKey', () => {
  test('returns userId and remainder for a well-formed token', () => {
    const result = parseApiKey('cst_42_abc-DEF_123');
    expect(result).toEqual({ userId: 42, remainder: 'abc-DEF_123' });
  });

  test('rejects tokens with the wrong prefix', () => {
    expect(parseApiKey('xyz_42_abc')).toBeNull();
    expect(parseApiKey('CST_42_abc')).toBeNull();
  });

  test('rejects tokens with non-positive userId', () => {
    expect(parseApiKey('cst_0_abc')).toBeNull();
    expect(parseApiKey('cst_-1_abc')).toBeNull();
  });

  test('rejects tokens with non-integer userId', () => {
    expect(parseApiKey('cst_abc_def')).toBeNull();
    expect(parseApiKey('cst_4.2_def')).toBeNull();
    expect(parseApiKey('cst_4e2_def')).toBeNull();
  });

  test('rejects tokens missing a section', () => {
    expect(parseApiKey('cst_42')).toBeNull();
    expect(parseApiKey('cst_')).toBeNull();
    expect(parseApiKey('cst')).toBeNull();
    expect(parseApiKey('')).toBeNull();
  });

  test('rejects tokens with empty remainder', () => {
    expect(parseApiKey('cst_42_')).toBeNull();
  });

  test('rejects tokens with empty userId (cst__abc)', () => {
    expect(parseApiKey('cst__abc')).toBeNull();
  });

  test('rejects userId with leading zero (cst_042_abc)', () => {
    expect(parseApiKey('cst_042_abc')).toBeNull();
  });

  test('rejects userId beyond Number.MAX_SAFE_INTEGER', () => {
    // 9007199254740993 = MAX_SAFE_INTEGER + 2; loses precision in JS Number.
    expect(parseApiKey('cst_9007199254740993_abc')).toBeNull();
  });
});

describe('verifyApiKey', () => {
  test('returns false on a wrong token of valid format', async () => {
    const { hash } = await generateApiKey(99);
    const wrong = 'cst_99_thisIsNotTheRealToken';
    expect(await verifyApiKey(wrong, hash)).toBe(false);
  });

  test('returns false on an empty hash', async () => {
    expect(await verifyApiKey('cst_99_anything', '')).toBe(false);
  });

  test('returns false on a malformed hash', async () => {
    expect(await verifyApiKey('cst_99_anything', 'not-a-bcrypt-hash')).toBe(false);
  });
});
