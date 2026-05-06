import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { Hono } from 'hono';
import type { AppEnv } from '../../src/types.js';

interface MockUserRow {
  id: number;
  email: string;
  status: string;
  apiKeyHash: string | null;
}

let mockUserRow: MockUserRow | null = null;
let lastUsedUpdates: Array<{ id: number }> = [];

mock.module('../../src/db/index.js', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve(mockUserRow ? [mockUserRow] : []),
        }),
      }),
    }),
    update: () => ({
      set: () => ({
        where: (_pred: unknown) => {
          // Predicate ignored; tests assert that an update fired by checking lastUsedUpdates length
          if (mockUserRow) lastUsedUpdates.push({ id: mockUserRow.id });
          return Promise.resolve();
        },
      }),
    }),
  },
  client: {},
}));

import { generateApiKey } from '../../src/lib/api-key.js';
import { requireApiKey } from '../../src/middleware/api-key.js';

function createApp() {
  const app = new Hono<AppEnv>();
  app.use('*', requireApiKey);
  app.get('/protected', (c) => {
    const user = c.get('currentUser');
    return c.json({ userId: user.userId, email: user.email, projectId: user.projectId });
  });
  return app;
}

async function seedUser(userId: number, email = 'test@example.com'): Promise<string> {
  const { token, hash } = await generateApiKey(userId);
  mockUserRow = { id: userId, email, status: 'active', apiKeyHash: hash };
  return token;
}

describe('requireApiKey middleware', () => {
  const app = createApp();

  beforeEach(() => {
    mockUserRow = null;
    lastUsedUpdates = [];
  });

  it('rejects requests with no Authorization header', async () => {
    const res = await app.request('/protected');
    expect(res.status).toBe(401);
    expect(res.headers.get('content-type')).toContain('application/problem+json');
    const body = await res.json();
    expect(body.title).toBe('Authentication required');
  });

  it('rejects non-Bearer schemes', async () => {
    const res = await app.request('/protected', {
      headers: { authorization: 'Basic dXNlcjpwYXNz' },
    });
    expect(res.status).toBe(401);
  });

  it('rejects malformed tokens', async () => {
    const res = await app.request('/protected', {
      headers: { authorization: 'Bearer cst_abc' },
    });
    expect(res.status).toBe(401);
  });

  it('rejects tokens for unknown users', async () => {
    mockUserRow = null;
    const res = await app.request('/protected', {
      headers: { authorization: 'Bearer cst_42_anything' },
    });
    expect(res.status).toBe(401);
  });

  it('rejects tokens whose bcrypt hash does not match', async () => {
    const real = await seedUser(42);
    const fake = `${real.slice(0, real.length - 4)}XXXX`;
    const res = await app.request('/protected', {
      headers: { authorization: `Bearer ${fake}` },
    });
    expect(res.status).toBe(401);
  });

  it('rejects tokens for users whose apiKeyHash was revoked', async () => {
    const token = await seedUser(42);
    if (mockUserRow) mockUserRow.apiKeyHash = null;
    const res = await app.request('/protected', {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(401);
  });

  it('rejects tokens for non-active users', async () => {
    const token = await seedUser(42);
    if (mockUserRow) mockUserRow.status = 'disabled';
    const res = await app.request('/protected', {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(401);
  });

  it('accepts a valid token and populates currentUser', async () => {
    const token = await seedUser(42, 'admin@example.com');
    const res = await app.request('/protected', {
      headers: {
        authorization: `Bearer ${token}`,
        'x-project-id': '7',
      },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.userId).toBe(42);
    expect(body.email).toBe('admin@example.com');
    expect(body.projectId).toBe(7);
  });

  it('updates apiKeyLastUsedAt on successful auth', async () => {
    const token = await seedUser(99);
    await app.request('/protected', {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(lastUsedUpdates).toHaveLength(1);
    expect(lastUsedUpdates[0].id).toBe(99);
  });

  it('treats X-Project-Id: 0 as null', async () => {
    const token = await seedUser(42);
    const res = await app.request('/protected', {
      headers: {
        authorization: `Bearer ${token}`,
        'x-project-id': '0',
      },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.projectId).toBeNull();
  });
});
