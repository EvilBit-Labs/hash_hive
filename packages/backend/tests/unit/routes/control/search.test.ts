/**
 * Control API hash search route tests (issue #102, unit U11).
 *
 * Verifies GET /api/v1/control/search?q=&limit=&offset=:
 *   - 200 happy path: API-key auth, project-scoped results, pagination
 *   - 200 round-trip: live response parses through hashSearchResponseSchema (KTD8)
 *   - 400 when q is empty string or missing
 *   - 403 when caller is not a project member (problem+json)
 *   - crackedAt Date → ISO string mapping confirmed (service mock uses Date)
 *   - null crackedAt (uncracked row) passes through as null
 *
 * Isolation: mocks routes/control/helpers.js, services/hash-items/search.js,
 * db/index.js, ioredis.
 * Must run with CONTROL_HASH_SEARCH_TEST_ISOLATED=1.
 *
 * KTD8: mock fixtures typed against Awaited<ReturnType<typeof searchHashes>>
 * where crackedAt is Date (service layer), NOT string (wire schema). Mixing
 * the two would mean the round-trip test validates the schema against itself.
 */

import { hashSearchResponseSchema } from '@hashhive/shared'
import { beforeEach, describe, expect, it, mock } from 'bun:test'

const IS_ISOLATED = process.env['CONTROL_HASH_SEARCH_TEST_ISOLATED'] === '1'

if (!IS_ISOLATED) {
  describe.skip('control-hash-search (skipped - runs in isolated phase)', () => {
    it('signals isolation phase is required', () => {
      // oxlint-disable-next-line no-console -- surface phase-gating drift in CI logs
      console.warn(
        '[control-hash-search] skipped - set CONTROL_HASH_SEARCH_TEST_ISOLATED=1 to run.'
      )
      expect(process.env['CONTROL_HASH_SEARCH_TEST_ISOLATED']).toBeUndefined()
    })
  })
} else {
  // ─── KTD8 fixture typed against the service ReturnType ───────────────────────
  // crackedAt is Date (service layer), NOT string (wire layer).
  // The mock must return a Date so the route's Date → ISO mapping is exercised.

  type SearchResult = Awaited<
    ReturnType<typeof import('../../../../src/services/hash-items/search.js').searchHashes>
  >

  const makeCrackedAt = (): Date => new Date('2025-03-20T14:00:00.000Z')

  const makeSearchResult = (overrides: Partial<SearchResult> = {}): SearchResult =>
    ({
      results: [
        {
          hashValue: 'aabbccdd11223344aabbccdd11223344',
          hashListId: 5,
          hashListName: 'control-list',
          crackedAt: makeCrackedAt(), // Date — service ReturnType, NOT wire string
        },
        {
          hashValue: '0000111122223333000011112222333300001111',
          hashListId: 6,
          hashListName: 'second-list',
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

  // ─── Module mocks — must precede any route import ────────────────────────────

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

  mock.module('../../../../src/routes/control/helpers.js', () => ({
    requireProjectMembership: async () => {
      if (activeProjectId === null) {
        const err = Object.assign(new Error('No project selected'), { status: 400 })
        throw err
      }
      if (!isMember) {
        const err = Object.assign(new Error('Not a member of this project'), { status: 403 })
        throw err
      }
      return { projectId: activeProjectId, roles: ['admin'] }
    },
    controlErrorResponse: (
      c: { json: (body: unknown, status: number) => Response },
      err: unknown
    ) => {
      const message = err instanceof Error ? err.message : 'unknown'
      const status =
        err instanceof Error && 'status' in err
          ? ((err as Error & { status?: number }).status ?? 500)
          : 500
      const code = status === 403 ? 'forbidden' : status === 400 ? 'validation' : 'internal'
      return c.json(
        {
          type: `https://hashhive.dev/errors/${code}`,
          title:
            status === 403 ? 'Forbidden' : status === 400 ? 'Validation failed' : 'Internal error',
          status,
          detail: message,
          instance: '/',
        },
        status
      )
    },
  }))

  mock.module('../../../../src/services/hash-items/search.js', () => ({
    searchHashes: mockSearchHashes,
    SEARCH_DEFAULT_LIMIT: 50,
    SEARCH_MAX_LIMIT: 100,
    SEARCH_DEFAULT_OFFSET: 0,
    SEARCH_MAX_Q_LENGTH: 1024,
  }))

  // ─── Route mount (after all mocks) ───────────────────────────────────────────

  const { controlSearchRoutes } = await import('../../../../src/routes/control/search.js')
  const { Hono } = await import('hono')
  const app = new (Hono as { new (): { use: Function; route: Function; request: Function } })()
  app.use('*', async (c: { set: (k: string, v: unknown) => void }, next: () => Promise<void>) => {
    c.set('currentUser', {
      userId: 1,
      email: 'api@test.local',
      roles: [],
      projectId: activeProjectId,
    })
    await next()
  })
  app.route('/', controlSearchRoutes)

  // ─── Helpers ─────────────────────────────────────────────────────────────────

  function makeRequest(
    params: Record<string, string | number>,
    headers: Record<string, string> = {}
  ) {
    const qs = new URLSearchParams(
      Object.entries(params).map(([k, v]) => [k, String(v)])
    ).toString()
    return (
      app as unknown as { request: (url: string, init: RequestInit) => Promise<Response> }
    ).request(`/${qs ? `?${qs}` : ''}`, {
      method: 'GET',
      headers: { ...headers },
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

  describe('GET / (control search)', () => {
    it('200 happy path: API key auth, project-scoped results, pagination envelope', async () => {
      const res = await makeRequest({ q: 'aabbccdd' })
      expect(res.status).toBe(200)

      const body = await res.json()

      // Service called with correct project scope
      expect(mockSearchHashes).toHaveBeenCalledWith(1, 'aabbccdd', { limit: 50, offset: 0 })

      // Results present
      expect(body.results).toHaveLength(2)

      // crackedAt Date (in service mock) → ISO string on the wire
      const cracked = body.results[0]
      expect(typeof cracked.crackedAt).toBe('string')
      expect(cracked.crackedAt).toBe('2025-03-20T14:00:00.000Z')

      // Uncracked row: crackedAt null
      const uncracked = body.results[1]
      expect(uncracked.crackedAt).toBeNull()

      // Pagination envelope fields
      expect(body.total).toBe(2)
      expect(body.limit).toBe(50)
      expect(body.offset).toBe(0)
    })

    it('200 round-trip: live response parses through hashSearchResponseSchema (KTD8)', async () => {
      const res = await makeRequest({ q: 'test' })
      expect(res.status).toBe(200)

      const body = await res.json()

      // KTD8 round-trip: run the live wire body through the shared schema.
      // Fails if crackedAt is a Date object instead of an ISO string, or if
      // extra fields slip in (hashSearchResponseSchema is .strict()).
      const parsed = hashSearchResponseSchema.safeParse(body)
      expect(parsed.success).toBe(true)

      // Strict schema: no extra keys
      expect(Object.keys(body).sort()).toStrictEqual(['limit', 'offset', 'results', 'total'])
    })

    it('400 when q is empty string', async () => {
      const res = await makeRequest({ q: '' })
      expect(res.status).toBe(400)
    })

    it('400 when q is missing', async () => {
      const res = await makeRequest({})
      expect(res.status).toBe(400)
    })

    it('403 when caller is not a project member (problem+json)', async () => {
      isMember = false

      const res = await makeRequest({ q: 'abc' })
      expect(res.status).toBe(403)

      const body = await res.json()
      // problem+json envelope
      expect(body.type).toMatch(/hashhive\.dev\/errors\/forbidden/)
      expect(body.status).toBe(403)
    })

    it('respects custom limit and offset', async () => {
      activeSearchResult = makeSearchResult({ total: 200, limit: 25, offset: 50 })

      const res = await makeRequest({ q: 'hash', limit: 25, offset: 50 })
      expect(res.status).toBe(200)

      expect(mockSearchHashes).toHaveBeenCalledWith(1, 'hash', { limit: 25, offset: 50 })

      const body = await res.json()
      expect(body.limit).toBe(25)
      expect(body.offset).toBe(50)
    })
  })
}
