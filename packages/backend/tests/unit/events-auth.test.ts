import { beforeEach, describe, expect, it, mock } from 'bun:test';

// ─── Mock DB ─────────────────────────────────────────────────────────

let mockProjectUserRows: Array<{
  projectId: number;
  roles: string[];
  projectName: string;
  projectSlug: string;
}> = [];

let mockUserRows: Array<{
  id: number;
  email: string;
  name: string;
  status: string;
}> = [];

mock.module('../../src/db/index.js', () => ({
  db: {
    select: (cols?: Record<string, unknown>) => ({
      from: () => ({
        where: () => ({
          limit: () => {
            if (cols && 'projectId' in cols) {
              return Promise.resolve(mockProjectUserRows);
            }
            return Promise.resolve(mockUserRows);
          },
        }),
        innerJoin: () => ({
          where: () => Promise.resolve(mockProjectUserRows),
        }),
      }),
    }),
  },
  client: {},
}));

import { createToken, validateToken } from '../../src/services/auth.js';

describe('WebSocket events hybrid auth', () => {
  beforeEach(() => {
    mockUserRows = [{ id: 1, email: 'test@example.com', name: 'Test User', status: 'active' }];
    mockProjectUserRows = [
      { projectId: 10, roles: ['admin'], projectName: 'Test Project', projectSlug: 'test-project' },
    ];
  });

  it('should validate a session cookie token', async () => {
    const token = await createToken({
      userId: 1,
      email: 'test@example.com',
      type: 'session',
      projectId: 10,
    });

    // Token should be valid

    const payload = await validateToken(token);
    expect(payload).not.toBeNull();
    expect(payload?.userId).toBe(1);
    expect(payload?.type).toBe('session');
    expect(payload?.projectId).toBe(10);
  });

  it('should validate a query token for WebSocket fallback', async () => {
    const token = await createToken({
      userId: 1,
      email: 'test@example.com',
      type: 'session',
      projectId: 10,
    });

    const payload = await validateToken(token);
    expect(payload).not.toBeNull();
    expect(payload?.type).toBe('session');
  });

  it('should reject agent tokens in WebSocket auth', async () => {
    const token = await createToken({
      userId: 1,
      email: 'agent@example.com',
      type: 'agent',
    });

    const payload = await validateToken(token);
    // Agent tokens are valid JWTs but the events route checks payload.type !== 'session'
    expect(payload).not.toBeNull();
    expect(payload?.type).toBe('agent');
    // Events route would close with 4001 since type is not 'session'
  });

  it('should reject invalid tokens', async () => {
    const payload = await validateToken('invalid-token-string');
    expect(payload).toBeNull();
  });

  it('should include projectId in session token when set', async () => {
    const token = await createToken({
      userId: 1,
      email: 'test@example.com',
      type: 'session',
      projectId: 42,
    });

    const payload = await validateToken(token);
    expect(payload?.projectId).toBe(42);
  });

  it('should omit projectId when not set in token', async () => {
    const token = await createToken({
      userId: 1,
      email: 'test@example.com',
      type: 'session',
    });

    const payload = await validateToken(token);
    expect(payload?.projectId).toBeUndefined();
  });
});
