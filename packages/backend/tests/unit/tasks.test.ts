import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';

// ─── DB mock ────────────────────────────────────────────────────────
// Mock the db module before importing the service under test.

const mockSelect = mock(() => ({ from: mockFrom }));
const mockFrom = mock(() => ({ where: mockWhere, innerJoin: mock() }));
const mockWhere = mock(() => ({ limit: mockLimit, innerJoin: mock() }));
const mockLimit = mock(() => Promise.resolve([]));
const mockExecute = mock(() => Promise.resolve([]));

mock.module('../../src/db/index.js', () => ({
  db: {
    select: mockSelect,
    execute: mockExecute,
    insert: mock(() => ({ values: mock(() => ({ returning: mock(() => Promise.resolve([])) })) })),
    update: mock(() => ({
      set: mock(() => ({
        where: mock(() => ({ returning: mock(() => Promise.resolve([])) })),
      })),
    })),
    transaction: mock(),
  },
}));

// Mock events to avoid side effects
mock.module('../../src/services/events.js', () => ({
  emitCrackResult: mock(),
  emitTaskUpdate: mock(),
}));

// Mock campaigns service
mock.module('../../src/services/campaigns.js', () => ({
  updateCampaignProgress: mock(),
}));

// Import after mocks are set up
const { assignNextTask } = await import('../../src/services/tasks.js');
const { db } = await import('../../src/db/index.js');

// ─── Tests ──────────────────────────────────────────────────────────

describe('assignNextTask', () => {
  beforeEach(() => {
    // Reset all mocks
    mockSelect.mockClear();
    mockFrom.mockClear();
    mockWhere.mockClear();
    mockLimit.mockClear();
    mockExecute.mockClear();
  });

  test('returns null when agent does not exist', async () => {
    // Agent lookup returns empty array
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
    // Agent lookup: online agent with NO GPU and limited hash modes
    mockLimit.mockResolvedValueOnce([
      {
        id: 1,
        projectId: 1,
        status: 'online',
        capabilities: { gpu: false, hashModes: [0] },
      },
    ]);

    // The atomic CTE query returns empty (no rows match the capability predicate)
    mockExecute.mockResolvedValueOnce([]);

    const result = await assignNextTask(1);
    expect(result).toBeNull();
    // Verify that db.execute was called (atomic SQL path)
    expect(mockExecute).toHaveBeenCalled();
  });

  test('assigns task when agent capabilities match via DB predicate', async () => {
    // Raw SQL returns snake_case; assignNextTask maps to camelCase for the public API
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
      workRange: { start: 0, end: 10000000, total: 10000000 },
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

    // Agent lookup: online agent with matching capabilities
    mockLimit.mockResolvedValueOnce([
      {
        id: 1,
        projectId: 1,
        status: 'online',
        capabilities: { gpu: true, hashModes: [0, 1000, 3000] },
      },
    ]);

    // The atomic CTE query returns the raw snake_case row
    mockExecute.mockResolvedValueOnce([rawDbRow]);

    const result = await assignNextTask(1);
    expect(result).not.toBeNull();
    // Public API should return camelCase keys
    expect(result).toEqual(expectedCamelCase);
    expect(mockExecute).toHaveBeenCalled();
  });

  test('uses SQL-level predicate, not app-layer filtering', async () => {
    // Agent with specific capabilities
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

    // Verify db.execute was called (raw SQL CTE path) instead of
    // db.transaction with app-layer .find()
    expect(mockExecute).toHaveBeenCalledTimes(1);
    // db.transaction should NOT have been called — atomic CTE replaces it
    expect((db as Record<string, unknown>)['transaction']).not.toHaveBeenCalled();
  });
});
