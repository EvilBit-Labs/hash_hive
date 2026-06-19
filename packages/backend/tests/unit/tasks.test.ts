import { beforeEach, describe, expect, mock, test } from 'bun:test'

// This file must run in isolation (own bun:test process) to avoid module cache
// poisoning from agent-api-contract.test.ts. The package.json test script runs
// it first with TASKS_TEST_ISOLATED=1, then runs the full suite where this file
// is skipped via the guard below.
const isIsolated = process.env['TASKS_TEST_ISOLATED'] === '1'

// Declared at module scope so mocks are accessible in describe/beforeEach blocks.
// Assigned inside the `if (isIsolated)` guard where mock.module runs.
let mockFrom: ReturnType<typeof mock>
let mockWhere: ReturnType<typeof mock>
let mockLimit: ReturnType<typeof mock>
let mockExecute: ReturnType<typeof mock>
let mockGetAgentBenchmarkForMode: ReturnType<typeof mock>
let mockUpdateSet: ReturnType<typeof mock>
let mockUpdateWhere: ReturnType<typeof mock>
let mockEmitTaskUpdate: ReturnType<typeof mock>
let mockEmitCrackResult: ReturnType<typeof mock>
let mockInsert: ReturnType<typeof mock>
let mockUpdateCampaignProgress: ReturnType<typeof mock>
let mockUpdateAgentObservedRate: ReturnType<typeof mock>
// updateTaskProgress now wraps the hot-row UPDATE + telemetry INSERT (U4) in
// db.transaction; the mock invokes the callback with a tx that delegates to the
// same update mocks and a no-op telemetry insert.
let mockTransaction: ReturnType<typeof mock>

if (isIsolated) {
  // ─── Config / logger mocks (prevent env validation during import) ──
  mock.module('../../src/config/env.js', () => ({
    env: {
      DATABASE_URL: 'postgres://test:test@localhost:5432/test',
      REDIS_URL: 'redis://localhost:6379',
      S3_ENDPOINT: 'http://localhost:9000',
      S3_ACCESS_KEY: 'test',
      S3_SECRET_KEY: 'test',
      BETTER_AUTH_SECRET: 'test-betterauth-secret-must-be-at-least-32-characters',
      NODE_ENV: 'test',
      // U11: lease duration used in assignNextTask CTE and updateTaskProgress
      TASK_LEASE_DURATION_MS: 90_000,
      // U13: target parcel duration used in assignNextTask split-on-claim
      TASK_TARGET_DURATION_SECONDS: 300,
    },
  }))

  mock.module('../../src/config/logger.js', () => ({
    logger: {
      info: mock(),
      warn: mock(),
      error: mock(),
      debug: mock(),
    },
  }))

  // ─── DB mock ────────────────────────────────────────────────────────
  mockFrom = mock(() => ({ where: mockWhere, innerJoin: mock() }))
  mockWhere = mock(() => ({ limit: mockLimit, innerJoin: mock() }))
  mockLimit = mock(() => Promise.resolve([]))
  mockExecute = mock(() => Promise.resolve([]))
  const mockSelect = mock(() => ({ from: mockFrom }))

  // Update-call captures shared with the reassignStaleTasks tests. Default
  // implementation is a chain that returns nothing; the rebalance tests
  // override `mockUpdateSet` to record each call's payload.
  mockUpdateSet = mock(() => ({ where: mockUpdateWhere }))
  mockUpdateWhere = mock(() => ({
    returning: mock(() => Promise.resolve([])),
  }))

  // Invokes the callback with a tx that delegates `update` to the shared
  // update mocks (so the hot-row UPDATE assertions still hold) and provides a
  // no-op `insert(...).values(...)` for the appended telemetry row.
  mockTransaction = mock((cb: (tx: unknown) => unknown) =>
    cb({
      update: () => ({ set: mockUpdateSet }),
      insert: () => ({ values: () => Promise.resolve(undefined) }),
    })
  )

  // db.insert mock: supports both the outer hash_items upsert path
  // (.values().onConflictDoUpdate()) and any other .values().returning() callers.
  // Capturable so crack-persist tests can assert called / not-called.
  mockInsert = mock(() => ({
    values: mock(() => ({
      returning: mock(() => Promise.resolve([])),
      onConflictDoUpdate: mock(() => Promise.resolve()),
    })),
  }))

  mock.module('../../src/db/index.js', () => ({
    db: {
      select: mockSelect,
      execute: mockExecute,
      insert: mockInsert,
      update: mock(() => ({ set: mockUpdateSet })),
      transaction: mockTransaction,
    },
  }))

  mockEmitTaskUpdate = mock()
  mockEmitCrackResult = mock()
  mock.module('../../src/services/events.js', () => ({
    emitCrackResult: mockEmitCrackResult,
    emitTaskUpdate: mockEmitTaskUpdate,
  }))

  mockUpdateCampaignProgress = mock()
  mock.module('../../src/services/campaigns.js', () => ({
    updateCampaignProgress: mockUpdateCampaignProgress,
    // tasks.ts + retry.ts now statically import this (#97 U6 completion
    // trigger); the named import fails to link if the mock omits it.
    enqueuePreemptionEvaluation: mock(() => Promise.resolve()),
  }))

  mockGetAgentBenchmarkForMode = mock(() => Promise.resolve(null))
  mock.module('../../src/services/agents.js', () => ({
    getAgentBenchmarkForMode: mockGetAgentBenchmarkForMode,
  }))

  // updateTaskProgress now calls updateAgentObservedRate (U6, observe-only EWMA)
  // on the running path. Mock it so the real atomic UPDATE doesn't run against
  // the db mock and pollute mockUpdateSet call counts.
  mockUpdateAgentObservedRate = mock(() => Promise.resolve())
  mock.module('../../src/services/agent-rate.js', () => ({
    updateAgentObservedRate: mockUpdateAgentObservedRate,
  }))

  const { assignNextTask, handleTaskFailure, reassignStaleTasks, updateTaskProgress } =
    await import('../../src/services/tasks.js')
  const { db } = await import('../../src/db/index.js')

  describe('updateTaskProgress preemption guard (#97 U4)', () => {
    beforeEach(() => {
      // select(...).from(tasks).innerJoin(campaigns).where(...).limit(1)
      mockSelect.mockReset().mockImplementation(() => ({ from: mockFrom }))
      mockFrom.mockReset().mockImplementation(() => ({ innerJoin: () => ({ where: mockWhere }) }))
      mockWhere.mockReset().mockImplementation(() => ({ limit: mockLimit }))
      mockLimit.mockReset().mockImplementation(() => Promise.resolve([]))
      // update(tasks).set(...).where(...).returning()
      mockUpdateSet.mockReset().mockImplementation(() => ({ where: mockUpdateWhere }))
      mockUpdateWhere
        .mockReset()
        .mockImplementation(() => ({ returning: mock(() => Promise.resolve([{ id: 1 }])) }))
      // crack-result mocks: reset before each test so call-count assertions don't bleed
      mockInsert.mockReset().mockImplementation(() => ({
        values: mock(() => ({
          returning: mock(() => Promise.resolve([])),
          onConflictDoUpdate: mock(() => Promise.resolve()),
        })),
      }))
      mockEmitCrackResult.mockReset()
    })

    const ownedRow = (status: string, hashListId: number | null = 1) => ({
      taskId: 1,
      attackId: 1,
      campaignId: 1,
      status,
      startedAt: new Date(),
      projectId: 1,
      hashListId,
    })

    test('returns { stopped: true } and skips the write when the task is paused (no results)', async () => {
      mockLimit.mockResolvedValueOnce([ownedRow('paused')])

      const result = await updateTaskProgress(1, 100, { status: 'running' })

      expect(result).toEqual({ stopped: true })
      // The progress write must NOT fire — a paused row stays paused.
      expect(mockUpdateSet).not.toHaveBeenCalled()
    })

    test('updates the row when the task is still active', async () => {
      mockLimit.mockResolvedValueOnce([ownedRow('running')])
      mockUpdateWhere.mockReturnValueOnce({
        returning: mock(() => Promise.resolve([{ id: 1, status: 'completed' }])),
      })

      const result = await updateTaskProgress(1, 100, { status: 'completed' })

      expect('task' in result).toBe(true)
      expect(mockUpdateSet).toHaveBeenCalledTimes(1)
    })

    // ─── U5: crack-result persist-first tests ───────────────────────

    test('happy path: running report with crack persists hash_item and fires emitCrackResult', async () => {
      // Arrange
      mockLimit.mockResolvedValueOnce([ownedRow('running')])
      mockUpdateWhere.mockReturnValueOnce({
        returning: mock(() => Promise.resolve([{ id: 1, status: 'running' }])),
      })

      // Act
      const result = await updateTaskProgress(1, 100, {
        status: 'running',
        results: [{ hashValue: 'abc123', plaintext: 'password' }],
      })

      // Assert: plaintext persisted, crack event fired, task returned
      expect(mockInsert).toHaveBeenCalledTimes(1)
      expect(mockEmitCrackResult).toHaveBeenCalledTimes(1)
      expect(mockEmitCrackResult).toHaveBeenCalledWith(1, 1, 1)
      expect('task' in result).toBe(true)
    })

    test('behavior change (U5): paused task with crack persists plaintext then returns stopped', async () => {
      // Arrange: task is paused mid-flight; agent reports with a crack result
      mockLimit.mockResolvedValueOnce([ownedRow('paused')])

      // Act
      const result = await updateTaskProgress(1, 100, {
        status: 'running',
        results: [{ hashValue: 'abc123', plaintext: 'password' }],
      })

      // Assert: plaintext IS persisted (was dropped before U5)
      expect(mockInsert).toHaveBeenCalledTimes(1)
      // Attribution must NOT fire — task is not live
      expect(mockEmitCrackResult).not.toHaveBeenCalled()
      // Progress write must NOT fire — paused row stays paused
      expect(mockUpdateSet).not.toHaveBeenCalled()
      // Agent is told to stop
      expect(result).toEqual({ stopped: true })
    })

    test('TOCTOU: task reassigned between SELECT and UPDATE persists plaintext but skips emitCrackResult', async () => {
      // Arrange: task appears running at SELECT time; UPDATE matches zero rows
      // (reassigned or reclaimed between the two operations)
      mockLimit.mockResolvedValueOnce([ownedRow('running')])
      mockUpdateWhere.mockReturnValueOnce({
        returning: mock(() => Promise.resolve([])), // zero rows -> updated is undefined
      })

      // Act
      const result = await updateTaskProgress(1, 100, {
        status: 'running',
        results: [{ hashValue: 'deadbeef', plaintext: 'secret' }],
      })

      // Assert: plaintext IS persisted (before the ownership UPDATE)
      expect(mockInsert).toHaveBeenCalledTimes(1)
      // Attribution must NOT fire — ownership was lost
      expect(mockEmitCrackResult).not.toHaveBeenCalled()
      // Returns the reassigned error
      expect(result).toEqual({ error: 'Task was reassigned during update' })
    })

    test('duplicate crack (same hash_list_id + hash_value) upserts without error', async () => {
      // Arrange: onConflictDoUpdate resolves cleanly on duplicate
      mockLimit.mockResolvedValueOnce([ownedRow('running')])
      mockUpdateWhere.mockReturnValueOnce({
        returning: mock(() => Promise.resolve([{ id: 1, status: 'running' }])),
      })

      // Act: submit the same crack twice (simulating idempotent retry)
      const result = await updateTaskProgress(1, 100, {
        status: 'running',
        results: [
          { hashValue: 'abc123', plaintext: 'password' },
          { hashValue: 'abc123', plaintext: 'password' },
        ],
      })

      // Assert: insert called once (with both rows; DB handles dedup via upsert)
      expect(mockInsert).toHaveBeenCalledTimes(1)
      expect('error' in result).toBe(false)
    })

    test('campaign with no hash list returns error, no insert', async () => {
      // Arrange: task row has no hashListId
      mockLimit.mockResolvedValueOnce([ownedRow('running', null)])

      // Act
      const result = await updateTaskProgress(1, 100, {
        status: 'running',
        results: [{ hashValue: 'abc123', plaintext: 'password' }],
      })

      // Assert: insert must NOT be called; error surfaces
      expect(mockInsert).not.toHaveBeenCalled()
      expect(result).toMatchObject({ error: expect.stringContaining('no associated hash list') })
    })
  })

  describe('assignNextTask', () => {
    beforeEach(() => {
      mockSelect.mockReset().mockImplementation(() => ({ from: mockFrom }))
      mockFrom.mockReset().mockImplementation(() => ({ where: mockWhere, innerJoin: mock() }))
      mockWhere.mockReset().mockImplementation(() => ({ limit: mockLimit, innerJoin: mock() }))
      mockLimit.mockReset().mockImplementation(() => Promise.resolve([]))
      mockExecute.mockReset().mockImplementation(() => Promise.resolve([]))
      mockGetAgentBenchmarkForMode.mockReset().mockImplementation(() => Promise.resolve(null))
      // assignNextTask must not use db.transaction; clear leaked calls from the
      // updateTaskProgress suite (the transaction mock is created once).
      mockTransaction.mockClear()
    })

    test('returns null when agent does not exist', async () => {
      mockLimit.mockResolvedValueOnce([])
      const result = await assignNextTask(999)
      expect(result).toBeNull()
    })

    test('returns null when agent is not online', async () => {
      mockLimit.mockResolvedValueOnce([
        {
          id: 1,
          projectId: 1,
          status: 'offline',
          capabilities: { gpu: true, hashModes: [0, 1000] },
        },
      ])
      const result = await assignNextTask(1)
      expect(result).toBeNull()
    })

    test('returns null when no matching tasks (capabilities mismatch) via DB predicate', async () => {
      mockLimit.mockResolvedValueOnce([
        {
          id: 1,
          projectId: 1,
          status: 'online',
          capabilities: { gpu: false, hashModes: [0] },
        },
      ])
      mockExecute.mockResolvedValueOnce([])
      const result = await assignNextTask(1)
      expect(result).toBeNull()
      expect(mockExecute).toHaveBeenCalled()
    })

    test('assigns task when agent capabilities match via DB predicate', async () => {
      const now = new Date()
      const rawDbRow = {
        id: 42,
        attack_id: 10,
        campaign_id: 5,
        agent_id: 1,
        status: 'assigned',
        work_range: { start: 0, end: 10000000, total: 10000000 },
        progress: {},
        result_stats: {},
        required_capabilities: { hashcatMode: 1000 },
        assigned_at: now,
        started_at: null,
        completed_at: null,
        failure_reason: null,
        retry_count: 0,
        created_at: now,
        updated_at: now,
      }
      const expectedCamelCase = {
        id: 42,
        attackId: 10,
        campaignId: 5,
        agentId: 1,
        status: 'assigned',
        workRange: {
          start: 0,
          end: 10000000,
          total: 10000000,
          agentSpeedHs: 1_000_000,
        },
        progress: {},
        resultStats: {},
        requiredCapabilities: { hashcatMode: 1000 },
        assignedAt: now,
        startedAt: null,
        completedAt: null,
        failureReason: null,
        retryCount: 0,
        createdAt: now,
        updatedAt: now,
      }

      mockLimit.mockResolvedValueOnce([
        {
          id: 1,
          projectId: 1,
          status: 'online',
          capabilities: { gpu: true, hashModes: [0, 1000, 3000] },
        },
      ])
      mockExecute.mockResolvedValueOnce([rawDbRow])

      const result = await assignNextTask(1)
      expect(result).not.toBeNull()
      expect(result).toEqual(expectedCamelCase)
      expect(mockExecute).toHaveBeenCalled()
    })

    test('assigns task to agent with benchmarked status', async () => {
      const now = new Date()
      const rawDbRow = {
        id: 50,
        attack_id: 11,
        campaign_id: 6,
        agent_id: 2,
        status: 'assigned',
        work_range: { start: 0, end: 5000, total: 5000 },
        progress: {},
        result_stats: {},
        required_capabilities: { hashcatMode: 0 },
        assigned_at: now,
        started_at: null,
        completed_at: null,
        failure_reason: null,
        created_at: now,
        updated_at: now,
      }

      mockLimit.mockResolvedValueOnce([
        {
          id: 2,
          projectId: 1,
          status: 'benchmarked',
          capabilities: { gpu: true, hashModes: [0] },
        },
      ])
      mockExecute.mockResolvedValueOnce([rawDbRow])

      const result = await assignNextTask(2)
      expect(result).not.toBeNull()
      expect(result!.id).toBe(50)
      expect(result!.workRange).toHaveProperty('agentSpeedHs')
    })

    test('returns null for non-eligible agent statuses', async () => {
      for (const status of ['offline', 'busy', 'error']) {
        mockLimit.mockResolvedValueOnce([{ id: 3, projectId: 1, status, capabilities: {} }])
        const result = await assignNextTask(3)
        expect(result).toBeNull()
      }
    })

    // diagnoseAssignmentSkip helper - covers the skip-reason path that fires
    // when the atomic CTE returns no rows. The helper queries the count of
    // matching tasks twice (any-pending, capability-matching) to decide
    // between no_pending_tasks / no_matching_capability / claim_race_lost.
    // Each test seeds the eligible-agent row, an empty execute() result, then
    // the two count queries that decide the reason.
    test('skip-diagnosis: no_pending_tasks when project has no pending tasks', async () => {
      mockLimit.mockResolvedValueOnce([
        {
          id: 1,
          projectId: 1,
          status: 'online',
          capabilities: { hashModes: [0] },
        },
      ])
      mockExecute.mockResolvedValueOnce([]) // CTE returns no claim
      // Diagnostic count #1 (any pending in project): 0 -> no_pending_tasks.
      mockLimit.mockResolvedValueOnce([{ n: 0 }])

      const result = await assignNextTask(1)
      expect(result).toBeNull()
    })

    test('skip-diagnosis: no_matching_capability when pending tasks exist but capabilities mismatch', async () => {
      mockLimit.mockResolvedValueOnce([
        {
          id: 1,
          projectId: 1,
          status: 'online',
          capabilities: { hashModes: [0] },
        },
      ])
      mockExecute.mockResolvedValueOnce([]) // CTE: no claim
      // Diagnostic #1: 5 pending; diagnostic #2: 0 matching.
      mockLimit.mockResolvedValueOnce([{ n: 5 }])
      mockLimit.mockResolvedValueOnce([{ n: 0 }])

      const result = await assignNextTask(1)
      expect(result).toBeNull()
    })

    test('skip-diagnosis: claim_race_lost when matching tasks exist but were locked', async () => {
      mockLimit.mockResolvedValueOnce([
        {
          id: 1,
          projectId: 1,
          status: 'online',
          capabilities: { hashModes: [0] },
        },
      ])
      mockExecute.mockResolvedValueOnce([]) // CTE: no claim
      mockLimit.mockResolvedValueOnce([{ n: 5 }]) // any-pending: 5
      mockLimit.mockResolvedValueOnce([{ n: 3 }]) // matching: 3 -> race lost

      const result = await assignNextTask(1)
      expect(result).toBeNull()
    })

    test('skip-diagnosis: diagnostic failure falls back to claim_race_lost', async () => {
      // The diagnostic is wrapped in try/catch so a DB blip during the
      // skip-reason lookup doesn't introduce a new failure mode in the
      // claim path. Simulate the diagnostic blowing up - assignNextTask
      // must still return null cleanly.
      mockLimit.mockResolvedValueOnce([
        {
          id: 1,
          projectId: 1,
          status: 'online',
          capabilities: { hashModes: [0] },
        },
      ])
      mockExecute.mockResolvedValueOnce([]) // CTE: no claim
      // Diagnostic query rejects -> caught, fallback to claim_race_lost log.
      mockLimit.mockImplementationOnce(() => Promise.reject(new Error('db blip')))

      const result = await assignNextTask(1)
      expect(result).toBeNull()
    })

    test('uses benchmark speed when available', async () => {
      const now = new Date()
      const rawDbRow = {
        id: 60,
        attack_id: 12,
        campaign_id: 7,
        agent_id: 1,
        status: 'assigned',
        work_range: { start: 0, end: 10000, total: 10000 },
        progress: {},
        result_stats: {},
        required_capabilities: { hashcatMode: 1000 },
        assigned_at: now,
        started_at: null,
        completed_at: null,
        failure_reason: null,
        created_at: now,
        updated_at: now,
      }

      mockLimit.mockResolvedValueOnce([
        {
          id: 1,
          projectId: 1,
          status: 'online',
          capabilities: { gpu: true, hashModes: [1000] },
        },
      ])
      mockExecute.mockResolvedValueOnce([rawDbRow])
      mockGetAgentBenchmarkForMode.mockResolvedValueOnce({
        speedHs: 5_000_000,
      })

      const result = await assignNextTask(1)
      expect(result).not.toBeNull()
      expect(result!.workRange.agentSpeedHs).toBe(5_000_000)
      expect(mockGetAgentBenchmarkForMode).toHaveBeenCalledWith(1, 1000)
    })

    test('falls back to DEFAULT_AGENT_SPEED_HS when no benchmark exists', async () => {
      const now = new Date()
      const rawDbRow = {
        id: 61,
        attack_id: 13,
        campaign_id: 8,
        agent_id: 1,
        status: 'assigned',
        work_range: { start: 0, end: 10000, total: 10000 },
        progress: {},
        result_stats: {},
        required_capabilities: { hashcatMode: 9999 },
        assigned_at: now,
        started_at: null,
        completed_at: null,
        failure_reason: null,
        created_at: now,
        updated_at: now,
      }

      mockLimit.mockResolvedValueOnce([
        {
          id: 1,
          projectId: 1,
          status: 'online',
          capabilities: { gpu: true, hashModes: [9999] },
        },
      ])
      mockExecute.mockResolvedValueOnce([rawDbRow])
      mockGetAgentBenchmarkForMode.mockResolvedValueOnce(null)

      const result = await assignNextTask(1)
      expect(result).not.toBeNull()
      expect(result!.workRange.agentSpeedHs).toBe(1_000_000)
    })

    test('uses SQL-level predicate, not app-layer filtering', async () => {
      mockLimit.mockResolvedValueOnce([
        {
          id: 1,
          projectId: 1,
          status: 'online',
          capabilities: { gpu: false, hashModes: [0, 100] },
        },
      ])
      mockExecute.mockResolvedValueOnce([])

      await assignNextTask(1)

      expect(mockExecute).toHaveBeenCalledTimes(1)
      expect((db as Record<string, unknown>)['transaction']).not.toHaveBeenCalled()
    })
  })

  // ─── reassignStaleTasks ───────────────────────────────────────────
  //
  // The new rebalance policy (U5) emits three outcomes per stale task:
  //   1. failed-overrun     - keyspaceProgress >= total -> mark failed
  //                          (covers both true overrun and un-acked
  //                          completion at exact-equal-total)
  //   2. rebalanced         - 0 < keyspaceProgress < total -> trim workRange.start
  //   3. reassigned (reset) - 0% progress -> existing reset-to-pending path
  // These tests assert the SET payload routed to each outcome branch.
  describe('reassignStaleTasks', () => {
    // The select chain for reassignStaleTasks is
    //   .from(tasks).innerJoin(agents, ...).innerJoin(campaigns, ...).where(...)
    // The default mock above only handles a single innerJoin, so we wire a
    // two-step chain that returns the seeded stale-task array from the final
    // .where() call.
    function seedStaleTasks(rows: unknown[], poisonRows: unknown[] = []) {
      // 1st select: staleTasks — .from(tasks).innerJoin(agents).innerJoin(campaigns).where()
      const whereReturning = mock(() => Promise.resolve(rows))
      const secondInnerJoin = mock(() => ({ where: whereReturning }))
      const firstInnerJoin = mock(() => ({ innerJoin: secondInnerJoin }))
      mockFrom.mockImplementationOnce(() => ({
        innerJoin: firstInnerJoin,
        where: mock(),
      }))
      // 2nd select (U12 poison sweep): .from(tasks).innerJoin(campaigns).where()
      const poisonWhere = mock(() => Promise.resolve(poisonRows))
      const poisonInnerJoin = mock(() => ({ where: poisonWhere }))
      mockFrom.mockImplementationOnce(() => ({
        innerJoin: poisonInnerJoin,
        where: mock(),
      }))
    }

    // Captures every .set() payload so each test can assert which branch fired.
    let setCalls: Array<Record<string, unknown>>
    beforeEach(() => {
      setCalls = []
      mockUpdateSet.mockReset().mockImplementation((payload: Record<string, unknown>) => {
        setCalls.push(payload)
        return { where: mockUpdateWhere }
      })
      // Sweep branches now gate event emission and counter increments on
      // `.returning()` rowcount > 0 — the default mock must report a row
      // matched so the existing happy-path tests still observe the side
      // effects. Tests that exercise the concurrent-sweep no-op override
      // this to return [].
      mockUpdateWhere.mockReset().mockImplementation(() => ({
        returning: mock(() => Promise.resolve([{ id: 1 }])),
      }))
      mockEmitTaskUpdate.mockReset()
      mockUpdateCampaignProgress.mockReset()
    })

    test('marks task failed when keyspaceProgress equals total (un-acked completion)', async () => {
      // Agent reported 100% progress but never sent the explicit completion
      // message. We can't trust the un-acked report - mark failed so a fresh
      // agent reruns the chunk.
      seedStaleTasks([
        {
          taskId: 50,
          agentId: 8,
          projectId: 1,
          campaignId: 1,
          workRange: { start: 0, end: 1000, total: 1000 },
          progress: { keyspaceProgress: 1000 }, // exactly equals total
        },
      ])

      const result = await reassignStaleTasks()

      expect(result).toEqual({
        reassigned: 0,
        rebalanced: 0,
        failedOverrun: 1,
        failedMaxRetries: 0,
        errored: 0,
      })
      expect(setCalls).toHaveLength(1)
      expect(setCalls[0]?.['status']).toBe('failed')
      expect(setCalls[0]?.['failureReason']).toBe('keyspace_progress_overrun')
    })

    test('marks task failed when keyspaceProgress overruns total', async () => {
      seedStaleTasks([
        {
          taskId: 42,
          agentId: 7,
          projectId: 1,
          campaignId: 1,
          workRange: { start: 0, end: 1000, total: 1000 },
          progress: { keyspaceProgress: 5000 }, // 5x the chunk size
        },
      ])

      const result = await reassignStaleTasks()

      expect(result).toEqual({
        reassigned: 0,
        rebalanced: 0,
        failedOverrun: 1,
        failedMaxRetries: 0,
        errored: 0,
      })
      expect(setCalls).toHaveLength(1)
      expect(setCalls[0]?.['status']).toBe('failed')
      expect(setCalls[0]?.['failureReason']).toBe('keyspace_progress_overrun')
      expect(setCalls[0]?.['completedAt']).toBeInstanceOf(Date)
    })

    test('trims workRange.start forward on partial progress', async () => {
      seedStaleTasks([
        {
          taskId: 17,
          agentId: 3,
          projectId: 1,
          campaignId: 1,
          workRange: { start: 0, end: 1_000_000, total: 1_000_000 },
          progress: { keyspaceProgress: 250_000 }, // 25% done
        },
      ])

      const result = await reassignStaleTasks()

      expect(result).toEqual({
        reassigned: 0,
        rebalanced: 1,
        failedOverrun: 0,
        failedMaxRetries: 0,
        errored: 0,
      })
      expect(setCalls).toHaveLength(1)
      expect(setCalls[0]?.['status']).toBe('pending')
      expect(setCalls[0]?.['agentId']).toBe(null)
      expect(setCalls[0]?.['assignedAt']).toBe(null)
      expect(setCalls[0]?.['startedAt']).toBe(null)
      // workRange.start advanced from 0 -> 250_000, end unchanged, total recomputed.
      const wr = setCalls[0]?.['workRange'] as Record<string, unknown>
      expect(wr['start']).toBe(250_000)
      expect(wr['end']).toBe(1_000_000)
      expect(wr['total']).toBe(750_000)
      // Reported progress reset so the next agent starts at 0 within the trimmed range.
      expect(setCalls[0]?.['progress']).toEqual({})
      // Retry counter bumped via SQL expression (`tasks.retry_count + 1`).
      expect(setCalls[0]?.['retryCount']).toBeDefined()
    })

    test('falls through to reset-to-pending on 0% progress', async () => {
      seedStaleTasks([
        {
          taskId: 9,
          agentId: 2,
          projectId: 1,
          campaignId: 1,
          workRange: { start: 0, end: 1000, total: 1000 },
          progress: {},
        },
      ])

      const result = await reassignStaleTasks()

      expect(result).toEqual({
        reassigned: 1,
        rebalanced: 0,
        failedOverrun: 0,
        failedMaxRetries: 0,
        errored: 0,
      })
      expect(setCalls).toHaveLength(1)
      // Existing reset path: clear claim metadata but leave workRange/progress alone.
      expect(setCalls[0]?.['status']).toBe('pending')
      expect(setCalls[0]?.['agentId']).toBe(null)
      expect(setCalls[0]?.['assignedAt']).toBe(null)
      expect(setCalls[0]?.['startedAt']).toBe(null)
      expect(setCalls[0]?.['workRange']).toBeUndefined()
      expect(setCalls[0]?.['progress']).toBeUndefined()
      // Retry counter bumped via SQL expression (`tasks.retry_count + 1`).
      expect(setCalls[0]?.['retryCount']).toBeDefined()
    })

    test('handles string-encoded workRange values (bigint overflow case)', async () => {
      // Mask attack: keyspace is 10^20, agent reported 10^18 progress.
      // Both values overflow Number.MAX_SAFE_INTEGER (~9e15) and arrive as decimal strings.
      seedStaleTasks([
        {
          taskId: 99,
          agentId: 11,
          projectId: 1,
          campaignId: 1,
          workRange: {
            start: '0',
            end: '100000000000000000000', // 1e20
            total: '100000000000000000000',
          },
          progress: { keyspaceProgress: '1000000000000000000' }, // 1e18
        },
      ])

      const result = await reassignStaleTasks()

      expect(result).toEqual({
        reassigned: 0,
        rebalanced: 1,
        failedOverrun: 0,
        failedMaxRetries: 0,
        errored: 0,
      })
      expect(setCalls).toHaveLength(1)
      const wr = setCalls[0]?.['workRange'] as Record<string, unknown>
      // New start = 0 + 1e18 = "1000000000000000000" (decimal string, bigint-safe).
      expect(wr['start']).toBe('1000000000000000000')
      // End unchanged.
      expect(wr['end']).toBe('100000000000000000000')
      // Total = 1e20 - 1e18, still well above MAX_SAFE_INTEGER -> string.
      expect(wr['total']).toBe('99000000000000000000')
    })

    test('emits zero counts when no stale tasks exist', async () => {
      seedStaleTasks([])
      const result = await reassignStaleTasks()
      expect(result).toEqual({
        reassigned: 0,
        rebalanced: 0,
        failedOverrun: 0,
        failedMaxRetries: 0,
        errored: 0,
      })
      expect(setCalls).toHaveLength(0)
    })

    test('terminal-fails partial-progress task when retry budget exhausted', async () => {
      seedStaleTasks([
        {
          taskId: 77,
          agentId: 4,
          projectId: 9,
          campaignId: 42,
          workRange: { start: 0, end: 1_000_000, total: 1_000_000 },
          progress: { keyspaceProgress: 250_000 }, // partial-progress branch
          retryCount: 3, // at MAX_RETRIES — exceededRetries is true
        },
      ])

      const result = await reassignStaleTasks()

      expect(result).toEqual({
        reassigned: 0,
        rebalanced: 0,
        failedOverrun: 0,
        failedMaxRetries: 1,
        errored: 0,
      })
      expect(setCalls).toHaveLength(1)
      expect(setCalls[0]?.['status']).toBe('failed')
      expect(setCalls[0]?.['failureReason']).toBe('max_retries_exceeded')
      expect(setCalls[0]?.['completedAt']).toBeInstanceOf(Date)
      // Terminal fail must not touch workRange/progress — the row is dead.
      expect(setCalls[0]?.['workRange']).toBeUndefined()
      expect(setCalls[0]?.['progress']).toBeUndefined()
      expect(mockEmitTaskUpdate).toHaveBeenCalledWith(9, 77, 'failed', {
        campaignId: 42,
      })
      expect(mockUpdateCampaignProgress).toHaveBeenCalledWith(42)
    })

    test('terminal-fails zero-progress task when retry budget exhausted', async () => {
      seedStaleTasks([
        {
          taskId: 78,
          agentId: 5,
          projectId: 9,
          campaignId: 43,
          workRange: { start: 0, end: 1000, total: 1000 },
          progress: {}, // 0% / unreadable
          retryCount: 4, // above cap (defensive bound)
        },
      ])

      const result = await reassignStaleTasks()

      expect(result).toEqual({
        reassigned: 0,
        rebalanced: 0,
        failedOverrun: 0,
        failedMaxRetries: 1,
        errored: 0,
      })
      expect(setCalls[0]?.['status']).toBe('failed')
      expect(setCalls[0]?.['failureReason']).toBe('max_retries_exceeded')
      expect(mockEmitTaskUpdate).toHaveBeenCalledWith(9, 78, 'failed', {
        campaignId: 43,
      })
      expect(mockUpdateCampaignProgress).toHaveBeenCalledWith(43)
    })

    test('does NOT terminal-fail at the boundary (retryCount = MAX_RETRIES - 1)', async () => {
      // Boundary guard: predicate is `>= MAX_RETRIES`, so retryCount=2 must
      // still rebalance, not terminal-fail. Catches an off-by-one regression.
      seedStaleTasks([
        {
          taskId: 79,
          agentId: 6,
          projectId: 9,
          campaignId: 44,
          workRange: { start: 0, end: 1000, total: 1000 },
          progress: { keyspaceProgress: 250 },
          retryCount: 2,
        },
      ])

      const result = await reassignStaleTasks()

      expect(result.failedMaxRetries).toBe(0)
      expect(result.rebalanced).toBe(1)
      expect(setCalls[0]?.['status']).toBe('pending')
      expect(setCalls[0]?.['failureReason']).toBeUndefined()
    })

    test('isolates per-task errors so siblings still process', async () => {
      // Three stale tasks; the second's UPDATE rejects. The first and third
      // must still complete and the envelope reports errored=1.
      seedStaleTasks([
        {
          taskId: 101,
          agentId: 11,
          projectId: 1,
          campaignId: 1,
          workRange: { start: 0, end: 1000, total: 1000 },
          progress: {},
          retryCount: 0,
        },
        {
          taskId: 102,
          agentId: 12,
          projectId: 1,
          campaignId: 1,
          workRange: { start: 0, end: 1000, total: 1000 },
          progress: {},
          retryCount: 0,
        },
        {
          taskId: 103,
          agentId: 13,
          projectId: 1,
          campaignId: 1,
          workRange: { start: 0, end: 1000, total: 1000 },
          progress: {},
          retryCount: 0,
        },
      ])

      // Sweep paths now call `.where(...).returning({id})`. The second
      // per-task UPDATE rejects from `.returning()` so the try/catch path
      // is exercised; the first and third resolve with a single-row array
      // so the success path runs.
      let callIdx = 0
      mockUpdateWhere.mockReset().mockImplementation(() => {
        const i = callIdx++
        if (i === 1) {
          return { returning: mock(() => Promise.reject(new Error('db blip'))) }
        }
        return { returning: mock(() => Promise.resolve([{ id: 1 }])) }
      })

      const result = await reassignStaleTasks()

      expect(result.reassigned).toBe(2)
      expect(result.errored).toBe(1)
    })
  })

  // ─── handleTaskFailure ────────────────────────────────────────────
  //
  // Exercises the retry-budget gating, the source-of-truth migration from
  // result_stats.retryCount to the new tasks.retry_count column, and the
  // terminal-fail branch that now also refreshes the campaign aggregate.
  describe('handleTaskFailure', () => {
    let setCalls: Array<Record<string, unknown>>

    beforeEach(() => {
      setCalls = []
      mockSelect.mockReset().mockImplementation(() => ({ from: mockFrom }))
      mockFrom.mockReset().mockImplementation(() => ({ where: mockWhere, innerJoin: mock() }))
      mockWhere.mockReset().mockImplementation(() => ({ limit: mockLimit, innerJoin: mock() }))
      mockLimit.mockReset().mockImplementation(() => Promise.resolve([]))
      mockUpdateSet.mockReset().mockImplementation((payload: Record<string, unknown>) => {
        setCalls.push(payload)
        return { where: mockUpdateWhere }
      })
      mockUpdateWhere.mockReset().mockImplementation(() => ({
        returning: mock(() => Promise.resolve([])),
      }))
      mockEmitTaskUpdate.mockReset()
      mockUpdateCampaignProgress.mockReset()
    })

    test('signals stop when the failed task is paused, without writing (#97 U6)', async () => {
      // A preempted task retains agentId, so a failure report still resolves
      // it; the read-time paused guard must short-circuit to stop, not retry.
      const task = {
        id: 60,
        agentId: 9,
        campaignId: 12,
        status: 'paused',
        resultStats: {},
        retryCount: 0,
      }
      mockLimit.mockResolvedValueOnce([task])

      const result = await handleTaskFailure(60, 9, 'agent_timeout')

      expect(result).toEqual({ stopped: true })
      expect(setCalls).toHaveLength(0)
    })

    test('signals stop on a zero-row retry write (task changed concurrently) (#221)', async () => {
      const task = {
        id: 61,
        agentId: 9,
        campaignId: 12,
        status: 'running',
        resultStats: {},
        retryCount: 0,
      }
      mockLimit.mockResolvedValueOnce([task]) // SELECT task (running at read)
      mockLimit.mockResolvedValueOnce([{ projectId: 3 }]) // SELECT campaign
      // The guarded UPDATE matches 0 rows (paused/reassigned between read and
      // write); default mockUpdateWhere returns []. Must signal stop, not
      // claim retried:true on a no-op write.
      const result = await handleTaskFailure(61, 9, 'agent_timeout')

      expect(result).toEqual({ stopped: true })
    })

    test('retries (sets retryCount = current + 1) when below MAX_RETRIES', async () => {
      const task = {
        id: 50,
        agentId: 8,
        campaignId: 12,
        resultStats: { lastFailure: 'prior' },
        retryCount: 1,
      }
      // First .limit() returns the task; second returns the campaign.
      mockLimit.mockResolvedValueOnce([task])
      mockLimit.mockResolvedValueOnce([{ projectId: 3 }])
      mockUpdateWhere.mockImplementationOnce(() => ({
        returning: mock(() =>
          Promise.resolve([{ ...task, status: 'pending', retryCount: 2, agentId: null }])
        ),
      }))

      const result = await handleTaskFailure(50, 8, 'agent_timeout')

      expect(result).toMatchObject({ retried: true })
      expect(setCalls).toHaveLength(1)
      expect(setCalls[0]?.['status']).toBe('pending')
      expect(setCalls[0]?.['retryCount']).toBe(2)
      expect(setCalls[0]?.['failureReason']).toBe('agent_timeout')
      // result_stats.retryCount must NOT be written anymore.
      const stats = setCalls[0]?.['resultStats'] as Record<string, unknown>
      expect(stats['retryCount']).toBeUndefined()
      expect(stats['lastFailure']).toBe('agent_timeout')
    })

    test('terminal-fails when retryCount equals MAX_RETRIES and refreshes campaign', async () => {
      const task = {
        id: 51,
        agentId: 9,
        campaignId: 12,
        resultStats: {},
        retryCount: 3,
      }
      mockLimit.mockResolvedValueOnce([task])
      mockLimit.mockResolvedValueOnce([{ projectId: 3 }])
      mockUpdateWhere.mockImplementationOnce(() => ({
        returning: mock(() => Promise.resolve([{ ...task, status: 'failed' }])),
      }))

      const result = await handleTaskFailure(51, 9, 'agent_timeout')

      expect(result).toMatchObject({ retried: false })
      expect(setCalls[0]?.['status']).toBe('failed')
      // Stable terminal code so this row is distinguishable from a one-shot
      // failure with the same agent-reported reason; sweep terminal branches
      // use the same code so both paths look identical to downstream code.
      expect(setCalls[0]?.['failureReason']).toBe('max_retries_exceeded')
      // The agent-reported reason that tipped the budget is preserved in
      // resultStats.lastFailure for debugging.
      const stats = setCalls[0]?.['resultStats'] as Record<string, unknown>
      expect(stats['lastFailure']).toBe('agent_timeout')
      expect(setCalls[0]?.['completedAt']).toBeInstanceOf(Date)
      expect(mockEmitTaskUpdate).toHaveBeenCalledWith(3, 51, 'failed', {
        agentId: 9,
        campaignId: 12,
      })
      // Terminal fail must refresh the campaign aggregate so the dashboard
      // does not lag a sweep cycle (symmetric with the sweep terminal-fail).
      expect(mockUpdateCampaignProgress).toHaveBeenCalledWith(12)
    })

    test('reads retryCount from the column, not result_stats (back-compat)', async () => {
      // A row migrated from the legacy schema may still carry a stale
      // result_stats.retryCount; the new code must IGNORE it and only honor
      // the column. Otherwise pre-migration tasks one-failure-from-terminal
      // would silently fail immediately on first post-migration retry.
      const task = {
        id: 52,
        agentId: 10,
        campaignId: 12,
        resultStats: { retryCount: 99, lastFailure: 'stale_legacy_value' },
        retryCount: 0,
      }
      mockLimit.mockResolvedValueOnce([task])
      mockLimit.mockResolvedValueOnce([{ projectId: 3 }])
      mockUpdateWhere.mockImplementationOnce(() => ({
        returning: mock(() => Promise.resolve([{ ...task, retryCount: 1 }])),
      }))

      const result = await handleTaskFailure(52, 10, 'agent_timeout')

      // Despite resultStats.retryCount=99, the column says 0 -> still retry.
      expect(result).toMatchObject({ retried: true })
      expect(setCalls[0]?.['retryCount']).toBe(1)
      expect(setCalls[0]?.['status']).toBe('pending')
    })
  })

  // ─── generateTasksForAttack ───────────────────────────────────────
  //
  // Covers the end-to-end wiring: attack row -> resource lookup ->
  // fleet benchmarks -> pickChunkSize -> bigint chunk walk -> insert.
  // The pure helpers (`calculateAttackKeyspace`, `pickChunkSize`) have
  // their own unit tests; these tests exercise the integration glue.
  const { generateTasksForAttack } = await import('../../src/services/tasks.js')

  describe('generateTasksForAttack', () => {
    // The select chain we have to satisfy:
    //   1. db.select().from(attacks).where(...).limit(1)            -> attack row
    //   2. db.select({lineCount}).from(wordLists).where(...).limit(1) -> wordlist row (optional)
    //   3. db.select({lineCount}).from(ruleLists).where(...).limit(1) -> rulelist row (optional)
    //   4. db.select({lineCount}).from(maskLists).where(...).limit(1) -> masklist row (optional)
    //   5. db.select({speedHs}).from(agentBenchmarks).innerJoin(agents).where(...) -> fleet benchmarks
    //   6. db.insert(tasks).values([...]).returning()                -> created tasks
    //
    // Seed each via `mockLimit.mockResolvedValueOnce` (calls 1-4) and a
    // dedicated chain for the fleet-benchmark query. Insert returns are
    // captured via a separate mock so chunk emission can be asserted.

    let insertValuesArg: unknown
    let mockInsert: ReturnType<typeof mock>

    beforeEach(() => {
      insertValuesArg = undefined
      mockSelect.mockReset().mockImplementation(() => ({ from: mockFrom }))
      mockFrom.mockReset().mockImplementation(() => ({ where: mockWhere, innerJoin: mock() }))
      mockWhere.mockReset().mockImplementation(() => ({ limit: mockLimit, innerJoin: mock() }))
      mockLimit.mockReset().mockImplementation(() => Promise.resolve([]))

      // Replace db.insert so we can capture the values array.
      mockInsert = mock((_table: unknown) => ({
        values: mock((rows: unknown) => {
          insertValuesArg = rows
          // Return a fake .returning() that resolves to the inserted rows
          // with synthetic ids, matching real drizzle behavior.
          return {
            returning: mock(() =>
              Promise.resolve(
                Array.isArray(rows)
                  ? rows.map((r, i) => ({
                      ...(r as Record<string, unknown>),
                      id: 1000 + i,
                    }))
                  : [{ ...(rows as Record<string, unknown>), id: 1000 }]
              )
            ),
          }
        }),
      }))
      ;(db as Record<string, unknown>)['insert'] = mockInsert
    })

    test('mode 3 mask attack with computed keyspace inserts the right chunks', async () => {
      // attack row
      mockLimit.mockResolvedValueOnce([
        {
          id: 7,
          campaignId: 3,
          projectId: 1,
          mode: 3,
          wordlistId: null,
          rulelistId: null,
          masklistId: null,
          keyspace: null,
          advancedConfiguration: { mask: '?d?d?d?d' }, // 10^4 = 10_000
        },
      ])
      // No wordlist / rulelist / masklist lookups for mode 3 with no IDs.
      // Next call is the fleet benchmark query; seed an empty fleet so
      // pickChunkSize falls back to FALLBACK_CHUNK_SIZE (10_000_000), which
      // exceeds the 10_000 keyspace - chunks should clamp at totalKeyspace.
      const benchmarkWhereReturning = mock(() => Promise.resolve([]))
      mockFrom.mockImplementationOnce(() => ({
        where: mockWhere,
        innerJoin: mock(),
      }))
      mockFrom.mockImplementationOnce(() => ({
        innerJoin: mock(() => ({ where: benchmarkWhereReturning })),
      }))

      const result = await generateTasksForAttack(7)

      // 10_000 keyspace, fallback chunk 10_000_000 -> single chunk.
      expect(result).toMatchObject({ count: 1 })
      expect(Array.isArray(insertValuesArg)).toBe(true)
      const rows = insertValuesArg as Array<Record<string, unknown>>
      expect(rows).toHaveLength(1)
      const range = rows[0]?.['workRange'] as Record<string, unknown>
      expect(range['start']).toBe(0)
      expect(range['end']).toBe(10000)
      expect(range['total']).toBe(10000)
    })

    test('non-empty fleet benchmarks size the chunks (fleet-aware path)', async () => {
      // attack row: mode 3 mask `?d?d?d?d?d?d` = 10^6 = 1_000_000 keyspace.
      mockLimit.mockResolvedValueOnce([
        {
          id: 11,
          campaignId: 3,
          projectId: 1,
          mode: 3,
          wordlistId: null,
          rulelistId: null,
          masklistId: null,
          keyspace: null,
          advancedConfiguration: { mask: '?d?d?d?d?d?d' },
        },
      ])
      // Fleet benchmark: single agent at 1000 H/s. pickChunkSize -> 1000 * 60 =
      // 60_000 per chunk. Total = 1_000_000 -> 17 chunks (16 full + 1 trailing
      // 40_000-unit chunk).
      const benchmarkWhereReturning = mock(() => Promise.resolve([{ speedHs: 1000 }]))
      mockFrom.mockImplementationOnce(() => ({
        where: mockWhere,
        innerJoin: mock(),
      }))
      mockFrom.mockImplementationOnce(() => ({
        innerJoin: mock(() => ({ where: benchmarkWhereReturning })),
      }))

      const result = await generateTasksForAttack(11)

      expect(result).toMatchObject({ count: 17 })
      const rows = insertValuesArg as Array<Record<string, unknown>>
      expect(rows).toHaveLength(17)
      // Each full chunk is exactly speedHs * targetSeconds = 60_000.
      const firstChunk = rows[0]?.['workRange'] as Record<string, unknown>
      expect(firstChunk['start']).toBe(0)
      expect(firstChunk['end']).toBe(60_000)
      expect(firstChunk['total']).toBe(60_000)
      // Last chunk holds the trailing remainder, capped at totalKeyspace.
      const lastChunk = rows[16]?.['workRange'] as Record<string, unknown>
      expect(lastChunk['end']).toBe(1_000_000)
    })

    test('rejects non-positive or non-integer chunkSize before any DB work', async () => {
      // Validation runs at the function boundary, ahead of the attack lookup,
      // so we don't need to seed any mocks. Each invalid value must throw a
      // descriptive Error and never reach the BigInt math or division below.
      const invalid: Array<number> = [0, -1, -1_000_000, Number.NaN, Number.POSITIVE_INFINITY, 1.5]
      for (const value of invalid) {
        await expect(generateTasksForAttack(7, { chunkSize: value })).rejects.toThrow(
          /opts\.chunkSize must be a positive integer/
        )
      }
    })

    test('returns single placeholder task when keyspace cannot be computed', async () => {
      // Mode 1 (combination) needs secondaryWordlistRows which the schema
      // doesn't expose, so calculateAttackKeyspace returns null and the
      // caller emits a single placeholder task with workRange of zeros.
      mockLimit.mockResolvedValueOnce([
        {
          id: 8,
          campaignId: 3,
          projectId: 1,
          mode: 1,
          wordlistId: 100,
          rulelistId: null,
          masklistId: null,
          keyspace: null,
          advancedConfiguration: {},
        },
      ])
      // Wordlist lookup returns a row, but mode 1 still falls through.
      mockLimit.mockResolvedValueOnce([{ lineCount: 5000 }])

      const result = await generateTasksForAttack(8)
      expect(result).toMatchObject({ count: 1 })
      // Placeholder path passes a single object to .values(...), not an array.
      const row = (Array.isArray(insertValuesArg) ? insertValuesArg[0] : insertValuesArg) as Record<
        string,
        unknown
      >
      const range = row?.['workRange'] as Record<string, unknown>
      expect(range['start']).toBe(0)
      expect(range['end']).toBe(0)
      expect(range['total']).toBe(0)
    })
  })
} else {
  // Skipped in full suite — already validated in isolated first-phase run.
  // Using describe.skip so bun:test doesn't report zero tests from this file.
  describe.skip('assignNextTask (skipped — runs in isolated phase)', () => {
    test.skip('see isolated run', () => {})
  })
  describe.skip('reassignStaleTasks (skipped — runs in isolated phase)', () => {
    test.skip('see isolated run', () => {})
  })
  describe.skip('generateTasksForAttack (skipped — runs in isolated phase)', () => {
    test.skip('see isolated run', () => {})
  })
}
