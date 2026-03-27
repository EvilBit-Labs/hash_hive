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

  mock.module('../../src/db/index.js', () => ({
    db: {
      select: mockSelect,
      execute: mockExecute,
      insert: mock(() => ({
        values: mock(() => ({ returning: mock(() => Promise.resolve([])) })),
      })),
      update: mock(() => ({
        set: mock(() => ({
          where: mock(() => ({ returning: mock(() => Promise.resolve([])) })),
        })),
      })),
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

  const { assignNextTask } = await import('../../src/services/tasks.js');
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
} else {
  // Skipped in full suite — already validated in isolated first-phase run.
  // Using describe.skip so bun:test doesn't report zero tests from this file.
  describe.skip('assignNextTask (skipped — runs in isolated phase)', () => {
    test.skip('see isolated run', () => {});
  });
}
