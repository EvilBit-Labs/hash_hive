import type Redis from 'ioredis'

import { describe, expect, mock, test } from 'bun:test'

// Issue #97 U5 — preemption worker factory. Mirrors the bullmq-Worker-capture
// pattern in heartbeat-monitor.test.ts: mock the Worker class to grab the
// processor function, mock the preemption service, then invoke the captured
// processor directly.

mock.module('../../../src/config/logger.js', () => ({
  logger: { info: mock(), warn: mock(), error: mock(), debug: mock() },
}))

const mockEvaluatePreemption = mock(() =>
  Promise.resolve({ pausedTaskIds: [200], resumedTaskIds: [] })
)
mock.module('../../../src/services/tasks/preemption.js', () => ({
  evaluatePreemption: mockEvaluatePreemption,
}))

let capturedProcessor: ((job: unknown) => Promise<unknown>) | null = null
mock.module('bullmq', () => ({
  Worker: class MockWorker {
    constructor(_name: string, processor: (job: unknown) => Promise<unknown>) {
      capturedProcessor = processor
    }
    on() {
      return this
    }
    close() {
      return Promise.resolve()
    }
  },
}))

const { createPreemptionWorker } = await import('../../../src/queue/workers/preemption.js')

describe('createPreemptionWorker', () => {
  test('processor evaluates preemption for the job projectId', async () => {
    mockEvaluatePreemption.mockClear()
    createPreemptionWorker({} as unknown as Redis)

    expect(capturedProcessor).toBeDefined()
    const result = await capturedProcessor!({ id: 'preempt:7', data: { projectId: 7 } })

    expect(mockEvaluatePreemption).toHaveBeenCalledWith(7)
    expect(result).toEqual({ pausedTaskIds: [200], resumedTaskIds: [] })
  })
})
