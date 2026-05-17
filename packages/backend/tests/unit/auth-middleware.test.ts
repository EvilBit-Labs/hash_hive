import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { Hono } from 'hono';
import type { AppEnv } from '../../src/types.js';

// ─── Mock DB for agent token middleware ──────────────────────────────

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

// ─── Mock BetterAuth session lookup ──────────────────────────────────

let mockSession: {
  user: { id: string; email: string; name: string; emailVerified: boolean; image: string | null };
  session: { id: string; userId: string; token: string; expiresAt: Date };
} | null = null;

let mockGetSessionError: Error | null = null;

mock.module('../../src/lib/auth.js', () => ({
  auth: {
    api: {
      getSession: async () => {
        if (mockGetSessionError) throw mockGetSessionError;
        return mockSession;
      },
    },
    handler: async () => new Response('ok'),
  },
}));

import {
  requireAgentToken,
  requireAgentTokenForHeartbeatRecovery,
  requireSession,
} from '../../src/middleware/auth.js';

/** Build a valid mock session for the given user id and email. */
function buildMockSession(
  overrides: { id?: string; email?: string } = {}
): NonNullable<typeof mockSession> {
  const id = overrides.id ?? '1';
  return {
    user: {
      id,
      email: overrides.email ?? 'test@example.com',
      name: 'Test User',
      emailVerified: true,
      image: null,
    },
    session: {
      id: `sess-${id}`,
      userId: id,
      token: `tok-${id}`,
      expiresAt: new Date(Date.now() + 3600000),
    },
  };
}

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

function createAgentRecoveryApp() {
  const app = new Hono<AppEnv>();
  app.use('*', requireAgentTokenForHeartbeatRecovery);
  app.get('/agent-endpoint', (c) => {
    const agent = c.get('agent');
    return c.json({ agentId: agent.agentId, projectId: agent.projectId });
  });
  return app;
}

describe('requireSession middleware (BetterAuth)', () => {
  const app = createSessionApp();

  beforeEach(() => {
    mockSession = null;
    mockGetSessionError = null;
  });

  it('should reject requests without a valid session', async () => {
    mockSession = null;
    const res = await app.request('/protected');
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body['error']['code']).toBe('AUTH_TOKEN_INVALID');
  });

  it('should return 401 when getSession throws an error', async () => {
    mockGetSessionError = new Error('Database connection failed');
    const res = await app.request('/protected');
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body['error']['code']).toBe('AUTH_TOKEN_INVALID');
  });

  it('should accept a valid BetterAuth session', async () => {
    mockSession = buildMockSession();
    const res = await app.request('/protected', {
      headers: { cookie: 'hh.session_token=valid-session' },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body['userId']).toBe(1);
    expect(body['email']).toBe('test@example.com');
  });

  it('should read projectId from X-Project-Id header', async () => {
    mockSession = buildMockSession();
    const res = await app.request('/protected', {
      headers: {
        cookie: 'hh.session_token=valid-session',
        'x-project-id': '42',
      },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body['projectId']).toBe(42);
  });

  it('should set projectId to null when X-Project-Id header is missing', async () => {
    mockSession = buildMockSession();
    const res = await app.request('/protected', {
      headers: { cookie: 'hh.session_token=valid-session' },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body['projectId']).toBeNull();
  });
  it('should set projectId to null for malformed X-Project-Id values', async () => {
    mockSession = buildMockSession();

    // Non-numeric
    let res = await app.request('/protected', {
      headers: { cookie: 'hh.session_token=valid-session', 'x-project-id': 'abc' },
    });
    expect((await res.json())['projectId']).toBeNull();

    // Zero
    res = await app.request('/protected', {
      headers: { cookie: 'hh.session_token=valid-session', 'x-project-id': '0' },
    });
    expect((await res.json())['projectId']).toBeNull();

    // Negative
    res = await app.request('/protected', {
      headers: { cookie: 'hh.session_token=valid-session', 'x-project-id': '-1' },
    });
    expect((await res.json())['projectId']).toBeNull();

    // Float
    res = await app.request('/protected', {
      headers: { cookie: 'hh.session_token=valid-session', 'x-project-id': '1.5' },
    });
    expect((await res.json())['projectId']).toBeNull();

    // Empty string
    res = await app.request('/protected', {
      headers: { cookie: 'hh.session_token=valid-session', 'x-project-id': '' },
    });
    expect((await res.json())['projectId']).toBeNull();
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
    mockAgentResult = [{ id: 42, projectId: 7, status: 'online', capabilities: { gpu: true } }];

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

describe('requireAgentTokenForHeartbeatRecovery middleware', () => {
  const app = createAgentRecoveryApp();

  beforeEach(() => {
    mockAgentResult = [];
  });

  it('should accept a valid active agent (same path as the strict middleware)', async () => {
    // Arrange
    mockAgentResult = [{ id: 42, projectId: 7, status: 'online', capabilities: { gpu: true } }];

    // Act
    const res = await app.request('/agent-endpoint', {
      headers: { authorization: 'Bearer valid-agent-token' },
    });

    // Assert
    expect(res.status).toBe(200);
  });

  it('should accept agents in error state so they can post a recovery heartbeat', async () => {
    // Arrange — this is the difference from the strict variant. The
    // recovery middleware is only mounted on /heartbeat; the heartbeat
    // handler transitions the agent back to `online` on a clean payload.
    mockAgentResult = [{ id: 99, projectId: 7, status: 'error', capabilities: {} }];

    // Act
    const res = await app.request('/agent-endpoint', {
      headers: { authorization: 'Bearer recovering-agent-token' },
    });

    // Assert
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body['agentId']).toBe(99);
  });

  it('should still reject an unknown token', async () => {
    // Arrange
    mockAgentResult = [];

    // Act
    const res = await app.request('/agent-endpoint', {
      headers: { authorization: 'Bearer unknown-token' },
    });

    // Assert — the recovery middleware allows error-state agents, not
    // anonymous callers. Bearer validation still applies.
    expect(res.status).toBe(401);
  });
});
