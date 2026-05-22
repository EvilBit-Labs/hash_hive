// Redis degradation regression coverage (AC #3). Gated as an isolated phase
// because the events.js mock is process-global and would leak into siblings.

import { describe, expect, mock, test } from 'bun:test';

const IS_ISOLATED = process.env['REDIS_DEGRADATION_TEST_ISOLATED'] === '1';
const describeIfIsolated = IS_ISOLATED ? describe : describe.skip;

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

// resolveGenerationStrategy switches to async at >= 100 chunks (MIN_CHUNK_SIZE = 1000).
const QUEUE_BOUND_ATTACKS = [{ id: 20, keyspace: String(100 * 1000), campaignId: 1 }];

// Captured by the db.update mock so individual tests can assert rollback.
const updatedRows: Array<Record<string, unknown>> = [];

// Helper: same dual-purpose mock as in campaign-transition.test.ts.
// validateCampaignResources awaits where() directly; the legacy
// campaign/attack chains use where().limit / .orderBy. Resolving
// where() to [{ id: 1 }] makes hashListId=1 look present so the
// resource validation gate passes and we reach the queue checks
// these tests target.
function makeAwaitableChain(defaultRows: unknown[], chain: Record<string, unknown>) {
  const promise = Promise.resolve(defaultRows);
  return Object.assign(promise, chain);
}

if (IS_ISOLATED) {
  mock.module('../../src/db/index.js', () => ({
    db: {
      select: mock(() => ({
        from: mock(() => ({
          where: mock(() =>
            makeAwaitableChain([{ id: 1 }], {
              limit: mock(() => Promise.resolve([makeCampaignRow()])),
              orderBy: mock(() => Promise.resolve(QUEUE_BOUND_ATTACKS)),
            })
          ),
        })),
      })),
      update: mock(() => ({
        set: mock((values: Record<string, unknown>) => {
          updatedRows.push(values);
          return {
            where: mock(() => ({
              returning: mock(() => Promise.resolve([makeCampaignRow({ status: 'running' })])),
            })),
          };
        }),
      })),
    },
    client: {},
  }));

  mock.module('../../src/services/events.js', () => ({
    emitCampaignStatus: mock(() => {}),
    emitAgentStatus: mock(() => {}),
    emitAgentError: mock(() => {}),
    emitTaskUpdate: mock(() => {}),
    emitCrackResult: mock(() => {}),
    emit: mock(() => {}),
    broadcastSystemEvent: mock(() => {}),
    broadcastSystemHealth: mock(() => {}),
    registerClient: mock(() => {}),
    unregisterClient: mock(() => {}),
    getClientCount: mock(() => 0),
    __resetEventsForTesting: mock(() => {}),
    SYSTEM_EVENT_PROJECT_ID: 0,
  }));
}

// Module evaluation deferred behind the gate so the shared phase doesn't load
// the real campaigns module unnecessarily.
type CampaignsModule = typeof import('../../src/services/campaigns.js');
let campaignsModule: CampaignsModule | null = null;
async function loadCampaigns(): Promise<CampaignsModule> {
  if (!campaignsModule) {
    campaignsModule = await import('../../src/services/campaigns.js');
    const { _deps } = campaignsModule;
    _deps.getQueueConfig = () =>
      Promise.resolve({
        QUEUE_NAMES: { TASK_GENERATION: 'jobs-task-generation' },
      } as never);
    _deps.getQueueTypes = () =>
      Promise.resolve({ JOB_PRIORITY: { HIGH: 1, NORMAL: 5, LOW: 10 } } as never);
    _deps.getTasksModule = () =>
      Promise.resolve({
        generateTasksForAttack: mock(() => Promise.resolve({ count: 0 })),
      } as never);
  }
  return campaignsModule;
}

describeIfIsolated('Redis degradation: dashboard/control surface', () => {
  test('transitionCampaign returns QUEUE_UNAVAILABLE when queue manager is null', async () => {
    const { transitionCampaign, _deps } = await loadCampaigns();
    _deps.getQueueContext = () => Promise.resolve({ getQueueManager: () => null } as never);

    const result = await transitionCampaign(1, 'running');

    expect(result).toEqual(
      expect.objectContaining({
        code: 'QUEUE_UNAVAILABLE',
        error: expect.stringContaining('Queue unavailable'),
      })
    );
  });

  test("transitionCampaign returns QUEUE_UNAVAILABLE when queue manager reports 'disconnected'", async () => {
    const { transitionCampaign, _deps } = await loadCampaigns();
    _deps.getQueueContext = () =>
      Promise.resolve({
        getQueueManager: () => ({
          getHealth: () => Promise.resolve({ status: 'disconnected', queues: {} }),
          enqueue: mock(() => Promise.resolve(false)),
        }),
      } as never);

    const result = await transitionCampaign(1, 'running');

    expect(result).toEqual(
      expect.objectContaining({
        code: 'QUEUE_UNAVAILABLE',
        error: expect.stringContaining('Queue unavailable'),
      })
    );
  });

  test('transitionCampaign rolls back and returns QUEUE_UNAVAILABLE when enqueue fails on the async path', async () => {
    // Health check passes, but enqueue returns false — covers the post-flight
    // rollback branch at campaigns.ts:380-415 that the prior two tests skip.
    const { transitionCampaign, _deps } = await loadCampaigns();
    updatedRows.length = 0;
    _deps.getQueueContext = () =>
      Promise.resolve({
        getQueueManager: () => ({
          getHealth: () => Promise.resolve({ status: 'connected', queues: {} }),
          enqueue: mock(() => Promise.resolve(false)),
        }),
      } as never);

    const result = await transitionCampaign(1, 'running');

    expect(result).toEqual(
      expect.objectContaining({
        code: 'QUEUE_UNAVAILABLE',
      })
    );
    // Rollback restored prior campaign state.
    const rollback = updatedRows.find((row) => row['status'] === 'draft');
    expect(rollback).toBeDefined();
    expect(rollback?.['startedAt']).toBeNull();
  });
});

describeIfIsolated('Redis degradation: agent surface (static guard)', () => {
  // Direct-import check, not closure walk — transitive imports through shared
  // services are fine and would false-positive. The four guarded files are
  // the only modules that execute on the agent request path.
  // Pattern matches both static `from '...'` and dynamic `import('...')`.
  const QUEUE_IMPORT_RE =
    /(?:from\s*|import\s*\(\s*)['"][^'"]*queue\/(?:context|manager)(?:\.js)?['"]/;

  const AGENT_PATH_FILES = [
    'routes/agent/index.ts',
    'services/agents.ts',
    'services/tasks.ts',
    'services/crackers.ts',
  ];

  test.each(
    AGENT_PATH_FILES
  )('agent-path module %s does not import queue/context or queue/manager', async (relPath) => {
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const file = path.resolve(import.meta.dirname, '../../src', relPath);
    const source = await fs.readFile(file, 'utf8');

    expect(source).not.toMatch(QUEUE_IMPORT_RE);
  });

  test('the agent route module does not reference QueueManager / getQueueManager directly', async () => {
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const agentIndex = path.resolve(import.meta.dirname, '../../src/routes/agent/index.ts');
    const source = await fs.readFile(agentIndex, 'utf8');

    expect(source).not.toMatch(/\b(getQueueManager|QueueManager)\b/);
  });
});
