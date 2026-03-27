import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { Hono } from 'hono';
import type { AppEnv } from '../../src/types.js';

// ─── Mock DB for agent token middleware ──────────────────────────────

// Mutable result that each test sets before making a request.
// The mock DB chain always resolves with this value.
let mockAgentResult: Array<{
  id: number;
  projectId: number;
  status: string;
  capabilities: Record<string, unknown>;
}> = [];

mock.module('../../src/db/index.js', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve(mockAgentResult),
        }),
      }),
    }),
  },
  client: {},
}));

import { requireAgentToken, requireSession } from '../../src/middleware/auth.js';
import { createToken } from '../../src/services/auth.js';

function createSessionApp() {
  const app = new Hono<AppEnv>();
  app.use('*', requireSession);
  app.get('/protected', (c) => {
    const user = c.get('currentUser');
    return c.json({ userId: user.userId, email: user.email, projectId: user.projectId });
  });
  return app;
}

function createAgentApp() {
  const app = new Hono<AppEnv>();
  app.use('*', requireAgentToken);
  app.get('/agent-endpoint', (c) => {
    const agent = c.get('agent');
    return c.json({ agentId: agent.agentId, projectId: agent.projectId });
  });
  return app;
}

describe('requireSession middleware', () => {
  const app = createSessionApp();

  it('should reject requests without a session cookie', async () => {
    const res = await app.request('/protected');
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body['error']['code']).toBe('AUTH_TOKEN_INVALID');
  });

  it('should accept a valid session cookie', async () => {
    const token = await createToken({ userId: 1, email: 'test@example.com', type: 'session' });
    const res = await app.request('/protected', {
      headers: { cookie: `session=${token}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body['userId']).toBe(1);
    expect(body['email']).toBe('test@example.com');
  });

  it('should reject an agent token in session cookie', async () => {
    const token = await createToken({ userId: 1, email: 'agent@example.com', type: 'agent' });
    const res = await app.request('/protected', {
      headers: { cookie: `session=${token}` },
    });
    expect(res.status).toBe(401);
  });
});

describe('requireAgentToken middleware', () => {
  const app = createAgentApp();

  beforeEach(() => {
    mockAgentResult = [];
  });

  it('should reject requests without Authorization header', async () => {
    const res = await app.request('/agent-endpoint');
    expect(res.status).toBe(401);
  });

  it('should reject non-Bearer tokens', async () => {
    const res = await app.request('/agent-endpoint', {
      headers: { authorization: 'Basic abc123' },
    });
    expect(res.status).toBe(401);
  });

  it('should accept a valid active agent pre-shared token', async () => {
    mockAgentResult = [{ id: 42, projectId: 7, status: 'active', capabilities: { gpu: true } }];

    const res = await app.request('/agent-endpoint', {
      headers: { authorization: 'Bearer valid-agent-token' },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body['agentId']).toBe(42);
    expect(body['projectId']).toBe(7);
  });

  it('should reject an unknown token', async () => {
    mockAgentResult = [];

    const res = await app.request('/agent-endpoint', {
      headers: { authorization: 'Bearer unknown-token-does-not-exist' },
    });
    expect(res.status).toBe(401);
  });

  it('should reject agents in error state', async () => {
    mockAgentResult = [{ id: 99, projectId: 7, status: 'error', capabilities: {} }];

    const res = await app.request('/agent-endpoint', {
      headers: { authorization: 'Bearer error-agent-token' },
    });
    expect(res.status).toBe(401);
  });
});
