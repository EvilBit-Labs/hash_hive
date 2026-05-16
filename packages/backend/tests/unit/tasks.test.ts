import { beforeEach, describe, expect, mock, test } from 'bun:test';

// This file must run in isolation (own bun:test process) to avoid module cache
// poisoning from agent-api-contract.test.ts. The package.json test script runs
// it first with TASKS_TEST_ISOLATED=1, then runs the full suite where this file
// is skipped via the guard below.
const isIsolated = process.env['TASKS_TEST_ISOLATED'] === '1';

// Declared at module scope so mocks are accessible in describe/beforeEach blocks.
// Assigned inside the `if (isIsolated)` guard where mock.module runs.
let mockFrom: ReturnType<typeof mock>;
let mockWhere: ReturnType<typeof mock>;
let mockLimit: ReturnType<typeof mock>;
let mockExecute: ReturnType<typeof mock>;
let mockGetAgentBenchmarkForMode: ReturnType<typeof mock>;
let mockUpdateSet: ReturnType<typeof mock>;
let mockUpdateWhere: ReturnType<typeof mock>;

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
    },
  }));

  mock.module('../../src/config/logger.js', () => ({
    logger: {
      info: mock(),
      warn: mock(),
      error: mock(),
      debug: mock(),
    },
  }));

  // ─── DB mock ────────────────────────────────────────────────────────
  mockFrom = mock(() => ({ where: mockWhere, innerJoin: mock() }));
  mockWhere = mock(() => ({ limit: mockLimit, innerJoin: mock() }));
  mockLimit = mock(() => Promise.resolve([]));
  mockExecute = mock(() => Promise.resolve([]));
  const mockSelect = mock(() => ({ from: mockFrom }));

  // Update-call captures shared with the reassignStaleTasks tests. Default
  // implementation is a chain that returns nothing; the rebalance tests
  // override `mockUpdateSet` to record each call's payload.
  mockUpdateSet = mock(() => ({ where: mockUpdateWhere }));
  mockUpdateWhere = mock(() => ({ returning: mock(() => Promise.resolve([])) }));

  mock.module('../../src/db/index.js', () => ({
    db: {
      select: mockSelect,
      execute: mockExecute,
      insert: mock(() => ({
        values: mock(() => ({ returning: mock(() => Promise.resolve([])) })),
      })),
      update: mock(() => ({ set: mockUpdateSet })),
      transaction: mock(),
    },
  }));

  mock.module('../../src/services/events.js', () => ({
    emitCrackResult: mock(),
    emitTaskUpdate: mock(),
  }));

  mock.module('../../src/services/campaigns.js', () => ({
    updateCampaignProgress: mock(),
  }));

  mockGetAgentBenchmarkForMode = mock(() => Promise.resolve(null));
  mock.module('../../src/services/agents.js', () => ({
    getAgentBenchmarkForMode: mockGetAgentBenchmarkForMode,
  }));

  const { assignNextTask, reassignStaleTasks } = await import('../../src/services/tasks.js');
  const { db } = await import('../../src/db/index.js');

  describe('assignNextTask', () => {
    beforeEach(() => {
      mockSelect.mockReset().mockImplementation(() => ({ from: mockFrom }));
      mockFrom.mockReset().mockImplementation(() => ({ where: mockWhere, innerJoin: mock() }));
      mockWhere.mockReset().mockImplementation(() => ({ limit: mockLimit, innerJoin: mock() }));
      mockLimit.mockReset().mockImplementation(() => Promise.resolve([]));
      mockExecute.mockReset().mockImplementation(() => Promise.resolve([]));
      mockGetAgentBenchmarkForMode.mockReset().mockImplementation(() => Promise.resolve(null));
    });

    test('returns null when agent does not exist', async () => {
      mockLimit.mockResolvedValueOnce([]);
      const result = await assignNextTask(999);
      expect(result).toBeNull();
    });

    test('returns null when agent is not online', async () => {
      mockLimit.mockResolvedValueOnce([
        {
          id: 1,
          projectId: 1,
          status: 'offline',
          capabilities: { gpu: true, hashModes: [0, 1000] },
        },
      ]);
      const result = await assignNextTask(1);
      expect(result).toBeNull();
    });

    test('returns null when no matching tasks (capabilities mismatch) via DB predicate', async () => {
      mockLimit.mockResolvedValueOnce([
        {
          id: 1,
          projectId: 1,
          status: 'online',
          capabilities: { gpu: false, hashModes: [0] },
        },
      ]);
      mockExecute.mockResolvedValueOnce([]);
      const result = await assignNextTask(1);
      expect(result).toBeNull();
      expect(mockExecute).toHaveBeenCalled();
    });

    test('assigns task when agent capabilities match via DB predicate', async () => {
      const now = new Date();
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
        created_at: now,
        updated_at: now,
      };
      const expectedCamelCase = {
        id: 42,
        attackId: 10,
        campaignId: 5,
        agentId: 1,
        status: 'assigned',
        workRange: { start: 0, end: 10000000, total: 10000000, agentSpeedHs: 1_000_000 },
        progress: {},
        resultStats: {},
        requiredCapabilities: { hashcatMode: 1000 },
        assignedAt: now,
        startedAt: null,
        completedAt: null,
        failureReason: null,
        createdAt: now,
        updatedAt: now,
      };

      mockLimit.mockResolvedValueOnce([
        {
          id: 1,
          projectId: 1,
          status: 'online',
          capabilities: { gpu: true, hashModes: [0, 1000, 3000] },
        },
      ]);
      mockExecute.mockResolvedValueOnce([rawDbRow]);

      const result = await assignNextTask(1);
      expect(result).not.toBeNull();
      expect(result).toEqual(expectedCamelCase);
      expect(mockExecute).toHaveBeenCalled();
    });

    test('assigns task to agent with benchmarked status', async () => {
      const now = new Date();
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
      };

      mockLimit.mockResolvedValueOnce([
        {
          id: 2,
          projectId: 1,
          status: 'benchmarked',
          capabilities: { gpu: true, hashModes: [0] },
        },
      ]);
      mockExecute.mockResolvedValueOnce([rawDbRow]);

      const result = await assignNextTask(2);
      expect(result).not.toBeNull();
      expect(result!.id).toBe(50);
      expect(result!.workRange).toHaveProperty('agentSpeedHs');
    });

    test('returns null for non-eligible agent statuses', async () => {
      for (const status of ['offline', 'busy', 'error']) {
        mockLimit.mockResolvedValueOnce([{ id: 3, projectId: 1, status, capabilities: {} }]);
        const result = await assignNextTask(3);
        expect(result).toBeNull();
      }
    });

    test('uses benchmark speed when available', async () => {
      const now = new Date();
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
      };

      mockLimit.mockResolvedValueOnce([
        {
          id: 1,
          projectId: 1,
          status: 'online',
          capabilities: { gpu: true, hashModes: [1000] },
        },
      ]);
      mockExecute.mockResolvedValueOnce([rawDbRow]);
      mockGetAgentBenchmarkForMode.mockResolvedValueOnce({ speedHs: 5_000_000 });

      const result = await assignNextTask(1);
      expect(result).not.toBeNull();
      expect(result!.workRange.agentSpeedHs).toBe(5_000_000);
      expect(mockGetAgentBenchmarkForMode).toHaveBeenCalledWith(1, 1000);
    });

    test('falls back to DEFAULT_AGENT_SPEED_HS when no benchmark exists', async () => {
      const now = new Date();
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
      };

      mockLimit.mockResolvedValueOnce([
        {
          id: 1,
          projectId: 1,
          status: 'online',
          capabilities: { gpu: true, hashModes: [9999] },
        },
      ]);
      mockExecute.mockResolvedValueOnce([rawDbRow]);
      mockGetAgentBenchmarkForMode.mockResolvedValueOnce(null);

      const result = await assignNextTask(1);
      expect(result).not.toBeNull();
      expect(result!.workRange.agentSpeedHs).toBe(1_000_000);
    });

    test('uses SQL-level predicate, not app-layer filtering', async () => {
      mockLimit.mockResolvedValueOnce([
        {
          id: 1,
          projectId: 1,
          status: 'online',
          capabilities: { gpu: false, hashModes: [0, 100] },
        },
      ]);
      mockExecute.mockResolvedValueOnce([]);

      await assignNextTask(1);

      expect(mockExecute).toHaveBeenCalledTimes(1);
      expect((db as Record<string, unknown>)['transaction']).not.toHaveBeenCalled();
    });
  });

  // ─── reassignStaleTasks ───────────────────────────────────────────
  //
  // The new rebalance policy (U5) emits three outcomes per stale task:
  //   1. failed-overrun     - keyspaceProgress > total -> mark failed
  //   2. rebalanced         - 0 < keyspaceProgress < total -> trim workRange.start
  //   3. reassigned (reset) - 0% progress -> existing reset-to-pending path
  // These tests assert the SET payload routed to each outcome branch.
  describe('reassignStaleTasks', () => {
    // The select chain for reassignStaleTasks is
    //   .from(tasks).innerJoin(agents, ...).innerJoin(campaigns, ...).where(...)
    // The default mock above only handles a single innerJoin, so we wire a
    // two-step chain that returns the seeded stale-task array from the final
    // .where() call.
    function seedStaleTasks(rows: unknown[]) {
      const whereReturning = mock(() => Promise.resolve(rows));
      const secondInnerJoin = mock(() => ({ where: whereReturning }));
      const firstInnerJoin = mock(() => ({ innerJoin: secondInnerJoin }));
      mockFrom.mockImplementationOnce(() => ({ innerJoin: firstInnerJoin, where: mock() }));
    }

    // Captures every .set() payload so each test can assert which branch fired.
    let setCalls: Array<Record<string, unknown>>;
    beforeEach(() => {
      setCalls = [];
      mockUpdateSet.mockReset().mockImplementation((payload: Record<string, unknown>) => {
        setCalls.push(payload);
        return { where: mockUpdateWhere };
      });
      mockUpdateWhere
        .mockReset()
        .mockImplementation(() => ({ returning: mock(() => Promise.resolve([])) }));
    });

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
      ]);

      const result = await reassignStaleTasks();

      expect(result).toEqual({ reassigned: 0, rebalanced: 0, failedOverrun: 1 });
      expect(setCalls).toHaveLength(1);
      expect(setCalls[0]?.['status']).toBe('failed');
      expect(setCalls[0]?.['failureReason']).toBe('keyspace_progress_overrun');
    });

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
      ]);

      const result = await reassignStaleTasks();

      expect(result).toEqual({ reassigned: 0, rebalanced: 0, failedOverrun: 1 });
      expect(setCalls).toHaveLength(1);
      expect(setCalls[0]?.['status']).toBe('failed');
      expect(setCalls[0]?.['failureReason']).toBe('keyspace_progress_overrun');
      expect(setCalls[0]?.['completedAt']).toBeInstanceOf(Date);
    });

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
      ]);

      const result = await reassignStaleTasks();

      expect(result).toEqual({ reassigned: 0, rebalanced: 1, failedOverrun: 0 });
      expect(setCalls).toHaveLength(1);
      expect(setCalls[0]?.['status']).toBe('pending');
      expect(setCalls[0]?.['agentId']).toBe(null);
      expect(setCalls[0]?.['assignedAt']).toBe(null);
      expect(setCalls[0]?.['startedAt']).toBe(null);
      // workRange.start advanced from 0 -> 250_000, end unchanged, total recomputed.
      const wr = setCalls[0]?.['workRange'] as Record<string, unknown>;
      expect(wr['start']).toBe(250_000);
      expect(wr['end']).toBe(1_000_000);
      expect(wr['total']).toBe(750_000);
      // Reported progress reset so the next agent starts at 0 within the trimmed range.
      expect(setCalls[0]?.['progress']).toEqual({});
    });

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
      ]);

      const result = await reassignStaleTasks();

      expect(result).toEqual({ reassigned: 1, rebalanced: 0, failedOverrun: 0 });
      expect(setCalls).toHaveLength(1);
      // Existing reset path: clear claim metadata but leave workRange/progress alone.
      expect(setCalls[0]?.['status']).toBe('pending');
      expect(setCalls[0]?.['agentId']).toBe(null);
      expect(setCalls[0]?.['assignedAt']).toBe(null);
      expect(setCalls[0]?.['startedAt']).toBe(null);
      expect(setCalls[0]?.['workRange']).toBeUndefined();
      expect(setCalls[0]?.['progress']).toBeUndefined();
    });

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
      ]);

      const result = await reassignStaleTasks();

      expect(result).toEqual({ reassigned: 0, rebalanced: 1, failedOverrun: 0 });
      expect(setCalls).toHaveLength(1);
      const wr = setCalls[0]?.['workRange'] as Record<string, unknown>;
      // New start = 0 + 1e18 = "1000000000000000000" (decimal string, bigint-safe).
      expect(wr['start']).toBe('1000000000000000000');
      // End unchanged.
      expect(wr['end']).toBe('100000000000000000000');
      // Total = 1e20 - 1e18, still well above MAX_SAFE_INTEGER -> string.
      expect(wr['total']).toBe('99000000000000000000');
    });

    test('emits zero counts when no stale tasks exist', async () => {
      seedStaleTasks([]);
      const result = await reassignStaleTasks();
      expect(result).toEqual({ reassigned: 0, rebalanced: 0, failedOverrun: 0 });
      expect(setCalls).toHaveLength(0);
    });
  });

  // ─── generateTasksForAttack ───────────────────────────────────────
  //
  // Covers the end-to-end wiring: attack row -> resource lookup ->
  // fleet benchmarks -> pickChunkSize -> bigint chunk walk -> insert.
  // The pure helpers (`calculateAttackKeyspace`, `pickChunkSize`) have
  // their own unit tests; these tests exercise the integration glue.
  const { generateTasksForAttack } = await import('../../src/services/tasks.js');

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

    let insertValuesArg: unknown;
    let mockInsert: ReturnType<typeof mock>;

    beforeEach(() => {
      insertValuesArg = undefined;
      mockSelect.mockReset().mockImplementation(() => ({ from: mockFrom }));
      mockFrom.mockReset().mockImplementation(() => ({ where: mockWhere, innerJoin: mock() }));
      mockWhere.mockReset().mockImplementation(() => ({ limit: mockLimit, innerJoin: mock() }));
      mockLimit.mockReset().mockImplementation(() => Promise.resolve([]));

      // Replace db.insert so we can capture the values array.
      mockInsert = mock((_table: unknown) => ({
        values: mock((rows: unknown) => {
          insertValuesArg = rows;
          // Return a fake .returning() that resolves to the inserted rows
          // with synthetic ids, matching real drizzle behavior.
          return {
            returning: mock(() =>
              Promise.resolve(
                Array.isArray(rows)
                  ? rows.map((r, i) => ({ ...(r as Record<string, unknown>), id: 1000 + i }))
                  : [{ ...(rows as Record<string, unknown>), id: 1000 }]
              )
            ),
          };
        }),
      }));
      (db as Record<string, unknown>)['insert'] = mockInsert;
    });

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
      ]);
      // No wordlist / rulelist / masklist lookups for mode 3 with no IDs.
      // Next call is the fleet benchmark query; seed an empty fleet so
      // pickChunkSize falls back to FALLBACK_CHUNK_SIZE (10_000_000), which
      // exceeds the 10_000 keyspace - chunks should clamp at totalKeyspace.
      const benchmarkWhereReturning = mock(() => Promise.resolve([]));
      mockFrom.mockImplementationOnce(() => ({ where: mockWhere, innerJoin: mock() }));
      mockFrom.mockImplementationOnce(() => ({
        innerJoin: mock(() => ({ where: benchmarkWhereReturning })),
      }));

      const result = await generateTasksForAttack(7);

      // 10_000 keyspace, fallback chunk 10_000_000 -> single chunk.
      expect(result).toMatchObject({ count: 1 });
      expect(Array.isArray(insertValuesArg)).toBe(true);
      const rows = insertValuesArg as Array<Record<string, unknown>>;
      expect(rows).toHaveLength(1);
      const range = rows[0]?.['workRange'] as Record<string, unknown>;
      expect(range['start']).toBe(0);
      expect(range['end']).toBe(10000);
      expect(range['total']).toBe(10000);
    });

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
      ]);
      // Wordlist lookup returns a row, but mode 1 still falls through.
      mockLimit.mockResolvedValueOnce([{ lineCount: 5000 }]);

      const result = await generateTasksForAttack(8);
      expect(result).toMatchObject({ count: 1 });
      // Placeholder path passes a single object to .values(...), not an array.
      const row = (Array.isArray(insertValuesArg) ? insertValuesArg[0] : insertValuesArg) as Record<
        string,
        unknown
      >;
      const range = row?.['workRange'] as Record<string, unknown>;
      expect(range['start']).toBe(0);
      expect(range['end']).toBe(0);
      expect(range['total']).toBe(0);
    });
  });
} else {
  // Skipped in full suite — already validated in isolated first-phase run.
  // Using describe.skip so bun:test doesn't report zero tests from this file.
  describe.skip('assignNextTask (skipped — runs in isolated phase)', () => {
    test.skip('see isolated run', () => {});
  });
  describe.skip('reassignStaleTasks (skipped — runs in isolated phase)', () => {
    test.skip('see isolated run', () => {});
  });
  describe.skip('generateTasksForAttack (skipped — runs in isolated phase)', () => {
    test.skip('see isolated run', () => {});
  });
}
