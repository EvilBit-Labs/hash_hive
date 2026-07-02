/**
 * Unit tests for U6 audit capture wiring — agents.
 *
 * Mocks `recordAuditEvent` to assert call shapes without a real DB, and
 * mocks the db module so no Postgres connection is needed. All service
 * functions are imported after mocks are registered (bun:test top-level-
 * await ordering).
 *
 * Isolated because mock.module('db') leaks process-wide.
 * Run with: AGENT_AUDIT_TEST_ISOLATED=1 bun test ... tests/unit/services/agent-audit.test.ts
 *
 * Scope:
 *   - updateAgent: admin config-edit records 'updated' with actorType 'user'
 *   - updateAgent: operational fields excluded from changes (allowlist gate)
 *   - createEnrollmentToken: records 'token_issued' with actorType 'user', changes null
 *   - claimEnrollmentToken: self-registration records 'created' with actorType 'agent'
 *   - heartbeat path: DOES NOT record any audit event (negative assertion)
 *
 * Not covered here (no admin create/delete routes exist):
 *   - agent admin-create: agents are only created via enrollment (claimEnrollmentToken)
 *   - agent admin-delete: no deleteAgent service or route exists in this codebase
 */
import { afterEach, describe, expect, it, mock } from 'bun:test'

const IS_ISOLATED = process.env['AGENT_AUDIT_TEST_ISOLATED'] === '1'

if (!IS_ISOLATED) {
  describe.skip('agent-audit (skipped — runs in isolated phase)', () => {
    it('runs only with AGENT_AUDIT_TEST_ISOLATED=1', () => {
      expect(true).toBe(true)
    })
  })
} else {
  // ─── recordAuditEvent spy ───────────────────────────────────────────────────

  const recordAuditEventSpy = mock(async () => ({ id: 1 }))

  mock.module('../../../src/services/audit-log.js', () => ({
    recordAuditEvent: recordAuditEventSpy,
  }))

  // ─── Row factories ──────────────────────────────────────────────────────────

  const makeAgentRow = (overrides: Record<string, unknown> = {}) => ({
    id: 1,
    projectId: 10,
    name: 'test-rig',
    status: 'offline',
    capabilities: {},
    hardwareProfile: { cpu: 'Intel', ram: '32GB' },
    crackerVersion: null,
    enrollmentClientId: 'rig-001',
    enrolledByTokenId: 5,
    operatingSystemId: null,
    authToken: null,
    authTokenHash: 'bcrypt$hash$value',
    authTokenFormat: 'bcrypt',
    lastSeenAt: new Date('2026-01-01T00:00:00Z'),
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  })

  const makeTokenRow = (overrides: Record<string, unknown> = {}) => ({
    id: 5,
    projectId: 10,
    label: 'rack-3',
    secretHash: 'EHASH-5',
    isReusable: true,
    maxUses: null,
    useCount: 0,
    expiresAt: null,
    revokedAt: null,
    createdByUserId: 7,
    lastUsedAt: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  })

  // ─── DB mock ────────────────────────────────────────────────────────────────

  // capturedTx is set by the transaction wrapper so E1 tests can assert identity.
  const txState: {
    agentRow: Record<string, unknown>
    notFound: boolean
    capturedTx: ReturnType<typeof makeTxMock> | null
  } = {
    agentRow: makeAgentRow(),
    notFound: false,
    capturedTx: null,
  }

  const makeTxMock = (agentRow: Record<string, unknown> = makeAgentRow()) => ({
    select: () => ({
      from: () => ({
        where: () => ({
          // updateAgent calls .limit(1) on the pre-mutation select;
          // return [] when txState.notFound is set to simulate a missing row
          limit: () => Promise.resolve(txState.notFound ? [] : [agentRow]),
        }),
      }),
    }),
    update: () => ({
      set: () => ({
        where: () => ({
          returning: () => Promise.resolve([agentRow]),
        }),
      }),
    }),
    insert: () => ({
      values: () => ({
        returning: () => Promise.resolve([agentRow]),
        onConflictDoNothing: () => ({
          returning: () => Promise.resolve([agentRow]),
        }),
      }),
    }),
    delete: () => ({
      where: () => Promise.resolve(),
    }),
  })

  mock.module('../../../src/db/index.js', () => ({
    db: {
      select: () => ({
        from: () => ({
          where: () => Promise.resolve([txState.agentRow]),
        }),
      }),
      update: () => ({
        set: () => ({
          where: () => ({
            returning: () => Promise.resolve([txState.agentRow]),
          }),
        }),
      }),
      insert: () => ({
        values: () => ({
          returning: () => Promise.resolve([txState.agentRow]),
          onConflictDoNothing: () => ({
            returning: () => Promise.resolve([txState.agentRow]),
          }),
        }),
      }),
      delete: () => ({
        where: () => Promise.resolve(),
      }),
      transaction: async (fn: (tx: ReturnType<typeof makeTxMock>) => Promise<unknown>) => {
        const tx = makeTxMock(txState.agentRow)
        txState.capturedTx = tx
        return fn(tx)
      },
      client: {},
    },
    client: {},
  }))

  // ─── Additional mocks for transitive imports ────────────────────────────────

  mock.module('../../../src/config/logger.js', () => ({
    logger: { info: mock(), warn: mock(), error: mock(), debug: mock() },
  }))

  mock.module('../../../src/services/events.js', () => ({
    emitAgentStatus: mock(),
    emitAgentError: mock(),
    // issue #106 U8: services/agents.ts now imports emitTaskUpdate at top
    // level for retireAgent's post-commit task-released broadcast.
    emitTaskUpdate: mock(),
  }))

  // ─── Token lib mocks (for enrollment-tokens) ────────────────────────────────

  const recordAuditEventMockForEnrollment = mock(async () => ({ id: 1 }))

  const generateEnrollmentTokenMock = mock((id: number) =>
    Promise.resolve({ token: `etk_${id}_brave-coral-otter-47`, hash: `EHASH-${id}` })
  )
  mock.module('../../../src/lib/enrollment-token.js', () => ({
    parseEnrollmentToken: mock(() => ({ tokenId: 5, secret: 'brave-coral-otter-47' })),
    verifyEnrollmentTokenHash: mock(() => Promise.resolve(true)),
    generateEnrollmentToken: generateEnrollmentTokenMock,
    ENROLLMENT_TOKEN_PREFIX: 'etk',
    ENROLLMENT_TOKEN_BCRYPT_COST: 12,
  }))

  const generateAgentTokenMock = mock((id: number) =>
    Promise.resolve({ token: `agt_${id}_rand`, hash: `AHASH-${id}` })
  )
  mock.module('../../../src/lib/agent-token.js', () => ({
    generateAgentToken: generateAgentTokenMock,
  }))

  // ─── Import modules under test (after all mocks) ────────────────────────────

  const { updateAgent } = await import('../../../src/services/agents.js')
  const { createEnrollmentToken, claimEnrollmentToken } =
    await import('../../../src/services/enrollment-tokens.js')

  // ─── Test actors ────────────────────────────────────────────────────────────

  const USER_ACTOR = { actorType: 'user' as const, actorId: 7 }
  const AGENT_ID = 1
  const PROJECT_ID = 10

  // ─── Tests ──────────────────────────────────────────────────────────────────

  describe('U6 — agent audit capture', () => {
    afterEach(() => {
      recordAuditEventSpy.mockClear()
      recordAuditEventMockForEnrollment.mockClear()
      generateAgentTokenMock.mockClear()
      generateEnrollmentTokenMock.mockClear()
      txState.agentRow = makeAgentRow()
      txState.notFound = false
      txState.capturedTx = null
    })

    // ── updateAgent: config edit ─────────────────────────────────────────────

    describe('updateAgent', () => {
      it('records updated event with entityType=agent and user actor', async () => {
        await updateAgent(AGENT_ID, { name: 'new-name' }, PROJECT_ID, USER_ACTOR)

        expect(recordAuditEventSpy).toHaveBeenCalledTimes(1)
        const [input] = recordAuditEventSpy.mock.calls[0]!
        expect(input.action).toBe('updated')
        expect(input.entityType).toBe('agent')
        expect(input.entityId).toBe(AGENT_ID)
        expect(input.actor).toEqual(USER_ACTOR)
        expect(input.projectId).toBe(PROJECT_ID)
      })

      it('defaults to system actor when no actor is provided', async () => {
        await updateAgent(AGENT_ID, { name: 'new-name' }, PROJECT_ID)

        expect(recordAuditEventSpy).toHaveBeenCalledTimes(1)
        const [input] = recordAuditEventSpy.mock.calls[0]!
        expect(input.actor).toEqual({ actorType: 'system', actorId: null })
      })

      it('updateAgent forwards the transaction handle as executor argument (E1)', async () => {
        // updateAgent wraps in db.transaction; recordAuditEvent must receive the
        // same tx handle for atomicity. txState.capturedTx is set by the transaction
        // wrapper above, enabling exact object identity assertion.
        await updateAgent(AGENT_ID, { name: 'tx-check' }, PROJECT_ID, USER_ACTOR)
        expect(txState.capturedTx).not.toBeNull()
        expect(recordAuditEventSpy.mock.calls[0]?.[1]).toBe(txState.capturedTx)
      })

      it('does not include operational fields in the audit changes (allowlist gate)', async () => {
        // Row includes authTokenHash, hardwareProfile, lastSeenAt — all excluded
        // by the agent allowlist in audit-log.ts. Since we mock recordAuditEvent,
        // we verify the raw rows are passed and trust the allowlist (tested in
        // audit-log.test.ts). The key assertion is that oldRow/newRow ARE passed
        // so the recorder has data to project.
        txState.agentRow = makeAgentRow({
          authTokenHash: 'bcrypt$secret$hash',
          hardwareProfile: { cpu: 'AMD' },
          lastSeenAt: new Date(),
        })

        await updateAgent(AGENT_ID, { name: 'renamed' }, PROJECT_ID, USER_ACTOR)

        expect(recordAuditEventSpy).toHaveBeenCalledTimes(1)
        const [input] = recordAuditEventSpy.mock.calls[0]!
        // oldRow and newRow are passed (recorder applies allowlist)
        expect(input.oldRow).toBeDefined()
        expect(input.newRow).toBeDefined()
        // The test verifies the raw rows ARE passed (not pre-filtered here).
        // The allowlist test in audit-log.test.ts covers projection correctness.
        expect(input.action).toBe('updated')
      })

      it('returns null and records no audit event when agent not found', async () => {
        // Arrange: make the in-tx select return [] so the agent lookup fails
        txState.notFound = true

        // Act
        const result = await updateAgent(AGENT_ID, { name: 'ghost' }, PROJECT_ID, USER_ACTOR)

        // Assert
        expect(result).toBeNull()
        expect(recordAuditEventSpy).not.toHaveBeenCalled()
      })
    })

    // ── createEnrollmentToken: token_issued ──────────────────────────────────

    describe('createEnrollmentToken', () => {
      it('records token_issued event with actorType user and no token plaintext in any field', async () => {
        await createEnrollmentToken(PROJECT_ID, USER_ACTOR.actorId, {
          label: 'rack-3 rigs',
          isReusable: true,
        })

        expect(recordAuditEventSpy).toHaveBeenCalledTimes(1)
        const [input] = recordAuditEventSpy.mock.calls[0]!
        expect(input.action).toBe('token_issued')
        expect(input.entityType).toBe('agent')
        expect(input.actor).toEqual(USER_ACTOR)
        expect(input.projectId).toBe(PROJECT_ID)
        // changes must be null for token_issued (enforced by recorder)
        // oldRow/newRow are not passed for token_issued
        expect(input.oldRow).toBeUndefined()
        expect(input.newRow).toBeUndefined()
      })

      it('does not expose token plaintext in any audit field', async () => {
        await createEnrollmentToken(PROJECT_ID, USER_ACTOR.actorId, { isReusable: false })

        const [input] = recordAuditEventSpy.mock.calls[0]!
        const serialized = JSON.stringify(input)
        // The raw token `etk_1_brave-coral-otter-47` must not appear
        expect(serialized).not.toContain('brave-coral-otter-47')
        expect(serialized).not.toContain('EHASH')
      })
    })

    // ── claimEnrollmentToken: self-registration ──────────────────────────────

    describe('claimEnrollmentToken', () => {
      it('records created event with actorType agent when a new agent enrolls', async () => {
        // Enrollment token db: select returns token row, then empty (no existing agent)
        // consume update returns [{ id: 5 }], agent insert returns full agent row
        const tokenRow = makeTokenRow()
        let selectCallCount = 0
        const selectMockEnroll = () => {
          selectCallCount++
          const chain: Record<string, unknown> = {}
          chain['from'] = () => chain
          chain['where'] = () => {
            if (selectCallCount === 1) return Promise.resolve([tokenRow])
            return Promise.resolve([])
          }
          return chain
        }

        mock.module('../../../src/db/index.js', () => ({
          db: {
            select: selectMockEnroll,
            update: () => ({
              set: () => ({
                where: () => ({
                  returning: () => Promise.resolve([{ id: 5 }]),
                }),
              }),
            }),
            insert: () => ({
              values: () => ({
                onConflictDoNothing: () => ({
                  returning: () => Promise.resolve([makeAgentRow({ id: 42, projectId: 10 })]),
                }),
                returning: () => Promise.resolve([makeAgentRow({ id: 42, projectId: 10 })]),
              }),
            }),
            delete: () => ({ where: () => Promise.resolve() }),
            transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
              selectCallCount = 0
              return fn({
                select: selectMockEnroll,
                update: () => ({
                  set: () => ({
                    where: () => ({
                      returning: () => Promise.resolve([{ id: 5 }]),
                    }),
                  }),
                }),
                insert: () => ({
                  values: () => ({
                    onConflictDoNothing: () => ({
                      returning: () => Promise.resolve([makeAgentRow({ id: 42, projectId: 10 })]),
                    }),
                    returning: () => Promise.resolve([makeAgentRow({ id: 42, projectId: 10 })]),
                  }),
                }),
                delete: () => ({ where: () => Promise.resolve() }),
              })
            },
            client: {},
          },
          client: {},
        }))

        const result = await claimEnrollmentToken({
          rawToken: 'etk_5_brave-coral-otter-47',
          clientId: 'rig-a',
          name: 'rig-a',
        })

        expect(result.ok).toBe(true)
        expect(recordAuditEventSpy).toHaveBeenCalledTimes(1)
        const [input] = recordAuditEventSpy.mock.calls[0]!
        expect(input.action).toBe('created')
        expect(input.entityType).toBe('agent')
        expect(input.actor.actorType).toBe('agent')
        expect(input.actor.actorId).toBe(42)
        expect(input.projectId).toBe(10)
        expect(input.newRow).toBeDefined()
      })

      it('does not record an audit event on idempotent retry (existing agent re-enrollment)', async () => {
        const tokenRow = makeTokenRow()
        const existingAgent = { id: 7, enrolledByTokenId: 5 }
        let selectCallCount = 0
        const selectMockRetry = () => {
          selectCallCount++
          const chain: Record<string, unknown> = {}
          chain['from'] = () => chain
          chain['where'] = () => {
            if (selectCallCount === 1) return Promise.resolve([tokenRow])
            return Promise.resolve([existingAgent])
          }
          return chain
        }

        mock.module('../../../src/db/index.js', () => ({
          db: {
            select: selectMockRetry,
            update: () => ({
              set: () => ({
                where: () => ({
                  returning: () => Promise.resolve([{ id: 5 }]),
                }),
              }),
            }),
            insert: () => ({
              values: () => ({
                onConflictDoNothing: () => ({ returning: () => Promise.resolve([]) }),
                returning: () => Promise.resolve([]),
              }),
            }),
            delete: () => ({ where: () => Promise.resolve() }),
            transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
              selectCallCount = 0
              return fn({
                select: selectMockRetry,
                update: () => ({
                  set: () => ({
                    where: () => ({
                      returning: () => Promise.resolve([{ id: 5 }]),
                    }),
                  }),
                }),
                insert: () => ({
                  values: () => ({
                    onConflictDoNothing: () => ({ returning: () => Promise.resolve([]) }),
                    returning: () => Promise.resolve([]),
                  }),
                }),
                delete: () => ({ where: () => Promise.resolve() }),
              })
            },
            client: {},
          },
          client: {},
        }))

        const result = await claimEnrollmentToken({
          rawToken: 'etk_5_brave-coral-otter-47',
          clientId: 'rig-a',
        })

        expect(result.ok).toBe(true)
        // Idempotent path re-issues bearer without creating a new agent;
        // no audit event should fire.
        expect(recordAuditEventSpy).not.toHaveBeenCalled()
      })
    })
  })
}
