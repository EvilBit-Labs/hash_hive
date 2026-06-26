/**
 * Unit tests for U4 audit capture wiring — project CRUD and membership changes.
 *
 * Mocks `recordAuditEvent` to assert call shapes without a real DB, and mocks
 * the db module so no Postgres connection is needed. All service functions are
 * imported after mocks are registered (bun:test's top-level-await ordering).
 *
 * Isolated because mock.module('db') leaks process-wide.
 * Run with: PROJECT_AUDIT_TEST_ISOLATED=1 bun test ... tests/unit/services/project-audit.test.ts
 */
import { afterEach, describe, expect, it, mock } from 'bun:test'

const IS_ISOLATED = process.env['PROJECT_AUDIT_TEST_ISOLATED'] === '1'

if (!IS_ISOLATED) {
  describe.skip('project-audit (skipped — runs in isolated phase)', () => {
    it('runs only with PROJECT_AUDIT_TEST_ISOLATED=1', () => {
      expect(true).toBe(true)
    })
  })
} else {
  // ─── recordAuditEvent spy ──────────────────────────────────────────────────

  const recordAuditEventSpy = mock(async () => ({ id: 1 }))

  mock.module('../../../src/services/audit-log.js', () => ({
    recordAuditEvent: recordAuditEventSpy,
  }))

  // ─── Row factories ─────────────────────────────────────────────────────────

  const makeProjectRow = (overrides: Record<string, unknown> = {}) => ({
    id: 10,
    name: 'Test Project',
    description: null,
    slug: 'test-project',
    settings: {},
    createdBy: 1,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  })

  const makeMembershipRow = (overrides: Record<string, unknown> = {}) => ({
    projectId: 10,
    userId: 99,
    roles: ['contributor'],
    createdAt: new Date(),
    ...overrides,
  })

  // ─── DB mock ────────────────────────────────────────────────────────────────
  //
  // All mutating project service functions use db.transaction internally.
  // The tx mock must support select/update/insert/delete so old-row fetches,
  // mutations, and the recordAuditEvent insert (inside the transaction) all work.

  const makeTxMock = (
    projectOverride: Record<string, unknown> = {},
    membershipOverride: Record<string, unknown> = {},
    notFound = false
  ) => ({
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () =>
            // Return [] when notFound is true so updateProject hits the early-return
            // guard (`if (!oldRow) return null`) before reaching recordAuditEvent.
            Promise.resolve(notFound ? [] : [makeProjectRow(projectOverride)]),
        }),
        innerJoin: () => ({ where: () => Promise.resolve([]) }),
      }),
    }),
    update: () => ({
      set: () => ({
        where: () => ({
          returning: () => Promise.resolve([makeProjectRow(projectOverride)]),
        }),
      }),
    }),
    insert: () => ({
      values: () => ({
        returning: () => Promise.resolve([makeProjectRow(projectOverride)]),
      }),
    }),
    delete: () => ({
      where: () => ({
        returning: () => Promise.resolve([makeMembershipRow(membershipOverride)]),
      }),
    }),
  })

  // Mutable state so individual tests can control what the tx returns.
  // capturedTx is set by the transaction wrapper so E1 tests can assert identity.
  // notFound: true makes the tx select return [] so updateProject hits the early return.
  const txState: {
    projectOverride: Record<string, unknown>
    membershipOverride: Record<string, unknown>
    capturedTx: ReturnType<typeof makeTxMock> | null
    notFound: boolean
  } = { projectOverride: {}, membershipOverride: {}, capturedTx: null, notFound: false }

  mock.module('../../../src/db/index.js', () => ({
    db: {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: () => Promise.resolve([makeProjectRow(txState.projectOverride)]),
          }),
          innerJoin: () => ({ where: () => Promise.resolve([]) }),
        }),
      }),
      update: () => ({
        set: () => ({
          where: () => ({
            returning: () => Promise.resolve([makeProjectRow(txState.projectOverride)]),
          }),
        }),
      }),
      insert: () => ({
        values: () => ({
          returning: () => Promise.resolve([makeProjectRow(txState.projectOverride)]),
        }),
      }),
      delete: () => ({
        where: () => ({
          returning: () => Promise.resolve([makeMembershipRow(txState.membershipOverride)]),
        }),
      }),
      transaction: async (fn: (tx: ReturnType<typeof makeTxMock>) => Promise<unknown>) => {
        const tx = makeTxMock(txState.projectOverride, txState.membershipOverride, txState.notFound)
        txState.capturedTx = tx
        return fn(tx)
      },
      client: {},
    },
    client: {},
  }))

  // ─── Import module under test (after all mocks) ───────────────────────────

  const {
    createProject,
    updateProject,
    addUserToProject,
    removeUserFromProject,
    updateMemberRoles,
  } = await import('../../../src/services/projects.js')

  // ─── Test actors ───────────────────────────────────────────────────────────

  const USER_ACTOR = { actorType: 'user' as const, actorId: 42 }
  const SYSTEM_ACTOR = { actorType: 'system' as const, actorId: null }

  // ─── Tests ─────────────────────────────────────────────────────────────────

  describe('U4 — project audit capture', () => {
    afterEach(() => {
      recordAuditEventSpy.mockClear()
      txState.projectOverride = {}
      txState.membershipOverride = {}
      txState.capturedTx = null
      txState.notFound = false
    })

    // ── createProject ──────────────────────────────────────────────────────

    describe('createProject', () => {
      it('calls recordAuditEvent with action=created and user actor', async () => {
        const result = await createProject(
          { name: 'Alpha', slug: 'alpha', createdBy: 1 },
          USER_ACTOR
        )
        expect(result).not.toBeNull()
        expect(recordAuditEventSpy).toHaveBeenCalledTimes(1)
        const [input] = recordAuditEventSpy.mock.calls[0]!
        expect(input.action).toBe('created')
        expect(input.entityType).toBe('project')
        expect(input.actor).toEqual(USER_ACTOR)
        expect(typeof input.entityId).toBe('number')
        expect(input.newRow).toBeDefined()
        expect(input.oldRow).toBeUndefined()
      })

      it('uses system actor when called without actor param', async () => {
        await createProject({ name: 'Beta', slug: 'beta', createdBy: 1 })
        expect(recordAuditEventSpy).toHaveBeenCalledTimes(1)
        const [input] = recordAuditEventSpy.mock.calls[0]!
        expect(input.actor).toEqual(SYSTEM_ACTOR)
      })
    })

    // ── updateProject ──────────────────────────────────────────────────────

    describe('updateProject', () => {
      it('calls recordAuditEvent with action=updated and user actor', async () => {
        const result = await updateProject(10, { name: 'Updated Name' }, USER_ACTOR)
        expect(result).not.toBeNull()
        expect(recordAuditEventSpy).toHaveBeenCalledTimes(1)
        const [input] = recordAuditEventSpy.mock.calls[0]!
        expect(input.action).toBe('updated')
        expect(input.entityType).toBe('project')
        expect(input.entityId).toBe(10)
        expect(input.projectId).toBe(10)
        expect(input.actor).toEqual(USER_ACTOR)
        expect(input.oldRow).toBeDefined()
        expect(input.newRow).toBeDefined()
      })

      it('uses system actor when called without actor param', async () => {
        await updateProject(10, { name: 'Sys Update' })
        expect(recordAuditEventSpy).toHaveBeenCalledTimes(1)
        const [input] = recordAuditEventSpy.mock.calls[0]!
        expect(input.actor).toEqual(SYSTEM_ACTOR)
      })

      it('forwards the transaction handle as the executor argument (E1)', async () => {
        // updateProject wraps in db.transaction; recordAuditEvent receives tx as 2nd arg.
        // txState.capturedTx is set by the transaction wrapper above, so we assert
        // exact object identity — confirming the same tx handle is forwarded.
        await updateProject(10, { name: 'Updated Name' }, USER_ACTOR)
        expect(txState.capturedTx).not.toBeNull()
        expect(recordAuditEventSpy.mock.calls[0]?.[1]).toBe(txState.capturedTx)
      })

      it('writes no audit row when project not found (returns null early) (E2)', async () => {
        // Force the tx select to return [] so updateProject hits the not-found early return.
        txState.notFound = true
        const result = await updateProject(10, { name: 'Should Not Audit' }, USER_ACTOR)
        expect(result).toBeNull()
        expect(recordAuditEventSpy).not.toHaveBeenCalled()
      })
    })

    // ── addUserToProject ───────────────────────────────────────────────────

    describe('addUserToProject', () => {
      it('calls recordAuditEvent with action=updated capturing userId and roles', async () => {
        const result = await addUserToProject(10, 99, ['contributor'], USER_ACTOR)
        expect(result).not.toBeNull()
        expect(recordAuditEventSpy).toHaveBeenCalledTimes(1)
        const [input] = recordAuditEventSpy.mock.calls[0]!
        expect(input.action).toBe('updated')
        expect(input.entityType).toBe('project')
        expect(input.entityId).toBe(10)
        expect(input.actor).toEqual(USER_ACTOR)
        // newRow must contain the member's userId, not email
        expect(input.newRow).toMatchObject({ memberUserId: 99, memberRoles: ['contributor'] })
        // oldRow must show null (member was not previously present)
        expect(input.oldRow).toMatchObject({ memberUserId: null, memberRoles: null })
        // No email/credential fields in the rows passed to the recorder
        expect(input.newRow).not.toHaveProperty('email')
        expect(input.newRow).not.toHaveProperty('password')
        expect(input.oldRow).not.toHaveProperty('email')
      })

      it('uses system actor when called without actor param', async () => {
        await addUserToProject(10, 99, ['viewer'])
        const [input] = recordAuditEventSpy.mock.calls[0]!
        expect(input.actor).toEqual(SYSTEM_ACTOR)
      })
    })

    // ── removeUserFromProject ──────────────────────────────────────────────

    describe('removeUserFromProject', () => {
      it('calls recordAuditEvent with action=updated capturing removed userId and roles', async () => {
        txState.membershipOverride = { userId: 99, roles: ['contributor'] }
        const result = await removeUserFromProject(10, 99, USER_ACTOR)
        expect(result).not.toBeNull()
        expect(recordAuditEventSpy).toHaveBeenCalledTimes(1)
        const [input] = recordAuditEventSpy.mock.calls[0]!
        expect(input.action).toBe('updated')
        expect(input.entityType).toBe('project')
        expect(input.actor).toEqual(USER_ACTOR)
        // oldRow must capture the removed member's userId (not email)
        expect(input.oldRow).toMatchObject({ memberUserId: 99 })
        // newRow must show null (member no longer present)
        expect(input.newRow).toMatchObject({ memberUserId: null, memberRoles: null })
        // No email/credential fields
        expect(input.oldRow).not.toHaveProperty('email')
        expect(input.oldRow).not.toHaveProperty('password')
      })

      it('uses system actor when called without actor param', async () => {
        await removeUserFromProject(10, 99)
        const [input] = recordAuditEventSpy.mock.calls[0]!
        expect(input.actor).toEqual(SYSTEM_ACTOR)
      })
    })

    // ── updateMemberRoles ──────────────────────────────────────────────────

    describe('updateMemberRoles', () => {
      it('records old->new role change with userId, no email or credential', async () => {
        // The tx select returns a membership-shaped object — override to have the old roles
        // We need the tx mock's select to return a membership row for projectUsers query.
        // Since our makeTxMock select always returns a project row, we patch projectOverride
        // to act as an old membership row for the select (fields used: roles)
        txState.projectOverride = {
          userId: 99,
          roles: ['contributor'],
          projectId: 10,
          createdAt: new Date(),
        }

        const result = await updateMemberRoles(10, 99, ['admin'], USER_ACTOR)
        expect(result).not.toBeNull()
        expect(recordAuditEventSpy).toHaveBeenCalledTimes(1)
        const [input] = recordAuditEventSpy.mock.calls[0]!
        expect(input.action).toBe('updated')
        expect(input.entityType).toBe('project')
        expect(input.entityId).toBe(10)
        expect(input.actor).toEqual(USER_ACTOR)
        // Both old and new rows identify the member by userId, not email
        expect(input.oldRow).toMatchObject({ memberUserId: 99 })
        expect(input.newRow).toMatchObject({ memberUserId: 99, memberRoles: ['admin'] })
        // No email, password, or credential field
        expect(input.oldRow).not.toHaveProperty('email')
        expect(input.oldRow).not.toHaveProperty('password')
        expect(input.newRow).not.toHaveProperty('email')
        expect(input.newRow).not.toHaveProperty('password')
        // No apiKeyHash or authToken
        expect(JSON.stringify(input.oldRow)).not.toContain('apiKey')
        expect(JSON.stringify(input.newRow)).not.toContain('apiKey')
      })

      it('uses system actor when called without actor param', async () => {
        txState.projectOverride = {
          userId: 99,
          roles: ['contributor'],
          projectId: 10,
          createdAt: new Date(),
        }
        await updateMemberRoles(10, 99, ['viewer'])
        const [input] = recordAuditEventSpy.mock.calls[0]!
        expect(input.actor).toEqual(SYSTEM_ACTOR)
      })
    })

    // ── rollback invariant ─────────────────────────────────────────────────

    describe('rollback invariant', () => {
      it('a transaction error from recordAuditEvent propagates and prevents return', async () => {
        // Make recordAuditEvent throw to simulate a write failure inside the tx
        recordAuditEventSpy.mockImplementationOnce(async () => {
          throw new Error('audit write failed')
        })
        await expect(
          createProject({ name: 'Fail', slug: 'fail', createdBy: 1 }, USER_ACTOR)
        ).rejects.toThrow('audit write failed')
        // No successful return means the tx rolled back (no row returned)
      })
    })
  })
}
