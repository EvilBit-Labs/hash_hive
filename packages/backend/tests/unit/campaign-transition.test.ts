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
// Mutable so a test can drive getCampaignById's status (e.g. 'running' for
// the stop-cascade test). Default empty → 'draft'.
let campaignOverrides: Record<string, unknown> = {}
// Captures the WHERE of the tasks cancel-cascade UPDATE (status='cancelled').
let capturedCancelWhere: unknown

// Shared mock helper: makes where() awaitable AND chainable to
// limit/orderBy. validateCampaignResources awaits where() directly;
// the legacy campaign/attack chains use where().limit / .orderBy.
import { makeAwaitableChain } from '../helpers/db-mock.js'

mock.module('../../src/db/index.js', () => ({
  db: {
    select: mock(() => ({
      from: mock(() =>
        // For validateCampaignResources lookups (no further chain), where()
        // is awaited directly and should resolve to [{ id: 1 }] so the
        // hashListId=1 reference is treated as existing. For the legacy
        // campaign/attack chains, the `.limit` / `.orderBy` methods are
        // attached to the same returned object.
        ({
          where: mock(() =>
            makeAwaitableChain([{ id: 1 }], {
              limit: mock(() => Promise.resolve([makeCampaignRow(campaignOverrides)])),
              orderBy: mock(() => Promise.resolve(mockAttacks)),
            })
          ),
          orderBy: mock(() => Promise.resolve(mockAttacks)),
        })
      ),
    })),
    update: mock(() => ({
      set: mock((payload: Record<string, unknown>) => ({
        where: mock((w: unknown) => {
          // The cancel cascade is the only UPDATE that sets status='cancelled'.
          if (payload['status'] === 'cancelled') capturedCancelWhere = w
          return {
            returning: mock(() => Promise.resolve([makeCampaignRow({ status: 'running' })])),
          }
        }),
      })),
    })),
    insert: mock(() => ({
      values: mock(() => ({
        returning: mock(() => Promise.resolve([{}])),
        onConflictDoNothing: mock(() => Promise.resolve()),
      })),
    })),
    // changeRunningCampaignPriority wraps its SELECT + UPDATE in a transaction.
    // The tx object re-uses the same select/update/insert mocks so existing
    // test assertions on those mocks are unchanged.
    transaction: mock(async (fn: (tx: Record<string, unknown>) => Promise<unknown>) => {
      const tx = {
        select: mock(() => ({
          from: mock(() => ({
            where: mock(() =>
              makeAwaitableChain([{ id: 1 }], {
                limit: mock(() => Promise.resolve([makeCampaignRow(campaignOverrides)])),
                orderBy: mock(() => Promise.resolve(mockAttacks)),
              })
            ),
            orderBy: mock(() => Promise.resolve(mockAttacks)),
          })),
        })),
        update: mock(() => ({
          set: mock((payload: Record<string, unknown>) => ({
            where: mock((w: unknown) => {
              if (payload['status'] === 'cancelled') capturedCancelWhere = w
              return {
                returning: mock(() => Promise.resolve([makeCampaignRow({ status: 'running' })])),
              }
            }),
          })),
        })),
        insert: mock(() => ({
          values: mock(() => ({
            returning: mock(() => Promise.resolve([{}])),
            onConflictDoNothing: mock(() => Promise.resolve()),
          })),
        })),
      }
      return fn(tx)
    }),
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

// campaigns.ts now imports audit-log.js (U3). Mock it so the transition
// tests don't need a real db.insert for audit rows.
mock.module('../../src/services/audit-log.js', () => ({
  recordAuditEvent: mock(() => Promise.resolve({ id: 1 })),
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

// Recursively collect string literals from a drizzle SQL object's chunks so
// a test can assert the rendered filter without a real DB. StringChunks carry
// `value: string[]`; composite SQL carries `queryChunks`.
function collectSqlStrings(node: unknown): string {
  if (node == null) return ''
  if (typeof node === 'string') return node
  const obj = node as Record<string, unknown>
  if (Array.isArray(obj['value']) && obj['value'].every((v) => typeof v === 'string')) {
    return (obj['value'] as string[]).join(' ')
  }
  if (Array.isArray(obj['queryChunks'])) {
    return (obj['queryChunks'] as unknown[]).map(collectSqlStrings).join(' ')
  }
  return ''
}

// ─── Tests ──────────────────────────────────────────────────────────

describe('transitionCampaign task generation branching', () => {
  afterEach(() => {
    generateTasksForAttackSpy.mockClear()
    enqueueSpy.mockClear()
    mockAttacks = []
    campaignOverrides = {}
    capturedCancelWhere = undefined
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

  test("stopping a running campaign cancels 'paused' tasks too (#97 U8)", async () => {
    // getCampaignById returns a running campaign so running → draft is a
    // valid stop transition that fires the cancel cascade.
    campaignOverrides = { status: 'running' }

    await transitionCampaign(1, 'draft')

    expect(capturedCancelWhere).toBeDefined()
    // The cancel filter must include 'paused' so preempted tasks are
    // cancelled rather than orphaned (they're excluded from the stale sweep).
    expect(collectSqlStrings(capturedCancelWhere)).toContain('paused')
  })
})
