import { describe, expect, it, mock } from 'bun:test';

// Mock the object-store probe so the health test does not require a running
// S3-compatible endpoint. The legacy `checkMinioHealth` re-export is also
// stubbed for back-compat coverage; both point at the same fixture.
const probeStub = mock(() =>
  Promise.resolve({ status: 'connected' as const, bucket: 'hashhive-test' })
);
mock.module('../../src/config/storage.js', () => ({
  checkObjectStoreHealth: probeStub,
  checkMinioHealth: probeStub,
  s3: {},
  uploadFile: mock(),
  downloadFile: mock(),
  deleteFile: mock(),
  getPresignedUrl: mock(),
}));

import { app } from '../../src/index.js';

describe('GET /health', () => {
  // Issue #109: /health now returns 503 when the system is unhealthy
  // (e.g. Redis disconnected because the queue manager isn't initialized
  // in unit-test mode), 200 otherwise. The body shape is identical in
  // both cases so older probes that only read the body keep working.
  const VALID_HTTP_STATUSES = [200, 503];

  it('should return health envelope with all expected fields', async () => {
    const res = await app.request('/health');
    expect(VALID_HTTP_STATUSES).toContain(res.status);

    const body = await res.json();
    expect(['ok', 'degraded']).toContain(body['status']);
    expect(['healthy', 'degraded', 'unhealthy']).toContain(body['aggregateStatus']);
    expect(body['version']).toBe('1.1.0');
    expect(body['timestamp']).toBeDefined();
    expect(body['services']['database']).toBeDefined();
    expect(['connected', 'disconnected']).toContain(body['services']['database']['status']);
  });

  it('should include object-store health status under the legacy `minio` wire key', async () => {
    // The wire key stays `minio` across the SeaweedFS swap so the dashboard
    // and any external probe consumers do not need a coupled release.
    const res = await app.request('/health');
    expect(VALID_HTTP_STATUSES).toContain(res.status);

    const body = await res.json();
    const objectStore = body['services']['minio'];
    expect(objectStore).toBeDefined();
    expect(objectStore['status']).toBe('connected');
    expect(typeof objectStore['bucket']).toBe('string');
    expect(objectStore['bucket'].length).toBeGreaterThan(0);
  });

  it('should expose services.queues.queues map (api-contract-3)', async () => {
    const res = await app.request('/health');
    expect(VALID_HTTP_STATUSES).toContain(res.status);

    const body = await res.json();
    expect(body['services']['queues']).toBeDefined();
    expect(body['services']['queues']['queues']).toBeDefined();
    // queues map may be empty when queue manager is unavailable; type check is enough.
    expect(typeof body['services']['queues']['queues']).toBe('object');
  });

  it('HTTP status mirrors body.aggregateStatus (200/503 contract)', async () => {
    // This test runs against whatever state the unit env happens to be
    // in (no QueueManager → typically unhealthy); it verifies the
    // *invariant* between body.aggregateStatus and the HTTP status, not
    // the 503 path on its own. Deterministic 200/503 path coverage —
    // forced by mocking getSystemHealth — lives in
    // tests/integration/health-deterministic.test.ts so the contract
    // is not at the mercy of unit-env state.
    const res = await app.request('/health');
    const body = await res.json();
    if (body['aggregateStatus'] === 'unhealthy') {
      expect(res.status).toBe(503);
    } else {
      expect(res.status).toBe(200);
    }
  });
});

describe('404 handler', () => {
  it('should return 404 for unknown routes', async () => {
    const res = await app.request('/nonexistent');
    expect(res.status).toBe(404);

    const body = await res.json();
    expect(body['error']['code']).toBe('NOT_FOUND');
  });
});
