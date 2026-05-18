/**
 * Redis degradation policy regression coverage.
 *
 * AC #3 of the BullMQ Queue Architecture spec requires:
 *   - Agent endpoints (`/api/v1/agent/*`) keep functioning when Redis is down
 *   - Dashboard/control operations requiring async processing return a
 *     `QUEUE_UNAVAILABLE` error envelope
 *
 * This file exercises the contract at three layers:
 *   1. `transitionCampaign(_, 'running')` returns `{ error, code:
 *      'QUEUE_UNAVAILABLE' }` when the queue manager is null
 *   2. ...and when the queue manager exists but `getHealth()` reports
 *      disconnected
 *   3. Direct-import guard on the agent-path entrypoints (`routes/agent/*`
 *      plus `services/{agents,tasks,crackers}.ts`). Those files must not
 *      import from `queue/context` or `queue/manager`. Adding a queue
 *      dependency to any of them silently regresses AC #3 by definition,
 *      since they are the only modules that execute on an agent request.
 *
 * Pattern follows `tests/unit/campaign-transition.test.ts` (uses
 * `_deps.getQueueContext` injection rather than `mock.module`, because
 * bun:test's shared module cache makes module-level mocks fragile
 * across files).
 *
 * The dashboard-route mapping (transitionCampaign → 503 SERVICE_UNAVAILABLE
 * response envelope) is exercised in tests/unit/dashboard-campaigns-routes.test.ts
 * and tests/unit/control-routes-rbac.test.ts; this file owns the service
 * boundary and the import-graph guard.
 */

import { describe, expect, mock, test } from 'bun:test';

// bun:test mocks are process-global; campaigns.ts pulls events.js via a
// minimal mock here, which would otherwise leak an incomplete events module
// into sibling tests that need broadcastSystemHealth/emitAgentError/etc.
// Run this file in an isolated bun:test phase via REDIS_DEGRADATION_TEST_ISOLATED=1
// so the campaigns.ts module cache is hermetic to this file's overrides and
// the shared phase sees the real events module.
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

// One attack with enough keyspace to force the async / queue path
// (resolveGenerationStrategy switches to async at >= 100 estimated chunks
// using MIN_CHUNK_SIZE = 1000 per chunk; we use 100k keyspace to be safe).
const QUEUE_BOUND_ATTACKS = [{ id: 20, keyspace: String(100 * 1000), campaignId: 1 }];

if (IS_ISOLATED) {
  mock.module('../../src/db/index.js', () => ({
    db: {
      select: mock(() => ({
        from: mock(() => ({
          where: mock(() => ({
            limit: mock(() => Promise.resolve([makeCampaignRow()])),
            orderBy: mock(() => Promise.resolve(QUEUE_BOUND_ATTACKS)),
          })),
        })),
      })),
      update: mock(() => ({
        set: mock(() => ({
          where: mock(() => ({
            returning: mock(() => Promise.resolve([makeCampaignRow({ status: 'running' })])),
          })),
        })),
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

const { transitionCampaign, _deps } = await import('../../src/services/campaigns.js');

if (IS_ISOLATED) {
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

describeIfIsolated('Redis degradation: dashboard/control surface', () => {
  test('transitionCampaign returns QUEUE_UNAVAILABLE when queue manager is null', async () => {
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
});

describeIfIsolated('Redis degradation: agent surface (static guard)', () => {
  /**
   * Direct-import guard on the entrypoints that handle agent traffic. The
   * surface stays queue-free *by construction* — handlers in
   * `routes/agent/index.ts` and the service modules they call directly
   * (`services/agents.ts`, `services/tasks.ts`, `services/crackers.ts`,
   * `services/resources.ts` for `getAgentDownloadUrl`) must not import
   * `queue/context` or `queue/manager` from the modules they execute on
   * the agent path. Transitive imports through `services/resources.ts`'s
   * hash-list upload path are fine — those code paths are dashboard-only,
   * not invoked from an agent handler — so the guard checks direct
   * imports rather than walking the full closure (the closure walk would
   * false-positive on every shared service).
   *
   * Token-based regex over `from '<spec>'` avoids false positives on
   * comments and string literals. The regression a future contributor
   * has to introduce to break AC #3 is direct: adding a queue/context
   * import to an agent route handler or to one of the agent-only service
   * paths. This guard catches that.
   */
  const QUEUE_IMPORT_RE = /from\s*['"][^'"]*queue\/(?:context|manager)(?:\.js)?['"]/;

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
