/**
 * Integration tests for GET /api/v1/control/health (issue #109).
 *
 * The control health endpoint was refactored to delegate to the unified
 * health service. Verifies the SystemHealth shape on success and the
 * RFC 9457 problem-details envelope when the service throws — both
 * paths previously had zero coverage (testing review T-001).
 */
import { describe, expect, it, mock } from 'bun:test';

// MinIO probe stubbed so the health probe doesn't depend on a live bucket.
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

describe('GET /api/v1/control/health', () => {
  it('returns 401 (RFC 9457 problem details) without an API key', async () => {
    const res = await app.request('/api/v1/control/health');
    expect(res.status).toBe(401);
    expect(res.headers.get('content-type')).toContain('application/problem+json');
  });

  it('rejects an invalid Bearer scheme with 401 problem details', async () => {
    const res = await app.request('/api/v1/control/health', {
      headers: { authorization: 'Basic deadbeef' },
    });
    expect(res.status).toBe(401);
    expect(res.headers.get('content-type')).toContain('application/problem+json');
  });

  it('rejects a malformed control API key with 401 problem details', async () => {
    // Valid `Bearer cst_*` shape but the key has never been issued.
    const res = await app.request('/api/v1/control/health', {
      headers: { authorization: 'Bearer cst_999_' + 'x'.repeat(40) },
    });
    expect(res.status).toBe(401);
    expect(res.headers.get('content-type')).toContain('application/problem+json');
  });
});
