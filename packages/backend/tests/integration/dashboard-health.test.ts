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
import { beforeEach, describe, expect, it, mock } from 'bun:test'

// ─── Mock BetterAuth ─────────────────────────────────────────────────
//
// Reuse the same cookie convention as dashboard-api-contract tests so
// the auth middleware behavior is identical.

mock.module('../../src/lib/auth.js', () => ({
  auth: {
    api: {
      getSession: async ({ headers }: { headers: Headers }) => {
        const cookie = headers.get('cookie') ?? ''
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
          }
        }
        return null
      },
    },
    handler: async () => new Response('ok'),
  },
}))

mock.module('../../src/services/auth.js', () => ({
  getUserWithProjects: async () => null,
  findProjectMembership: async () => null,
}))

// Object-store probe stubbed to avoid bucket dependency.
const probeStub = mock(() =>
  Promise.resolve({ status: 'connected' as const, bucket: 'hashhive-test' })
)
mock.module('../../src/config/storage.js', () => ({
  checkObjectStoreHealth: probeStub,
  s3: {},
  uploadFile: mock(),
  downloadFile: mock(),
  deleteFile: mock(),
  getPresignedUrl: mock(),
}))

// Force the queue manager to be absent so the queues probe deterministically
// reports `disconnected → unhealthy` regardless of what other test files have
// set on the global registry. Combined with the cache reset below this makes
// the "non-healthy component" assertions in this file order-independent.
mock.module('../../src/queue/context.js', () => ({
  getQueueManager: () => null,
  setQueueManager: () => {},
}))

import { app } from '../../src/index.js'
import { __resetSystemHealthCache } from '../../src/services/health.js'

// Clear the 5s system-health cache before each case so a stale value
// from a prior test (or another suite that ran moments earlier) cannot
// leak through.
beforeEach(() => {
  __resetSystemHealthCache()
})

describe('GET /api/v1/dashboard/health', () => {
  it('returns 401 without a session cookie', async () => {
    const res = await app.request('/api/v1/dashboard/health')
    expect(res.status).toBe(401)
    const body = (await res.json()) as Record<string, { code: string }>
    expect(body['error']?.code).toBe('AUTH_TOKEN_INVALID')
  })

  it('returns SystemHealth shape with all four components when authenticated', async () => {
    const res = await app.request('/api/v1/dashboard/health', {
      headers: { cookie: 'hh.session_token=valid-session' },
    })
    expect(res.status).toBe(200)

    const body = (await res.json()) as {
      status: string
      timestamp: string
      version: string
      components: Record<string, { status: string; durationMs: number }>
    }

    // Top-level envelope
    expect(['healthy', 'degraded', 'unhealthy']).toContain(body.status)
    expect(typeof body.timestamp).toBe('string')
    expect(body.version).toBe('1.1.0')

    // All four components present. Bracket notation per
    // `noPropertyAccessFromIndexSignature` (Record<string, …>).
    expect(body.components['database']).toBeDefined()
    expect(body.components['redis']).toBeDefined()
    expect(body.components['minio']).toBeDefined()
    expect(body.components['queues']).toBeDefined()

    // Per-component status uses the new three-tier enum
    for (const c of Object.values(body.components)) {
      expect(['healthy', 'degraded', 'unhealthy']).toContain(c.status)
      expect(typeof c.durationMs).toBe('number')
    }
  })

  it('exposes per-component detail (unlike the public surface)', async () => {
    const res = await app.request('/api/v1/dashboard/health', {
      headers: { cookie: 'hh.session_token=valid-session' },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      components: Record<string, { detail?: Record<string, unknown> }>
    }
    // MinIO probe is mocked to connected, so detail should include the bucket name
    expect(body.components['minio']?.detail?.['bucket']).toBe('hashhive-test')
  })

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
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      components: Record<
        string,
        { status: string; message?: string; detail?: Record<string, unknown> }
      >
    }
    // Whatever the actual component states, the response shape must
    // preserve the structured envelope on every component. (In test env
    // queues will be unhealthy because there's no QueueManager; that
    // gives us a real non-healthy component to inspect.)
    // Precondition guard: the test's whole point is to verify
    // non-healthy components retain message + detail. If a future
    // refactor mocks the queue manager (or otherwise makes every
    // component healthy in test env), this assertion fails loudly
    // instead of letting the conditional block below silently skip.
    const someNonHealthy = Object.values(body.components).some((c) => c.status !== 'healthy')
    expect(someNonHealthy).toBe(true)

    // The contract under test: every non-healthy component carries a
    // `message` (required by the ComponentHealth discriminated union).
    // `detail` is optional per probe — redis omits it, queues+minio
    // include it — so we only assert message presence on the
    // first-non-healthy. Detail is asserted on the queues path (which
    // always carries `{ queues: {} }`) and the minio path (which always
    // carries `{ bucket }`) below.
    const nonHealthy = Object.values(body.components).find((c) => c.status !== 'healthy')
    expect(nonHealthy).toBeDefined()
    expect(nonHealthy?.message).toBeDefined()
    expect(typeof nonHealthy?.message).toBe('string')

    // Pin the queues path: when queues is non-healthy (the reliable
    // signal in unit-test env without a QueueManager), its detail must
    // include the queues map. Bracket access yields T | undefined; pin
    // presence first so a regression that drops the key entirely fails
    // loudly instead of silently skipping via optional chaining.
    const queues = body.components['queues']
    expect(queues).toBeDefined()
    if (queues && queues.status !== 'healthy') {
      expect(queues.detail).toBeDefined()
    }
    // minio probe is stubbed, so its detail.bucket is reliably present
    // — proves the dashboard surface keeps the field that the public
    // envelope is allowed to strip.
    expect(body.components['minio']?.detail?.['bucket']).toBe('hashhive-test')
  })
})
