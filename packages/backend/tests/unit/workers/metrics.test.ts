/**
 * Unit tests for worker metrics — every worker factory must register a
 * `completed` event handler that logs `durationMs` and the job result,
 * and the `failed` handler must include `durationMs` alongside the error.
 *
 * Implements AC #4 ("Workers log job processing metrics — duration,
 * success/failure") from the BullMQ Queue Architecture spec. Mocks
 * BullMQ Worker so the test captures `.on()` listeners directly without
 * needing a real Redis or BullMQ queue runtime.
 */

import { beforeEach, describe, expect, mock, test } from 'bun:test';
import type Redis from 'ioredis';
import { QUEUE_NAMES } from '../../../src/config/queue.js';
import { computeJobDurationMs } from '../../../src/queue/workers/metrics.js';

// bun:test shares its module cache process-wide, so the `mock.module('bullmq',
// ...)` call below would otherwise leak its Worker stub into sibling worker
// test files (task-generator, heartbeat-monitor) whose own MockWorker classes
// capture their per-file `capturedProcessor` symbol. The runtime keeps
// whichever mock was registered last, which produces `capturedProcessor is
// null` failures depending on alphabetical file order. Run this file in an
// isolated bun:test process via the WORKER_METRICS_TEST_ISOLATED env gate,
// mirroring the same convention used by queue-manager.test.ts and
// agent-heartbeat.test.ts. The package.json test script runs the isolated
// phase before the shared phase and skips the file in the shared phase.
const IS_ISOLATED = process.env['WORKER_METRICS_TEST_ISOLATED'] === '1';
const describeIfIsolated = IS_ISOLATED ? describe : describe.skip;

const infoMock = mock();
const errorMock = mock();
const warnMock = mock();

// Capture the `.on()` handlers registered by the worker factories.
type Handler = (...args: unknown[]) => unknown;
const capturedHandlers: Record<string, Handler[]> = {};

// Gate all mock.module installations on the isolation env var. mock.module is
// process-global in bun:test — installing these unconditionally would override
// the per-file mocks in sibling worker tests (hash-list-parser, heartbeat-monitor,
// task-generator) even when this file's describe blocks are skipped, because
// top-level mock.module calls execute at file load time regardless of describe
// state. Gating ensures this file is a complete no-op in the shared test phase.
if (IS_ISOLATED) {
  mock.module('../../../src/config/logger.js', () => ({
    logger: {
      info: infoMock,
      error: errorMock,
      warn: warnMock,
      debug: mock(),
    },
  }));

  mock.module('../../../src/db/index.js', () => ({
    db: {
      update: () => ({ set: () => ({ where: () => Promise.resolve() }) }),
      select: () => ({ from: () => ({ where: () => Promise.resolve([]) }) }),
    },
  }));

  mock.module('../../../src/services/tasks.js', () => ({
    generateTasksForAttack: mock(() => Promise.resolve({ tasks: [], count: 2 })),
    reassignStaleTasks: mock(() => Promise.resolve({ reassigned: 0 })),
  }));

  mock.module('../../../src/services/events.js', () => ({
    emitAgentStatus: mock(),
    broadcastSystemHealth: mock(),
  }));

  mock.module('../../../src/services/health.js', () => ({
    getSystemHealth: mock(() =>
      Promise.resolve({
        components: {
          database: { status: 'healthy' },
          redis: { status: 'healthy' },
          minio: { status: 'healthy' },
          queues: { status: 'healthy' },
        },
      })
    ),
  }));

  mock.module('bullmq', () => ({
    Worker: class MockWorker {
      constructor(_name: string, _processor: (job: unknown) => Promise<unknown>) {}
      on(event: string, handler: Handler) {
        // Append rather than overwrite — workers attach multiple `failed`
        // listeners (e.g. hash-list-parser has one for metrics and one for
        // DB cleanup). Capturing only the last listener masks regressions
        // where the metrics listener gets unregistered.
        (capturedHandlers[event] ??= []).push(handler);
        return this;
      }
      close() {
        return Promise.resolve();
      }
    },
    Queue: class MockQueue {
      add() {
        return Promise.resolve();
      }
      close() {
        return Promise.resolve();
      }
    },
  }));
}

function fakeJobWithTiming(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'job-1',
    processedOn: 1_000,
    finishedOn: 1_250,
    attemptsMade: 1,
    opts: { attempts: 3 },
    data: { hashListId: 42, projectId: 7, campaignId: 9, triggeredAt: 'now' },
    ...overrides,
  };
}

/**
 * Pull the most recent call payload off a captured logger mock and assert it
 * is a structured object. Folds the otherwise-repeated
 * `(payload as Record<string, unknown>)['key']` boilerplate that surfaces in
 * every metrics assertion.
 */
function lastCallPayload(m: typeof infoMock): Record<string, unknown> {
  const call = m.mock.calls.at(-1);
  if (!call) throw new Error('logger mock has no recorded calls');
  return call[0] as Record<string, unknown>;
}

function lastCallMessage(m: typeof infoMock): unknown {
  return m.mock.calls.at(-1)?.[1];
}

/**
 * Invoke every captured listener for `event` (preserving registration order).
 * Mirrors BullMQ's behaviour of fanning a single event out to N listeners.
 */
function fireHandlers(event: string, ...args: unknown[]): Promise<void> {
  const handlers = capturedHandlers[event] ?? [];
  return handlers.reduce<Promise<void>>(
    (acc, handler) => acc.then(() => Promise.resolve(handler(...args)).then(() => undefined)),
    Promise.resolve()
  );
}

describeIfIsolated('computeJobDurationMs', () => {
  test('returns finishedOn - processedOn for a normal job', () => {
    expect(computeJobDurationMs({ processedOn: 100, finishedOn: 350 })).toBe(250);
  });

  test('returns 0 when job is undefined or null', () => {
    expect(computeJobDurationMs(undefined)).toBe(0);
    expect(computeJobDurationMs(null)).toBe(0);
  });

  test('returns 0 when processedOn is missing', () => {
    expect(computeJobDurationMs({ finishedOn: 500 })).toBe(0);
  });

  test('returns 0 when finishedOn is missing', () => {
    // Defensive against a `failed` event firing before BullMQ stamps
    // `finishedOn` — without the both-required guard, this would return
    // wall-clock-since-pickup, conflating real processing time with
    // elapsed time since BullMQ scheduled the job.
    expect(computeJobDurationMs({ processedOn: 100 })).toBe(0);
  });

  test('returns 0 when both timing fields are missing', () => {
    expect(computeJobDurationMs({})).toBe(0);
  });

  test('clamps to 0 if finishedOn precedes processedOn', () => {
    expect(computeJobDurationMs({ processedOn: 500, finishedOn: 100 })).toBe(0);
  });
});

describeIfIsolated('task-generator worker metrics', () => {
  beforeEach(() => {
    infoMock.mockReset();
    errorMock.mockReset();
    for (const k of Object.keys(capturedHandlers)) delete capturedHandlers[k];
  });

  test("registers a 'completed' handler that logs durationMs and result", async () => {
    const { createTaskGeneratorWorker } = await import(
      '../../../src/queue/workers/task-generator.js'
    );
    createTaskGeneratorWorker({} as Redis, QUEUE_NAMES.TASKS_NORMAL);

    await fireHandlers('completed', fakeJobWithTiming(), { campaignId: 9, totalTasks: 6 });

    expect(infoMock).toHaveBeenCalled();
    const payload = lastCallPayload(infoMock);
    expect(lastCallMessage(infoMock)).toBe('Job completed');
    expect(payload['queue']).toBe(QUEUE_NAMES.TASKS_NORMAL);
    expect(payload['durationMs']).toBe(250);
    expect(payload['campaignId']).toBe(9);
    expect(payload['result']).toEqual({ campaignId: 9, totalTasks: 6 });
  });

  test("'failed' handler emits durationMs alongside the error", async () => {
    const { createTaskGeneratorWorker } = await import(
      '../../../src/queue/workers/task-generator.js'
    );
    createTaskGeneratorWorker({} as Redis, QUEUE_NAMES.TASKS_HIGH);

    await fireHandlers('failed', fakeJobWithTiming({ id: 'job-fail' }), new Error('boom'));

    const payload = lastCallPayload(errorMock);
    expect(payload['durationMs']).toBe(250);
    expect(payload['queue']).toBe(QUEUE_NAMES.TASKS_HIGH);
  });
});

describeIfIsolated('heartbeat-monitor worker metrics', () => {
  beforeEach(() => {
    infoMock.mockReset();
    errorMock.mockReset();
    for (const k of Object.keys(capturedHandlers)) delete capturedHandlers[k];
  });

  test("'completed' logs queue and result", async () => {
    const { createHeartbeatMonitorWorker } = await import(
      '../../../src/queue/workers/heartbeat-monitor.js'
    );
    createHeartbeatMonitorWorker({} as Redis);

    await fireHandlers('completed', fakeJobWithTiming(), { reassigned: 3, offlineAgents: 1 });

    const payload = lastCallPayload(infoMock);
    expect(lastCallMessage(infoMock)).toBe('Job completed');
    expect(payload['queue']).toBe(QUEUE_NAMES.HEARTBEAT_MONITOR);
    expect(payload['durationMs']).toBe(250);
    expect(payload['result']).toEqual({ reassigned: 3, offlineAgents: 1 });
  });
});

describeIfIsolated('hash-list-parser worker metrics', () => {
  beforeEach(() => {
    infoMock.mockReset();
    errorMock.mockReset();
    for (const k of Object.keys(capturedHandlers)) delete capturedHandlers[k];
  });

  test("'completed' logs hashListId, durationMs, and result", async () => {
    const { createHashListParserWorker } = await import(
      '../../../src/queue/workers/hash-list-parser.js'
    );
    createHashListParserWorker({} as Redis);

    await fireHandlers('completed', fakeJobWithTiming(), { inserted: 1234, skippedLines: 2 });

    const payload = lastCallPayload(infoMock);
    expect(lastCallMessage(infoMock)).toBe('Job completed');
    expect(payload['queue']).toBe(QUEUE_NAMES.HASH_LIST_PARSING);
    expect(payload['hashListId']).toBe(42);
    expect(payload['durationMs']).toBe(250);
    expect(payload['result']).toEqual({ inserted: 1234, skippedLines: 2 });
  });

  test("'failed' logs durationMs even when timing fields are absent", async () => {
    const { createHashListParserWorker } = await import(
      '../../../src/queue/workers/hash-list-parser.js'
    );
    createHashListParserWorker({} as Redis);

    await fireHandlers(
      'failed',
      { id: 'no-timing', data: { hashListId: 99 }, attemptsMade: 1, opts: { attempts: 3 } },
      new Error('parse failure')
    );

    const payload = lastCallPayload(errorMock);
    expect(payload['durationMs']).toBe(0);
  });

  test("'failed' on the final attempt triggers cleanup db.update without throwing", async () => {
    // Exercises the second 'failed' listener — the one that marks the hash
    // list as error on the last attempt. The metrics-logging listener is
    // also fired (BullMQ fans events to all listeners), so this proves both
    // are wired and survive together.
    const { createHashListParserWorker } = await import(
      '../../../src/queue/workers/hash-list-parser.js'
    );
    createHashListParserWorker({} as Redis);

    await expect(
      fireHandlers(
        'failed',
        fakeJobWithTiming({ attemptsMade: 3, opts: { attempts: 3 } }),
        new Error('final attempt failure')
      )
    ).resolves.toBeUndefined();

    // Metrics listener still logged
    const payload = lastCallPayload(errorMock);
    expect(payload['queue']).toBe(QUEUE_NAMES.HASH_LIST_PARSING);
    expect(payload['durationMs']).toBe(250);
  });
});

describeIfIsolated('health-monitor worker metrics', () => {
  beforeEach(() => {
    infoMock.mockReset();
    errorMock.mockReset();
    for (const k of Object.keys(capturedHandlers)) delete capturedHandlers[k];
  });

  test("'completed' logs durationMs and the tick result", async () => {
    const { createHealthMonitorWorker } = await import(
      '../../../src/queue/workers/health-monitor.js'
    );
    createHealthMonitorWorker({
      get: () => Promise.resolve(null),
      set: () => Promise.resolve('OK'),
    } as unknown as Redis);

    await fireHandlers('completed', fakeJobWithTiming(), {
      transitioned: [],
      initialized: ['queues'],
      unchanged: ['database'],
    });

    // health-monitor's processor itself emits an info log on every tick;
    // the completed-handler log line comes last and has 'Job completed'.
    expect(lastCallMessage(infoMock)).toBe('Job completed');
    const payload = lastCallPayload(infoMock);
    expect(payload['queue']).toBe(QUEUE_NAMES.HEALTH_MONITOR);
    expect(payload['durationMs']).toBe(250);
  });
});

describeIfIsolated('worker-factory coverage parity', () => {
  // Every create*Worker factory must register at least one 'completed'
  // listener — otherwise AC #4 silently regresses when a future worker is
  // added without going through attachWorkerMetrics. This is a small
  // meta-test that proves the parity rather than each per-worker case
  // having to check it individually.
  beforeEach(() => {
    infoMock.mockReset();
    errorMock.mockReset();
    for (const k of Object.keys(capturedHandlers)) delete capturedHandlers[k];
  });

  test('every worker factory registers a completed listener', async () => {
    const { createTaskGeneratorWorker } = await import(
      '../../../src/queue/workers/task-generator.js'
    );
    const { createHeartbeatMonitorWorker } = await import(
      '../../../src/queue/workers/heartbeat-monitor.js'
    );
    const { createHashListParserWorker } = await import(
      '../../../src/queue/workers/hash-list-parser.js'
    );
    const { createHealthMonitorWorker } = await import(
      '../../../src/queue/workers/health-monitor.js'
    );

    for (const factory of [
      () => createTaskGeneratorWorker({} as Redis, QUEUE_NAMES.TASKS_NORMAL),
      () => createHeartbeatMonitorWorker({} as Redis),
      () => createHashListParserWorker({} as Redis),
      () =>
        createHealthMonitorWorker({
          get: () => Promise.resolve(null),
          set: () => Promise.resolve('OK'),
        } as unknown as Redis),
    ]) {
      for (const k of Object.keys(capturedHandlers)) delete capturedHandlers[k];
      factory();
      expect(capturedHandlers['completed']?.length ?? 0).toBeGreaterThanOrEqual(1);
      expect(capturedHandlers['failed']?.length ?? 0).toBeGreaterThanOrEqual(1);
    }
  });
});
