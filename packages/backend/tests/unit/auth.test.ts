import { describe, expect, it } from 'bun:test';
import {
  createToken,
  hashPassword,
  validateToken,
  verifyPassword,
} from '../../src/services/auth.js';

describe('password hashing', () => {
  it('should hash and verify a password', async () => {
    const password = 'my-secret-password';
    const hash = await hashPassword(password);

    expect(hash).not.toBe(password);
    expect(await verifyPassword(password, hash)).toBe(true);
  });

  it('should reject an incorrect password', async () => {
    const hash = await hashPassword('correct-password');
    expect(await verifyPassword('wrong-password', hash)).toBe(false);
  });
});

describe('JWT tokens', () => {
  it('should create and validate a session token', async () => {
    const token = await createToken({ userId: 1, email: 'test@example.com', type: 'session' });
    expect(typeof token).toBe('string');

    const payload = await validateToken(token);
    expect(payload).not.toBeNull();
    expect(payload!.userId).toBe(1);
    expect(payload!.email).toBe('test@example.com');
    expect(payload!.type).toBe('session');
  });

  it('should create and validate an agent token', async () => {
    const token = await createToken({ userId: 42, email: 'agent@example.com', type: 'agent' });
    const payload = await validateToken(token);
    expect(payload).not.toBeNull();
    expect(payload!.userId).toBe(42);
    expect(payload!.type).toBe('agent');
  });

  it('should reject an invalid token', async () => {
    const payload = await validateToken('garbage.token.value');
    expect(payload).toBeNull();
  });

  it('should reject a tampered token', async () => {
    const token = await createToken({ userId: 1, email: 'test@example.com', type: 'session' });
    // Replace the entire signature with garbage
    const parts = token.split('.');
    parts[2] = 'invalidSignatureData1234567890abcdef';
    const tampered = parts.join('.');
    const payload = await validateToken(tampered);
    expect(payload).toBeNull();
  });
});
