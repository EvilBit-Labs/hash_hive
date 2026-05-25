import type Redis from 'ioredis'

import { beforeEach, describe, expect, mock, test } from 'bun:test'

import { QUEUE_NAMES } from '../../../src/config/queue.js'
import { computeJobDurationMs } from '../../../src/queue/workers/metrics.js'

const IS_ISOLATED = process.env['WORKER_METRICS_TEST_ISOLATED'] === '1'
const describeIfIsolated = IS_ISOLATED ? describe : describe.skip

const infoMock = mock()
const errorMock = mock()
const warnMock = mock()

// Typed per-event handler map — argument shapes match BullMQ's actual
// listener signatures so call sites in tests are checked against the real
// contract instead of being erased to (...unknown[]).
type CompletedHandler = (job: unknown, result: unknown) => unknown
type FailedHandler = (job: unknown, err: Error) => unknown
type ErrorHandler = (err: Error) => unknown
type AnyHandler = CompletedHandler | FailedHandler | ErrorHandler
type EventName = 'completed' | 'failed' | 'error'
const capturedHandlers: Partial<Record<EventName, AnyHandler[]>> = {}

// Mutable db.update handler so individual tests can drive resolve vs reject.
let dbUpdateImpl: () => Promise<void> = () => Promise.resolve()

// Gated: process-global mock.module('bullmq', ...) would leak this Worker
// stub into sibling worker tests whose capturedProcessor is per-file.
if (IS_ISOLATED) {
  mock.module('../../../src/config/logger.js', () => ({
    logger: { info: infoMock, error: errorMock, warn: warnMock, debug: mock() },
  }))

  mock.module('../../../src/db/index.js', () => ({
    db: {
      update: () => ({ set: () => ({ where: () => dbUpdateImpl() }) }),
      select: () => ({ from: () => ({ where: () => Promise.resolve([]) }) }),
    },
  }))

  mock.module('../../../src/services/tasks.js', () => ({
    generateTasksForAttack: mock(() => Promise.resolve({ tasks: [], count: 2 })),
    reassignStaleTasks: mock(() => Promise.resolve({ reassigned: 0 })),
  }))

  // Inline events mock — the file-level `createEventsMockFactory` helper
  // can't be used here because this file is gated behind `IS_ISOLATED`
  // and the helper is imported at module top, before the gate runs.
  mock.module('../../../src/services/events.js', () => ({
    emit: mock(),
    emitAgentStatus: mock(),
    emitAgentError: mock(),
    emitCampaignStatus: mock(),
    emitTaskUpdate: mock(),
    emitCrackResult: mock(),
    emitResourceUpdate: mock(),
    broadcastSystemHealth: mock(),
    registerClient: mock(),
    unregisterClient: mock(),
    getClientCount: mock(() => 0),
    __resetEventsForTesting: mock(),
  }))

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
  }))

  mock.module('bullmq', () => ({
    Worker: class MockWorker {
      on(event: EventName, handler: AnyHandler) {
        // Append not overwrite — workers attach multiple 'failed' listeners.
        ;(capturedHandlers[event] ??= []).push(handler)
        return this
      }
      close() {
        return Promise.resolve()
      }
    },
    Queue: class MockQueue {
      add() {
        return Promise.resolve()
      }
      close() {
        return Promise.resolve()
      }
    },
  }))
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
  }
}

function lastCallPayload(m: typeof infoMock): Record<string, unknown> {
  const call = m.mock.calls.at(-1)
  if (!call) throw new Error('logger mock has no recorded calls')
  return call[0] as Record<string, unknown>
}

function lastCallMessage(m: typeof infoMock): unknown {
  return m.mock.calls.at(-1)?.[1]
}

function fireHandlers(event: EventName, ...args: unknown[]): Promise<void> {
  const handlers = capturedHandlers[event] ?? []
  return handlers.reduce<Promise<void>>(
    (acc, handler) =>
      acc.then(() =>
        Promise.resolve((handler as (...a: unknown[]) => unknown)(...args)).then(() => undefined)
      ),
    Promise.resolve()
  )
}

function resetCapture(): void {
  infoMock.mockReset()
  errorMock.mockReset()
  for (const k of Object.keys(capturedHandlers)) delete capturedHandlers[k]
  dbUpdateImpl = () => Promise.resolve()
}

describeIfIsolated('computeJobDurationMs', () => {
  test('returns finishedOn - processedOn for a normal job', () => {
    expect(computeJobDurationMs({ processedOn: 100, finishedOn: 350 })).toBe(250)
  })

  test('returns 0 when job is undefined or null', () => {
    expect(computeJobDurationMs(undefined)).toBe(0)
    expect(computeJobDurationMs(null)).toBe(0)
  })

  test('returns 0 when processedOn is missing', () => {
    expect(computeJobDurationMs({ finishedOn: 500 })).toBe(0)
  })

  test('returns 0 when finishedOn is missing', () => {
    expect(computeJobDurationMs({ processedOn: 100 })).toBe(0)
  })

  test('returns 0 when both timing fields are missing', () => {
    expect(computeJobDurationMs({})).toBe(0)
  })

  test('clamps to 0 if finishedOn precedes processedOn', () => {
    expect(computeJobDurationMs({ processedOn: 500, finishedOn: 100 })).toBe(0)
  })
})

describeIfIsolated('task-generator worker metrics', () => {
  beforeEach(resetCapture)

  test("registers a 'completed' handler that logs durationMs and result", async () => {
    const { createTaskGeneratorWorker } =
      await import('../../../src/queue/workers/task-generator.js')
    createTaskGeneratorWorker({} as Redis, QUEUE_NAMES.TASKS_NORMAL)

    await fireHandlers('completed', fakeJobWithTiming(), { campaignId: 9, totalTasks: 6 })

    const payload = lastCallPayload(infoMock)
    expect(lastCallMessage(infoMock)).toBe('Job completed')
    expect(payload['queue']).toBe(QUEUE_NAMES.TASKS_NORMAL)
    expect(payload['durationMs']).toBe(250)
    expect(payload['campaignId']).toBe(9)
    expect(payload['result']).toEqual({ campaignId: 9, totalTasks: 6 })
  })

  test("'failed' handler emits durationMs alongside the error", async () => {
    const { createTaskGeneratorWorker } =
      await import('../../../src/queue/workers/task-generator.js')
    createTaskGeneratorWorker({} as Redis, QUEUE_NAMES.TASKS_HIGH)

    await fireHandlers('failed', fakeJobWithTiming({ id: 'job-fail' }), new Error('boom'))

    const payload = lastCallPayload(errorMock)
    expect(payload['durationMs']).toBe(250)
    expect(payload['queue']).toBe(QUEUE_NAMES.TASKS_HIGH)
  })
})

describeIfIsolated('heartbeat-monitor worker metrics', () => {
  beforeEach(resetCapture)

  test("'completed' logs queue and result", async () => {
    const { createHeartbeatMonitorWorker } =
      await import('../../../src/queue/workers/heartbeat-monitor.js')
    createHeartbeatMonitorWorker({} as Redis)

    await fireHandlers('completed', fakeJobWithTiming(), { reassigned: 3, offlineAgents: 1 })

    const payload = lastCallPayload(infoMock)
    expect(lastCallMessage(infoMock)).toBe('Job completed')
    expect(payload['queue']).toBe(QUEUE_NAMES.HEARTBEAT_MONITOR)
    expect(payload['durationMs']).toBe(250)
    expect(payload['result']).toEqual({ reassigned: 3, offlineAgents: 1 })
  })
})

describeIfIsolated('hash-list-parser worker metrics', () => {
  beforeEach(resetCapture)

  test("'completed' logs hashListId, durationMs, and result", async () => {
    const { createHashListParserWorker } =
      await import('../../../src/queue/workers/hash-list-parser.js')
    createHashListParserWorker({} as Redis)

    await fireHandlers('completed', fakeJobWithTiming(), { inserted: 1234, skippedLines: 2 })

    const payload = lastCallPayload(infoMock)
    expect(lastCallMessage(infoMock)).toBe('Job completed')
    expect(payload['queue']).toBe(QUEUE_NAMES.HASH_LIST_PARSING)
    expect(payload['hashListId']).toBe(42)
    expect(payload['durationMs']).toBe(250)
    expect(payload['result']).toEqual({ inserted: 1234, skippedLines: 2 })
  })

  test("'failed' logs durationMs=0 when timing fields are absent", async () => {
    const { createHashListParserWorker } =
      await import('../../../src/queue/workers/hash-list-parser.js')
    createHashListParserWorker({} as Redis)

    await fireHandlers(
      'failed',
      { id: 'no-timing', data: { hashListId: 99 }, attemptsMade: 1, opts: { attempts: 3 } },
      new Error('parse failure')
    )

    expect(lastCallPayload(errorMock)['durationMs']).toBe(0)
  })

  test('cleanup listener does not run on attemptsMade < attempts (boundary 2 of 3)', async () => {
    let updateCalled = false
    dbUpdateImpl = () => {
      updateCalled = true
      return Promise.resolve()
    }
    const { createHashListParserWorker } =
      await import('../../../src/queue/workers/hash-list-parser.js')
    createHashListParserWorker({} as Redis)

    await fireHandlers(
      'failed',
      fakeJobWithTiming({ attemptsMade: 2, opts: { attempts: 3 } }),
      new Error('retry-eligible failure')
    )

    expect(updateCalled).toBe(false)
  })

  test('cleanup listener uses DEFAULT_JOB_ATTEMPTS when attempts is unset', async () => {
    let updateCalled = false
    dbUpdateImpl = () => {
      updateCalled = true
      return Promise.resolve()
    }
    const { createHashListParserWorker } =
      await import('../../../src/queue/workers/hash-list-parser.js')
    createHashListParserWorker({} as Redis)

    await fireHandlers(
      'failed',
      fakeJobWithTiming({ attemptsMade: 3, opts: {} }),
      new Error('final attempt failure (default attempts)')
    )

    expect(updateCalled).toBe(true)
  })

  test('cleanup listener skips non-numeric hashListId', async () => {
    let updateCalled = false
    dbUpdateImpl = () => {
      updateCalled = true
      return Promise.resolve()
    }
    const { createHashListParserWorker } =
      await import('../../../src/queue/workers/hash-list-parser.js')
    createHashListParserWorker({} as Redis)

    await fireHandlers(
      'failed',
      {
        id: 'bad-data',
        processedOn: 1_000,
        finishedOn: 1_100,
        attemptsMade: 3,
        opts: { attempts: 3 },
        data: { hashListId: 'oops' },
      },
      new Error('bad data')
    )

    expect(updateCalled).toBe(false)
  })

  test('cleanup db.update failure is caught and logged (not re-thrown)', async () => {
    dbUpdateImpl = () => Promise.reject(new Error('db connection refused'))
    const { createHashListParserWorker } =
      await import('../../../src/queue/workers/hash-list-parser.js')
    createHashListParserWorker({} as Redis)

    await expect(
      fireHandlers(
        'failed',
        fakeJobWithTiming({ attemptsMade: 3, opts: { attempts: 3 } }),
        new Error('final attempt failure')
      )
    ).resolves.toBeUndefined()

    const cleanupLog = errorMock.mock.calls.find((call) =>
      String(call[1] ?? '').includes('cleanup db.update failed')
    )
    expect(cleanupLog).toBeDefined()
  })

  test("'failed' on the final attempt fires both the metrics and cleanup listeners", async () => {
    let updateCalled = false
    dbUpdateImpl = () => {
      updateCalled = true
      return Promise.resolve()
    }
    const { createHashListParserWorker } =
      await import('../../../src/queue/workers/hash-list-parser.js')
    createHashListParserWorker({} as Redis)

    await fireHandlers(
      'failed',
      fakeJobWithTiming({ attemptsMade: 3, opts: { attempts: 3 } }),
      new Error('final attempt failure')
    )

    expect(updateCalled).toBe(true)
    const payload = lastCallPayload(errorMock)
    expect(payload['queue']).toBe(QUEUE_NAMES.HASH_LIST_PARSING)
    expect(payload['durationMs']).toBe(250)
  })
})

describeIfIsolated('health-monitor worker metrics', () => {
  beforeEach(resetCapture)

  test("'completed' logs durationMs and the tick result", async () => {
    const { createHealthMonitorWorker } =
      await import('../../../src/queue/workers/health-monitor.js')
    createHealthMonitorWorker({
      get: () => Promise.resolve(null),
      set: () => Promise.resolve('OK'),
    } as unknown as Redis)

    await fireHandlers('completed', fakeJobWithTiming(), {
      transitioned: [],
      initialized: ['queues'],
      unchanged: ['database'],
    })

    expect(lastCallMessage(infoMock)).toBe('Job completed')
    const payload = lastCallPayload(infoMock)
    expect(payload['queue']).toBe(QUEUE_NAMES.HEALTH_MONITOR)
    expect(payload['durationMs']).toBe(250)
  })
})

describeIfIsolated('attachWorkerMetrics field-collision and error channel', () => {
  beforeEach(resetCapture)

  test('canonical jobId/queue/durationMs/result always win over extractContext keys', async () => {
    // Direct test against attachWorkerMetrics with a hostile extractor.
    const { attachWorkerMetrics } = await import('../../../src/queue/workers/metrics.js')
    const { Worker } = await import('bullmq')
    const mockWorker = new (Worker as unknown as new (n: string, p: unknown) => unknown)(
      'test-collision',
      async () => undefined
    )
    attachWorkerMetrics(mockWorker as Parameters<typeof attachWorkerMetrics>[0], {
      queueName: 'real-queue',
      failureMessage: 'real-failure',
      extractContext: () => ({
        jobId: 'HIJACKED',
        queue: 'HIJACKED',
        durationMs: 99_999,
        result: 'HIJACKED',
      }),
    })

    await fireHandlers('completed', fakeJobWithTiming({ id: 'canonical-job-id' }), {
      real: true,
    })

    const payload = lastCallPayload(infoMock)
    expect(payload['jobId']).toBe('canonical-job-id')
    expect(payload['queue']).toBe('real-queue')
    expect(payload['durationMs']).toBe(250)
    expect(payload['result']).toEqual({ real: true })
  })

  test('extractContext that throws does not crash the listener', async () => {
    const { attachWorkerMetrics } = await import('../../../src/queue/workers/metrics.js')
    const { Worker } = await import('bullmq')
    const mockWorker = new (Worker as unknown as new (n: string, p: unknown) => unknown)(
      'test-throw',
      async () => undefined
    )
    attachWorkerMetrics(mockWorker as Parameters<typeof attachWorkerMetrics>[0], {
      queueName: 'thrown-queue',
      failureMessage: 'job failed',
      extractContext: () => {
        throw new Error('extractContext exploded')
      },
    })

    await expect(
      fireHandlers('completed', fakeJobWithTiming(), { ok: true })
    ).resolves.toBeUndefined()

    // The completed log still landed (with empty context), and the throw
    // was logged separately to error.
    const completedLog = infoMock.mock.calls.find((call) => call[1] === 'Job completed')
    expect(completedLog).toBeDefined()
    const throwLog = errorMock.mock.calls.find((call) =>
      String(call[1] ?? '').includes('extractContext threw')
    )
    expect(throwLog).toBeDefined()
  })

  test("registers an 'error' listener that logs non-job worker errors", async () => {
    const { createHeartbeatMonitorWorker } =
      await import('../../../src/queue/workers/heartbeat-monitor.js')
    createHeartbeatMonitorWorker({} as Redis)

    expect(capturedHandlers['error']?.length ?? 0).toBeGreaterThanOrEqual(1)

    await fireHandlers('error', new Error('redis disconnected'))

    const errorLog = errorMock.mock.calls.find((call) =>
      String(call[1] ?? '').includes('Worker error')
    )
    expect(errorLog).toBeDefined()
    const payload = errorLog?.[0] as Record<string, unknown>
    expect(payload['queue']).toBe(QUEUE_NAMES.HEARTBEAT_MONITOR)
  })
})

describeIfIsolated('worker-factory coverage parity', () => {
  beforeEach(resetCapture)

  test('every worker factory registers completed, failed, and error listeners', async () => {
    const { createTaskGeneratorWorker } =
      await import('../../../src/queue/workers/task-generator.js')
    const { createHeartbeatMonitorWorker } =
      await import('../../../src/queue/workers/heartbeat-monitor.js')
    const { createHashListParserWorker } =
      await import('../../../src/queue/workers/hash-list-parser.js')
    const { createHealthMonitorWorker } =
      await import('../../../src/queue/workers/health-monitor.js')

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
      for (const k of Object.keys(capturedHandlers)) delete capturedHandlers[k]
      factory()
      expect(capturedHandlers['completed']?.length ?? 0).toBeGreaterThanOrEqual(1)
      expect(capturedHandlers['failed']?.length ?? 0).toBeGreaterThanOrEqual(1)
      expect(capturedHandlers['error']?.length ?? 0).toBeGreaterThanOrEqual(1)
    }
  })
})
