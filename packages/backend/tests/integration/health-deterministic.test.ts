/**
 * Deterministic /health 200/503 contract tests (PR review C-1).
 *
 * The original health.test.ts accepts either 200 or 503 because the
 * unit-test environment lacks a queue manager. A regression that
 * always returned 200 with status='ok' regardless of probe results
 * would pass that test vacuously. This file mocks `getSystemHealth`
 * directly to drive each terminal HTTP outcome.
 *
 * **Isolated phase**: Bun's test runner shares one process across all
 * test files when invoked as a single `bun test` command. The
 * `mock.module('services/health.js', ...)` call below replaces
 * `getSystemHealth` PROCESS-WIDE — so any other file that imports
 * `getSystemHealth` after this one (notably `health-service.test.ts`)
 * sees the mocked function and ignores its `opts.probes` argument.
 *
 * The package.json test script runs this file FIRST in its own
 * `bun test` invocation with `HEALTH_DETERMINISTIC_TEST_ISOLATED=1`
 * set, then runs the full suite where this file's mocks are gated
 * behind the env var and skipped. See `tasks.test.ts` and
 * `queue-manager.test.ts` for the prior pattern this mirrors.
 */
import { afterAll, describe, expect, it, mock, test } from 'bun:test';
import {
  __resetSystemHealthCache,
  HEALTH_VERSION,
  legacyPublicEnvelope,
} from '../../src/services/health.js';
import type { ComponentHealth, SystemHealth } from '../../src/services/health.js';

const IS_ISOLATED = process.env['HEALTH_DETERMINISTIC_TEST_ISOLATED'] === '1';

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

// Install mocks ONLY when the isolated-phase env var is set. Without
// the gate, this file's mocks would replace the real `getSystemHealth`
// process-wide and poison `health-service.test.ts` (which imports the
// real function and passes its own `probes:` argument). The
// `tasks.test.ts` / `queue-manager.test.ts` pattern uses
// `describeIfIsolated` for similar isolation; here the gate must wrap
// `mock.module` itself because that's the side-effect causing the
// cross-file leak.
if (IS_ISOLATED) {
  mock.module('../../src/services/health.js', () => ({
    legacyPublicEnvelope,
    HEALTH_VERSION,
    __resetSystemHealthCache,
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
}

// Static import; under the isolated-phase gate the mocks above already
// fired before this evaluates, so `app` sees the mocked `getSystemHealth`.
// Under the non-isolated run the real `app` loads but the test bodies
// below are skipped, so the real module isn't exercised here either.
import { app } from '../../src/index.js';

if (!IS_ISOLATED) {
  describe.skip('health-deterministic (skipped — runs in isolated phase)', () => {
    test('runs only with HEALTH_DETERMINISTIC_TEST_ISOLATED=1', () => {});
  });
} else {
  // Defensive cleanup. Even with the env-var gate the suite restores
  // mocks at end so a future change that runs additional files in the
  // same isolated process won't pick up our overrides.
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
}
