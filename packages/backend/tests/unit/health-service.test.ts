import { beforeEach, describe, expect, test } from 'bun:test';
import {
  __resetSystemHealthCache,
  aggregateStatus,
  type ComponentHealth,
  type ComponentName,
  getSystemHealth,
  legacyPublicEnvelope,
  probeDatabase,
  probeMinio,
  probeQueues,
  probeRedis,
  runProbe,
} from '../../src/services/health.js';

// getSystemHealth() carries a 5s in-memory cache + in-flight dedupe.
// Tests that pass `probes:` bypass the cache by design, but tests that
// run AFTER one without the bypass could hit a stale cached value.
// Reset before each test so every assertion observes only its own
// probes — eliminates ordering-dependent CI flakes.
beforeEach(() => {
  __resetSystemHealthCache();
});

function makeComponent(status: ComponentHealth['status']): ComponentHealth {
  return { status, durationMs: 1 };
}

function makeComponents(
  overrides: Partial<Record<ComponentName, ComponentHealth['status']>>
): Record<ComponentName, ComponentHealth> {
  return {
    database: makeComponent(overrides.database ?? 'healthy'),
    redis: makeComponent(overrides.redis ?? 'healthy'),
    minio: makeComponent(overrides.minio ?? 'healthy'),
    queues: makeComponent(overrides.queues ?? 'healthy'),
  };
}

describe('aggregateStatus', () => {
  test('returns healthy when all components are healthy', () => {
    expect(aggregateStatus(makeComponents({}))).toBe('healthy');
  });

  test('returns degraded when one component is degraded and others healthy', () => {
    expect(aggregateStatus(makeComponents({ queues: 'degraded' }))).toBe('degraded');
  });

  test('returns unhealthy when any component is unhealthy regardless of degraded', () => {
    expect(aggregateStatus(makeComponents({ minio: 'unhealthy', queues: 'degraded' }))).toBe(
      'unhealthy'
    );
  });

  test('returns unhealthy when all components are unhealthy', () => {
    expect(
      aggregateStatus(
        makeComponents({
          database: 'unhealthy',
          redis: 'unhealthy',
          minio: 'unhealthy',
          queues: 'unhealthy',
        })
      )
    ).toBe('unhealthy');
  });
});

describe('runProbe', () => {
  test('attaches durationMs to a successful probe result', async () => {
    const result = await runProbe('database', async () => ({ status: 'healthy' as const }), 1000);
    expect(result.status).toBe('healthy');
    expect(typeof result.durationMs).toBe('number');
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  test('coerces a thrown error into unhealthy with the error message', async () => {
    const result = await runProbe(
      'database',
      async () => {
        throw new Error('boom');
      },
      1000
    );
    expect(result.status).toBe('unhealthy');
    expect(result.message).toBe('boom');
  });

  test('coerces a probe that exceeds the timeout into unhealthy with timeout message', async () => {
    const result = await runProbe(
      'database',
      () => new Promise(() => {}), // never resolves
      50
    );
    expect(result.status).toBe('unhealthy');
    expect(result.message).toContain('timed out');
    expect(result.message).toContain('50ms');
  });

  test('passes an AbortSignal to the probe and aborts it on timeout', async () => {
    let receivedSignal: AbortSignal | undefined;
    const probeFn = (signal: AbortSignal) =>
      new Promise<never>(() => {
        // Capture the signal so the test can assert it aborts.
        receivedSignal = signal;
      });
    const result = await runProbe('database', probeFn, 30);
    expect(result.status).toBe('unhealthy');
    expect(result.message).toContain('timed out');
    // The probe captured the signal; once the wrapper times out, it
    // should be aborted so cancellation-aware drivers (S3 SDK
    // abortSignal, fetch) terminate the underlying call.
    expect(receivedSignal).toBeDefined();
    expect(receivedSignal?.aborted).toBe(true);
  });

  test('does NOT abort the signal when the probe resolves before timeout', async () => {
    let receivedSignal: AbortSignal | undefined;
    const probeFn = async (signal: AbortSignal) => {
      receivedSignal = signal;
      return { status: 'healthy' as const };
    };
    const result = await runProbe('database', probeFn, 1000);
    expect(result.status).toBe('healthy');
    expect(receivedSignal?.aborted).toBe(false);
  });
});

describe('probeDatabase', () => {
  test('returns healthy when pool usage is below warn threshold', async () => {
    const result = await probeDatabase(
      {
        ping: async () => undefined,
        poolStats: async () => ({ used: 10, max: 100 }),
      },
      80
    );
    expect(result.status).toBe('healthy');
    expect(result.detail?.['connectionsUsed']).toBe(10);
    expect(result.detail?.['connectionsMax']).toBe(100);
  });

  test('returns degraded at exactly the warn threshold (inclusive boundary)', async () => {
    // Issue #109 (C5): "warn at 80%" fires when pool reaches 80%. Strictly-
    // greater-than would silently let the boundary value pass.
    const result = await probeDatabase(
      {
        ping: async () => undefined,
        poolStats: async () => ({ used: 80, max: 100 }),
      },
      80
    );
    expect(result.status).toBe('degraded');
  });

  test('returns healthy just below the warn threshold', async () => {
    const result = await probeDatabase(
      {
        ping: async () => undefined,
        poolStats: async () => ({ used: 79, max: 100 }),
      },
      80
    );
    expect(result.status).toBe('healthy');
  });

  test('returns degraded when pool usage exceeds warn threshold', async () => {
    const result = await probeDatabase(
      {
        ping: async () => undefined,
        poolStats: async () => ({ used: 85, max: 100 }),
      },
      80
    );
    expect(result.status).toBe('degraded');
    // Message now uses unrounded pct (formatted to 1 decimal) so the
    // displayed value matches the threshold-comparison value exactly.
    expect(result.message).toContain('85.0%');
    expect(result.message).toContain('80%');
  });

  test('reports unrounded connectionsPct in detail (no display/decision drift)', async () => {
    // 79.6% should remain healthy (below 80% threshold) AND read 79.6
    // in detail.connectionsPct — previously detail rounded to 80 while
    // the unrounded 79.6 kept status healthy, which was confusing.
    const result = await probeDatabase(
      {
        ping: async () => undefined,
        poolStats: async () => ({ used: 796, max: 1000 }),
      },
      80
    );
    expect(result.status).toBe('healthy');
    expect(result.detail?.['connectionsPct']).toBeCloseTo(79.6, 5);
  });

  test('throws (caught upstream by runProbe) when ping fails', async () => {
    await expect(
      probeDatabase(
        {
          ping: async () => {
            throw new Error('connection refused');
          },
          poolStats: async () => ({ used: 0, max: 100 }),
        },
        80
      )
    ).rejects.toThrow('connection refused');
  });
});

describe('probeRedis', () => {
  test('returns healthy when status reports connected', async () => {
    const result = await probeRedis({ status: () => 'connected' });
    expect(result.status).toBe('healthy');
  });

  test('returns unhealthy when status reports disconnected', async () => {
    const result = await probeRedis({ status: () => 'disconnected' });
    expect(result.status).toBe('unhealthy');
    expect(result.message).toContain('not ready');
  });
});

describe('probeMinio', () => {
  test('returns healthy when bucket is connected', async () => {
    const result = await probeMinio({
      check: async () => ({ status: 'connected', bucket: 'hashhive' }),
    });
    expect(result.status).toBe('healthy');
    expect(result.detail?.['bucket']).toBe('hashhive');
  });

  test('returns unhealthy when bucket is unreachable', async () => {
    const result = await probeMinio({
      check: async () => ({ status: 'disconnected', bucket: 'hashhive' }),
    });
    expect(result.status).toBe('unhealthy');
    expect(result.message).toContain('hashhive');
  });
});

describe('probeQueues', () => {
  test('returns healthy when all queues are within thresholds', async () => {
    const result = await probeQueues(
      {
        health: async () => ({
          status: 'connected',
          queues: {
            'tasks-high': { waiting: 5, active: 1, failed: 0 },
            'tasks-normal': { waiting: 100, active: 5, failed: 2 },
          },
        }),
      },
      10_000,
      100
    );
    expect(result.status).toBe('healthy');
    expect((result.detail?.['queues'] as Record<string, unknown>)['tasks-high']).toBeDefined();
  });

  test('returns degraded with offender queue named when waiting exceeds threshold', async () => {
    const result = await probeQueues(
      {
        health: async () => ({
          status: 'connected',
          queues: {
            'tasks-high': { waiting: 50_000, active: 1, failed: 0 },
            'tasks-normal': { waiting: 5, active: 5, failed: 2 },
          },
        }),
      },
      10_000,
      100
    );
    expect(result.status).toBe('degraded');
    expect(result.message).toContain('tasks-high');
    expect(result.message).toContain('50000');
  });

  test('returns degraded when failed count exceeds threshold', async () => {
    const result = await probeQueues(
      {
        health: async () => ({
          status: 'connected',
          queues: {
            'jobs-task-generation': { waiting: 0, active: 0, failed: 500 },
          },
        }),
      },
      10_000,
      100
    );
    expect(result.status).toBe('degraded');
    expect(result.message).toContain('jobs-task-generation');
    expect(result.message).toContain('failed=500');
  });

  test('returns degraded at exactly the waiting threshold (inclusive boundary)', async () => {
    // Issue #109 (C5): "warn at 10000" means 10000 is already the warn state.
    const result = await probeQueues(
      {
        health: async () => ({
          status: 'connected',
          queues: { q: { waiting: 10_000, active: 0, failed: 0 } },
        }),
      },
      10_000,
      100
    );
    expect(result.status).toBe('degraded');
    expect(result.message).toContain('q waiting=10000');
  });

  test('returns healthy just below the waiting threshold', async () => {
    const result = await probeQueues(
      {
        health: async () => ({
          status: 'connected',
          queues: { q: { waiting: 9_999, active: 0, failed: 0 } },
        }),
      },
      10_000,
      100
    );
    expect(result.status).toBe('healthy');
  });

  test('returns unhealthy when redis is disconnected', async () => {
    const result = await probeQueues(
      {
        health: async () => ({ status: 'disconnected', queues: {} }),
      },
      10_000,
      100
    );
    expect(result.status).toBe('unhealthy');
    expect(result.message).toContain('not connected');
  });
});

describe('getSystemHealth', () => {
  const allHealthyProbes = {
    database: {
      ping: async () => undefined,
      poolStats: async () => ({ used: 1, max: 100 }),
    },
    redis: {
      status: () => 'connected' as const,
    },
    minio: {
      check: async () => ({ status: 'connected' as const, bucket: 'test' }),
    },
    queues: {
      health: async () => ({
        status: 'connected' as const,
        queues: { 'tasks-normal': { waiting: 1, active: 0, failed: 0 } },
      }),
    },
  };

  test('returns SystemHealth shape with all four components and version', async () => {
    const result = await getSystemHealth({ probes: allHealthyProbes });
    expect(result.status).toBe('healthy');
    expect(result.version).toBe('1.1.0');
    expect(result.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(result.components.database.status).toBe('healthy');
    expect(result.components.redis.status).toBe('healthy');
    expect(result.components.minio.status).toBe('healthy');
    expect(result.components.queues.status).toBe('healthy');
  });

  test('aggregates degraded when one probe reports degraded', async () => {
    const result = await getSystemHealth({
      probes: {
        ...allHealthyProbes,
        queues: {
          health: async () => ({
            status: 'connected',
            queues: { q: { waiting: 999_999, active: 0, failed: 0 } },
          }),
        },
      },
    });
    expect(result.status).toBe('degraded');
    expect(result.components.queues.status).toBe('degraded');
    expect(result.components.database.status).toBe('healthy');
  });

  test('aggregates unhealthy when one probe throws (parallel execution does not short-circuit)', async () => {
    const result = await getSystemHealth({
      probes: {
        ...allHealthyProbes,
        minio: {
          check: async () => {
            throw new Error('minio down');
          },
        },
      },
    });
    expect(result.status).toBe('unhealthy');
    expect(result.components.minio.status).toBe('unhealthy');
    expect(result.components.minio.message).toBe('minio down');
    // Other components still healthy — parallel probes did not short-circuit
    expect(result.components.database.status).toBe('healthy');
    expect(result.components.redis.status).toBe('healthy');
    expect(result.components.queues.status).toBe('healthy');
  });

  test('three async probes hanging simultaneously do not serialize wall-clock (parallelism proof, T-008)', async () => {
    // The redis probe's status() is synchronous so it can't hang on a
    // timeout — instead it reports unhealthy immediately. The three
    // async probes (database, minio, queues) all hang and must time
    // out in parallel, not one-after-another.
    const hangingProbe = () => new Promise<never>(() => {});
    const start = Date.now();
    const result = await getSystemHealth({
      probes: {
        database: {
          ping: hangingProbe,
          poolStats: async () => ({ used: 0, max: 100 }),
        },
        redis: { status: () => 'disconnected' },
        minio: { check: hangingProbe },
        queues: { health: hangingProbe },
      },
      thresholds: { probeTimeoutMs: 50 },
    });
    const elapsed = Date.now() - start;
    expect(result.status).toBe('unhealthy');
    expect(result.components.database.message).toContain('timed out');
    expect(result.components.minio.message).toContain('timed out');
    expect(result.components.queues.message).toContain('timed out');
    // Parallel execution: total wall-clock should be roughly one probe's
    // timeout, not three times it. Allow generous margin for CI.
    expect(elapsed).toBeLessThan(200);
  });

  test('coerces probe timeout to unhealthy without affecting other components', async () => {
    const result = await getSystemHealth({
      probes: {
        ...allHealthyProbes,
        database: {
          ping: () => new Promise(() => {}), // never resolves
          poolStats: async () => ({ used: 0, max: 100 }),
        },
      },
      thresholds: { probeTimeoutMs: 50 },
    });
    expect(result.components.database.status).toBe('unhealthy');
    expect(result.components.database.message).toContain('timed out');
    expect(result.components.redis.status).toBe('healthy');
  });

  test('every component has a numeric durationMs', async () => {
    const result = await getSystemHealth({ probes: allHealthyProbes });
    for (const c of Object.values(result.components)) {
      expect(typeof c.durationMs).toBe('number');
      expect(Number.isFinite(c.durationMs)).toBe(true);
      expect(c.durationMs).toBeGreaterThanOrEqual(0);
    }
  });

  test('respects custom thresholds passed via opts', async () => {
    const result = await getSystemHealth({
      probes: {
        ...allHealthyProbes,
        database: {
          ping: async () => undefined,
          poolStats: async () => ({ used: 50, max: 100 }),
        },
      },
      thresholds: { dbConnectionWarnPct: 40 },
    });
    expect(result.components.database.status).toBe('degraded');
  });
});

describe('legacyPublicEnvelope', () => {
  async function makeHealth(
    overrides: Partial<{
      db: ComponentHealth['status'];
      redis: ComponentHealth['status'];
      minio: ComponentHealth['status'];
      queues: ComponentHealth['status'];
    }> = {}
  ): Promise<ReturnType<typeof getSystemHealth> extends Promise<infer T> ? T : never> {
    return getSystemHealth({
      probes: {
        database: {
          ping: async () => {
            if (overrides.db === 'unhealthy') throw new Error('SECRET_DB_ERROR_should_not_leak');
          },
          poolStats: async () => ({
            used: overrides.db === 'degraded' ? 95 : 1,
            max: 100,
          }),
        },
        redis: {
          status: () => (overrides.redis === 'unhealthy' ? 'disconnected' : 'connected'),
        },
        minio: {
          check: async () => ({
            status: overrides.minio === 'unhealthy' ? 'disconnected' : 'connected',
            bucket: 'hashhive-test',
          }),
        },
        queues: {
          health: async () => ({
            status: 'connected',
            queues:
              overrides.queues === 'degraded'
                ? { q: { waiting: 999_999, active: 0, failed: 0 } }
                : { q: { waiting: 1, active: 0, failed: 0 } },
          }),
        },
      },
    });
  }

  test('healthy maps to status="ok", aggregateStatus="healthy", and all services="connected"', async () => {
    const env = legacyPublicEnvelope(await makeHealth({}));
    expect(env.status).toBe('ok');
    expect(env.aggregateStatus).toBe('healthy');
    expect(env.services.database.status).toBe('connected');
    expect(env.services.redis.status).toBe('connected');
    expect(env.services.minio.status).toBe('connected');
    expect(env.services.minio.bucket).toBe('hashhive-test');
    expect(env.services.queues.status).toBe('connected');
    expect(env.version).toBe('1.1.0');
  });

  test('degraded maps to status="degraded" body, aggregateStatus="degraded", services stay "connected"', async () => {
    const env = legacyPublicEnvelope(await makeHealth({ queues: 'degraded' }));
    expect(env.status).toBe('degraded');
    expect(env.aggregateStatus).toBe('degraded');
    expect(env.services.redis.status).toBe('connected');
    expect(env.services.database.status).toBe('connected');
    // Queue still connected (degraded != disconnected)
    expect(env.services.queues.status).toBe('connected');
  });

  test('unhealthy component maps to body status="degraded" but aggregateStatus="unhealthy" (api-contract-4)', async () => {
    // The body's coarse `status` collapses to 'degraded' for backward compat,
    // but the new `aggregateStatus` field carries the full three-tier value
    // so JSON-only monitors can distinguish degraded from unhealthy.
    const env = legacyPublicEnvelope(await makeHealth({ minio: 'unhealthy' }));
    expect(env.status).toBe('degraded');
    expect(env.aggregateStatus).toBe('unhealthy');
    expect(env.services.minio.status).toBe('disconnected');
  });

  test('exposes services.queues.queues map with per-queue stats (api-contract-3)', async () => {
    const env = legacyPublicEnvelope(await makeHealth({}));
    expect(env.services.queues.queues).toBeDefined();
    expect(env.services.queues.queues['q']).toEqual({ waiting: 1, active: 0, failed: 0 });
  });

  test('omits per-component detail to avoid leaking infra info', async () => {
    const env = legacyPublicEnvelope(await makeHealth({}));
    // The legacy envelope intentionally does not have a `components` key.
    expect((env as Record<string, unknown>)['components']).toBeUndefined();
    // And no `detail` on per-service entries.
    for (const svc of Object.values(env.services)) {
      expect((svc as Record<string, unknown>)['detail']).toBeUndefined();
    }
  });

  test('strips per-component message so probe error text never reaches anonymous callers (security)', async () => {
    // Issue #109 security review: verify a probe error message containing a
    // sentinel string never appears in the legacy envelope.
    const env = legacyPublicEnvelope(await makeHealth({ db: 'unhealthy' }));
    const serialized = JSON.stringify(env);
    expect(serialized).not.toContain('SECRET_DB_ERROR_should_not_leak');
    // Per-service entries must not carry a 'message' field.
    for (const svc of Object.values(env.services)) {
      expect((svc as Record<string, unknown>)['message']).toBeUndefined();
    }
  });

  test('strips per-component connection counts so DB pool details never reach anonymous callers (security)', async () => {
    // The internal SystemHealth.detail.connectionsUsed/Max would leak infra
    // capacity — verify it is gone from the envelope.
    const env = legacyPublicEnvelope(await makeHealth({ db: 'degraded' }));
    const serialized = JSON.stringify(env);
    expect(serialized).not.toContain('connectionsUsed');
    expect(serialized).not.toContain('connectionsMax');
    expect(serialized).not.toContain('connectionsPct');
  });
});
