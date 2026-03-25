/**
 * Tests verifying transitionCampaign invokes the correct task generation path
 * (inline generateTasksForAttack vs async qm.enqueue) based on the resolved
 * generation strategy at the 99/100 boundary.
 *
 * Uses _deps overrides instead of mock.module for dynamic imports, because
 * bun:test shares the module cache across test files — mock.module from
 * agent-api-contract.test.ts caches tasks.js before this file runs, making
 * mock.module here ineffective for dynamic imports within campaigns.ts.
 */
import { afterEach, describe, expect, mock, test } from 'bun:test';

const CHUNK_SIZE = 10_000_000;

// ─── Spies ──────────────────────────────────────────────────────────

const generateTasksForAttackSpy = mock(() => Promise.resolve({ tasks: [], count: 0 }));
const enqueueSpy = mock(() => Promise.resolve(true));

// ─── Mock modules (must be registered before importing the module under test) ──

// Mock db with chainable stubs
const makeCampaignRow = (overrides: Record<string, unknown> = {}) => ({
  id: 1,
  projectId: 1,
  name: 'Test Campaign',
  status: 'draft',
  priority: 5,
  hashListId: 1,
  description: null,
  progress: {},
  startedAt: null,
  completedAt: null,
  createdBy: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...overrides,
});

let mockAttacks: Array<Record<string, unknown>> = [];

mock.module('../../src/db/index.js', () => ({
  db: {
    select: mock(() => ({
      from: mock(() => {
        // getCampaignById path: campaigns table → returns campaign row
        // listAttacks path: attacks table → returns mockAttacks
        return {
          where: mock(() => ({
            limit: mock(() => Promise.resolve([makeCampaignRow()])),
            orderBy: mock(() => Promise.resolve(mockAttacks)),
          })),
          orderBy: mock(() => Promise.resolve(mockAttacks)),
        };
      }),
    })),
    update: mock(() => ({
      set: mock(() => ({
        where: mock(() => ({
          returning: mock(() => Promise.resolve([makeCampaignRow({ status: 'running' })])),
        })),
      })),
    })),
    insert: mock(() => ({
      values: mock(() => ({
        returning: mock(() => Promise.resolve([{}])),
        onConflictDoNothing: mock(() => Promise.resolve()),
      })),
    })),
  },
  client: {},
}));

mock.module('../../src/services/events.js', () => ({
  emitCampaignStatus: mock(() => {}),
}));

// Import module under test after DB/events mocks are registered
const { transitionCampaign, _deps } = await import('../../src/services/campaigns.js');

// Override _deps to inject spies directly — bypasses bun's shared module cache
_deps.getTasksModule = () =>
  Promise.resolve({ generateTasksForAttack: generateTasksForAttackSpy } as any);
_deps.getQueueContext = () =>
  Promise.resolve({
    getQueueManager: mock(() => ({
      getHealth: mock(() => Promise.resolve({ status: 'connected' })),
      enqueue: enqueueSpy,
    })),
  } as any);
_deps.getQueueConfig = () =>
  Promise.resolve({
    QUEUE_NAMES: { TASK_GENERATION: 'jobs-task-generation' },
  } as any);
_deps.getQueueTypes = () =>
  Promise.resolve({ JOB_PRIORITY: { HIGH: 1, NORMAL: 5, LOW: 10 } } as any);

// ─── Tests ──────────────────────────────────────────────────────────

describe('transitionCampaign task generation branching', () => {
  afterEach(() => {
    generateTasksForAttackSpy.mockClear();
    enqueueSpy.mockClear();
    mockAttacks = [];
  });

  test('calls generateTasksForAttack inline when estimated tasks < 100', async () => {
    // Single attack with no keyspace → 1 estimated task → inline strategy
    mockAttacks = [{ id: 10, keyspace: null, campaignId: 1 }];

    const result = await transitionCampaign(1, 'running');

    expect(result).toHaveProperty('campaign');
    expect(generateTasksForAttackSpy).toHaveBeenCalledTimes(1);
    expect(generateTasksForAttackSpy).toHaveBeenCalledWith(10);
    expect(enqueueSpy).not.toHaveBeenCalled();
  });

  test('calls generateTasksForAttack inline when estimated tasks = 99 (boundary)', async () => {
    // Single attack with keyspace producing exactly 99 chunks → inline strategy
    const keyspace = String(99 * CHUNK_SIZE);
    mockAttacks = [{ id: 15, keyspace, campaignId: 1 }];

    const result = await transitionCampaign(1, 'running');

    expect(result).toHaveProperty('campaign');
    expect(generateTasksForAttackSpy).toHaveBeenCalledTimes(1);
    expect(generateTasksForAttackSpy).toHaveBeenCalledWith(15);
    expect(enqueueSpy).not.toHaveBeenCalled();
  });

  test('enqueues to BullMQ when estimated tasks >= 100', async () => {
    // Single attack with keyspace producing exactly 100 chunks → async strategy
    const keyspace = String(100 * CHUNK_SIZE);
    mockAttacks = [{ id: 20, keyspace, campaignId: 1 }];

    const result = await transitionCampaign(1, 'running');

    expect(result).toHaveProperty('campaign');
    expect(enqueueSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSpy.mock.calls[0]?.[0]).toBe('jobs-task-generation');
    expect(generateTasksForAttackSpy).not.toHaveBeenCalled();
  });
});
