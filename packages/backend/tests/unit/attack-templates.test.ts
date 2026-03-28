/**
 * Attack Templates tests.
 *
 * Unit tests for the extractAttackPayload helper and API contract tests
 * for auth guards, validation, and project-scope enforcement.
 */
import { describe, expect, it, mock } from 'bun:test';

// ─── extractAttackPayload unit tests (no mocks needed) ────────────

import { extractAttackPayload } from '../../src/services/attack-templates.js';

describe('extractAttackPayload', () => {
  it('should return all attack-relevant fields from a template', () => {
    const template = {
      mode: 0,
      hashTypeId: 1000,
      wordlistId: 10,
      rulelistId: 20,
      masklistId: null,
      advancedConfiguration: { optimized: true },
    };

    const result = extractAttackPayload(template);

    expect(result).toEqual({
      mode: 0,
      hashTypeId: 1000,
      wordlistId: 10,
      rulelistId: 20,
      masklistId: null,
      advancedConfiguration: { optimized: true },
    });
  });

  it('should return nulls for unset resource references', () => {
    const template = {
      mode: 3,
      hashTypeId: null,
      wordlistId: null,
      rulelistId: null,
      masklistId: null,
      advancedConfiguration: {},
    };

    const result = extractAttackPayload(template);

    expect(result.hashTypeId).toBeNull();
    expect(result.wordlistId).toBeNull();
    expect(result.rulelistId).toBeNull();
    expect(result.masklistId).toBeNull();
  });

  it('should not include template-only fields (name, tags, etc)', () => {
    const template = {
      mode: 1,
      hashTypeId: null,
      wordlistId: null,
      rulelistId: null,
      masklistId: null,
      advancedConfiguration: null,
    };

    const result = extractAttackPayload(template);

    expect(Object.keys(result).sort()).toEqual([
      'advancedConfiguration',
      'hashTypeId',
      'masklistId',
      'mode',
      'rulelistId',
      'wordlistId',
    ]);
  });
});

// ─── Schema validation tests ────────────────────────────────────────

import { createAttackTemplateRequestSchema } from '@hashhive/shared';

describe('createAttackTemplateRequestSchema', () => {
  it('should accept a valid minimal template', () => {
    const result = createAttackTemplateRequestSchema.safeParse({
      name: 'My Template',
      mode: 0,
    });
    expect(result.success).toBe(true);
  });

  it('should accept a fully populated template', () => {
    const result = createAttackTemplateRequestSchema.safeParse({
      name: 'Full Template',
      description: 'Test description',
      mode: 3,
      hashTypeId: 1000,
      wordlistId: 1,
      rulelistId: 2,
      masklistId: 3,
      advancedConfiguration: { increment: true },
      tags: ['preferred', 'fast'],
    });
    expect(result.success).toBe(true);
  });

  it('should reject an empty name', () => {
    const result = createAttackTemplateRequestSchema.safeParse({
      name: '',
      mode: 0,
    });
    expect(result.success).toBe(false);
  });

  it('should reject a negative mode', () => {
    const result = createAttackTemplateRequestSchema.safeParse({
      name: 'Test',
      mode: -1,
    });
    expect(result.success).toBe(false);
  });

  it('should reject missing mode', () => {
    const result = createAttackTemplateRequestSchema.safeParse({
      name: 'Test',
    });
    expect(result.success).toBe(false);
  });

  it('should reject missing name', () => {
    const result = createAttackTemplateRequestSchema.safeParse({
      mode: 0,
    });
    expect(result.success).toBe(false);
  });

  it('should accept nullable resource IDs', () => {
    const result = createAttackTemplateRequestSchema.safeParse({
      name: 'Nullable Test',
      mode: 0,
      wordlistId: null,
      rulelistId: null,
      masklistId: null,
      hashTypeId: null,
    });
    expect(result.success).toBe(true);
  });

  it('should reject zero-value resource IDs', () => {
    const result = createAttackTemplateRequestSchema.safeParse({
      name: 'Zero ID',
      mode: 0,
      wordlistId: 0,
    });
    expect(result.success).toBe(false);
  });

  it('should reject tags exceeding max count', () => {
    const result = createAttackTemplateRequestSchema.safeParse({
      name: 'Too many tags',
      mode: 0,
      tags: Array.from({ length: 21 }, (_, i) => `tag-${i}`),
    });
    expect(result.success).toBe(false);
  });

  it('should reject empty tag strings', () => {
    const result = createAttackTemplateRequestSchema.safeParse({
      name: 'Empty tag',
      mode: 0,
      tags: ['valid', ''],
    });
    expect(result.success).toBe(false);
  });

  it('should accept description set to null', () => {
    const result = createAttackTemplateRequestSchema.safeParse({
      name: 'Null desc',
      mode: 0,
      description: null,
    });
    expect(result.success).toBe(true);
  });
});

// ─── API contract tests (mocked DB + auth) ─────────────────────────

// These must be declared before importing the app module, because
// bun:test mock.module hoists to the top of the file scope.

mock.module('../../src/lib/auth.js', () => ({
  auth: {
    api: {
      getSession: async ({ headers }: { headers: Headers }) => {
        const cookie = headers.get('cookie') ?? '';
        if (cookie.includes('hh.session_token=valid-session')) {
          return {
            user: {
              id: '1',
              email: 'test@example.com',
              name: 'Test User',
              emailVerified: true,
              image: null,
            },
            session: {
              id: 'sess-1',
              userId: '1',
              token: 'tok-1',
              expiresAt: new Date(Date.now() + 3600000),
            },
          };
        }
        return null;
      },
    },
    handler: async () => new Response('ok'),
  },
}));

mock.module('../../src/services/auth.js', () => ({
  getUserWithProjects: async () => null,
  findProjectMembership: async (_userId: number, projectId: number) => {
    // Project 1 = contributor access, anything else = null
    if (projectId === 1) {
      return { userId: 1, projectId: 1, roles: ['contributor'] };
    }
    return null;
  },
}));

mock.module('../../src/db/index.js', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve([]),
        }),
        innerJoin: () => ({
          where: () => Promise.resolve([]),
        }),
        $dynamic: () => ({
          where: () => ({
            limit: () => ({
              offset: () => ({
                orderBy: () => Promise.resolve([]),
              }),
            }),
          }),
        }),
      }),
    }),
    insert: () => ({
      values: () => ({
        returning: () => Promise.resolve([]),
        onConflictDoNothing: () => ({
          returning: () => Promise.resolve([]),
        }),
      }),
    }),
    update: () => ({
      set: () => ({
        where: () => ({
          returning: () => Promise.resolve([]),
        }),
      }),
    }),
    delete: () => ({
      where: () => ({
        returning: () => Promise.resolve([]),
      }),
    }),
  },
  client: {},
}));

mock.module('../../src/queue/context.js', () => ({
  getQueueManager: () => ({
    getHealth: async () => ({ status: 'connected', queues: {} }),
    init: async () => {},
    shutdown: async () => {},
  }),
  setQueueManager: () => {},
}));

mock.module('../../src/queue/manager.js', () => ({
  QueueManager: class {
    init() {
      return Promise.resolve();
    }
    shutdown() {
      return Promise.resolve();
    }
    getHealth() {
      return Promise.resolve({ status: 'connected', queues: {} });
    }
  },
}));

mock.module('../../src/config/storage.js', () => ({
  checkMinioHealth: async () => ({ status: 'connected' }),
  createPresignedDownloadUrl: async () => 'http://localhost:9000/fake',
}));

mock.module('ioredis', () => ({
  default: class MockRedis {
    ping() {
      return Promise.resolve('PONG');
    }
    on() {
      return this;
    }
    disconnect() {}
  },
}));

import { app } from '../../src/index.js';

const BASE = '/api/v1/dashboard/attack-templates';

const authHeaders = {
  'Content-Type': 'application/json',
  cookie: 'hh.session_token=valid-session',
  'x-project-id': '1',
};

describe('Attack Templates API: Auth guards', () => {
  const routes = [
    { method: 'GET', path: '' },
    { method: 'POST', path: '' },
    { method: 'GET', path: '/1' },
    { method: 'PATCH', path: '/1' },
    { method: 'DELETE', path: '/1' },
    { method: 'POST', path: '/1/instantiate' },
    { method: 'POST', path: '/import' },
  ];

  for (const { method, path } of routes) {
    it(`should return 401 for ${method} ${path} without session`, async () => {
      const res = await app.request(`${BASE}${path}`, { method });
      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body['error']['code']).toBe('AUTH_TOKEN_INVALID');
    });
  }
});

describe('Attack Templates API: Project scope enforcement', () => {
  it('should return 400 for GET / without project header', async () => {
    const res = await app.request(BASE, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        cookie: 'hh.session_token=valid-session',
      },
    });
    // Without X-Project-Id, middleware throws 400 PROJECT_NOT_SELECTED
    expect(res.status).toBe(400);
  });

  it('should return 403 for non-member project', async () => {
    const res = await app.request(BASE, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        cookie: 'hh.session_token=valid-session',
        'x-project-id': '999',
      },
    });
    expect(res.status).toBe(403);
  });
});

describe('Attack Templates API: Validation', () => {
  it('should return 400 for POST with empty body', async () => {
    const res = await app.request(BASE, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it('should return 400 for POST with missing name', async () => {
    const res = await app.request(BASE, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ mode: 0 }),
    });
    expect(res.status).toBe(400);
  });

  it('should return 400 for POST with missing mode', async () => {
    const res = await app.request(BASE, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ name: 'Test' }),
    });
    expect(res.status).toBe(400);
  });

  it('should return 400 for PATCH with empty body', async () => {
    const res = await app.request(`${BASE}/1`, {
      method: 'PATCH',
      headers: authHeaders,
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it('should return 400 for POST /import with empty body', async () => {
    const res = await app.request(`${BASE}/import`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it('should return 400 for POST /import with missing name', async () => {
    const res = await app.request(`${BASE}/import`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ mode: 0 }),
    });
    expect(res.status).toBe(400);
  });
});
