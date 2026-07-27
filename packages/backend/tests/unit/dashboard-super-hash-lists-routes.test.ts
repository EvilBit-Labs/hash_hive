/**
 * Route-contract tests for the dashboard SuperHashlist management surface
 * (issue #101 — U8; R13, R4).
 *
 * Pins, in order of what would hurt most if it regressed:
 *
 *  1. **Security F1 — mutation gating.** Every mutating route
 *     (`POST /`, `PATCH /{id}`, `POST /{id}/members`,
 *     `DELETE /{id}/members/{listId}`, `POST /{id}/archive`) must gate on
 *     `requireMembershipRole('admin', 'contributor')`, so a project `viewer`
 *     gets 403. Bare `requireProjectAccess()` would let a read-only role
 *     mutate membership — and once U12/U13 land, trigger reconciliation and
 *     the remove-member harvest from a read-only seat. The reads
 *     (`GET /`, `GET /{id}`) stay open to a viewer.
 *  2. Non-member → 403; global admin WITHOUT project membership → 403
 *     (pins that a global role does not bypass the project gate).
 *  3. Service domain errors map to 4xx dashboard codes, never 500:
 *     `SuperMemberAlreadyInSuperError` → 409, `SuperMemberProjectMismatchError`
 *     → 400.
 *  4. Responses round-trip through the shared schemas' `.parse()`, and a
 *     negative-shape assertion pins that the route leaks no derived field the
 *     service never produced.
 *
 * **Contract-mock discipline**
 * (`docs/solutions/conventions/contract-test-mocks-mirror-service-not-schema.md`):
 * every `services/super-hash-lists.js` mock below is pinned to the REAL
 * service's return type — static fixtures via
 * `satisfies Awaited<ReturnType<typeof svc.fn>>`, dynamic factories via
 * `mock<typeof svc.fn>(...)`. Mocking against the route's response schema
 * would mean the schema tests itself (the PR-#190 escape).
 *
 * Runs in an isolated phase via `SUPER_DASHBOARD_TEST_ISOLATED=1` because this
 * file mocks `services/super-hash-lists.js` and `src/db/index.js` wholesale —
 * `mock.module` leaks process-wide and would clobber neighbours.
 */
import {
  superHashListDetailResponseSchema,
  superHashListListResponseSchema,
  superHashListResponseSchema,
} from '@hashhive/shared'
import { beforeEach, describe, expect, it, mock } from 'bun:test'

const IS_ISOLATED = process.env['SUPER_DASHBOARD_TEST_ISOLATED'] === '1'

if (!IS_ISOLATED) {
  describe('dashboard-super-hash-lists-routes (skipped - runs in isolated phase)', () => {
    it('signals isolation phase is required', () => {
      // oxlint-disable-next-line no-console -- surface phase-gating drift in CI logs
      console.warn(
        '[dashboard-super-hash-lists-routes] skipped - set SUPER_DASHBOARD_TEST_ISOLATED=1 to run; the route suite did NOT execute in this phase.'
      )
      expect(process.env['SUPER_DASHBOARD_TEST_ISOLATED']).toBeUndefined()
    })
  })
} else {
  type SuperSvc = typeof import('../../src/services/super-hash-lists.js')

  const ADMIN_COOKIE = 'hh.session_token=valid-admin-session'
  const CONTRIBUTOR_COOKIE = 'hh.session_token=valid-contributor-session'
  const VIEWER_COOKIE = 'hh.session_token=valid-viewer-session'
  const NON_MEMBER_COOKIE = 'hh.session_token=valid-non-member-session'
  const GLOBAL_ADMIN_COOKIE = 'hh.session_token=valid-global-admin-session'
  const SAME_ORIGIN_HOST = 'lab.local'

  // ─── Session fixtures ───────────────────────────────────────────────

  interface SessionFixture {
    userId: string
    email: string
    name: string
    roles: string[]
  }

  const SESSIONS: Record<string, SessionFixture> = {
    'valid-admin-session': { userId: '1', email: 'admin@t.local', name: 'Admin', roles: ['admin'] },
    'valid-contributor-session': {
      userId: '2',
      email: 'contrib@t.local',
      name: 'Contrib',
      roles: [],
    },
    'valid-viewer-session': { userId: '3', email: 'viewer@t.local', name: 'Viewer', roles: [] },
    'valid-non-member-session': {
      userId: '4',
      email: 'outsider@t.local',
      name: 'Outsider',
      roles: ['analyst'],
    },
    // Global `admin` role but NO membership row in project 1 — pins that a
    // global role does not bypass the per-project gate.
    'valid-global-admin-session': {
      userId: '5',
      email: 'globaladmin@t.local',
      name: 'GlobalAdmin',
      roles: ['admin'],
    },
  }

  // Project-1 membership roles, keyed by numeric user id. User 4 (non-member)
  // and user 5 (global admin) are deliberately absent.
  const PROJECT_MEMBERSHIP: Record<number, string[]> = {
    1: ['admin'],
    2: ['contributor'],
    3: ['viewer'],
  }

  mock.module('../../src/lib/auth.js', () => ({
    auth: {
      api: {
        getSession: async ({ headers }: { headers: Headers }) => {
          const cookie = headers.get('cookie') ?? ''
          const match = Object.entries(SESSIONS).find(([token]) => cookie.includes(token))
          if (!match) return null
          const [token, fixture] = match
          return {
            user: {
              id: fixture.userId,
              email: fixture.email,
              name: fixture.name,
              emailVerified: true,
              image: null,
              roles: fixture.roles,
            },
            session: {
              id: `sess-${token}`,
              userId: fixture.userId,
              token: `tok-${token}`,
              expiresAt: new Date(Date.now() + 3600000),
              projectId: 1,
            },
          }
        },
      },
      handler: async () => new Response('ok'),
    },
  }))

  mock.module('../../src/services/auth.js', () => ({
    getUserWithProjects: async (userId: number) => {
      const roles = PROJECT_MEMBERSHIP[userId]
      if (!roles) return { id: userId, projects: [] }
      return { id: userId, projects: [{ projectId: 1, roles }] }
    },
    findProjectMembership: async (userId: number, projectId: number) => {
      if (projectId !== 1) return null
      const roles = PROJECT_MEMBERSHIP[userId]
      return roles ? { projectId: 1, roles } : null
    },
    getUserLastProjectId: async () => null,
    setUserLastProjectIdIfMember: async () => 1,
    setUserLastProjectId: async () => undefined,
    issueUserApiKey: mock(async () => ({ apiKey: 'cst_test', metadata: null })),
    revokeUserApiKey: mock(async () => undefined),
    getUserApiKeyMetadata: mock(async () => null),
  }))

  // ─── Service fixtures, pinned to the REAL service return types ──────
  //
  // `satisfies Awaited<ReturnType<...>>` lifts each fixture into the real
  // service's type scope: if `SuperHashListRow` / `SuperHashListWithMembers`
  // gains or renames a field, these fail type-check rather than silently
  // drifting from the wire the route actually serves.

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

  // Real service domain errors — reused so `instanceof` in the route's
  // `membershipErrorResponse` matches (the route imports the same module the
  // factory below returns, so the classes are identical references).
  const { SuperMemberAlreadyInSuperError, SuperMemberProjectMismatchError } =
    await import('../../src/services/super-hash-lists.js')

  // Dynamic factories typed via `mock<typeof svc.fn>(...)` so the factory
  // BODY is constrained by the real signature, not just the fixture.
  const mockCreateSuper = mock<SuperSvc['createSuper']>(async () => superDetail)
  const mockListSupers = mock<SuperSvc['listSupers']>(async () => ({
    items: [superRow],
    total: 1,
  }))
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

  mock.module('../../src/db/index.js', () => ({
    db: {
      select: () => ({ from: () => ({ where: () => ({ limit: () => Promise.resolve([]) }) }) }),
      insert: () => ({ values: () => ({ returning: () => Promise.resolve([]) }) }),
      update: () => ({ set: () => ({ where: () => ({ returning: () => Promise.resolve([]) }) }) }),
    },
    client: {},
  }))

  mock.module('ioredis', () => ({
    default: class MockRedis {
      ping() {
        return Promise.resolve('PONG')
      }
      on() {
        return this
      }
      disconnect() {}
    },
  }))

  const { app } = await import('../../src/index.js')

  const BASE = '/api/v1/dashboard/super-hash-lists'
  const OPENAPI = '/api/v1/dashboard/openapi.json'

  function headers(cookie: string = ADMIN_COOKIE, extra: Record<string, string> = {}) {
    return {
      cookie,
      host: SAME_ORIGIN_HOST,
      origin: `https://${SAME_ORIGIN_HOST}`,
      'x-project-id': '1',
      ...extra,
    }
  }

  function jsonHeaders(cookie: string = ADMIN_COOKIE) {
    return headers(cookie, { 'content-type': 'application/json' })
  }

  beforeEach(() => {
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

  // Every mutating route, as (label, request-factory). Drives the
  // table-driven RBAC assertions below so a future route added without a role
  // gate has one obvious place to be registered.
  const MUTATING_ROUTES: Array<{ label: string; send: (cookie: string) => Promise<Response> }> = [
    {
      label: 'POST /',
      send: (cookie) =>
        app.request(BASE, {
          method: 'POST',
          headers: jsonHeaders(cookie),
          body: JSON.stringify({ name: 'New Super', memberIds: [11, 12] }),
        }),
    },
    {
      label: 'PATCH /{id}',
      send: (cookie) =>
        app.request(`${BASE}/7`, {
          method: 'PATCH',
          headers: jsonHeaders(cookie),
          body: JSON.stringify({ name: 'Renamed' }),
        }),
    },
    {
      label: 'POST /{id}/members',
      send: (cookie) =>
        app.request(`${BASE}/7/members`, {
          method: 'POST',
          headers: jsonHeaders(cookie),
          body: JSON.stringify({ hashListId: 13 }),
        }),
    },
    {
      label: 'DELETE /{id}/members/{listId}',
      send: (cookie) =>
        app.request(`${BASE}/7/members/12`, { method: 'DELETE', headers: headers(cookie) }),
    },
    {
      label: 'POST /{id}/archive',
      send: (cookie) =>
        app.request(`${BASE}/7/archive`, { method: 'POST', headers: headers(cookie) }),
    },
  ]

  const READ_ROUTES: Array<{ label: string; send: (cookie: string) => Promise<Response> }> = [
    { label: 'GET /', send: (cookie) => app.request(BASE, { headers: headers(cookie) }) },
    {
      label: 'GET /{id}',
      send: (cookie) => app.request(`${BASE}/7`, { headers: headers(cookie) }),
    },
  ]

  // ─── Auth ───────────────────────────────────────────────────────────

  describe('auth', () => {
    it('returns 401 with no session cookie', async () => {
      const res = await app.request(BASE, { headers: { host: SAME_ORIGIN_HOST } })
      expect(res.status).toBe(401)
    })

    it('returns 401 with an unrecognised session cookie', async () => {
      const res = await app.request(BASE, {
        headers: { host: SAME_ORIGIN_HOST, cookie: 'hh.session_token=nope' },
      })
      expect(res.status).toBe(401)
    })
  })

  // ─── RBAC (security F1) ─────────────────────────────────────────────

  describe('access control', () => {
    for (const route of [...READ_ROUTES, ...MUTATING_ROUTES]) {
      it(`${route.label}: 403 for an authenticated non-member of the project`, async () => {
        const res = await route.send(NON_MEMBER_COOKIE)
        expect(res.status).toBe(403)
      })

      it(`${route.label}: 403 for a global admin with no project membership`, async () => {
        const res = await route.send(GLOBAL_ADMIN_COOKIE)
        expect(res.status).toBe(403)
      })
    }

    // The core F1 assertion: a read-only project role must not reach ANY
    // membership/lifecycle mutation.
    for (const route of MUTATING_ROUTES) {
      it(`${route.label}: 403 for a project viewer (read-only role cannot mutate)`, async () => {
        const res = await route.send(VIEWER_COOKIE)
        expect(res.status).toBe(403)
        const body = (await res.json()) as { error?: { code?: string } }
        expect(body.error?.code).toBe('AUTHZ_INSUFFICIENT_PERMISSIONS')
      })

      it(`${route.label}: allows a project contributor`, async () => {
        const res = await route.send(CONTRIBUTOR_COOKIE)
        expect(res.status).toBeLessThan(300)
      })

      it(`${route.label}: allows a project admin`, async () => {
        const res = await route.send(ADMIN_COOKIE)
        expect(res.status).toBeLessThan(300)
      })
    }

    for (const route of READ_ROUTES) {
      it(`${route.label}: a project viewer CAN read`, async () => {
        const res = await route.send(VIEWER_COOKIE)
        expect(res.status).toBe(200)
      })
    }

    it('a viewer 403 on POST /{id}/members never reaches the service', async () => {
      await app.request(`${BASE}/7/members`, {
        method: 'POST',
        headers: jsonHeaders(VIEWER_COOKIE),
        body: JSON.stringify({ hashListId: 13 }),
      })
      expect(mockAddMember).not.toHaveBeenCalled()
    })
  })

  // ─── Create ─────────────────────────────────────────────────────────

  describe('POST /', () => {
    it('creates a super and returns the detail envelope', async () => {
      const res = await app.request(BASE, {
        method: 'POST',
        headers: jsonHeaders(),
        body: JSON.stringify({ name: 'Q3 Union', memberIds: [11, 12] }),
      })
      expect(res.status).toBe(201)
      const body = await res.json()
      expect(superHashListDetailResponseSchema.safeParse(body).success).toBe(true)
      expect(body).toEqual({
        superHashList: {
          id: 7,
          projectId: 1,
          name: 'Q3 Union',
          archivedAt: null,
          createdAt: CREATED_AT.toISOString(),
          updatedAt: UPDATED_AT.toISOString(),
          memberIds: [11, 12],
        },
      })
      expect(mockCreateSuper).toHaveBeenCalledWith({
        projectId: 1,
        name: 'Q3 Union',
        memberIds: [11, 12],
      })
    })

    it('accepts a create with no memberIds (R2 is enforced at target time, not here)', async () => {
      const res = await app.request(BASE, {
        method: 'POST',
        headers: jsonHeaders(),
        body: JSON.stringify({ name: 'Empty Super' }),
      })
      expect(res.status).toBe(201)
      expect(mockCreateSuper).toHaveBeenCalledWith({
        projectId: 1,
        name: 'Empty Super',
        memberIds: undefined,
      })
    })

    it('returns the dashboard VALIDATION_ERROR envelope on a bad body', async () => {
      const res = await app.request(BASE, {
        method: 'POST',
        headers: jsonHeaders(),
        body: JSON.stringify({ name: '' }),
      })
      expect(res.status).toBe(400)
      const body = (await res.json()) as { error?: { code?: string; message?: string } }
      expect(body.error?.code).toBe('VALIDATION_ERROR')
      expect(typeof body.error?.message).toBe('string')
    })

    it('maps SuperMemberAlreadyInSuperError to 409, not 500 (R3)', async () => {
      mockCreateSuper.mockImplementationOnce(async () => {
        throw new SuperMemberAlreadyInSuperError([12])
      })
      const res = await app.request(BASE, {
        method: 'POST',
        headers: jsonHeaders(),
        body: JSON.stringify({ name: 'Dup', memberIds: [12] }),
      })
      expect(res.status).toBe(409)
      const body = (await res.json()) as { error?: { code?: string } }
      expect(body.error?.code).toBe('SUPER_MEMBER_ALREADY_IN_SUPER')
    })

    it('maps SuperMemberProjectMismatchError to 400, not 500 (R5)', async () => {
      mockCreateSuper.mockImplementationOnce(async () => {
        throw new SuperMemberProjectMismatchError([999])
      })
      const res = await app.request(BASE, {
        method: 'POST',
        headers: jsonHeaders(),
        body: JSON.stringify({ name: 'Foreign', memberIds: [999] }),
      })
      expect(res.status).toBe(400)
      const body = (await res.json()) as { error?: { code?: string } }
      expect(body.error?.code).toBe('SUPER_MEMBER_PROJECT_MISMATCH')
    })
  })

  // ─── List ───────────────────────────────────────────────────────────

  describe('GET /', () => {
    it('returns the paginated list envelope scoped to the session project', async () => {
      const res = await app.request(BASE, { headers: headers() })
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(superHashListListResponseSchema.safeParse(body).success).toBe(true)
      expect(body).toEqual({
        superHashLists: [
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
        limit: 50,
        offset: 0,
      })
      expect(mockListSupers).toHaveBeenCalledWith(1, {
        limit: 50,
        offset: 0,
        showArchived: false,
      })
    })

    it('list rows carry NO memberIds — the service list query never reads the join table', async () => {
      const res = await app.request(BASE, { headers: headers() })
      const body = (await res.json()) as { superHashLists: Array<Record<string, unknown>> }
      expect(Object.keys(body.superHashLists[0]!).sort()).toEqual(
        ['archivedAt', 'createdAt', 'id', 'name', 'projectId', 'updatedAt'].sort()
      )
      expect(body.superHashLists[0]).not.toHaveProperty('memberIds')
    })

    it('passes limit/offset/showArchived through to the service', async () => {
      const res = await app.request(`${BASE}?limit=10&offset=20&showArchived=true`, {
        headers: headers(),
      })
      expect(res.status).toBe(200)
      expect(mockListSupers).toHaveBeenCalledWith(1, {
        limit: 10,
        offset: 20,
        showArchived: true,
      })
    })

    it('falls back to defaults on malformed pagination rather than 400-ing', async () => {
      const res = await app.request(`${BASE}?limit=abc&offset=-5`, { headers: headers() })
      expect(res.status).toBe(200)
      expect(mockListSupers).toHaveBeenCalledWith(1, { limit: 50, offset: 0, showArchived: false })
    })

    it('does not honour a client-supplied x-project-id to widen scope', async () => {
      const res = await app.request(BASE, { headers: headers(ADMIN_COOKIE, {}) })
      expect(res.status).toBe(200)
      const res2 = await app.request(BASE, {
        headers: { ...headers(), 'x-project-id': '999' },
      })
      expect(res2.status).toBe(200)
      // Both calls forwarded the SESSION project (1), never the header value.
      for (const call of mockListSupers.mock.calls) {
        expect(call[0]).toBe(1)
      }
    })
  })

  // ─── Detail ─────────────────────────────────────────────────────────

  describe('GET /{id}', () => {
    it('returns the detail envelope with membership', async () => {
      const res = await app.request(`${BASE}/7`, { headers: headers() })
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(superHashListDetailResponseSchema.safeParse(body).success).toBe(true)
      expect(mockGetSuperById).toHaveBeenCalledWith(7, 1)
    })

    it('leaks no field the service never produced (negative shape)', async () => {
      const res = await app.request(`${BASE}/7`, { headers: headers() })
      const body = (await res.json()) as { superHashList: Record<string, unknown> }
      expect(Object.keys(body.superHashList).sort()).toEqual(
        ['archivedAt', 'createdAt', 'id', 'memberIds', 'name', 'projectId', 'updatedAt'].sort()
      )
      // A super owns no hash items (R10) — no count/aggregate may appear here.
      for (const forbidden of ['hashCount', 'crackedCount', 'hashTypeId', 'members', 'items']) {
        expect(body.superHashList).not.toHaveProperty(forbidden)
      }
    })

    it('returns 404 in the dashboard envelope for a missing / cross-project id', async () => {
      mockGetSuperById.mockImplementationOnce(async () => null)
      const res = await app.request(`${BASE}/4242`, { headers: headers() })
      expect(res.status).toBe(404)
      const body = (await res.json()) as { error?: { code?: string; message?: string } }
      expect(body.error?.code).toBe('RESOURCE_NOT_FOUND')
      expect(body.error?.message).toBe('Super hash list not found')
    })

    it('400s a non-numeric id through the shared validation hook', async () => {
      const res = await app.request(`${BASE}/not-a-number`, { headers: headers() })
      expect(res.status).toBe(400)
      const body = (await res.json()) as { error?: { code?: string } }
      expect(body.error?.code).toBe('VALIDATION_ERROR')
    })
  })

  // ─── Rename ─────────────────────────────────────────────────────────

  describe('PATCH /{id}', () => {
    it('renames and returns the bare (no-membership) envelope', async () => {
      const res = await app.request(`${BASE}/7`, {
        method: 'PATCH',
        headers: jsonHeaders(),
        body: JSON.stringify({ name: 'Renamed' }),
      })
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(superHashListResponseSchema.safeParse(body).success).toBe(true)
      // `renameSuper` returns a bare row — the route must not invent memberIds.
      expect((body as { superHashList: object }).superHashList).not.toHaveProperty('memberIds')
      expect(mockRenameSuper).toHaveBeenCalledWith(7, 1, 'Renamed')
    })

    it('returns 404 when the super is missing or in another project', async () => {
      mockRenameSuper.mockImplementationOnce(async () => null)
      const res = await app.request(`${BASE}/7`, {
        method: 'PATCH',
        headers: jsonHeaders(),
        body: JSON.stringify({ name: 'Renamed' }),
      })
      expect(res.status).toBe(404)
      const body = (await res.json()) as { error?: { code?: string } }
      expect(body.error?.code).toBe('RESOURCE_NOT_FOUND')
    })

    it('400s an empty name', async () => {
      const res = await app.request(`${BASE}/7`, {
        method: 'PATCH',
        headers: jsonHeaders(),
        body: JSON.stringify({ name: '' }),
      })
      expect(res.status).toBe(400)
    })
  })

  // ─── Membership ─────────────────────────────────────────────────────

  describe('POST /{id}/members', () => {
    it('adds a member and returns the updated membership', async () => {
      const res = await app.request(`${BASE}/7/members`, {
        method: 'POST',
        headers: jsonHeaders(),
        body: JSON.stringify({ hashListId: 13 }),
      })
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(superHashListDetailResponseSchema.safeParse(body).success).toBe(true)
      expect(mockAddMember).toHaveBeenCalledWith(7, 13, 1)
    })

    it('maps member-already-in-another-super to 409, not 500 (R3)', async () => {
      mockAddMember.mockImplementationOnce(async () => {
        throw new SuperMemberAlreadyInSuperError([13])
      })
      const res = await app.request(`${BASE}/7/members`, {
        method: 'POST',
        headers: jsonHeaders(),
        body: JSON.stringify({ hashListId: 13 }),
      })
      expect(res.status).toBe(409)
      const body = (await res.json()) as { error?: { code?: string; message?: string } }
      expect(body.error?.code).toBe('SUPER_MEMBER_ALREADY_IN_SUPER')
      expect(body.error?.message).toContain('13')
    })

    it('maps cross-project member to 400, not 500 (R5)', async () => {
      mockAddMember.mockImplementationOnce(async () => {
        throw new SuperMemberProjectMismatchError([777])
      })
      const res = await app.request(`${BASE}/7/members`, {
        method: 'POST',
        headers: jsonHeaders(),
        body: JSON.stringify({ hashListId: 777 }),
      })
      expect(res.status).toBe(400)
      const body = (await res.json()) as { error?: { code?: string } }
      expect(body.error?.code).toBe('SUPER_MEMBER_PROJECT_MISMATCH')
    })

    it('returns 404 when the super does not exist in the project', async () => {
      mockAddMember.mockImplementationOnce(async () => null)
      const res = await app.request(`${BASE}/7/members`, {
        method: 'POST',
        headers: jsonHeaders(),
        body: JSON.stringify({ hashListId: 13 }),
      })
      expect(res.status).toBe(404)
    })
  })

  describe('DELETE /{id}/members/{listId}', () => {
    it('removes a member and returns the shrunken membership', async () => {
      const res = await app.request(`${BASE}/7/members/12`, {
        method: 'DELETE',
        headers: headers(),
      })
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(superHashListDetailResponseSchema.safeParse(body).success).toBe(true)
      expect((body as { superHashList: { memberIds: number[] } }).superHashList.memberIds).toEqual([
        11,
      ])
      expect(mockRemoveMember).toHaveBeenCalledWith(7, 12, 1)
    })

    it('returns 404 when the super does not exist in the project', async () => {
      mockRemoveMember.mockImplementationOnce(async () => null)
      const res = await app.request(`${BASE}/7/members/12`, {
        method: 'DELETE',
        headers: headers(),
      })
      expect(res.status).toBe(404)
      const body = (await res.json()) as { error?: { code?: string } }
      expect(body.error?.code).toBe('RESOURCE_NOT_FOUND')
    })
  })

  // ─── Archive ────────────────────────────────────────────────────────

  describe('POST /{id}/archive', () => {
    it('archives and returns the stamped archivedAt', async () => {
      const res = await app.request(`${BASE}/7/archive`, { method: 'POST', headers: headers() })
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(superHashListResponseSchema.safeParse(body).success).toBe(true)
      expect((body as { superHashList: { archivedAt: string } }).superHashList.archivedAt).toBe(
        ARCHIVED_AT.toISOString()
      )
      expect(mockArchiveSuper).toHaveBeenCalledWith(7, 1)
    })

    it('returns 404 when the super does not exist in the project', async () => {
      mockArchiveSuper.mockImplementationOnce(async () => null)
      const res = await app.request(`${BASE}/7/archive`, { method: 'POST', headers: headers() })
      expect(res.status).toBe(404)
    })
  })

  // ─── OpenAPI registration (route-as-spec) ───────────────────────────

  describe('openapi registration', () => {
    it('publishes every super-hash-list path and schema in the served spec', async () => {
      const res = await app.request(OPENAPI, { headers: { host: SAME_ORIGIN_HOST } })
      expect(res.status).toBe(200)
      const spec = (await res.json()) as {
        paths: Record<string, Record<string, unknown>>
        components: { schemas: Record<string, unknown> }
      }
      expect(spec.paths['/super-hash-lists']?.['post']).toBeDefined()
      expect(spec.paths['/super-hash-lists']?.['get']).toBeDefined()
      expect(spec.paths['/super-hash-lists/{id}']?.['get']).toBeDefined()
      expect(spec.paths['/super-hash-lists/{id}']?.['patch']).toBeDefined()
      expect(spec.paths['/super-hash-lists/{id}/members']?.['post']).toBeDefined()
      expect(spec.paths['/super-hash-lists/{id}/members/{listId}']?.['delete']).toBeDefined()
      expect(spec.paths['/super-hash-lists/{id}/archive']?.['post']).toBeDefined()

      for (const name of [
        'SuperHashList',
        'SuperHashListDetail',
        'SuperHashListResponse',
        'SuperHashListDetailResponse',
        'SuperHashListListResponse',
        'CreateSuperHashListRequest',
        'RenameSuperHashListRequest',
        'AddSuperHashListMemberRequest',
      ]) {
        expect(spec.components.schemas[name]).toBeDefined()
      }
    })
  })
}
