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

  it('should include object-store health status under the legacy `minio` wire key', async () => {
    // The wire key stays `minio` across the SeaweedFS swap so the dashboard
    // and any external probe consumers do not need a coupled release.
    const res = await app.request('/health')
    expect(VALID_HTTP_STATUSES).toContain(res.status)

    const body = await res.json()
    const objectStore = body['services']['minio']
    expect(objectStore).toBeDefined()
    expect(objectStore['status']).toBe('connected')
    expect(typeof objectStore['bucket']).toBe('string')
    expect(objectStore['bucket'].length).toBeGreaterThan(0)
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

// ─── Object-store probe + legacy-wire contract regression tests ────────
//
// These pin the post-SeaweedFS-swap behavior so renaming the internal
// `ComponentName` value `'minio'` or dropping the legacy bucket fallback
// becomes a test-time error instead of a frontend regression.

describe('object-store probe + legacy wire contract', () => {
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

  it('preserves services.minio.bucket from env.S3_BUCKET even when probe detail is missing', async () => {
    // Simulates the timeout/programming-error path where ComponentHealth
    // has no `detail` field. The legacy envelope must still surface
    // `services.minio.bucket` so pre-#109 monitors that read it without
    // optional-chaining keep working.
    const { legacyPublicEnvelope } = await import('../../src/services/health.js')
    const envelope = legacyPublicEnvelope({
      status: 'unhealthy',
      timestamp: new Date().toISOString(),
      version: 'test',
      components: {
        database: { status: 'healthy', durationMs: 1 },
        redis: { status: 'healthy', durationMs: 1 },
        minio: { status: 'unhealthy', message: 'probe timed out', durationMs: 1 },
        queues: { status: 'healthy', durationMs: 1 },
      },
    })
    expect(envelope.services.minio.status).toBe('disconnected')
    expect(typeof envelope.services.minio.bucket).toBe('string')
    expect(envelope.services.minio.bucket.length).toBeGreaterThan(0)
  })

  it("pins ComponentName 'minio' as the wire identifier (regression: renaming breaks dashboard)", async () => {
    // If the internal `ComponentName` union is ever renamed away from
    // 'minio', the `components.minio` lookup below becomes a TypeScript
    // error at compile time and this test stops building. The compile-time
    // pin is the actual guard; the runtime assertion is the message.
    const { legacyPublicEnvelope } = await import('../../src/services/health.js')
    const envelope = legacyPublicEnvelope({
      status: 'healthy',
      timestamp: new Date().toISOString(),
      version: 'test',
      components: {
        database: { status: 'healthy', durationMs: 1 },
        redis: { status: 'healthy', durationMs: 1 },
        minio: {
          status: 'healthy',
          detail: { bucket: 'pinned-bucket' },
          durationMs: 1,
        },
        queues: { status: 'healthy', durationMs: 1 },
      },
    })
    expect(envelope.services.minio.bucket).toBe('pinned-bucket')
  })
})
