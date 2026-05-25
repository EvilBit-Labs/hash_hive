import { describe, expect, it, mock } from 'bun:test'

// Mock the object-store probe so the health test does not require a running
// S3-compatible endpoint.
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

import { app } from '../../src/index.js'

describe('GET /health', () => {
  // Issue #109: /health now returns 503 when the system is unhealthy
  // (e.g. Redis disconnected because the queue manager isn't initialized
  // in unit-test mode), 200 otherwise. The body shape is identical in
  // both cases so older probes that only read the body keep working.
  const VALID_HTTP_STATUSES = [200, 503]

  it('should return health envelope with all expected fields', async () => {
    const res = await app.request('/health')
    expect(VALID_HTTP_STATUSES).toContain(res.status)

    const body = await res.json()
    expect(['ok', 'degraded']).toContain(body['status'])
    expect(['healthy', 'degraded', 'unhealthy']).toContain(body['aggregateStatus'])
    expect(body['version']).toBe('1.1.0')
    expect(body['timestamp']).toBeDefined()
    expect(body['services']['database']).toBeDefined()
    expect(['connected', 'disconnected']).toContain(body['services']['database']['status'])
  })

  it('should include object-store health status under `services.object_store`', async () => {
    // The wire key is `object_store` (vendor-neutral). The pre-prod `minio`
    // placeholder was dropped in this PR; see issue #156 AC 4.3.
    const res = await app.request('/health')
    expect(VALID_HTTP_STATUSES).toContain(res.status)

    const body = await res.json()
    const objectStore = body['services']['object_store']
    expect(objectStore).toBeDefined()
    expect(objectStore['status']).toBe('connected')
    expect(typeof objectStore['bucket']).toBe('string')
    expect(objectStore['bucket'].length).toBeGreaterThan(0)
  })

  it('should not expose the legacy `services.minio` wire key', async () => {
    // Regression guard: AC 4.3 of issue #156 requires neutral naming.
    // Reintroducing the `minio` field would silently re-violate the AC.
    const res = await app.request('/health')
    expect(VALID_HTTP_STATUSES).toContain(res.status)

    const body = await res.json()
    expect(body['services']['minio']).toBeUndefined()
    // Positive assertion: the new `object_store` field carries the shape
    // the old `minio` field used to (status + bucket). This pairs with the
    // absence assertion above so the rename is enforced from both sides.
    expect(['connected', 'disconnected']).toContain(body['services']['object_store']['status'])
    expect(typeof body['services']['object_store']['bucket']).toBe('string')
    expect(body['services']['object_store']['bucket'].length).toBeGreaterThan(0)
  })

  it('should expose services.queues.queues map (api-contract-3)', async () => {
    const res = await app.request('/health')
    expect(VALID_HTTP_STATUSES).toContain(res.status)

    const body = await res.json()
    expect(body['services']['queues']).toBeDefined()
    expect(body['services']['queues']['queues']).toBeDefined()
    // queues map may be empty when queue manager is unavailable; type check is enough.
    expect(typeof body['services']['queues']['queues']).toBe('object')
  })

  it('HTTP status mirrors body.aggregateStatus (200/503 contract)', async () => {
    // This test runs against whatever state the unit env happens to be
    // in (no QueueManager → typically unhealthy); it verifies the
    // *invariant* between body.aggregateStatus and the HTTP status, not
    // the 503 path on its own. Deterministic 200/503 path coverage —
    // forced by mocking getSystemHealth — lives in
    // tests/integration/health-deterministic.test.ts so the contract
    // is not at the mercy of unit-env state.
    const res = await app.request('/health')
    const body = await res.json()
    if (body['aggregateStatus'] === 'unhealthy') {
      expect(res.status).toBe(503)
    } else {
      expect(res.status).toBe(200)
    }
  })
})

describe('404 handler', () => {
  it('should return 404 for unknown routes', async () => {
    const res = await app.request('/nonexistent')
    expect(res.status).toBe(404)

    const body = await res.json()
    expect(body['error']['code']).toBe('NOT_FOUND')
  })
})

// ─── Object-store probe + wire-contract regression tests ────────
//
// These pin the post-rename behavior so reintroducing the legacy `minio`
// wire identifier or dropping the bucket fallback becomes a test-time
// error instead of a frontend regression.

describe('object-store probe + wire contract', () => {
  it('reports the documented error string when the object store is unreachable', async () => {
    const { probeObjectStore } = await import('../../src/services/health.js')
    const result = await probeObjectStore({
      check: () => Promise.resolve({ status: 'disconnected' as const, bucket: 'b' }),
    })
    expect(result.status).toBe('unhealthy')
    if (result.status === 'unhealthy') {
      expect(result.message).toBe('object store bucket b unreachable')
    }
  })

  it('populates services.object_store.bucket from env.S3_BUCKET even when probe detail is missing', async () => {
    // Simulates the timeout/programming-error path where ComponentHealth
    // has no `detail` field. The legacy envelope must still surface
    // `services.object_store.bucket` so anonymous monitors that read it
    // without optional-chaining keep working.
    const { legacyPublicEnvelope } = await import('../../src/services/health.js')
    const envelope = legacyPublicEnvelope({
      status: 'unhealthy',
      timestamp: new Date().toISOString(),
      version: 'test',
      components: {
        database: { status: 'healthy', durationMs: 1 },
        redis: { status: 'healthy', durationMs: 1 },
        object_store: { status: 'unhealthy', message: 'probe timed out', durationMs: 1 },
        queues: { status: 'healthy', durationMs: 1 },
      },
    })
    expect(envelope.services.object_store.status).toBe('disconnected')
    expect(typeof envelope.services.object_store.bucket).toBe('string')
    expect(envelope.services.object_store.bucket.length).toBeGreaterThan(0)
  })

  it("pins ComponentName 'object_store' as the wire identifier (regression: renaming breaks dashboard)", async () => {
    // If the internal `ComponentName` union is ever renamed away from
    // 'object_store', the `components.object_store` lookup below becomes a
    // TypeScript error at compile time and this test stops building. The
    // compile-time pin is the actual guard; the runtime assertion is the
    // message.
    const { legacyPublicEnvelope } = await import('../../src/services/health.js')
    const envelope = legacyPublicEnvelope({
      status: 'healthy',
      timestamp: new Date().toISOString(),
      version: 'test',
      components: {
        database: { status: 'healthy', durationMs: 1 },
        redis: { status: 'healthy', durationMs: 1 },
        object_store: {
          status: 'healthy',
          detail: { bucket: 'pinned-bucket' },
          durationMs: 1,
        },
        queues: { status: 'healthy', durationMs: 1 },
      },
    })
    expect(envelope.services.object_store.bucket).toBe('pinned-bucket')
  })
})
