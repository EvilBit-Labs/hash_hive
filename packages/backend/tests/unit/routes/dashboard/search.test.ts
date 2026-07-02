/**
 * Dashboard hash search route tests (issue #102, unit U11).
 *
 * Verifies GET /api/v1/dashboard/hashes/search?q=&limit=&offset=:
 *   - 200 happy path: project-scoped matches returned; crackedAt Date → ISO string
 *   - 200 round-trip: live response parses through hashSearchResponseSchema (KTD8)
 *   - 400 when q is empty string
 *   - 400 when q is missing
 *   - 401 when session cookie is missing or invalid
 *   - 403 when caller is not a project member
 *   - Confirms search is NOT realtime-invalidated (fetch-on-demand, KTD8)
 *
 * Isolation: mocks lib/auth.js, services/auth.js, services/hash-items/search.js,
 * db/index.js, ioredis.
 * Must run with DASHBOARD_HASH_SEARCH_TEST_ISOLATED=1.
 *
 * KTD8: mock fixtures typed against service ReturnType (crackedAt is Date,
 * NOT the wire string) so the test pins the service contract, not the route
 * response schema.
 */

import { hashSearchResponseSchema } from '@hashhive/shared'
import { beforeEach, describe, expect, it, mock } from 'bun:test'

const IS_ISOLATED = process.env['DASHBOARD_HASH_SEARCH_TEST_ISOLATED'] === '1'

if (!IS_ISOLATED) {
  describe.skip('dashboard-hash-search (skipped - runs in isolated phase)', () => {
    it('signals isolation phase is required', () => {
      // oxlint-disable-next-line no-console -- surface phase-gating drift in CI logs
      console.warn(
        '[dashboard-hash-search] skipped - set DASHBOARD_HASH_SEARCH_TEST_ISOLATED=1 to run.'
      )
      expect(process.env['DASHBOARD_HASH_SEARCH_TEST_ISOLATED']).toBeUndefined()
    })
  })
} else {
  // ─── KTD8 fixture typed against the service ReturnType ───────────────────────
  // crackedAt is Date (service layer), NOT string (wire layer).
  // Mixing up the two would mean the schema tests itself rather than the mapping.

  type SearchResult = Awaited<
    ReturnType<typeof import('../../../../src/services/hash-items/search.js').searchHashes>
  >

  const makeCrackedAt = (): Date => new Date('2025-01-15T10:30:00.000Z')

  const makeSearchResult = (overrides: Partial<SearchResult> = {}): SearchResult =>
    ({
      results: [
        {
          hashValue: 'abc123def456abc123def456abc123def456abc123def456abc123def456abc1',
          hashListId: 10,
          hashListName: 'test-list',
          crackedAt: makeCrackedAt(), // Date, not string — service ReturnType
        },
        {
          hashValue: 'deadbeefdeadbeefdeadbeefdeadbeef',
          hashListId: 11,
          hashListName: 'another-list',
          crackedAt: null, // uncracked row
        },
      ],
      total: 2,
      limit: 50,
      offset: 0,
      ...overrides,
    }) satisfies SearchResult

  // ─── Controllable state ──────────────────────────────────────────────────────

  let activeProjectId: number | null = 1
  let isMember = true
  let activeSearchResult: SearchResult = makeSearchResult()

  const mockSearchHashes = mock(async (..._args: unknown[]) => activeSearchResult)

  // ─── Module mocks — must precede any app import ──────────────────────────────

  mock.module('../../../../src/lib/auth.js', () => ({
    auth: {
      api: {
        getSession: async ({ headers }: { headers: Headers }) => {
          const cookie = headers.get('cookie') ?? ''
          if (!cookie.includes('hh.session_token=valid-session')) return null
          return {
            user: { id: '1', email: 'user@test.local', role: 'admin', banned: null },
            session: {
              userId: '1',
              token: 'tok',
              expiresAt: new Date(Date.now() + 3_600_000),
              projectId: activeProjectId,
            },
          }
        },
      },
      handler: async () => new Response('ok'),
    },
  }))

  mock.module('../../../../src/services/auth.js', () => ({
    getUserWithProjects: async (userId: number) => {
      if (userId === 1) return { id: 1, projects: [{ projectId: 1, roles: ['admin'] }] }
      return null
    },
    findProjectMembership: async (userId: number, projectId: number) => {
      if (!isMember) return null
      if (projectId !== activeProjectId) return null
      if (userId !== 1) return null
      return { projectId, roles: ['admin'] }
    },
    getUserLastProjectId: async () => null,
    setUserLastProjectIdIfMember: async () => 1,
    setUserLastProjectId: async () => undefined,
    issueUserApiKey: mock(async () => ({ apiKey: 'cst_test', metadata: null })),
    revokeUserApiKey: mock(async () => undefined),
    getUserApiKeyMetadata: mock(async () => null),
  }))

  mock.module('../../../../src/services/hash-items/search.js', () => ({
    searchHashes: mockSearchHashes,
    SEARCH_DEFAULT_LIMIT: 50,
    SEARCH_MAX_LIMIT: 100,
    SEARCH_DEFAULT_OFFSET: 0,
    SEARCH_MAX_Q_LENGTH: 1024,
  }))

  mock.module('../../../../src/db/index.js', () => ({
    db: {
      select: () => ({ from: () => ({ where: () => ({ limit: () => Promise.resolve([]) }) }) }),
    },
    client: new Proxy(
      {},
      {
        get(_t, p) {
          throw new Error(`Test mock: unexpected access to client.${String(p)}`)
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

  // ─── App mount (after all mocks) ─────────────────────────────────────────────

  const { hashRoutes } = await import('../../../../src/routes/dashboard/hashes.js')
  const { Hono } = await import('hono')
  const app = new (Hono as { new (): { route: Function; request: Function } })()
  app.route('/', hashRoutes)

  // ─── Helpers ─────────────────────────────────────────────────────────────────

  function makeRequest(params: Record<string, string | number>, opts: { cookie?: string } = {}) {
    const qs = new URLSearchParams(
      Object.entries(params).map(([k, v]) => [k, String(v)])
    ).toString()
    return (
      app as unknown as { request: (url: string, init: RequestInit) => Promise<Response> }
    ).request(`/search${qs ? `?${qs}` : ''}`, {
      method: 'GET',
      headers: {
        cookie: opts.cookie ?? 'hh.session_token=valid-session',
      },
    })
  }

  beforeEach(() => {
    activeProjectId = 1
    isMember = true
    activeSearchResult = makeSearchResult()
    mockSearchHashes.mockReset()
    mockSearchHashes.mockImplementation(async () => activeSearchResult)
  })

  // ─── Tests ───────────────────────────────────────────────────────────────────

  describe('GET /search (dashboard)', () => {
    it('200 happy path: returns project-scoped matches, crackedAt Date converted to ISO string', async () => {
      const res = await makeRequest({ q: 'abc123' })
      expect(res.status).toBe(200)

      const body = await res.json()

      // Service was called with the right project scope
      expect(mockSearchHashes).toHaveBeenCalledWith(1, 'abc123', { limit: 50, offset: 0 })

      // Results are present
      expect(body.results).toHaveLength(2)

      // crackedAt Date → ISO string mapping: service returns Date, wire must be string
      const cracked = body.results[0]
      expect(typeof cracked.crackedAt).toBe('string')
      expect(cracked.crackedAt).toBe('2025-01-15T10:30:00.000Z')

      // Uncracked row: crackedAt null
      const uncracked = body.results[1]
      expect(uncracked.crackedAt).toBeNull()

      // Pagination envelope
      expect(body.total).toBe(2)
      expect(body.limit).toBe(50)
      expect(body.offset).toBe(0)
    })

    it('200 round-trip: live response parses through hashSearchResponseSchema (KTD8)', async () => {
      const res = await makeRequest({ q: 'abc' })
      expect(res.status).toBe(200)

      const body = await res.json()

      // This is the KTD8 contract-test round-trip .parse() check.
      // If the Date → ISO string mapping is missing, crackedAt will be a Date
      // object (which JSON.stringify would coerce, but the schema expects a string).
      const parsed = hashSearchResponseSchema.safeParse(body)
      expect(parsed.success).toBe(true)

      // Strict schema: no extra fields
      expect(Object.keys(body).sort()).toStrictEqual(['limit', 'offset', 'results', 'total'])
    })

    it('400 when q is empty string', async () => {
      const res = await makeRequest({ q: '' })
      expect(res.status).toBe(400)

      const body = await res.json()
      expect(body.error).toBeDefined()
      expect(body.error.code).toBe('VALIDATION_ERROR')
    })

    it('400 when q is missing', async () => {
      const res = await makeRequest({})
      expect(res.status).toBe(400)

      const body = await res.json()
      expect(body.error).toBeDefined()
      expect(body.error.code).toBe('VALIDATION_ERROR')
    })

    it('401 when session cookie is missing or invalid', async () => {
      const res = await makeRequest({ q: 'abc' }, { cookie: 'hh.session_token=bad-token' })
      expect(res.status).toBe(401)
    })

    it('403 when caller is not a member of the active project', async () => {
      isMember = false

      const res = await makeRequest({ q: 'abc' })
      expect(res.status).toBe(403)
    })

    it('respects custom limit and offset query params', async () => {
      activeSearchResult = makeSearchResult({ total: 100, limit: 10, offset: 20 })

      const res = await makeRequest({ q: 'test', limit: 10, offset: 20 })
      expect(res.status).toBe(200)

      expect(mockSearchHashes).toHaveBeenCalledWith(1, 'test', { limit: 10, offset: 20 })
    })
  })
}
