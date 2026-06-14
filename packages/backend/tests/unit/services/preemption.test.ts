/**
 * Issue #97 U3 — preemption pause pass + capability matching.
 *
 * Runs in an isolated bun:test phase (PREEMPTION_TEST_ISOLATED=1) because
 * the `mock.module` calls replace `db`, `events`, and `task-events`
 * process-wide and would poison sibling test files in the shared bun:test
 * cache. Mirrors the env-gate + skip-stub pattern in
 * `tests/integration/agent-heartbeat.test.ts`.
 *
 * The drizzle client is mocked at the chain level (the established
 * tests/integration convention here): `tx.select(...)` resolves to the next
 * queued result set, `tx.execute(...)` to the next queued rows. The first
 * `tx.execute` is always the advisory-lock acquisition; subsequent ones are
 * the atomic pause UPDATE, so execute-call-count discriminates "paused"
 * from "no preemption".
 */
import { beforeEach, describe, expect, it, mock } from 'bun:test'

const IS_ISOLATED = process.env['PREEMPTION_TEST_ISOLATED'] === '1'

if (!IS_ISOLATED) {
  describe('preemption (skipped — runs in isolated phase)', () => {
    it('signals isolation phase is required', () => {
      // oxlint-disable-next-line no-console -- surface phase-gating drift in CI logs
      console.warn(
        '[preemption] skipped — set PREEMPTION_TEST_ISOLATED=1 to run; the preemption suite did NOT execute in this phase.'
      )
      expect(process.env['PREEMPTION_TEST_ISOLATED']).toBeUndefined()
    })
  })
} else {
  mock.module('../../../src/config/env.js', () => ({
    env: {
      DATABASE_URL: 'postgres://test:test@localhost:5432/test',
      REDIS_URL: 'redis://localhost:6379',
      NODE_ENV: 'test',
    },
  }))
  mock.module('../../../src/config/logger.js', () => ({
    logger: { info: mock(), warn: mock(), error: mock(), debug: mock() },
  }))

  // ─── tx chain mock ──────────────────────────────────────────────────
  let selectQueue: unknown[][] = []
  let executeQueue: unknown[][] = []

  const txSelect = mock(() => {
    const result = selectQueue.shift() ?? []
    const chain: Record<string, unknown> = {}
    for (const m of ['from', 'innerJoin', 'where', 'orderBy', 'limit']) {
      chain[m] = () => chain
    }
    // A drizzle query builder is itself thenable; this mock mirrors that so
    // `await tx.select()...` resolves to the queued result set.
    // oxlint-disable-next-line unicorn/no-thenable -- intentional test double
    chain['then'] = (resolve: (v: unknown) => void) => resolve(result)
    return chain
  })
  const txExecute = mock(() => Promise.resolve(executeQueue.shift() ?? []))
  // update(...).set(...).where(...).returning() → next queued result set.
  let updateQueue: unknown[][] = []
  const txUpdate = mock(() => {
    const result = updateQueue.shift() ?? []
    const chain: Record<string, unknown> = {}
    for (const m of ['set', 'where']) {
      chain[m] = () => chain
    }
    chain['returning'] = () => Promise.resolve(result)
    return chain
  })
  const tx = { select: txSelect, execute: txExecute, update: txUpdate }

  mock.module('../../../src/db/index.js', () => ({
    db: { transaction: mock((cb: (t: typeof tx) => unknown) => cb(tx)) },
  }))

  const mockRecordTaskEvent = mock(() => Promise.resolve({ id: 1 }))
  mock.module('../../../src/services/tasks/task-events.js', () => ({
    recordTaskEvent: mockRecordTaskEvent,
  }))

  const mockEmitTaskUpdate = mock()
  mock.module('../../../src/services/events.js', () => ({
    emitTaskUpdate: mockEmitTaskUpdate,
    emitCrackResult: mock(),
  }))

  const { agentCanRunTask, evaluatePreemption } =
    await import('../../../src/services/tasks/preemption.js')

  // Result-set builders ------------------------------------------------
  const pending = (id: number, campaignId: number, priority: number, req: unknown = {}) => ({
    id,
    campaignId,
    priority,
    requiredCapabilities: req,
  })
  const victim = (
    id: number,
    priority: number,
    agentCaps: unknown = {},
    status = 'running',
    agentId = 100,
    campaignId = 50
  ) => ({ id, agentId, campaignId, priority, status, agentCaps })

  beforeEach(() => {
    selectQueue = []
    executeQueue = []
    updateQueue = []
    txSelect.mockClear()
    txExecute.mockClear()
    txUpdate.mockClear()
    mockRecordTaskEvent.mockClear()
    mockEmitTaskUpdate.mockClear()
  })

  // A paused-preempted task row for the resume pass.
  const pausedRow = (
    id: number,
    priority: number,
    progressDone = 40,
    range = { start: 0, end: 100, total: 100 },
    campaignId = 60
  ) => ({
    id,
    campaignId,
    priority,
    workRange: range,
    progress: { keyspaceProgress: progressDone },
  })

  describe('agentCanRunTask', () => {
    it('rejects a GPU-required task when the agent has no GPU', () => {
      expect(agentCanRunTask({ gpu: false }, { gpu: true })).toBe(false)
    })
    it('accepts a GPU-required task when the agent has a GPU', () => {
      expect(agentCanRunTask({ gpu: true }, { gpu: true })).toBe(true)
    })
    it('accepts when the agent advertises the required hash mode', () => {
      expect(agentCanRunTask({ hashModes: [0, 1000] }, { hashcatMode: 1000 })).toBe(true)
    })
    it('rejects when the agent does not advertise the required hash mode', () => {
      expect(agentCanRunTask({ hashModes: [0] }, { hashcatMode: 1000 })).toBe(false)
    })
    it('accepts when the task requires no hash mode', () => {
      expect(agentCanRunTask({ hashModes: [] }, {})).toBe(true)
    })
  })

  describe('evaluatePreemption pause pass', () => {
    it('pauses the lowest-priority matching running task for higher-priority pending work', async () => {
      // Arrange: one high-priority pending task (priority 1), two running
      // tasks (priority 5 and 10) on matching agents, no idle agents.
      selectQueue = [
        [pending(1, 10, 1)], // pending hi-pri
        [victim(200, 10), victim(201, 5)], // running, lowest-priority first
        [], // no idle agents
      ]
      executeQueue = [
        [], // advisory lock
        [{ id: 200, agent_id: 100 }], // pause UPDATE returns the victim
      ]

      // Act
      const result = await evaluatePreemption(7)

      // Assert: the priority-10 task (lowest priority) is the victim.
      expect(result.pausedTaskIds).toEqual([200])
      expect(txExecute).toHaveBeenCalledTimes(2) // advisory + pause
      expect(mockRecordTaskEvent).toHaveBeenCalledTimes(1)
      const event = mockRecordTaskEvent.mock.calls[0]?.[0] as Record<string, unknown>
      expect(event).toMatchObject({ taskId: 200, eventType: 'preempted', toStatus: 'paused' })
      expect(mockEmitTaskUpdate).toHaveBeenCalledTimes(1)
    })

    it('pauses an assigned (not yet running) task on the same terms', async () => {
      selectQueue = [[pending(1, 10, 1)], [victim(200, 10, {}, 'assigned')], []]
      executeQueue = [[], [{ id: 200, agent_id: 100 }]]

      const result = await evaluatePreemption(7)

      expect(result.pausedTaskIds).toEqual([200])
      const event = mockRecordTaskEvent.mock.calls[0]?.[0] as Record<string, unknown>
      expect(event['fromStatus']).toBe('assigned')
    })

    it('does not preempt when campaign priorities are equal', async () => {
      selectQueue = [[pending(1, 10, 5)], [victim(200, 5)], []]
      executeQueue = [[]] // only advisory lock should be consumed

      const result = await evaluatePreemption(7)

      expect(result.pausedTaskIds).toEqual([])
      expect(txExecute).toHaveBeenCalledTimes(1) // advisory only, no pause
      expect(mockRecordTaskEvent).not.toHaveBeenCalled()
    })

    it('does not preempt when no running task agent matches the pending capabilities', async () => {
      // pending needs a GPU; the only running task is on a non-GPU agent.
      selectQueue = [[pending(1, 10, 1, { gpu: true })], [victim(200, 10, { gpu: false })], []]
      executeQueue = [[]]

      const result = await evaluatePreemption(7)

      expect(result.pausedTaskIds).toEqual([])
      expect(txExecute).toHaveBeenCalledTimes(1)
    })

    it('does not preempt when an idle matching agent already exists', async () => {
      selectQueue = [
        [pending(1, 10, 1)],
        [victim(200, 10)],
        [{ id: 999, caps: {} }], // idle agent that can run the pending task
      ]
      executeQueue = [[]]

      const result = await evaluatePreemption(7)

      expect(result.pausedTaskIds).toEqual([])
      expect(txExecute).toHaveBeenCalledTimes(1)
    })

    it('returns empty when there is no pending work', async () => {
      selectQueue = [[]] // no pending; pause pass short-circuits
      executeQueue = [[]]

      const result = await evaluatePreemption(7)

      expect(result.pausedTaskIds).toEqual([])
      expect(result.resumedTaskIds).toEqual([])
    })
  })

  describe('evaluatePreemption resume pass', () => {
    it('resumes a paused task when no higher-priority pending work remains', async () => {
      // pause pass: no pending → short-circuits. resume pass: one paused
      // task, no blocker.
      selectQueue = [[], [pausedRow(300, 5)], []]
      executeQueue = [[]] // advisory lock
      updateQueue = [[{ id: 300 }]] // re-pend UPDATE matched

      const result = await evaluatePreemption(7)

      expect(result.resumedTaskIds).toEqual([300])
      expect(mockRecordTaskEvent).toHaveBeenCalledTimes(1)
      const event = mockRecordTaskEvent.mock.calls[0]?.[0] as Record<string, unknown>
      expect(event).toMatchObject({ taskId: 300, eventType: 'resumed', fromStatus: 'paused' })
      expect(event['toStatus']).toBe('pending')
      expect(mockEmitTaskUpdate).toHaveBeenCalledTimes(1)
    })

    it('does not resume while higher-priority pending work still blocks it', async () => {
      // Blocker query returns a strictly-higher-priority pending task.
      selectQueue = [[], [pausedRow(300, 5)], [{ id: 1 }]]
      executeQueue = [[]]

      const result = await evaluatePreemption(7)

      expect(result.resumedTaskIds).toEqual([])
      expect(mockRecordTaskEvent).not.toHaveBeenCalled()
    })

    it('marks an over-progressed paused task exhausted instead of re-pending', async () => {
      // progressDone (100) >= total (100) → terminal, not resumed to pending.
      selectQueue = [[], [pausedRow(300, 5, 100)], []]
      executeQueue = [[]]
      updateQueue = [[{ id: 300 }]]

      const result = await evaluatePreemption(7)

      expect(result.resumedTaskIds).toEqual([300])
      const event = mockRecordTaskEvent.mock.calls[0]?.[0] as Record<string, unknown>
      expect(event['toStatus']).toBe('exhausted')
    })
  })
}
