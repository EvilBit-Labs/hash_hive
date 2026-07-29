/**
 * Control API SuperHashlist route tests (issue #101 — U9; R13, R4).
 *
 * The Control-surface parallel of `dashboard-super-hash-lists-routes.test.ts`
 * (U8). Verifies the Control API wraps the shared U7 service correctly on ITS
 * conventions — distinct from the dashboard:
 *
 *   1. **RBAC (security F1 / R13).** Mutating routes gate on
 *      `requireProjectRole('contributor', 'admin')`, so a project `viewer` is
 *      rejected 403; reads use `requireProjectMembership` (viewer allowed).
 *      This suite runs the REAL `helpers.ts` gating (only `findProjectMembership`
 *      and the service are mocked), so the role check is genuinely exercised —
 *      a viewer 403 is enforcement, not a stub.
 *   2. **Problem-details errors** (`application/problem+json`, RFC 9457): the
 *      U7 domain errors map to 409 (`SuperMemberAlreadyInSuperError`, R3) and
 *      400 (`SuperMemberProjectMismatchError`, R5); a missing/cross-project id
 *      is 404.
 *   3. **offset/limit pagination**: `GET /` returns `{ items, total, offset,
 *      limit }` — NOT the dashboard's `{ superHashLists, ... }` envelope — and
 *      individual entities are returned bare (NOT `{ superHashList: ... }`).
 *
 * **Contract-mock discipline**
 * (`docs/solutions/conventions/contract-test-mocks-mirror-service-not-schema.md`):
 * every `services/super-hash-lists.js` mock is pinned to the REAL service's
 * return type — static fixtures via `satisfies Awaited<ReturnType<typeof svc.fn>>`,
 * dynamic factories via `mock<typeof svc.fn>(...)`. Mocking against the route's
 * response schema would mean the schema tests itself.
 *
 * Runs in an isolated phase via `SUPER_CONTROL_TEST_ISOLATED=1` because it mocks
 * `services/super-hash-lists.js` and `services/auth.js` wholesale — `mock.module`
 * leaks process-wide and would clobber neighbours (mirrors
 * `control-hashlists-routes.test.ts`).
 */

import { beforeEach, describe, expect, it, mock } from 'bun:test'

const IS_ISOLATED = process.env['SUPER_CONTROL_TEST_ISOLATED'] === '1'

if (!IS_ISOLATED) {
  describe.skip('control-super-hash-lists-routes (skipped - runs in isolated phase)', () => {
    it('runs only with SUPER_CONTROL_TEST_ISOLATED=1', () => {
      expect(true).toBe(true)
    })
  })
} else {
  type SuperSvc = typeof import('../../src/services/super-hash-lists.js')

  // ─── Module-scoped RBAC state (drives the REAL helpers via the mocked
  //     `findProjectMembership`). `activeRoles === null` ⇒ not a member (403);
  //     `activeProjectId === null` ⇒ no project selected (400). ────────────
  let activeRoles: string[] | null = ['admin']
  let activeProjectId: number | null = 1
  const ACTIVE_USER_ID = 42

  mock.module('../../src/services/auth.js', () => ({
    findProjectMembership: async (_userId: number, projectId: number) => {
      if (activeRoles === null) return null
      if (projectId !== activeProjectId) return null
      return { projectId, roles: activeRoles }
    },
  }))

  // ─── Service fixtures, pinned to the REAL service return types ──────

  const CREATED_AT = new Date('2026-07-01T10:00:00.000Z')
  const UPDATED_AT = new Date('2026-07-02T11:30:00.000Z')
  const ARCHIVED_AT = new Date('2026-07-03T12:45:00.000Z')

  const superRow = {
    id: 7,
    projectId: 1,
    name: 'Q3 Union',
    archivedAt: null,
    createdAt: CREATED_AT,
    updatedAt: UPDATED_AT,
  } satisfies Awaited<ReturnType<SuperSvc['renameSuper']>>

  const archivedRow = {
    ...superRow,
    archivedAt: ARCHIVED_AT,
  } satisfies Awaited<ReturnType<SuperSvc['archiveSuper']>>

  const superDetail = {
    ...superRow,
    memberIds: [11, 12],
  } satisfies Awaited<ReturnType<SuperSvc['getSuperById']>>

  // Reuse the real domain-error classes so `instanceof` in the route's
  // `membershipProblem` matches (the route imports the same module the factory
  // below returns, so the classes are identical references).
  const { SuperMemberAlreadyInSuperError, SuperMemberProjectMismatchError } =
    await import('../../src/services/super-hash-lists.js')

  const mockCreateSuper = mock<SuperSvc['createSuper']>(async () => superDetail)
  const mockListSupers = mock<SuperSvc['listSupers']>(async () => ({ items: [superRow], total: 1 }))
  const mockGetSuperById = mock<SuperSvc['getSuperById']>(async () => superDetail)
  const mockRenameSuper = mock<SuperSvc['renameSuper']>(async () => superRow)
  const mockArchiveSuper = mock<SuperSvc['archiveSuper']>(async () => archivedRow)
  const mockAddMember = mock<SuperSvc['addMember']>(async () => superDetail)
  const mockRemoveMember = mock<SuperSvc['removeMember']>(async () => ({
    ...superDetail,
    memberIds: [11],
  }))

  mock.module('../../src/services/super-hash-lists.js', () => ({
    createSuper: mockCreateSuper,
    listSupers: mockListSupers,
    getSuperById: mockGetSuperById,
    renameSuper: mockRenameSuper,
    archiveSuper: mockArchiveSuper,
    addMember: mockAddMember,
    removeMember: mockRemoveMember,
    SuperMemberAlreadyInSuperError,
    SuperMemberProjectMismatchError,
  }))

  const { controlSuperHashListRoutes } = require('../../src/routes/control/super-hash-lists.js')
  const { Hono } = require('hono')

  function makeApp() {
    // oxlint-disable-next-line typescript/no-explicit-any -- dynamically require()d Hono
    const app = new (Hono as any)()
    // Stand in for `requireApiKey`: populate `currentUser` so the REAL
    // `requireProjectMembership`/`requireProjectRole` run against it.
    app.use('*', async (c: any, next: any) => {
      c.set('currentUser', {
        userId: ACTIVE_USER_ID,
        email: 'auto@t.local',
        roles: [],
        projectId: activeProjectId,
      })
      await next()
    })
    app.route('/', controlSuperHashListRoutes)
    return app
  }

  const jsonHeaders = { 'content-type': 'application/json' }

  // Every mutating route as (label, request-factory) — drives the table-driven
  // RBAC assertions so a future route added without a role gate has one obvious
  // place to be registered.
  const MUTATING_ROUTES: Array<{ label: string; send: () => Promise<Response> }> = [
    {
      label: 'POST /',
      send: () =>
        makeApp().request('/', {
          method: 'POST',
          headers: jsonHeaders,
          body: JSON.stringify({ name: 'New Super', memberIds: [11, 12] }),
        }),
    },
    {
      label: 'PATCH /{id}',
      send: () =>
        makeApp().request('/7', {
          method: 'PATCH',
          headers: jsonHeaders,
          body: JSON.stringify({ name: 'Renamed' }),
        }),
    },
    {
      label: 'POST /{id}/members',
      send: () =>
        makeApp().request('/7/members', {
          method: 'POST',
          headers: jsonHeaders,
          body: JSON.stringify({ hashListId: 13 }),
        }),
    },
    {
      label: 'DELETE /{id}/members/{listId}',
      send: () => makeApp().request('/7/members/12', { method: 'DELETE' }),
    },
    {
      label: 'POST /{id}/archive',
      send: () => makeApp().request('/7/archive', { method: 'POST' }),
    },
  ]

  const READ_ROUTES: Array<{ label: string; send: () => Promise<Response> }> = [
    { label: 'GET /', send: () => makeApp().request('/') },
    { label: 'GET /{id}', send: () => makeApp().request('/7') },
  ]

  beforeEach(() => {
    activeRoles = ['admin']
    activeProjectId = 1
    for (const m of [
      mockCreateSuper,
      mockListSupers,
      mockGetSuperById,
      mockRenameSuper,
      mockArchiveSuper,
      mockAddMember,
      mockRemoveMember,
    ]) {
      m.mockClear()
    }
  })

  // ─── RBAC (security F1 / R13) ───────────────────────────────────────

  describe('access control', () => {
    for (const route of [...READ_ROUTES, ...MUTATING_ROUTES]) {
      it(`${route.label}: 403 problem-details for a non-member of the project`, async () => {
        activeRoles = null
        const res = await route.send()
        expect(res.status).toBe(403)
        expect(res.headers.get('content-type')).toContain('application/problem+json')
        const body = (await res.json()) as { type?: string }
        expect(body.type).toContain('forbidden')
      })

      it(`${route.label}: 400 problem-details when no project is selected`, async () => {
        activeProjectId = null
        const res = await route.send()
        expect(res.status).toBe(400)
        const body = (await res.json()) as { type?: string }
        expect(body.type).toContain('project-not-selected')
      })
    }

    // The core F1 assertion: a read-only project role must not reach ANY
    // membership/lifecycle mutation.
    for (const route of MUTATING_ROUTES) {
      it(`${route.label}: 403 for a project viewer (read-only role cannot mutate)`, async () => {
        activeRoles = ['viewer']
        const res = await route.send()
        expect(res.status).toBe(403)
        expect(res.headers.get('content-type')).toContain('application/problem+json')
      })

      it(`${route.label}: allows a project contributor`, async () => {
        activeRoles = ['contributor']
        const res = await route.send()
        expect(res.status).toBeLessThan(300)
      })

      it(`${route.label}: allows a project admin`, async () => {
        activeRoles = ['admin']
        const res = await route.send()
        expect(res.status).toBeLessThan(300)
      })
    }

    for (const route of READ_ROUTES) {
      it(`${route.label}: a project viewer CAN read`, async () => {
        activeRoles = ['viewer']
        const res = await route.send()
        expect(res.status).toBe(200)
      })
    }

    it('a viewer 403 on POST /{id}/members never reaches the service', async () => {
      activeRoles = ['viewer']
      await makeApp().request('/7/members', {
        method: 'POST',
        headers: jsonHeaders,
        body: JSON.stringify({ hashListId: 13 }),
      })
      expect(mockAddMember).not.toHaveBeenCalled()
    })
  })

  // ─── POST / (create) ─────────────────────────────────────────────────

  describe('POST /', () => {
    it('creates a super and returns the bare detail entity (201)', async () => {
      const res = await makeApp().request('/', {
        method: 'POST',
        headers: jsonHeaders,
        body: JSON.stringify({ name: 'Q3 Union', memberIds: [11, 12] }),
      })
      expect(res.status).toBe(201)
      const body = await res.json()
      expect(body).toEqual({
        id: 7,
        projectId: 1,
        name: 'Q3 Union',
        archivedAt: null,
        createdAt: CREATED_AT.toISOString(),
        updatedAt: UPDATED_AT.toISOString(),
        memberIds: [11, 12],
      })
      // Control returns entities bare — never the dashboard `{ superHashList }`.
      expect(body).not.toHaveProperty('superHashList')
      expect(mockCreateSuper).toHaveBeenCalledWith({
        projectId: 1,
        name: 'Q3 Union',
        memberIds: [11, 12],
      })
    })

    it('accepts a create with no memberIds (R2 enforced at target time, not here)', async () => {
      const res = await makeApp().request('/', {
        method: 'POST',
        headers: jsonHeaders,
        body: JSON.stringify({ name: 'Empty Super' }),
      })
      expect(res.status).toBe(201)
      expect(mockCreateSuper).toHaveBeenCalledWith({
        projectId: 1,
        name: 'Empty Super',
        memberIds: undefined,
      })
    })

    it('400 problem-details on an empty name (schema validation)', async () => {
      const res = await makeApp().request('/', {
        method: 'POST',
        headers: jsonHeaders,
        body: JSON.stringify({ name: '' }),
      })
      expect(res.status).toBe(400)
      expect(res.headers.get('content-type')).toContain('application/problem+json')
      expect(mockCreateSuper).not.toHaveBeenCalled()
    })

    it('maps SuperMemberAlreadyInSuperError to 409 problem-details, not 500 (R3)', async () => {
      mockCreateSuper.mockImplementationOnce(async () => {
        throw new SuperMemberAlreadyInSuperError([12])
      })
      const res = await makeApp().request('/', {
        method: 'POST',
        headers: jsonHeaders,
        body: JSON.stringify({ name: 'Dup', memberIds: [12] }),
      })
      expect(res.status).toBe(409)
      const body = (await res.json()) as { type?: string; detail?: string }
      expect(body.type).toContain('conflict')
      expect(body.detail).toContain('12')
    })

    it('maps SuperMemberProjectMismatchError to 400 problem-details, not 500 (R5)', async () => {
      mockCreateSuper.mockImplementationOnce(async () => {
        throw new SuperMemberProjectMismatchError([999])
      })
      const res = await makeApp().request('/', {
        method: 'POST',
        headers: jsonHeaders,
        body: JSON.stringify({ name: 'Foreign', memberIds: [999] }),
      })
      expect(res.status).toBe(400)
      const body = (await res.json()) as { type?: string }
      expect(body.type).toContain('validation')
    })
  })

  // ─── GET / (list) ─────────────────────────────────────────────────────

  describe('GET /', () => {
    it('returns the offset/limit page envelope (items/total/offset/limit)', async () => {
      const res = await makeApp().request('/')
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body).toEqual({
        items: [
          {
            id: 7,
            projectId: 1,
            name: 'Q3 Union',
            archivedAt: null,
            createdAt: CREATED_AT.toISOString(),
            updatedAt: UPDATED_AT.toISOString(),
          },
        ],
        total: 1,
        offset: 0,
        limit: 50,
      })
      // Not the dashboard envelope.
      expect(body).not.toHaveProperty('superHashLists')
      expect(mockListSupers).toHaveBeenCalledWith(1, { limit: 50, offset: 0, showArchived: false })
    })

    it('list rows carry NO memberIds — the list query never reads the join table', async () => {
      const res = await makeApp().request('/')
      const body = (await res.json()) as { items: Array<Record<string, unknown>> }
      expect(body.items[0]).not.toHaveProperty('memberIds')
    })

    it('passes offset/limit/showArchived through and echoes the window', async () => {
      const res = await makeApp().request('/?limit=10&offset=20&showArchived=true')
      expect(res.status).toBe(200)
      const body = (await res.json()) as { offset: number; limit: number }
      expect(body.offset).toBe(20)
      expect(body.limit).toBe(10)
      expect(mockListSupers).toHaveBeenCalledWith(1, { limit: 10, offset: 20, showArchived: true })
    })
  })

  // ─── GET /{id} (detail) ────────────────────────────────────────────────

  describe('GET /{id}', () => {
    it('returns the bare detail entity with membership', async () => {
      const res = await makeApp().request('/7')
      expect(res.status).toBe(200)
      const body = (await res.json()) as Record<string, unknown>
      expect(body['memberIds']).toEqual([11, 12])
      expect(mockGetSuperById).toHaveBeenCalledWith(7, 1)
    })

    it('leaks no field the service never produced (negative shape, R10)', async () => {
      const res = await makeApp().request('/7')
      const body = (await res.json()) as Record<string, unknown>
      expect(Object.keys(body).toSorted()).toEqual(
        ['archivedAt', 'createdAt', 'id', 'memberIds', 'name', 'projectId', 'updatedAt'].toSorted()
      )
      for (const forbidden of ['hashCount', 'crackedCount', 'hashTypeId', 'members', 'items']) {
        expect(body).not.toHaveProperty(forbidden)
      }
    })

    it('404 problem-details for a missing / cross-project id', async () => {
      mockGetSuperById.mockImplementationOnce(async () => null)
      const res = await makeApp().request('/4242')
      expect(res.status).toBe(404)
      const body = (await res.json()) as { type?: string }
      expect(body.type).toContain('not-found')
    })

    it('400 problem-details on a non-numeric id', async () => {
      const res = await makeApp().request('/not-a-number')
      expect(res.status).toBe(400)
      expect(res.headers.get('content-type')).toContain('application/problem+json')
    })
  })

  // ─── PATCH /{id} (rename) ──────────────────────────────────────────────

  describe('PATCH /{id}', () => {
    it('renames and returns the bare (no-membership) entity', async () => {
      const res = await makeApp().request('/7', {
        method: 'PATCH',
        headers: jsonHeaders,
        body: JSON.stringify({ name: 'Renamed' }),
      })
      expect(res.status).toBe(200)
      const body = (await res.json()) as Record<string, unknown>
      // `renameSuper` returns a bare row — the route must not invent memberIds.
      expect(body).not.toHaveProperty('memberIds')
      expect(mockRenameSuper).toHaveBeenCalledWith(7, 1, 'Renamed')
    })

    it('404 problem-details when the super is missing or in another project', async () => {
      mockRenameSuper.mockImplementationOnce(async () => null)
      const res = await makeApp().request('/7', {
        method: 'PATCH',
        headers: jsonHeaders,
        body: JSON.stringify({ name: 'Renamed' }),
      })
      expect(res.status).toBe(404)
    })

    it('400 problem-details on an empty name', async () => {
      const res = await makeApp().request('/7', {
        method: 'PATCH',
        headers: jsonHeaders,
        body: JSON.stringify({ name: '' }),
      })
      expect(res.status).toBe(400)
    })
  })

  // ─── POST /{id}/members (add) ──────────────────────────────────────────

  describe('POST /{id}/members', () => {
    it('adds a member and returns the updated membership', async () => {
      const res = await makeApp().request('/7/members', {
        method: 'POST',
        headers: jsonHeaders,
        body: JSON.stringify({ hashListId: 13 }),
      })
      expect(res.status).toBe(200)
      const body = (await res.json()) as { memberIds: number[] }
      expect(body.memberIds).toEqual([11, 12])
      expect(mockAddMember).toHaveBeenCalledWith(7, 13, 1)
    })

    it('maps member-already-in-another-super to 409 problem-details (R3)', async () => {
      mockAddMember.mockImplementationOnce(async () => {
        throw new SuperMemberAlreadyInSuperError([13])
      })
      const res = await makeApp().request('/7/members', {
        method: 'POST',
        headers: jsonHeaders,
        body: JSON.stringify({ hashListId: 13 }),
      })
      expect(res.status).toBe(409)
      const body = (await res.json()) as { type?: string; detail?: string }
      expect(body.type).toContain('conflict')
      expect(body.detail).toContain('13')
    })

    it('maps cross-project member to 400 problem-details (R5)', async () => {
      mockAddMember.mockImplementationOnce(async () => {
        throw new SuperMemberProjectMismatchError([777])
      })
      const res = await makeApp().request('/7/members', {
        method: 'POST',
        headers: jsonHeaders,
        body: JSON.stringify({ hashListId: 777 }),
      })
      expect(res.status).toBe(400)
      const body = (await res.json()) as { type?: string }
      expect(body.type).toContain('validation')
    })

    it('404 problem-details when the super does not exist in the project', async () => {
      mockAddMember.mockImplementationOnce(async () => null)
      const res = await makeApp().request('/7/members', {
        method: 'POST',
        headers: jsonHeaders,
        body: JSON.stringify({ hashListId: 13 }),
      })
      expect(res.status).toBe(404)
    })
  })

  // ─── DELETE /{id}/members/{listId} (remove) ────────────────────────────

  describe('DELETE /{id}/members/{listId}', () => {
    it('removes a member and returns the shrunken membership', async () => {
      const res = await makeApp().request('/7/members/12', { method: 'DELETE' })
      expect(res.status).toBe(200)
      const body = (await res.json()) as { memberIds: number[] }
      expect(body.memberIds).toEqual([11])
      expect(mockRemoveMember).toHaveBeenCalledWith(7, 12, 1)
    })

    it('404 problem-details when the super does not exist in the project', async () => {
      mockRemoveMember.mockImplementationOnce(async () => null)
      const res = await makeApp().request('/7/members/12', { method: 'DELETE' })
      expect(res.status).toBe(404)
      const body = (await res.json()) as { type?: string }
      expect(body.type).toContain('not-found')
    })
  })

  // ─── POST /{id}/archive ────────────────────────────────────────────────

  describe('POST /{id}/archive', () => {
    it('archives and returns the stamped archivedAt (bare entity)', async () => {
      const res = await makeApp().request('/7/archive', { method: 'POST' })
      expect(res.status).toBe(200)
      const body = (await res.json()) as { archivedAt: string }
      expect(body.archivedAt).toBe(ARCHIVED_AT.toISOString())
      expect(mockArchiveSuper).toHaveBeenCalledWith(7, 1)
    })

    it('404 problem-details when the super does not exist in the project', async () => {
      mockArchiveSuper.mockImplementationOnce(async () => null)
      const res = await makeApp().request('/7/archive', { method: 'POST' })
      expect(res.status).toBe(404)
    })
  })
} // end IS_ISOLATED
