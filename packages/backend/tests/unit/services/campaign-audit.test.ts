/**
 * Unit tests for U3 audit capture wiring — campaign CRUD + lifecycle + attacks.
 *
 * Mocks `recordAuditEvent` to assert call shapes without a real DB, and mocks
 * the db module so no Postgres connection is needed. All service functions are
 * imported after mocks are registered (bun:test's top-level-await ordering).
 *
 * Isolated because mock.module('db') leaks process-wide.
 * Run with: CAMPAIGN_AUDIT_TEST_ISOLATED=1 bun test ... tests/unit/services/campaign-audit.test.ts
 */
import { afterEach, describe, expect, it, mock } from 'bun:test'

const IS_ISOLATED = process.env['CAMPAIGN_AUDIT_TEST_ISOLATED'] === '1'

if (!IS_ISOLATED) {
  describe('campaign-audit (skipped — runs in isolated phase)', () => {
    it('signals isolation phase is required', () => {
      // oxlint-disable-next-line no-console -- surface phase-gating drift in CI logs
      console.warn(
        '[campaign-audit] skipped — set CAMPAIGN_AUDIT_TEST_ISOLATED=1 to run; the campaign-audit suite did NOT execute in this phase.'
      )
      expect(process.env['CAMPAIGN_AUDIT_TEST_ISOLATED']).toBeUndefined()
    })
  })
} else {
  // ─── recordAuditEvent spy ────────────────────────────────────────────────────

  const recordAuditEventSpy = mock(async () => ({ id: 1 }))

  mock.module('../../../src/services/audit-log.js', () => ({
    recordAuditEvent: recordAuditEventSpy,
  }))

  // ─── Row factories ───────────────────────────────────────────────────────────

  const makeCampaignRow = (overrides: Record<string, unknown> = {}) => ({
    id: 1,
    projectId: 10,
    name: 'Test Campaign',
    status: 'draft',
    priority: 5,
    hashListId: 1,
    description: null,
    progress: {},
    metadata: {},
    isPermanent: false,
    archivedAt: null,
    startedAt: null,
    completedAt: null,
    createdBy: 1,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  })

  const makeAttackRow = (overrides: Record<string, unknown> = {}) => ({
    id: 99,
    campaignId: 1,
    projectId: 10,
    mode: 0,
    hashTypeId: null,
    wordlistId: null,
    rulelistId: null,
    masklistId: null,
    advancedConfiguration: {},
    dependencies: [],
    keyspace: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  })

  // ─── DB mock ─────────────────────────────────────────────────────────────────
  //
  // updateCampaign, changeRunningCampaignPriority, createAttack, and deleteAttack
  // all use db.transaction internally. The tx mock must support select/update/
  // insert/delete so the mutation and the recordAuditEvent write (inside the
  // transaction) all work without a real DB.

  const makeTxMock = (campaignOverride: Record<string, unknown> = {}) => ({
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve([makeCampaignRow(campaignOverride)]),
        }),
      }),
    }),
    update: () => ({
      set: () => ({
        where: () => ({
          returning: () =>
            Promise.resolve([makeCampaignRow({ name: 'Updated', ...campaignOverride })]),
        }),
      }),
    }),
    // insert is used by both attack creation (returns attack row) and by
    // recordAuditEvent (returns audit row). Both callers only need a truthy
    // result with the fields they inspect, so makeAttackRow() is a safe
    // superset for both call sites.
    insert: () => ({
      values: () => ({
        returning: () => Promise.resolve([makeAttackRow()]),
      }),
    }),
    // delete is used by deleteAttack inside its transaction.
    delete: () => ({
      where: () => ({
        returning: () => Promise.resolve([makeAttackRow()]),
      }),
    }),
  })

  // campaignOverrides is mutable so individual tests can set different statuses
  // (e.g. 'running'/'paused' for changeRunningCampaignPriority).
  // capturedTx is set by the transaction wrapper so E1 tests can assert identity.
  const campaignState: {
    overrides: Record<string, unknown>
    capturedTx: ReturnType<typeof makeTxMock> | null
    staleState: boolean
  } = { overrides: {}, capturedTx: null, staleState: false }

  mock.module('../../../src/db/index.js', () => {
    return {
      db: {
        // top-level select (used by transitionCampaign's getCampaignById, listAttacks,
        // and updateAttack's existing-row fetch)
        select: () => ({
          from: () => ({
            where: () =>
              makeAwaitableChain([makeCampaignRow(campaignState.overrides)], {
                limit: () => Promise.resolve([makeCampaignRow(campaignState.overrides)]),
                orderBy: () => Promise.resolve([makeAttackRow()]),
              }),
            orderBy: () => Promise.resolve([makeAttackRow()]),
          }),
        }),
        // top-level update (used by transitionCampaign's status UPDATE and task cancel).
        // Returns [] when staleState is true so the service hits the STALE_STATE path.
        update: () => ({
          set: () => ({
            where: () => ({
              returning: () =>
                campaignState.staleState
                  ? Promise.resolve([])
                  : Promise.resolve([
                      makeCampaignRow({ status: 'paused', ...campaignState.overrides }),
                    ]),
            }),
          }),
        }),
        // top-level insert (used by recordAuditEvent on non-transactional paths,
        // e.g. transitionCampaign and updateAttack which pass no tx)
        insert: () => ({
          values: () => ({
            returning: () => Promise.resolve([{ id: 1 }]),
          }),
        }),
        // top-level delete (kept for completeness; deleteAttack now routes
        // through db.transaction so tx.delete handles the real call)
        delete: () => ({
          where: () => ({
            returning: () => Promise.resolve([makeAttackRow()]),
          }),
        }),
        // transaction: wraps updateCampaign / changeRunningCampaignPriority / deleteAttack.
        // Saves the tx handle so E1 tests can assert identity via toBe.
        transaction: async (fn: (tx: ReturnType<typeof makeTxMock>) => Promise<unknown>) => {
          const tx = makeTxMock({ status: 'running', ...campaignState.overrides })
          campaignState.capturedTx = tx
          return fn(tx)
        },
        client: {},
      },
      client: {},
    }
  })

  // ─── Helper for the select chain (mirrors db-mock.js makeAwaitableChain) ─────

  function makeAwaitableChain(
    result: unknown[],
    extras: Record<string, () => unknown> = {}
  ): Promise<unknown[]> & Record<string, () => unknown> {
    const p = Promise.resolve(result) as Promise<unknown[]> & Record<string, () => unknown>
    for (const [k, v] of Object.entries(extras)) {
      p[k] = v
    }
    return p
  }

  // ─── Dependency mocks ─────────────────────────────────────────────────────────

  mock.module('../../../src/services/events.js', () => ({
    emitCampaignStatus: mock(() => {}),
    emitResourceUpdate: mock(() => {}),
  }))

  mock.module('../../../src/services/campaign-resources.js', () => ({
    validateCampaignResources: mock(async () => ({
      valid: true,
      missing: [],
      reclaimed: [],
      archived: [],
    })),
    // `services/campaigns.js` re-exports this (issue #106 U12); the named
    // export fails to link if the campaign-resources.js mock omits it.
    findReclaimedResourceRefs: mock(async () => ({ reclaimed: [], archived: [] })),
  }))

  mock.module('../../../src/services/campaign-dag.js', () => ({
    validateCampaignDAG: mock(async () => ({ valid: true })),
    validateProposedDAG: mock(() => ({ valid: true })),
  }))

  mock.module('../../../src/services/attacks/complexity.js', () => ({
    computeAttackKeyspace: mock(async () => null),
    loadKeyspaceInputs: mock(async () => null),
    persistAttackKeyspace: mock(async () => null),
    recomputeKeyspaceForResource: mock(async () => null),
    estimateSecondsRemaining: mock(() => null),
  }))

  mock.module('../../../src/services/resources/line-count-trigger.js', () => ({
    enqueueLineCount: mock(async () => {}),
    enqueueLineCountForUncountedResources: mock(async () => {}),
    _lineCountDeps: {},
  }))

  mock.module('../../../src/config/logger.js', () => ({
    logger: {
      error: mock(() => {}),
      warn: mock(() => {}),
      info: mock(() => {}),
      debug: mock(() => {}),
    },
  }))

  // ─── Import modules under test (after all mocks) ─────────────────────────────

  const {
    createCampaign,
    updateCampaign,
    changeRunningCampaignPriority,
    transitionCampaign,
    createAttack,
    updateAttack,
    deleteAttack,
    _deps,
  } = await import('../../../src/services/campaigns.js')

  const { deleteCampaign } = await import('../../../src/services/campaign-dashboard.js')

  // Override _deps to inject no-op spies and bypass the queue/task dynamic imports
  _deps.getTasksModule = async () =>
    ({ generateTasksForAttack: async () => ({ tasks: [], count: 0 }) }) as never
  _deps.getQueueContext = async () =>
    ({
      getQueueManager: () => ({
        getHealth: async () => ({ status: 'connected' }),
        enqueue: async () => true,
      }),
    }) as never
  _deps.getQueueConfig = async () =>
    ({ QUEUE_NAMES: { TASK_GENERATION: 'gen', PREEMPTION: 'pre' } }) as never
  _deps.getQueueTypes = async () => ({ JOB_PRIORITY: { HIGH: 1, NORMAL: 5, LOW: 10 } }) as never

  // ─── Test actors ──────────────────────────────────────────────────────────────

  const USER_ACTOR = { actorType: 'user' as const, actorId: 42 }
  const SYSTEM_ACTOR = { actorType: 'system' as const, actorId: null }

  // ─── Tests ───────────────────────────────────────────────────────────────────

  describe('U3 — campaign audit capture', () => {
    afterEach(() => {
      recordAuditEventSpy.mockClear()
      campaignState.overrides = {}
      campaignState.capturedTx = null
      campaignState.staleState = false
    })

    // ── createCampaign ──────────────────────────────────────────────────────────

    describe('createCampaign', () => {
      it('calls recordAuditEvent with action=created and user actor', async () => {
        const result = await createCampaign(
          { projectId: 10, name: 'New Campaign', hashListId: 1 },
          USER_ACTOR
        )
        expect(result).not.toBeNull()
        expect(recordAuditEventSpy).toHaveBeenCalledTimes(1)
        const [input] = recordAuditEventSpy.mock.calls[0]!
        expect(input.action).toBe('created')
        expect(input.entityType).toBe('campaign')
        expect(input.actor).toEqual(USER_ACTOR)
        expect(input.projectId).toBe(10)
        expect(input.newRow).toBeDefined()
        expect(input.oldRow).toBeUndefined()
      })

      it('uses system actor when called without actor param', async () => {
        await createCampaign({ projectId: 10, name: 'New Campaign', hashListId: 1 })
        expect(recordAuditEventSpy).toHaveBeenCalledTimes(1)
        const [input] = recordAuditEventSpy.mock.calls[0]!
        expect(input.actor).toEqual(SYSTEM_ACTOR)
      })
    })

    // ── deleteCampaign ──────────────────────────────────────────────────────────

    describe('deleteCampaign', () => {
      it('calls recordAuditEvent with action=deleted and user actor on successful delete', async () => {
        // The tx mock returns a 'running' campaign by default; set status=draft and
        // isPermanent=false so the delete guard allows the operation through.
        campaignState.overrides = { status: 'draft', isPermanent: false }
        const result = await deleteCampaign(1, 10, USER_ACTOR)
        expect(result.kind).toBe('deleted')
        expect(recordAuditEventSpy).toHaveBeenCalledTimes(1)
        const [input] = recordAuditEventSpy.mock.calls[0]!
        expect(input.action).toBe('deleted')
        expect(input.entityType).toBe('campaign')
        expect(input.actor).toEqual(USER_ACTOR)
        expect(input.projectId).toBe(10)
        expect(input.oldRow).toBeDefined()
        expect(input.newRow).toBeUndefined()
      })

      it('uses system actor when called without actor param', async () => {
        campaignState.overrides = { status: 'draft', isPermanent: false }
        await deleteCampaign(1, 10)
        expect(recordAuditEventSpy).toHaveBeenCalledTimes(1)
        const [input] = recordAuditEventSpy.mock.calls[0]!
        expect(input.actor).toEqual(SYSTEM_ACTOR)
      })

      it('does NOT call recordAuditEvent when campaign is not_draft', async () => {
        // Default overrides: status='running' — the guard returns not_draft early.
        campaignState.overrides = { status: 'running', isPermanent: false }
        const result = await deleteCampaign(1, 10, USER_ACTOR)
        expect(result.kind).toBe('not_draft')
        expect(recordAuditEventSpy).not.toHaveBeenCalled()
      })
    })

    // ── updateCampaign ──────────────────────────────────────────────────────────

    describe('updateCampaign', () => {
      it('calls recordAuditEvent with action=updated and user actor', async () => {
        const result = await updateCampaign(1, 10, { name: 'New Name' }, USER_ACTOR)
        expect(result.kind).toBe('updated')
        expect(recordAuditEventSpy).toHaveBeenCalledTimes(1)
        const [input] = recordAuditEventSpy.mock.calls[0]!
        expect(input.action).toBe('updated')
        expect(input.entityType).toBe('campaign')
        expect(input.entityId).toBe(1)
        expect(input.actor).toEqual(USER_ACTOR)
        expect(input.projectId).toBe(10)
      })

      it('uses system actor when called without actor param', async () => {
        await updateCampaign(1, 10, { name: 'New Name' })
        expect(recordAuditEventSpy).toHaveBeenCalledTimes(1)
        const [input] = recordAuditEventSpy.mock.calls[0]!
        expect(input.actor).toEqual(SYSTEM_ACTOR)
      })

      it('forwards the transaction handle as the executor argument (E1)', async () => {
        // updateCampaign wraps in db.transaction; recordAuditEvent receives tx as 2nd arg.
        // campaignState.capturedTx is set by the transaction wrapper above, so we can
        // assert exact object identity — confirming the same tx handle is forwarded.
        await updateCampaign(1, 10, { name: 'New Name' }, USER_ACTOR)
        expect(campaignState.capturedTx).not.toBeNull()
        expect(recordAuditEventSpy.mock.calls[0]?.[1]).toBe(campaignState.capturedTx)
      })
    })

    // ── changeRunningCampaignPriority ───────────────────────────────────────────

    describe('changeRunningCampaignPriority', () => {
      it('calls recordAuditEvent with action=updated carrying user actor', async () => {
        // The tx mock returns a 'running' status row by default
        campaignState.overrides = { status: 'running' }
        const result = await changeRunningCampaignPriority(1, 10, 1, USER_ACTOR)
        expect(result.kind).toBe('updated')
        expect(recordAuditEventSpy).toHaveBeenCalledTimes(1)
        const [input] = recordAuditEventSpy.mock.calls[0]!
        expect(input.action).toBe('updated')
        expect(input.entityType).toBe('campaign')
        expect(input.actor).toEqual(USER_ACTOR)
      })
    })

    // ── transitionCampaign ──────────────────────────────────────────────────────

    describe('transitionCampaign', () => {
      it('calls recordAuditEvent with action=status_changed on committed transition', async () => {
        // draft → cancelled is a valid transition in VALID_TRANSITIONS
        const result = await transitionCampaign(1, 'cancelled', USER_ACTOR)
        expect('campaign' in result).toBe(true)
        expect(recordAuditEventSpy).toHaveBeenCalledTimes(1)
        const [input] = recordAuditEventSpy.mock.calls[0]!
        expect(input.action).toBe('status_changed')
        expect(input.fromStatus).toBe('draft')
        expect(input.toStatus).toBe('cancelled')
        expect(input.entityType).toBe('campaign')
        expect(input.actor).toEqual(USER_ACTOR)
      })

      it('records system actor when called without actor param (worker path)', async () => {
        // draft → cancelled is a valid transition in VALID_TRANSITIONS
        await transitionCampaign(1, 'cancelled')
        expect(recordAuditEventSpy).toHaveBeenCalledTimes(1)
        const [input] = recordAuditEventSpy.mock.calls[0]!
        expect(input.actor).toEqual(SYSTEM_ACTOR)
      })

      it('does NOT call recordAuditEvent on STALE_STATE (0 affected rows) (E2)', async () => {
        // Force db.update().returning() to return [] — the STALE_STATE condition.
        campaignState.staleState = true
        const result = await transitionCampaign(1, 'cancelled', USER_ACTOR)
        expect((result as { code: string }).code).toBe('STALE_STATE')
        expect(recordAuditEventSpy).not.toHaveBeenCalled()
      })
    })

    // ── attack CRUD ─────────────────────────────────────────────────────────────

    describe('attack CRUD', () => {
      it('createAttack calls recordAuditEvent with action=created, entityType=attack', async () => {
        await createAttack({ campaignId: 1, projectId: 10, mode: 0 }, USER_ACTOR)
        expect(recordAuditEventSpy).toHaveBeenCalledTimes(1)
        const [input] = recordAuditEventSpy.mock.calls[0]!
        expect(input.action).toBe('created')
        expect(input.entityType).toBe('attack')
        expect(input.actor).toEqual(USER_ACTOR)
      })

      it('updateAttack calls recordAuditEvent with action=updated', async () => {
        await updateAttack(99, { mode: 3 }, USER_ACTOR)
        expect(recordAuditEventSpy).toHaveBeenCalledTimes(1)
        const [input] = recordAuditEventSpy.mock.calls[0]!
        expect(input.action).toBe('updated')
        expect(input.entityType).toBe('attack')
        expect(typeof input.entityId).toBe('number')
        expect(input.actor).toEqual(USER_ACTOR)
      })

      it('deleteAttack calls recordAuditEvent with action=deleted', async () => {
        await deleteAttack(99, USER_ACTOR)
        expect(recordAuditEventSpy).toHaveBeenCalledTimes(1)
        const [input] = recordAuditEventSpy.mock.calls[0]!
        expect(input.action).toBe('deleted')
        expect(input.entityType).toBe('attack')
        expect(input.actor).toEqual(USER_ACTOR)
      })

      it('deleteAttack forwards the transaction handle as the executor argument (E1)', async () => {
        // deleteAttack wraps its mutation in db.transaction; recordAuditEvent must
        // receive the same tx handle so the audit row is atomic with the delete.
        // campaignState.capturedTx is set by the transaction wrapper, enabling
        // exact object identity assertion.
        await deleteAttack(99, USER_ACTOR)
        expect(campaignState.capturedTx).not.toBeNull()
        expect(recordAuditEventSpy.mock.calls[0]?.[1]).toBe(campaignState.capturedTx)
      })

      it('attack functions use system actor when called without actor param', async () => {
        await createAttack({ campaignId: 1, projectId: 10, mode: 0 })
        expect(recordAuditEventSpy.mock.calls[0]![0].actor).toEqual(SYSTEM_ACTOR)
      })
    })
  })
}
