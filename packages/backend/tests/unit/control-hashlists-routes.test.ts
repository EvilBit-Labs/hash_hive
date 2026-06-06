/**
 * Control API hash-list route tests (issue #163).
 *
 * Covers the new `PATCH /api/v1/control/v1/hash-lists/{id}` route
 * added for agent-native parity with the dashboard surface. Mirrors
 * the dashboard-resources-routes.test.ts isolation pattern so
 * `mock.module` calls don't leak into other tests in the same
 * bun:test invocation.
 *
 * The dashboard tests cover the service-layer behavior; this file
 * verifies the Control API wraps it correctly: RFC 9457
 * problem-details errors, project scoping via session, FK violation
 * mapping, and 404-on-cross-project semantics.
 */

import { beforeEach, describe, expect, it, mock } from 'bun:test'

const IS_ISOLATED = process.env['CONTROL_HASHLISTS_TEST_ISOLATED'] === '1'

if (!IS_ISOLATED) {
  describe.skip('control-hashlists-routes (skipped - runs in isolated phase)', () => {
    it('runs only with CONTROL_HASHLISTS_TEST_ISOLATED=1', () => {
      expect(true).toBe(true)
    })
  })
} else {
  type HashListRow = NonNullable<
    Awaited<ReturnType<typeof import('../../src/services/resources.js').getHashListById>>
  >

  const makeHashList = (overrides: Partial<HashListRow> = {}): HashListRow =>
    ({
      id: overrides.id ?? 42,
      projectId: overrides.projectId ?? 1,
      name: overrides.name ?? 'hl',
      hashTypeId: overrides.hashTypeId ?? null,
      source: overrides.source ?? 'upload',
      fileRef: overrides.fileRef ?? {},
      statistics: overrides.statistics ?? {},
      status: overrides.status ?? 'ready',
      createdAt: overrides.createdAt ?? new Date(),
      updatedAt: overrides.updatedAt ?? new Date(),
    }) satisfies HashListRow

  const mockSetHashListType = mock(
    async (_id: number, _projectId: number, _hashTypeId: number) => null as HashListRow | null
  )

  let activeMembershipRoles: string[] = ['admin']
  let activeProjectId: number | null = 1

  mock.module('../../src/services/resources.js', () => ({
    getHashListById: mock(async () => null),
    getHashListStats: mock(async () => ({ totalCount: 0, crackedCount: 0, crackRate: 0 })),
    listHashListsPaginated: mock(async () => ({ items: [], total: 0 })),
    setHashListType: mockSetHashListType,
    isForeignKeyViolation: (err: unknown, expectedConstraint?: string): boolean => {
      if (!(err instanceof Error)) return false
      const code = 'code' in err ? ((err as { code?: string }).code ?? undefined) : undefined
      const constraint =
        'constraint' in err ? ((err as { constraint?: string }).constraint ?? undefined) : undefined
      const isFkBySqlstate = code === '23503'
      const isFkByMessage = !isFkBySqlstate && /foreign key|violates|reference/i.test(err.message)
      if (!isFkBySqlstate && !isFkByMessage) return false
      if (expectedConstraint === undefined) return true
      return constraint === expectedConstraint
    },
  }))

  // Replace `requireProjectMembership` with a stub that consults the
  // module-scoped state so per-test overrides drive RBAC behavior
  // without standing up the real Bearer-token middleware chain.
  mock.module('../../src/routes/control/helpers.js', () => ({
    requireProjectMembership: async () => {
      if (activeProjectId === null) {
        const err = new Error('project not selected')
        ;(err as Error & { status?: number }).status = 400
        throw err
      }
      return { projectId: activeProjectId, roles: activeMembershipRoles }
    },
    controlErrorResponse: (
      c: { json: (body: unknown, status: number) => Response },
      err: unknown
    ) => {
      const message = err instanceof Error ? err.message : 'unknown'
      return c.json({ type: 'internal', title: 'internal', detail: message }, 500)
    },
  }))

  const { controlHashListRoutes } = require('../../src/routes/control/hashlists.js')
  const { Hono } = require('hono')

  function makeApp() {
    // oxlint-disable-next-line typescript/no-explicit-any -- dynamically require()d Hono
    const app = new (Hono as any)()
    app.route('/', controlHashListRoutes)
    return app
  }

  describe('Control API: PATCH /hash-lists/{id} - set hash type', () => {
    beforeEach(() => {
      mockSetHashListType.mockReset()
      activeMembershipRoles = ['admin']
      activeProjectId = 1
    })

    it('happy path: returns 200 with the updated row when service resolves', async () => {
      mockSetHashListType.mockImplementation(async (id, projectId, hashTypeId) =>
        makeHashList({ id, projectId, hashTypeId })
      )

      const app = makeApp()
      const res = await app.request('/42', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ hashTypeId: 1000 }),
      })

      expect(res.status).toBe(200)
      const body = (await res.json()) as { id?: number; hashTypeId?: number }
      expect(body.id).toBe(42)
      expect(body.hashTypeId).toBe(1000)

      // Service argument-order pinning: (id, projectId, hashTypeId).
      // A future refactor that swaps positions would let a different
      // hash list get patched silently.
      expect(mockSetHashListType).toHaveBeenCalledTimes(1)
      const call = mockSetHashListType.mock.calls[0]
      expect(call?.[0]).toBe(42)
      expect(call?.[1]).toBe(1) // projectId from session
      expect(call?.[2]).toBe(1000)
    })

    it('returns 404 problem-details when the row is not in the active project', async () => {
      mockSetHashListType.mockImplementation(async () => null)

      const app = makeApp()
      const res = await app.request('/42', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ hashTypeId: 1000 }),
      })

      expect(res.status).toBe(404)
      const body = (await res.json()) as { type?: string; title?: string; detail?: string }
      // RFC 9457 problem-details shape.
      expect(body.type).toContain('not-found')
    })

    it('maps Postgres FK violation on hash_type_id to 400 problem-details "unknown hashTypeId"', async () => {
      mockSetHashListType.mockImplementation(async () => {
        const err = new Error(
          'insert or update on table "hash_lists" violates foreign key constraint "hash_lists_hash_type_id_hash_types_id_fk"'
        )
        ;(err as Error & { code?: string; constraint?: string }).code = '23503'
        ;(err as Error & { code?: string; constraint?: string }).constraint =
          'hash_lists_hash_type_id_hash_types_id_fk'
        throw err
      })

      const app = makeApp()
      const res = await app.request('/42', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ hashTypeId: 99999 }),
      })

      expect(res.status).toBe(400)
      const body = (await res.json()) as { type?: string; detail?: string }
      expect(body.type).toContain('validation')
      expect(body.detail).toBe('unknown hashTypeId')
    })

    it('does NOT map unrelated FK violation to 400 - falls through to 500', async () => {
      mockSetHashListType.mockImplementation(async () => {
        const err = new Error('violates foreign key constraint "some_other_fk"')
        ;(err as Error & { code?: string; constraint?: string }).code = '23503'
        ;(err as Error & { code?: string; constraint?: string }).constraint = 'some_other_fk'
        throw err
      })

      const app = makeApp()
      const res = await app.request('/42', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ hashTypeId: 1000 }),
      })

      expect(res.status).toBe(500)
    })

    it('rejects non-positive hashTypeId at validation', async () => {
      const app = makeApp()
      const res = await app.request('/42', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ hashTypeId: 0 }),
      })

      expect(res.status).toBeGreaterThanOrEqual(400)
      expect(res.status).toBeLessThan(500)
      expect(mockSetHashListType).not.toHaveBeenCalled()
    })

    it('rejects non-positive id at validation', async () => {
      const app = makeApp()
      const res = await app.request('/0', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ hashTypeId: 1000 }),
      })

      expect(res.status).toBeGreaterThanOrEqual(400)
      expect(res.status).toBeLessThan(500)
      expect(mockSetHashListType).not.toHaveBeenCalled()
    })

    it('rejects with 5xx when no project is selected (membership middleware throws)', async () => {
      // Activates the `if (activeProjectId === null)` branch in the
      // requireProjectMembership mock so the test file exercises the
      // membership-throws path. Mirrors the real middleware behavior
      // when the session has no scoped project. Without this case,
      // the guard is dead code in the test surface.
      activeProjectId = null

      const app = makeApp()
      const res = await app.request('/42', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ hashTypeId: 1000 }),
      })

      // controlErrorResponse returns 500 with the err.message in its
      // detail field — the real helper maps to a problem-details
      // envelope but the stub keeps it simple. The point is that the
      // service is NOT reached when the middleware throws.
      expect(res.status).toBe(500)
      expect(mockSetHashListType).not.toHaveBeenCalled()
    })
  })
} // end IS_ISOLATED
