/**
 * Deterministic /health 200/503 contract tests (PR review C-1).
 *
 * The original health.test.ts accepts either 200 or 503 because the
 * unit-test environment lacks a queue manager. A regression that
 * always returned 200 with status='ok' regardless of probe results
 * would pass that test vacuously. This file mocks `getSystemHealth`
 * directly to drive each terminal HTTP outcome.
 */
import { afterAll, describe, expect, it, mock } from 'bun:test';
import type { ComponentHealth, SystemHealth } from '../../src/services/health.js';

let mockedAggregateStatus: SystemHealth['status'] = 'healthy';

function buildComponent(status: ComponentHealth['status']): ComponentHealth {
  if (status === 'healthy') {
    return { status: 'healthy', durationMs: 1, detail: { bucket: 'hashhive-test' } };
  }
  return {
    status,
    message: `${status} probe`,
    durationMs: 1,
    detail: { bucket: 'hashhive-test' },
  };
}

function buildSystemHealth(): SystemHealth {
  return {
    status: mockedAggregateStatus,
    timestamp: '2026-05-07T00:00:00.000Z',
    version: '1.1.0',
    components: {
      database: buildComponent(mockedAggregateStatus === 'unhealthy' ? 'unhealthy' : 'healthy'),
      redis: buildComponent('healthy'),
      minio: buildComponent('healthy'),
      queues: buildComponent(mockedAggregateStatus === 'degraded' ? 'degraded' : 'healthy'),
    },
  };
}

// Mock the entire health module synchronously. Importers will see only
// the functions/types we re-export here; legacyPublicEnvelope lives in
// the same file and is needed by index.ts, so we require() it through
// the synthetic factory below to keep its real implementation.
const realHealth = require('../../src/services/health.js') as Record<string, unknown>;

mock.module('../../src/services/health.js', () => ({
  ...realHealth,
  getSystemHealth: mock(async () => buildSystemHealth()),
}));

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

// Defensive cleanup: Bun normally isolates test files per process so
// the health/storage mocks here don't bleed into other suites. If that
// isolation model ever changes (e.g. running `bun test --concurrency=1`
// across files in one process), `mock.restore()` keeps the unmocked
// `getSystemHealth` for any test file that runs after this one.
afterAll(() => {
  mock.restore();
});

describe('GET /health — deterministic 200 vs 503', () => {
  it('returns 200 with body status="ok" when service reports healthy', async () => {
    mockedAggregateStatus = 'healthy';
    const res = await app.request('/health');
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body['status']).toBe('ok');
    expect(body['aggregateStatus']).toBe('healthy');
  });

  it('returns 200 with body status="degraded" when service reports degraded', async () => {
    mockedAggregateStatus = 'degraded';
    const res = await app.request('/health');
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body['status']).toBe('degraded');
    expect(body['aggregateStatus']).toBe('degraded');
  });

  it('returns 503 with body aggregateStatus="unhealthy" when service reports unhealthy', async () => {
    mockedAggregateStatus = 'unhealthy';
    const res = await app.request('/health');
    expect(res.status).toBe(503);
    const body = (await res.json()) as Record<string, unknown>;
    // Body's coarse `status` collapses to 'degraded' for backward compat
    expect(body['status']).toBe('degraded');
    // But aggregateStatus carries the full three-tier signal
    expect(body['aggregateStatus']).toBe('unhealthy');
  });
});
