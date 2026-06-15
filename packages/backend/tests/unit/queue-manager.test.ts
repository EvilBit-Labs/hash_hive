import { describe, expect, test } from 'bun:test'

import { QUEUE_NAMES, TASK_PRIORITY_QUEUES } from '../../src/config/queue.js'
import { getQueueManager, setQueueManager } from '../../src/queue/context.js'
import { QueueManager } from '../../src/queue/manager.js'

// This file must run in isolation (own bun:test process) to avoid module
// cache poisoning from sibling test files that mock
// '../../src/queue/context.js' and '../../src/queue/manager.js' at module
// scope (notably `attack-templates.test.ts` today; the same pattern is
// used throughout the dashboard-route test suite). On Linux test runners
// those mocks have already been installed in the shared bun:test process
// by the time this file runs, so identity comparisons (toBe) and
// class-shape assertions fail.
//
// The package.json test script runs this file first with
// QUEUE_MANAGER_TEST_ISOLATED=1, then runs the full suite where this file is
// skipped via the guard below.
const isIsolated = process.env['QUEUE_MANAGER_TEST_ISOLATED'] === '1'
const describeIfIsolated = isIsolated ? describe : describe.skip

describeIfIsolated('Queue config', () => {
  test('QUEUE_NAMES has priority task queue names', () => {
    expect(QUEUE_NAMES.TASKS_HIGH).toBe('tasks-high')
    expect(QUEUE_NAMES.TASKS_NORMAL).toBe('tasks-normal')
    expect(QUEUE_NAMES.TASKS_LOW).toBe('tasks-low')
  })

  test('QUEUE_NAMES has job queue names', () => {
    expect(QUEUE_NAMES.HASH_LIST_PARSING).toBe('jobs-hash-list-parsing')
    expect(QUEUE_NAMES.HEARTBEAT_MONITOR).toBe('jobs-heartbeat-monitor')
  })

  test('TASK_PRIORITY_QUEUES contains the three priority queues', () => {
    expect(TASK_PRIORITY_QUEUES).toEqual(['tasks-high', 'tasks-normal', 'tasks-low'])
  })
})

describeIfIsolated('Queue context', () => {
  test('getQueueManager returns null before setQueueManager', () => {
    // Context starts null (or may have been set by other tests),
    // so we test the set/get cycle
    const qm = new QueueManager()
    setQueueManager(qm)
    expect(getQueueManager()).toBe(qm)
  })

  test('setQueueManager replaces previous instance', () => {
    const qm1 = new QueueManager()
    const qm2 = new QueueManager()
    setQueueManager(qm1)
    expect(getQueueManager()).toBe(qm1)
    setQueueManager(qm2)
    expect(getQueueManager()).toBe(qm2)
  })
})

describeIfIsolated('QueueManager', () => {
  test('can be instantiated without errors', () => {
    const qm = new QueueManager()
    expect(qm).toBeDefined()
    expect(typeof qm.init).toBe('function')
    expect(typeof qm.enqueue).toBe('function')
    expect(typeof qm.getHealth).toBe('function')
    expect(typeof qm.shutdown).toBe('function')
  })

  test('getHealth returns disconnected when not initialized', async () => {
    const qm = new QueueManager()
    const health = await qm.getHealth()
    expect(health.status).toBe('disconnected')
    expect(health.queues).toEqual({})
  })

  test('enqueue returns false when not initialized', async () => {
    const qm = new QueueManager()
    const result = await qm.enqueue(QUEUE_NAMES.HASH_LIST_PARSING, {
      hashListId: 1,
      projectId: 1,
    })
    expect(result).toBe(false)
  })

  test('enqueue returns false for priority task queue when not initialized', async () => {
    const qm = new QueueManager()
    const result = await qm.enqueue(QUEUE_NAMES.TASKS_NORMAL, {
      campaignId: 1,
      projectId: 1,
      attackIds: [1],
      priority: 5,
    })
    expect(result).toBe(false)
  })

  test('enqueue evicts the deduped jobId on terminal (#221: else preemption fires once then never)', async () => {
    const qm = new QueueManager()
    const addCalls: Array<Record<string, unknown>> = []
    const fakeQueue = {
      add: (_name: string, _data: unknown, opts: Record<string, unknown>) => {
        addCalls.push(opts)
        return Promise.resolve({})
      },
    }
    // Inject a fake queue so enqueue reaches the .add() path without Redis.
    ;(qm as unknown as { queues: Map<string, unknown> }).queues.set(
      QUEUE_NAMES.PREEMPTION,
      fakeQueue
    )

    // With jobId: the dedup key MUST be evicted on terminal — BullMQ retains
    // terminal jobs and keeps the jobId alive, so without this preemption
    // would fire once per project then silently never again.
    await qm.enqueue(QUEUE_NAMES.PREEMPTION, { projectId: 7 }, { jobId: 'preempt:7' })
    expect(addCalls[0]?.['jobId']).toBe('preempt:7')
    expect(addCalls[0]?.['removeOnComplete']).toBe(true)
    expect(addCalls[0]?.['removeOnFail']).toBe(true)

    // Without jobId: no eviction options (other queues keep their job history).
    addCalls.length = 0
    ;(qm as unknown as { queues: Map<string, unknown> }).queues.set(
      QUEUE_NAMES.TASK_GENERATION,
      fakeQueue
    )
    await qm.enqueue(QUEUE_NAMES.TASK_GENERATION, {
      campaignId: 1,
      projectId: 7,
      attackIds: [1],
      priority: 5,
    })
    expect(addCalls[0]?.['jobId']).toBeUndefined()
    expect(addCalls[0]?.['removeOnComplete']).toBeUndefined()
    expect(addCalls[0]?.['removeOnFail']).toBeUndefined()
  })
})
