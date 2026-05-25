import type Redis from 'ioredis'

import { describe, expect, mock, test } from 'bun:test'

// Mock the logger (workers import it)
mock.module('../../../src/config/logger.js', () => ({
  logger: {
    info: mock(),
    warn: mock(),
    error: mock(),
    debug: mock(),
  },
}))

// Mutable per-test stale-agents fixture so individual tests can drive the
// broadcast loop without re-mocking the whole module.
let staleAgentsFixture: unknown[] = []

// Build a chainable mock for db.select().from().where() patterns
function createSelectChain() {
  const chain = {
    from: mock(() => chain),
    where: mock(() => Promise.resolve(staleAgentsFixture)),
  }
  return chain
}

// Build a chainable mock for db.update().set().where()
function createUpdateChain() {
  const chain = {
    set: mock(() => chain),
    where: mock(() => Promise.resolve()),
  }
  return chain
}

const mockSelectChain = createSelectChain()
const mockUpdateChain = createUpdateChain()

// Mock the DB (services import it)
mock.module('../../../src/db/index.js', () => ({
  db: {
    select: mock(() => mockSelectChain),
    update: mock(() => mockUpdateChain),
  },
}))

// Mock the tasks service
const mockReassignStaleTasks = mock(() => Promise.resolve({ reassigned: 0 }))
mock.module('../../../src/services/tasks.js', () => ({
  reassignStaleTasks: mockReassignStaleTasks,
  generateTasksForAttack: mock(),
}))

// Mock the events service — rebindable so individual tests can simulate a
// throwing broadcast.
let emitAgentStatusImpl: (projectId: number, agentId: number, status: string) => void = () => {}
import { createEventsMockFactory } from '../../mocks/events.js'

mock.module(
  '../../../src/services/events.js',
  createEventsMockFactory({
    emitAgentStatus: (projectId: number, agentId: number, status: string) =>
      emitAgentStatusImpl(projectId, agentId, status),
  })
)

// Mock BullMQ Worker to capture the processor function
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
  Queue: class MockQueue {
    add() {
      return Promise.resolve()
    }
    close() {
      return Promise.resolve()
    }
    getWaitingCount() {
      return Promise.resolve(0)
    }
    getActiveCount() {
      return Promise.resolve(0)
    }
    getFailedCount() {
      return Promise.resolve(0)
    }
    upsertJobScheduler() {
      return Promise.resolve()
    }
  },
}))

describe('Heartbeat monitor worker', () => {
  test('processor calls reassignStaleTasks', async () => {
    const { createHeartbeatMonitorWorker } =
      await import('../../../src/queue/workers/heartbeat-monitor.js')

    const fakeConnection = {} as Redis
    createHeartbeatMonitorWorker(fakeConnection)

    expect(capturedProcessor).toBeDefined()

    const fakeJob = { id: 'test-1', data: { triggeredAt: new Date().toISOString() } }
    const result = await capturedProcessor!(fakeJob)

    expect(mockReassignStaleTasks).toHaveBeenCalled()
    expect(result).toEqual({ reassigned: 0, offlineAgents: 0 })
  })

  test('processor returns reassignment count', async () => {
    mockReassignStaleTasks.mockResolvedValueOnce({ reassigned: 3 })

    const fakeJob = { id: 'test-2', data: { triggeredAt: new Date().toISOString() } }
    const result = await capturedProcessor!(fakeJob)

    expect(result).toEqual({ reassigned: 3, offlineAgents: 0 })
  })

  test('emitAgentStatus throws are isolated per-agent; remaining broadcasts still run', async () => {
    staleAgentsFixture = [
      { id: 11, projectId: 1 },
      { id: 22, projectId: 1 },
      { id: 33, projectId: 2 },
    ]
    const calls: number[] = []
    emitAgentStatusImpl = (_projectId, agentId, _status) => {
      calls.push(agentId)
      if (agentId === 22) throw new Error('WS broadcast failure')
    }

    const fakeJob = { id: 'test-3', data: { triggeredAt: new Date().toISOString() } }
    const result = await capturedProcessor!(fakeJob)

    expect(calls).toEqual([11, 22, 33])
    expect(result).toEqual({ reassigned: 0, offlineAgents: 3 })

    // Reset for any later test
    staleAgentsFixture = []
    emitAgentStatusImpl = () => {}
  })
})
