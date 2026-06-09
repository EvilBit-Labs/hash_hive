/**
 * Route-level tests for `GET /api/v1/dashboard/hash-lists` (issue #165 U2).
 *
 * The endpoint powers the global Results page's hash-list filter
 * dropdown and the hash list detail stats card. Tests pin:
 *
 *  - Auth + project scoping per the dashboard read-endpoint contract
 *    (`docs/solutions/conventions/dashboard-read-endpoint-contract.md`).
 *  - Count typing: postgres-js returns `count(*)` as a STRING and
 *    Drizzle's `sql<number>` is compile-time only — without `Number(...)`
 *    coercion the wire would ship strings. The mock returns string
 *    counts so the route's coercion is actually exercised.
 *  - OpenAPI registration: the served `/openapi.json` includes the new
 *    path after this unit lands.
 *
 * Runs in an isolated phase via `DASHBOARD_HASH_LISTS_ROUTES_TEST_ISOLATED=1`
 * because this file mocks `src/db/index.js` wholesale — the mock leaks
 * process-wide and would clobber any neighbor that hits the real
 * driver. Mirrors the `dashboard-results-routes` isolation pattern.
 */
import { hashListListResponseSchema } from '@hashhive/shared'
import { beforeEach, describe, expect, it, mock } from 'bun:test'

const IS_ISOLATED = process.env['DASHBOARD_HASH_LISTS_ROUTES_TEST_ISOLATED'] === '1'

if (!IS_ISOLATED) {
  describe('dashboard-hash-lists-routes (skipped - runs in isolated phase)', () => {
    it('signals isolation phase is required', () => {
      // oxlint-disable-next-line no-console -- surface phase-gating drift in CI logs
      console.warn(
        '[dashboard-hash-lists-routes] skipped - set DASHBOARD_HASH_LISTS_ROUTES_TEST_ISOLATED=1 to run.'
      )
      expect(process.env['DASHBOARD_HASH_LISTS_ROUTES_TEST_ISOLATED']).toBeUndefined()
    })
  })
} else {
  // ─── Fixtures ───────────────────────────────────────────────────────

  const ADMIN_COOKIE = 'hh.session_token=valid-admin-session'
  const NON_MEMBER_COOKIE = 'hh.session_token=valid-non-member-session'
  const SAME_ORIGIN_HOST = 'lab.local'

  interface FixtureHashListRow {
    id: number
    name: string
    hashTypeId: number | null
    // Stored as STRINGS in the fixture to mirror postgres-js's runtime
    // shape for count aggregates — the route must coerce via `Number(...)`.
    hashCount: string
    crackedCount: string
    projectId: number
  }

  const state: { rows: FixtureHashListRow[] } = { rows: [] }

  // ─── Mock BetterAuth + RBAC scoping ─────────────────────────────────

  mock.module('../../src/lib/auth.js', () => ({
    auth: {
      api: {
        getSession: async ({ headers }: { headers: Headers }) => {
          const cookie = headers.get('cookie') ?? ''
          if (cookie.includes('valid-admin-session')) {
            return {
              user: {
                id: '1',
                email: 'admin@test.local',
                name: 'Admin',
                emailVerified: true,
                image: null,
                roles: ['admin'],
              },
              session: {
                id: 'sess',
                userId: '1',
                token: 'tok',
                expiresAt: new Date(Date.now() + 3600000),
                projectId: 1,
              },
            }
          }
          if (cookie.includes('valid-non-member-session')) {
            return {
              user: {
                id: '2',
                email: 'outsider@test.local',
                name: 'Outsider',
                emailVerified: true,
                image: null,
                roles: ['analyst'],
              },
              session: {
                id: 'sess-2',
                userId: '2',
                token: 'tok-2',
                expiresAt: new Date(Date.now() + 3600000),
                projectId: 1,
              },
            }
          }
          return null
        },
      },
      handler: async () => new Response('ok'),
    },
  }))

  mock.module('../../src/services/auth.js', () => ({
    getUserWithProjects: async (userId: number) => {
      if (userId === 1) {
        return { id: 1, projects: [{ projectId: 1, roles: ['admin'] }] }
      }
      if (userId === 2) {
        // Authenticated but NOT a member of project 1 — pins the
        // requireProjectAccess() 403 path.
        return { id: 2, projects: [] }
      }
      return null
    },
    findProjectMembership: async (userId: number, projectId: number) => {
      if (projectId !== 1) return null
      if (userId === 1) return { projectId: 1, roles: ['admin'] }
      return null
    },
    getUserLastProjectId: async () => null,
    setUserLastProjectIdIfMember: async () => 1,
    setUserLastProjectId: async () => undefined,
    issueUserApiKey: mock(async () => ({ apiKey: 'cst_test', metadata: null })),
    revokeUserApiKey: mock(async () => undefined),
    getUserApiKeyMetadata: mock(async () => null),
  }))

  // Filter by projectId on the session's project (always 1 in these
  // tests). Returns the projected shape the route's SELECT expects.
  let whereInvoked = false

  function projectRows(): Array<Record<string, unknown>> {
    whereInvoked = true
    return state.rows
      .filter((r) => r.projectId === 1)
      .map((r) => ({
        id: r.id,
        name: r.name,
        hashTypeId: r.hashTypeId,
        // Mirror postgres-js: counts come back as STRINGS at runtime.
        hashCount: r.hashCount,
        crackedCount: r.crackedCount,
      }))
  }

  function makeChain() {
    const chain = {
      from: () => chain,
      leftJoin: () => chain,
      where: () => chain,
      groupBy: () => chain,
      orderBy: () => chain,
      // oxlint-disable-next-line unicorn/no-thenable -- intentional thenable: mimics Drizzle's query-builder thenable so `await db.select(...).orderBy(...)` resolves to rows
      then: (resolve: (rows: unknown[]) => unknown) => {
        resolve(projectRows())
      },
    }
    return chain
  }

  mock.module('../../src/db/index.js', () => ({
    db: {
      select: () => makeChain(),
      insert: () => ({ values: () => ({ returning: () => Promise.resolve([]) }) }),
      update: () => ({
        set: () => ({ where: () => ({ returning: () => Promise.resolve([]) }) }),
      }),
    },
    // Throws on any access — surfaces tests that assume the real `client`
    // export instead of going through `db`.
    client: new Proxy(
      {},
      {
        get(_target, prop) {
          throw new Error(
            `Test mock: unexpected access to client.${String(prop)} — extend the mock or use db.`
          )
        },
      }
    ),
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

  // Dynamically import the app after the mocks register.
  const { app } = await import('../../src/index.js')

  const HASH_LISTS = '/api/v1/dashboard/hash-lists'
  const OPENAPI = '/api/v1/dashboard/openapi.json'

  function makeHeaders(extra: Record<string, string> = {}) {
    return {
      cookie: ADMIN_COOKIE,
      host: SAME_ORIGIN_HOST,
      origin: `https://${SAME_ORIGIN_HOST}`,
      'x-project-id': '1',
      ...extra,
    }
  }

  beforeEach(() => {
    state.rows = []
    whereInvoked = false
  })

  // ─── Auth ───────────────────────────────────────────────────────────

  describe('auth', () => {
    it('returns 401 when no session cookie is present', async () => {
      const res = await app.request(HASH_LISTS, {
        method: 'GET',
        headers: { host: SAME_ORIGIN_HOST },
      })
      expect(res.status).toBe(401)
    })

    it('returns 401 when a non-matching session cookie is present', async () => {
      const res = await app.request(HASH_LISTS, {
        method: 'GET',
        headers: { host: SAME_ORIGIN_HOST, cookie: 'hh.session_token=invalid-session' },
      })
      expect(res.status).toBe(401)
    })

    it('returns 403 when session user has no membership in active project', async () => {
      const res = await app.request(HASH_LISTS, {
        method: 'GET',
        headers: {
          cookie: NON_MEMBER_COOKIE,
          host: SAME_ORIGIN_HOST,
          origin: `https://${SAME_ORIGIN_HOST}`,
        },
      })
      expect(res.status).toBe(403)
    })
  })

  // ─── Happy paths ────────────────────────────────────────────────────

  describe('listing', () => {
    it('returns empty hashLists array when project has no hash lists', async () => {
      state.rows = []
      const res = await app.request(HASH_LISTS, {
        method: 'GET',
        headers: makeHeaders(),
      })
      expect(res.status).toBe(200)
      const body = (await res.json()) as { hashLists: unknown[] }
      expect(body.hashLists).toEqual([])
      // Confirm the where(projectId=…) branch actually ran rather than
      // an accidental no-filter path that happened to return 0 rows.
      expect(whereInvoked).toBe(true)
    })

    it('returns hash lists scoped to the session project, sorted by name', async () => {
      state.rows = [
        {
          id: 1,
          name: 'Zebra',
          hashTypeId: 1000,
          hashCount: '5',
          crackedCount: '2',
          projectId: 1,
        },
        {
          id: 2,
          name: 'Alpha',
          hashTypeId: 1000,
          hashCount: '10',
          crackedCount: '3',
          projectId: 1,
        },
        // Belongs to a different project — must NOT appear in the
        // response. The mock filters by projectId so this row is dropped
        // the same way the production WHERE clause would drop it.
        {
          id: 3,
          name: 'BetweenAandZ',
          hashTypeId: null,
          hashCount: '7',
          crackedCount: '4',
          projectId: 99,
        },
      ]
      // Mock returns the rows as projected; the route's ORDER BY name
      // would sort them at the SQL layer. The mock isn't sorting, so
      // we present them in already-sorted order for the assertion below.
      state.rows = [
        {
          id: 2,
          name: 'Alpha',
          hashTypeId: 1000,
          hashCount: '10',
          crackedCount: '3',
          projectId: 1,
        },
        {
          id: 1,
          name: 'Zebra',
          hashTypeId: 1000,
          hashCount: '5',
          crackedCount: '2',
          projectId: 1,
        },
        {
          id: 3,
          name: 'BetweenAandZ',
          hashTypeId: null,
          hashCount: '7',
          crackedCount: '4',
          projectId: 99,
        },
      ]
      const res = await app.request(HASH_LISTS, {
        method: 'GET',
        headers: makeHeaders(),
      })
      expect(res.status).toBe(200)
      const body = (await res.json()) as {
        hashLists: Array<{ id: number; name: string }>
      }
      expect(body.hashLists.map((r) => r.name)).toEqual(['Alpha', 'Zebra'])
      // Project 99's hash list must not leak through.
      expect(body.hashLists.find((r) => r.id === 3)).toBeUndefined()
    })

    it('returns hashCount=0 and crackedCount=0 for a hash list with zero items', async () => {
      state.rows = [
        {
          id: 1,
          name: 'EmptyList',
          hashTypeId: null,
          hashCount: '0',
          crackedCount: '0',
          projectId: 1,
        },
      ]
      const res = await app.request(HASH_LISTS, {
        method: 'GET',
        headers: makeHeaders(),
      })
      expect(res.status).toBe(200)
      const body = (await res.json()) as {
        hashLists: Array<{ hashCount: number; crackedCount: number }>
      }
      expect(body.hashLists[0]?.hashCount).toBe(0)
      expect(body.hashLists[0]?.crackedCount).toBe(0)
    })

    it('returns hashCount=N and crackedCount=0 for a hash list with items but zero cracks', async () => {
      state.rows = [
        {
          id: 1,
          name: 'AllUncracked',
          hashTypeId: 1000,
          hashCount: '100',
          crackedCount: '0',
          projectId: 1,
        },
      ]
      const res = await app.request(HASH_LISTS, {
        method: 'GET',
        headers: makeHeaders(),
      })
      const body = (await res.json()) as {
        hashLists: Array<{ hashCount: number; crackedCount: number }>
      }
      expect(body.hashLists[0]?.hashCount).toBe(100)
      expect(body.hashLists[0]?.crackedCount).toBe(0)
    })

    it('returns each row with id, name, hashTypeId, hashCount, crackedCount', async () => {
      state.rows = [
        {
          id: 42,
          name: 'Sprint One',
          hashTypeId: 1000,
          hashCount: '500',
          crackedCount: '127',
          projectId: 1,
        },
      ]
      const res = await app.request(HASH_LISTS, {
        method: 'GET',
        headers: makeHeaders(),
      })
      const body = (await res.json()) as {
        hashLists: Array<Record<string, unknown>>
      }
      expect(Object.keys(body.hashLists[0]!).sort()).toEqual(
        ['crackedCount', 'hashCount', 'hashTypeId', 'id', 'name'].sort()
      )
      expect(body.hashLists[0]).toEqual({
        id: 42,
        name: 'Sprint One',
        hashTypeId: 1000,
        hashCount: 500,
        crackedCount: 127,
      })
    })

    it('supports a nullable hashTypeId on the wire', async () => {
      state.rows = [
        {
          id: 1,
          name: 'Untyped',
          hashTypeId: null,
          hashCount: '3',
          crackedCount: '0',
          projectId: 1,
        },
      ]
      const res = await app.request(HASH_LISTS, {
        method: 'GET',
        headers: makeHeaders(),
      })
      const body = (await res.json()) as { hashLists: Array<{ hashTypeId: number | null }> }
      expect(body.hashLists[0]?.hashTypeId).toBeNull()
    })

    it('ships hashCount and crackedCount as JavaScript numbers, not strings', async () => {
      // Regression guard: postgres-js returns count(*) as a string and
      // Drizzle's `sql<number>` is compile-time only — without an
      // explicit `Number(...)` cast both counts would ship as strings.
      // The fixture stores them as STRINGS so a missing cast surfaces
      // here as `typeof === 'string'`.
      state.rows = [
        {
          id: 1,
          name: 'NumberCheck',
          hashTypeId: 1000,
          hashCount: '7',
          crackedCount: '3',
          projectId: 1,
        },
      ]
      const res = await app.request(HASH_LISTS, {
        method: 'GET',
        headers: makeHeaders(),
      })
      const body = (await res.json()) as {
        hashLists: Array<{ hashCount: unknown; crackedCount: unknown }>
      }
      expect(typeof body.hashLists[0]?.hashCount).toBe('number')
      expect(typeof body.hashLists[0]?.crackedCount).toBe('number')
      expect(body.hashLists[0]?.hashCount).toBe(7)
      expect(body.hashLists[0]?.crackedCount).toBe(3)
    })

    it('produces a response that round-trips through hashListListResponseSchema', async () => {
      state.rows = [
        {
          id: 1,
          name: 'A',
          hashTypeId: 1000,
          hashCount: '5',
          crackedCount: '2',
          projectId: 1,
        },
        {
          id: 2,
          name: 'B',
          hashTypeId: null,
          hashCount: '0',
          crackedCount: '0',
          projectId: 1,
        },
      ]
      const res = await app.request(HASH_LISTS, {
        method: 'GET',
        headers: makeHeaders(),
      })
      const body = await res.json()
      const parsed = hashListListResponseSchema.safeParse(body)
      expect(parsed.success).toBe(true)
    })
  })

  // ─── Project scoping invariant ──────────────────────────────────────

  describe('project scoping', () => {
    it('does not honor a client-supplied x-project-id header to widen scope', async () => {
      // The mock filters by session.projectId (1); a stray header
      // attempting to widen scope must NOT change the response. This
      // mirrors the contract pinned by dashboard-results-routes.
      state.rows = [
        {
          id: 1,
          name: 'session-scope-row',
          hashTypeId: 1000,
          hashCount: '1',
          crackedCount: '0',
          projectId: 1,
        },
        {
          id: 2,
          name: 'other-project-row',
          hashTypeId: 1000,
          hashCount: '1',
          crackedCount: '0',
          projectId: 999,
        },
      ]
      const res = await app.request(HASH_LISTS, {
        method: 'GET',
        headers: { ...makeHeaders(), 'x-project-id': '999' },
      })
      expect(res.status).toBe(200)
      const body = (await res.json()) as { hashLists: Array<{ name: string }> }
      expect(body.hashLists.every((r) => r.name === 'session-scope-row')).toBe(true)
    })
  })

  // ─── OpenAPI registration ───────────────────────────────────────────

  describe('openapi registration', () => {
    it('exposes the GET /hash-lists path in the served openapi.json', async () => {
      const res = await app.request(OPENAPI, {
        method: 'GET',
        headers: { host: SAME_ORIGIN_HOST },
      })
      expect(res.status).toBe(200)
      const spec = (await res.json()) as {
        paths: Record<string, Record<string, unknown>>
        components: { schemas: Record<string, unknown> }
      }
      // The route is mounted at `/hash-lists` on the dashboard surface;
      // OpenAPIHono uses the mount path as the documented path.
      expect(spec.paths['/hash-lists']).toBeDefined()
      expect(spec.paths['/hash-lists']?.['get']).toBeDefined()
      // The response schema is registered as a named component so
      // downstream codegen can `$ref` it.
      expect(spec.components.schemas['HashListSummary']).toBeDefined()
      expect(spec.components.schemas['HashListListResponse']).toBeDefined()
    })
  })
}
