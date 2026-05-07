/**
 * Integration tests for GET /api/v1/dashboard/health (issue #109).
 *
 * Verifies the dashboard health endpoint:
 *   - rejects unauthenticated requests with 401
 *   - returns the SystemHealth shape (with `components` and `detail`)
 *     when authenticated
 *
 * Mocks BetterAuth and storage so the test does not depend on real
 * Postgres / Redis / MinIO availability.
 */
import { describe, expect, it, mock } from 'bun:test';

// ─── Mock BetterAuth ─────────────────────────────────────────────────
//
// Reuse the same cookie convention as dashboard-api-contract tests so
// the auth middleware behavior is identical.

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
              expiresAt: new Date(Date.now() + 3_600_000),
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
  findProjectMembership: async () => null,
}));

// MinIO probe stubbed to avoid bucket dependency.
mock.module('../../src/config/storage.js', () => ({
  checkMinioHealth: mock(() =>
    Promise.resolve({ status: 'connected' as const, bucket: 'hashhive-test' })
  ),
  s3: {},
  uploadFile: mock(),
  downloadFile: mock(),
  deleteFile: mock(),
  getPresignedUrl: mock(),
}));

import { app } from '../../src/index.js';

describe('GET /api/v1/dashboard/health', () => {
  it('returns 401 without a session cookie', async () => {
    const res = await app.request('/api/v1/dashboard/health');
    expect(res.status).toBe(401);
    const body = (await res.json()) as Record<string, { code: string }>;
    expect(body['error']?.code).toBe('AUTH_TOKEN_INVALID');
  });

  it('returns SystemHealth shape with all four components when authenticated', async () => {
    const res = await app.request('/api/v1/dashboard/health', {
      headers: { cookie: 'hh.session_token=valid-session' },
    });
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      status: string;
      timestamp: string;
      version: string;
      components: Record<string, { status: string; durationMs: number }>;
    };

    // Top-level envelope
    expect(['healthy', 'degraded', 'unhealthy']).toContain(body.status);
    expect(typeof body.timestamp).toBe('string');
    expect(body.version).toBe('1.0.0');

    // All four components present
    expect(body.components.database).toBeDefined();
    expect(body.components.redis).toBeDefined();
    expect(body.components.minio).toBeDefined();
    expect(body.components.queues).toBeDefined();

    // Per-component status uses the new three-tier enum
    for (const c of Object.values(body.components)) {
      expect(['healthy', 'degraded', 'unhealthy']).toContain(c.status);
      expect(typeof c.durationMs).toBe('number');
    }
  });

  it('exposes per-component detail (unlike the public surface)', async () => {
    const res = await app.request('/api/v1/dashboard/health', {
      headers: { cookie: 'hh.session_token=valid-session' },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      components: Record<string, { detail?: Record<string, unknown> }>;
    };
    // MinIO probe is mocked to connected, so detail should include the bucket name
    expect(body.components.minio.detail?.['bucket']).toBe('hashhive-test');
  });

  // PR review I-1: the dashboard surface intentionally exposes the rich
  // payload (detail + message) that the public envelope strips. Verify
  // the *inverse* of the legacyPublicEnvelope leak-prevention tests —
  // when a component is non-healthy, the dashboard reader must still see
  // the structured detail so the card can render it. A regression that
  // accidentally stripped detail on the dashboard route would silently
  // degrade the card's diagnostic value.
  it('preserves detail and message on non-healthy components for authenticated readers', async () => {
    const res = await app.request('/api/v1/dashboard/health', {
      headers: { cookie: 'hh.session_token=valid-session' },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      components: Record<
        string,
        { status: string; message?: string; detail?: Record<string, unknown> }
      >;
    };
    // Whatever the actual component states, the response shape must
    // preserve the structured envelope on every component. (In test env
    // queues will be unhealthy because there's no QueueManager; that
    // gives us a real non-healthy component to inspect.)
    const queues = body.components.queues;
    if (queues.status !== 'healthy') {
      expect(queues.message).toBeDefined();
      expect(typeof queues.message).toBe('string');
      expect(queues.detail).toBeDefined();
    }
    // minio probe is stubbed, so its detail.bucket is reliably present
    // — proves the dashboard surface keeps the field that the public
    // envelope is allowed to strip.
    expect(body.components.minio.detail?.['bucket']).toBe('hashhive-test');
  });
});
