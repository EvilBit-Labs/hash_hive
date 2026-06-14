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
import { afterEach, describe, expect, mock, test } from 'bun:test'

// Matches resolveGenerationStrategy's worst-case estimator basis
// (MIN_CHUNK_SIZE). The estimator switched from a 10M legacy constant to
// MIN_CHUNK_SIZE = 1000 so the chunk-count estimate is an upper bound on
// what generateTasksForAttack actually emits at runtime.
const CHUNK_SIZE = 1000

// ─── Spies ──────────────────────────────────────────────────────────

const generateTasksForAttackSpy = mock(() => Promise.resolve({ tasks: [], count: 0 }))
const enqueueSpy = mock(() => Promise.resolve(true))

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
})

let mockAttacks: Array<Record<string, unknown>> = []

// Shared mock helper: makes where() awaitable AND chainable to
// limit/orderBy. validateCampaignResources awaits where() directly;
// the legacy campaign/attack chains use where().limit / .orderBy.
import { makeAwaitableChain } from '../helpers/db-mock.js'

mock.module('../../src/db/index.js', () => ({
  db: {
    select: mock(() => ({
      from: mock(() => // For validateCampaignResources lookups (no further chain), where()
      // is awaited directly and should resolve to [{ id: 1 }] so the
      // hashListId=1 reference is treated as existing. For the legacy
      // campaign/attack chains, the `.limit` / `.orderBy` methods are
      // attached to the same returned object.
      ({
        where: mock(() =>
          makeAwaitableChain([{ id: 1 }], {
            limit: mock(() => Promise.resolve([makeCampaignRow()])),
            orderBy: mock(() => Promise.resolve(mockAttacks)),
          })
        ),
        orderBy: mock(() => Promise.resolve(mockAttacks)),
      })),
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
}))

// Partial mock: only what this test file needs. See agent-api-contract
// for the rationale (process-wide merge means listing more exports here
// would replace the real ones for events.test.ts on Linux).
mock.module('../../src/services/events.js', () => ({
  emitCampaignStatus: mock(() => {}),
  emitResourceUpdate: mock(() => {}),
}))

// Import module under test after DB/events mocks are registered
const { transitionCampaign, enqueuePreemptionEvaluation, changeRunningCampaignPriority, _deps } =
  await import('../../src/services/campaigns.js')

// Override _deps to inject spies directly — bypasses bun's shared module cache
_deps.getTasksModule = () =>
  Promise.resolve({ generateTasksForAttack: generateTasksForAttackSpy } as any)
_deps.getQueueContext = () =>
  Promise.resolve({
    getQueueManager: mock(() => ({
      getHealth: mock(() => Promise.resolve({ status: 'connected' })),
      enqueue: enqueueSpy,
    })),
  } as any)
_deps.getQueueConfig = () =>
  Promise.resolve({
    QUEUE_NAMES: { TASK_GENERATION: 'jobs-task-generation', PREEMPTION: 'jobs-preemption' },
  } as any)
_deps.getQueueTypes = () =>
  Promise.resolve({ JOB_PRIORITY: { HIGH: 1, NORMAL: 5, LOW: 10 } } as any)

// ─── Tests ──────────────────────────────────────────────────────────

describe('transitionCampaign task generation branching', () => {
  afterEach(() => {
    generateTasksForAttackSpy.mockClear()
    enqueueSpy.mockClear()
    mockAttacks = []
  })

  test('calls generateTasksForAttack inline when estimated tasks < 100', async () => {
    // Single attack with no keyspace → 1 estimated task → inline strategy
    mockAttacks = [{ id: 10, keyspace: null, campaignId: 1 }]

    const result = await transitionCampaign(1, 'running')

    expect(result).toHaveProperty('campaign')
    expect(generateTasksForAttackSpy).toHaveBeenCalledTimes(1)
    expect(generateTasksForAttackSpy).toHaveBeenCalledWith(10)
    // Inline generation does not enqueue task generation (the preemption
    // evaluation enqueue, #97 U5, is asserted separately).
    expect(enqueueSpy.mock.calls.some((c) => c[0] === 'jobs-task-generation')).toBe(false)
  })

  test('calls generateTasksForAttack inline when estimated tasks = 99 (boundary)', async () => {
    // Single attack with keyspace producing exactly 99 chunks → inline strategy
    const keyspace = String(99 * CHUNK_SIZE)
    mockAttacks = [{ id: 15, keyspace, campaignId: 1 }]

    const result = await transitionCampaign(1, 'running')

    expect(result).toHaveProperty('campaign')
    expect(generateTasksForAttackSpy).toHaveBeenCalledTimes(1)
    expect(generateTasksForAttackSpy).toHaveBeenCalledWith(15)
    expect(enqueueSpy.mock.calls.some((c) => c[0] === 'jobs-task-generation')).toBe(false)
  })

  test('enqueues to BullMQ when estimated tasks >= 100', async () => {
    // Single attack with keyspace producing exactly 100 chunks → async strategy
    const keyspace = String(100 * CHUNK_SIZE)
    mockAttacks = [{ id: 20, keyspace, campaignId: 1 }]

    const result = await transitionCampaign(1, 'running')

    expect(result).toHaveProperty('campaign')
    expect(enqueueSpy.mock.calls.some((c) => c[0] === 'jobs-task-generation')).toBe(true)
    expect(generateTasksForAttackSpy).not.toHaveBeenCalled()
  })

  test('enqueues a deduped preemption evaluation on → running (#97 U5)', async () => {
    mockAttacks = [{ id: 10, keyspace: null, campaignId: 1 }]

    await transitionCampaign(1, 'running')

    const preemptCall = enqueueSpy.mock.calls.find((c) => c[0] === 'jobs-preemption')
    expect(preemptCall).toBeDefined()
    // Payload carries the project id; jobId dedups per project.
    const [, payload, opts] = preemptCall as unknown as [
      string,
      { projectId: number },
      { jobId: string },
    ]
    expect(payload.projectId).toBeGreaterThan(0)
    expect(opts.jobId).toContain('preempt:')
  })

  test('enqueuePreemptionEvaluation enqueues a deduped per-project job (#97 U6)', async () => {
    // Shared by every preemption trigger (campaign start, terminal/draft
    // transitions, task completion, priority change).
    await enqueuePreemptionEvaluation(7)

    const call = enqueueSpy.mock.calls.find((c) => c[0] === 'jobs-preemption')
    expect(call).toBeDefined()
    const [, payload, opts] = call as unknown as [string, { projectId: number }, { jobId: string }]
    expect(payload.projectId).toBe(7)
    expect(opts.jobId).toBe('preempt:7')
  })

  test('changeRunningCampaignPriority updates a live campaign and triggers preemption (#97 U7)', async () => {
    // The db update mock returns a running campaign row → kind 'updated'.
    const result = await changeRunningCampaignPriority(1, 1, 1)

    expect(result).toMatchObject({ kind: 'updated' })
    expect(enqueueSpy.mock.calls.some((c) => c[0] === 'jobs-preemption')).toBe(true)
  })
})
