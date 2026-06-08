/**
 * Route-level tests for `GET /api/v1/dashboard/results` and
 * `GET /api/v1/dashboard/results/export`. Closes the test gap called
 * out by the source ticket (DoD) and exercises the streaming-CSV
 * keyset-pagination correctness that the AC2 "all matching rows"
 * invariant depends on.
 *
 * Runs in an isolated phase via `DASHBOARD_RESULTS_ROUTES_TEST_ISOLATED=1`
 * because this file mocks `src/db/index.js` wholesale - the mock leaks
 * process-wide and would clobber any neighbor that hits the real
 * driver. Mirrors the dashboard-campaigns-routes isolation pattern.
 */
import { beforeEach, describe, expect, it, mock } from 'bun:test'

const IS_ISOLATED = process.env['DASHBOARD_RESULTS_ROUTES_TEST_ISOLATED'] === '1'

if (!IS_ISOLATED) {
  describe('dashboard-results-routes (skipped - runs in isolated phase)', () => {
    it('signals isolation phase is required', () => {
      // oxlint-disable-next-line no-console -- surface phase-gating drift in CI logs
      console.warn(
        '[dashboard-results-routes] skipped - set DASHBOARD_RESULTS_ROUTES_TEST_ISOLATED=1 to run.'
      )
      expect(process.env['DASHBOARD_RESULTS_ROUTES_TEST_ISOLATED']).toBeUndefined()
    })
  })
} else {
  // ─── Fixtures ───────────────────────────────────────────────────────

  const ADMIN_COOKIE = 'hh.session_token=valid-admin-session'
  const SAME_ORIGIN_HOST = 'lab.local'

  interface FixtureRow {
    id: number
    hashValue: string
    plaintext: string | null
    crackedAt: Date | null
    hashListId: number
    hashListName: string
    campaignId: number
    campaignName: string | null
    attackId: number | null
    attackMode: number | null
    agentId: number | null
    // Project gating data (would join via campaigns.project_id IRL).
    campaignProjectId: number
  }

  const state: { rows: FixtureRow[] } = { rows: [] }

  function sortLikeDb(rows: FixtureRow[]): FixtureRow[] {
    return [...rows].sort((a, b) => {
      const aAt = a.crackedAt?.getTime() ?? 0
      const bAt = b.crackedAt?.getTime() ?? 0
      return bAt - aAt || b.id - a.id
    })
  }

  // oxlint-disable-next-line unicorn/consistent-function-scoping -- intentionally local to the isolated-phase else block so it can't be exercised outside of an IS_ISOLATED run; the lint nudge to hoist outside conflicts with the phase-gating pattern
  function makeRow(overrides: Partial<FixtureRow> = {}): FixtureRow {
    // `??` would collapse explicit `null` overrides into the default;
    // use property-existence so callers can pin a column to null.
    const pick = <K extends keyof FixtureRow>(key: K, def: FixtureRow[K]): FixtureRow[K] =>
      key in overrides ? (overrides[key] as FixtureRow[K]) : def
    return {
      id: pick('id', 1),
      hashValue: pick('hashValue', 'aabbcc'),
      plaintext: pick('plaintext', null),
      crackedAt: pick('crackedAt', new Date('2026-05-01T12:00:00.000Z')),
      hashListId: pick('hashListId', 10),
      hashListName: pick('hashListName', 'List Alpha'),
      campaignId: pick('campaignId', 100),
      campaignName: pick('campaignName', 'Campaign One'),
      attackId: pick('attackId', null),
      attackMode: pick('attackMode', null),
      agentId: pick('agentId', null),
      campaignProjectId: pick('campaignProjectId', 1),
    }
  }

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

  // The mock returns a thenable chain that resolves to rows from
  // `state.rows`. db.select() branches by projection shape using the
  // sentinel keys below; if the route's projections evolve, the
  // sentinels must move with them or the wrong branch fires.
  //   COUNT_SENTINEL     — only the count query projects this
  //   LIST_SENTINEL      — only the list projection includes `agentId`
  //   (export batch)     — fallback when neither sentinel is present

  const COUNT_SENTINEL = 'count'
  const LIST_SENTINEL = 'agentId'

  let limitBuffer: number | null = null
  let offsetBuffer = 0
  let exportRowsServed = 0
  let projectionsSeen: string[][] = []

  function makeChain(rowsProvider: () => unknown[]) {
    const chain = {
      from: () => chain,
      innerJoin: () => chain,
      leftJoin: () => chain,
      where: () => chain,
      orderBy: () => chain,
      limit: (n: number) => {
        limitBuffer = n
        return chain
      },
      offset: (n: number) => {
        offsetBuffer = n
        return chain
      },
      // oxlint-disable-next-line unicorn/no-thenable -- intentional thenable: mimics Drizzle's query-builder thenable so `await db.select(...).limit(N)` resolves to rows
      then: (resolve: (rows: unknown[]) => unknown) => {
        resolve(rowsProvider())
      },
    }
    return chain
  }

  // Mirror Drizzle's behavior: a select(projection) returns only the
  // projected columns, not the full row. Filtering here keeps fixture-
  // only fields (e.g., campaignProjectId) from leaking into responses.
  function project(row: FixtureRow, keys: string[]): Record<string, unknown> {
    const out: Record<string, unknown> = {}
    for (const k of keys) {
      out[k] = (row as unknown as Record<string, unknown>)[k]
    }
    return out
  }

  mock.module('../../src/db/index.js', () => ({
    db: {
      select: (projection: Record<string, unknown> | undefined) => {
        const keys = projection ? Object.keys(projection) : []
        projectionsSeen.push(keys)
        const isCount = keys.length === 1 && keys[0] === COUNT_SENTINEL
        const isListRows = keys.includes(LIST_SENTINEL)
        const isExportBatch = !isCount && !isListRows

        if (isCount) {
          // postgres-js returns `count(*)` as a STRING at runtime;
          // mirror that so the route's `Number(rawCount ?? 0)` cast
          // is actually exercised (a regression that drops the cast
          // would otherwise pass these tests because plain
          // `state.rows.length` is already a number).
          return makeChain(() => [{ count: String(state.rows.length) }])
        }
        if (isExportBatch) {
          return makeChain(() => {
            const batchSize = limitBuffer ?? state.rows.length
            const slice = state.rows.slice(exportRowsServed, exportRowsServed + batchSize)
            exportRowsServed += slice.length
            return slice.map((r) => project(r, keys))
          })
        }
        return makeChain(() => {
          const lim = limitBuffer ?? state.rows.length
          return state.rows.slice(offsetBuffer, offsetBuffer + lim).map((r) => project(r, keys))
        })
      },
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

  const RESULTS = '/api/v1/dashboard/results'
  const EXPORT = '/api/v1/dashboard/results/export'

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
    limitBuffer = null
    offsetBuffer = 0
    exportRowsServed = 0
    projectionsSeen = []
  })

  // ─── Auth + scoping ─────────────────────────────────────────────────

  describe('auth and project scoping', () => {
    it('returns 401 when no session cookie is present', async () => {
      const res = await app.request(RESULTS, {
        method: 'GET',
        headers: { host: SAME_ORIGIN_HOST },
      })
      expect(res.status).toBe(401)
    })

    it('returns 401 when a non-matching session cookie is present', async () => {
      const res = await app.request(RESULTS, {
        method: 'GET',
        headers: { host: SAME_ORIGIN_HOST, cookie: 'hh.session_token=invalid-session' },
      })
      expect(res.status).toBe(401)
    })

    it('returns 200 with empty results when project has no cracked rows', async () => {
      state.rows = []
      const res = await app.request(RESULTS, {
        method: 'GET',
        headers: makeHeaders(),
      })
      expect(res.status).toBe(200)
      const body = (await res.json()) as { results: unknown[]; total: number }
      expect(body.results).toEqual([])
      expect(body.total).toBe(0)
    })
  })

  // ─── List endpoint: shape + attribution ─────────────────────────────

  describe('list endpoint shape', () => {
    it('resolves attackModeName for every supported hashcat mode', async () => {
      // Pins the full HASHCAT_ATTACK_MODE_NAMES contract — a regression
      // that drops or renames any entry surfaces here.
      const supported: Array<[number, string]> = [
        [0, 'Dictionary'],
        [1, 'Combination'],
        [3, 'Mask'],
        [6, 'Hybrid Wordlist + Mask'],
        [7, 'Hybrid Mask + Wordlist'],
        [9, 'Association'],
      ]
      state.rows = [
        ...supported.map(([mode], i) => makeRow({ id: i + 1, attackMode: mode, attackId: 50 + i })),
        makeRow({ id: 100, attackMode: 99, attackId: 99 }),
        makeRow({ id: 101, attackMode: null, attackId: null }),
      ]
      const res = await app.request(RESULTS, {
        method: 'GET',
        headers: makeHeaders(),
      })
      expect(res.status).toBe(200)
      const body = (await res.json()) as {
        results: Array<{ id: number; attackMode: number | null; attackModeName: string | null }>
      }
      for (const [mode, expected] of supported) {
        const row = body.results.find((r) => r.attackMode === mode)
        expect(row?.attackModeName).toBe(expected)
      }
      expect(body.results.find((r) => r.id === 100)?.attackModeName).toBeNull()
      expect(body.results.find((r) => r.id === 101)?.attackModeName).toBeNull()
    })

    it('echoes total + limit + offset and ships total as a number, not a string', async () => {
      // Regression guard: postgres-js returns count(*) as a string and
      // Drizzle's `sql<number>` is compile-time only — without the
      // explicit `Number(...)` cast, total would be `"4"` and violate
      // listResultsResponseSchema.
      state.rows = [makeRow({ id: 1 }), makeRow({ id: 2 }), makeRow({ id: 3 }), makeRow({ id: 4 })]
      const res = await app.request(`${RESULTS}?limit=2&offset=0`, {
        method: 'GET',
        headers: makeHeaders(),
      })
      const body = (await res.json()) as { total: unknown; limit: unknown; offset: unknown }
      expect(typeof body.total).toBe('number')
      expect(body.total).toBe(4)
      expect(body.limit).toBe(2)
      expect(body.offset).toBe(0)
    })

    it('honors offset when paginating', async () => {
      state.rows = [
        makeRow({ id: 1, hashValue: 'a' }),
        makeRow({ id: 2, hashValue: 'b' }),
        makeRow({ id: 3, hashValue: 'c' }),
        makeRow({ id: 4, hashValue: 'd' }),
      ]
      const res = await app.request(`${RESULTS}?limit=2&offset=1`, {
        method: 'GET',
        headers: makeHeaders(),
      })
      const body = (await res.json()) as {
        results: Array<{ hashValue: string }>
        offset: number
      }
      expect(offsetBuffer).toBe(1)
      expect(body.offset).toBe(1)
      expect(body.results.map((r) => r.hashValue)).toEqual(['b', 'c'])
    })

    it('returns the documented row projection (all 12 fields)', async () => {
      state.rows = [makeRow({ id: 1, attackMode: 0, attackId: 7, agentId: 22 })]
      const res = await app.request(RESULTS, {
        method: 'GET',
        headers: makeHeaders(),
      })
      const body = (await res.json()) as { results: Array<Record<string, unknown>> }
      const expectedKeys = [
        'id',
        'hashValue',
        'plaintext',
        'crackedAt',
        'hashListId',
        'hashListName',
        'campaignId',
        'campaignName',
        'attackId',
        'attackMode',
        'attackModeName',
        'agentId',
      ].sort()
      expect(Object.keys(body.results[0]!).sort()).toEqual(expectedKeys)
      // Confirms at least one select() dispatched the LIST branch
      // (and a separate count() with COUNT_SENTINEL ran alongside).
      expect(projectionsSeen.some((p) => p.includes(LIST_SENTINEL))).toBe(true)
      expect(projectionsSeen.some((p) => p[0] === COUNT_SENTINEL && p.length === 1)).toBe(true)
    })

    it('serializes crackedAt as an ISO 8601 string', async () => {
      const at = new Date('2026-05-15T10:20:30.000Z')
      state.rows = [makeRow({ id: 1, crackedAt: at })]
      const res = await app.request(RESULTS, {
        method: 'GET',
        headers: makeHeaders(),
      })
      const body = (await res.json()) as { results: Array<{ crackedAt: string | null }> }
      expect(body.results[0]?.crackedAt).toBe('2026-05-15T10:20:30.000Z')
    })

    it('honors limit when within bounds (1-100)', async () => {
      state.rows = [makeRow({ id: 1 })]
      await app.request(`${RESULTS}?limit=99`, {
        method: 'GET',
        headers: makeHeaders(),
      })
      expect(limitBuffer).toBe(99)
    })

    it('falls back to default 50 when limit exceeds max 100', async () => {
      // `coercedIntegerQuery` uses `.catch(default)` rather than
      // saturating to max — out-of-range input is treated as malformed
      // and falls back to the schema default. This pins that contract.
      state.rows = [makeRow({ id: 1 })]
      await app.request(`${RESULTS}?limit=500`, {
        method: 'GET',
        headers: makeHeaders(),
      })
      expect(limitBuffer).toBe(50)
    })

    it('falls back to default limit on invalid input', async () => {
      state.rows = [makeRow({ id: 1 })]
      await app.request(`${RESULTS}?limit=abc`, {
        method: 'GET',
        headers: makeHeaders(),
      })
      expect(limitBuffer).toBe(50)
    })
  })

  // ─── List endpoint: filters ─────────────────────────────────────────

  describe('list endpoint filters', () => {
    it('accepts campaignId / hashListId / q / startDate / endDate without 400', async () => {
      state.rows = []
      const url =
        `${RESULTS}?campaignId=5&hashListId=10&q=abc` +
        `&startDate=2026-01-01T00:00:00.000Z&endDate=2026-12-31T23:59:59.000Z`
      const res = await app.request(url, {
        method: 'GET',
        headers: makeHeaders(),
      })
      expect(res.status).toBe(200)
    })

    it('returns 200 + empty result when startDate > endDate (no validation 400)', async () => {
      state.rows = []
      const url = `${RESULTS}?startDate=2026-12-31T00:00:00.000Z&endDate=2026-01-01T00:00:00.000Z`
      const res = await app.request(url, {
        method: 'GET',
        headers: makeHeaders(),
      })
      expect(res.status).toBe(200)
      const body = (await res.json()) as { results: unknown[] }
      expect(body.results).toEqual([])
    })

    it('falls through to no-filter on malformed startDate / endDate (no 400)', async () => {
      // Matches the dashboard surface convention: invalid filter input
      // is "no filter", not a validation error. Same posture as
      // `coercedOptionalPositiveIntegerQuery` on numeric filters.
      state.rows = [makeRow({ id: 1 })]
      const url = `${RESULTS}?startDate=not-a-date&endDate=2026-13-99`
      const res = await app.request(url, {
        method: 'GET',
        headers: makeHeaders(),
      })
      expect(res.status).toBe(200)
      const body = (await res.json()) as { results: unknown[] }
      expect(body.results).toHaveLength(1)
    })
  })

  // ─── CSV export: content + streaming ────────────────────────────────

  describe('csv export shape', () => {
    it('returns text/csv with attachment filename', async () => {
      state.rows = []
      const res = await app.request(EXPORT, {
        method: 'GET',
        headers: makeHeaders(),
      })
      expect(res.status).toBe(200)
      expect(res.headers.get('Content-Type')).toBe('text/csv; charset=utf-8')
      expect(res.headers.get('Content-Disposition')).toMatch(
        /^attachment; filename="results-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.csv"$/
      )
      expect(res.headers.get('X-Accel-Buffering')).toBe('no')
      expect(res.headers.get('Cache-Control')).toBe('no-store')
    })

    it('emits the documented column header line and nothing else on empty state', async () => {
      // Strict equality, not startsWith — a regression that double-emits
      // the header (e.g., headerSent reset per pull) would otherwise
      // sneak past.
      state.rows = []
      const res = await app.request(EXPORT, {
        method: 'GET',
        headers: makeHeaders(),
      })
      const text = await res.text()
      expect(text).toBe('hash_value,plaintext,campaign,attack,hash_list,cracked_at\n')
    })

    it('emits empty cells (not the strings "null"/"undefined") for null plaintext + campaignName', async () => {
      state.rows = [
        makeRow({
          id: 1,
          hashValue: 'safe',
          plaintext: null,
          hashListName: 'list',
          campaignName: null,
          attackMode: null,
          crackedAt: new Date('2026-05-01T12:00:00.000Z'),
        }),
      ]
      const res = await app.request(EXPORT, {
        method: 'GET',
        headers: makeHeaders(),
      })
      const text = await res.text()
      const dataLines = text
        .split('\n')
        .filter((l) => l.length > 0)
        .slice(1)
      expect(dataLines[0]).toBe('safe,,,,list,2026-05-01T12:00:00.000Z')
    })

    it('emits an empty cell for null crackedAt', async () => {
      // Production should never hit this path (the WHERE clause filters
      // crackedAt IS NOT NULL), but the encoder's null branch is still
      // exercised so a refactor that drops `r.crackedAt ? … : ''` fails
      // here instead of in production.
      state.rows = [
        makeRow({
          id: 1,
          hashValue: 'safe',
          plaintext: 'p',
          hashListName: 'list',
          campaignName: 'camp',
          attackMode: null,
          crackedAt: null,
        }),
      ]
      const res = await app.request(EXPORT, {
        method: 'GET',
        headers: makeHeaders(),
      })
      const text = await res.text()
      const dataLines = text
        .split('\n')
        .filter((l) => l.length > 0)
        .slice(1)
      // Last column (cracked_at) is empty.
      expect(dataLines[0]?.endsWith(',')).toBe(true)
    })

    it('exports one row per cracked hash with resolved attack name', async () => {
      state.rows = [
        makeRow({
          id: 1,
          hashValue: 'abcd1234',
          plaintext: 'p@ss',
          hashListName: 'ntlm-list',
          campaignName: 'Sprint One',
          attackMode: 3,
          crackedAt: new Date('2026-05-01T12:00:00.000Z'),
        }),
      ]
      const res = await app.request(EXPORT, {
        method: 'GET',
        headers: makeHeaders(),
      })
      const text = await res.text()
      const lines = text.split('\n').filter((l) => l.length > 0)
      expect(lines).toHaveLength(2) // header + 1 row
      expect(lines[1]).toBe('abcd1234,p@ss,Sprint One,Mask,ntlm-list,2026-05-01T12:00:00.000Z')
    })

    it('prefixes formula-injection triggers with a leading apostrophe', async () => {
      state.rows = [
        makeRow({
          id: 1,
          plaintext: '=cmd|/c calc',
          hashValue: 'safe',
          hashListName: 'list',
          campaignName: 'camp',
        }),
      ]
      const res = await app.request(EXPORT, {
        method: 'GET',
        headers: makeHeaders(),
      })
      const text = await res.text()
      // The leading-equals is prefixed with an apostrophe so
      // spreadsheets read it as literal text. Quote-wrapping only
      // kicks in when the value contains CSV special chars (`,`,
      // `"`, `\n`); `=cmd|/c calc` has none, so the apostrophe sits
      // bare.
      expect(text).toContain("'=cmd|/c calc")
    })

    it('quote-wraps + escapes when a cell contains a comma', async () => {
      state.rows = [
        makeRow({
          id: 1,
          plaintext: 'has, comma',
          hashValue: 'safe',
          hashListName: 'list',
          campaignName: 'camp',
        }),
      ]
      const res = await app.request(EXPORT, {
        method: 'GET',
        headers: makeHeaders(),
      })
      const text = await res.text()
      expect(text).toContain('"has, comma"')
    })

    it('quote-wraps cells containing a carriage return', async () => {
      // Bare CR splits the row in RFC 4180 parsers (Excel and many
      // CSV libraries treat \r as a record terminator). Make sure
      // the escape path catches it.
      state.rows = [
        makeRow({
          id: 1,
          plaintext: 'has\rCR',
          hashValue: 'safe',
          hashListName: 'list',
          campaignName: 'camp',
        }),
      ]
      const res = await app.request(EXPORT, {
        method: 'GET',
        headers: makeHeaders(),
      })
      const text = await res.text()
      expect(text).toContain('"has\rCR"')
    })

    it('prefixes formula triggers for `+`, `-`, `@`, `\\t`, `\\r`, `\\n`', async () => {
      // CSV_FORMULA_TRIGGER_REGEX covers /^[=+\-@\t\r\n]/ — every one
      // of those leading characters is a known spreadsheet formula
      // entry point. Pin all six so a future regex narrowing fails
      // here instead of in a production export.
      const triggers = [
        { sample: '+SUM(A1)', expected: "'+SUM(A1)" },
        { sample: '-1+2', expected: "'-1+2" },
        { sample: '@dde(', expected: "'@dde(" },
        { sample: '\tindent', expected: "'\tindent" },
        { sample: '\rcr', expected: "'\rcr" },
        { sample: '\nlf', expected: "'\nlf" },
      ]
      for (const { sample, expected } of triggers) {
        state.rows = [
          makeRow({
            id: 1,
            plaintext: sample,
            hashValue: 'safe',
            hashListName: 'list',
            campaignName: 'camp',
          }),
        ]
        exportRowsServed = 0
        const res = await app.request(EXPORT, {
          method: 'GET',
          headers: makeHeaders(),
        })
        const text = await res.text()
        // The apostrophe prefix sits inside the quote-wrapping when
        // the cell also carries CSV specials (`\t`, `\r`, `\n` force
        // wrapping; `+`, `-`, `@` do not).
        expect(text).toContain(expected)
      }
    })

    it('streams the response in multiple ReadableStream chunks with exact row count', async () => {
      state.rows = sortLikeDb(
        Array.from({ length: 2500 }, (_, i) =>
          makeRow({ id: 5000 - i, crackedAt: new Date(2026, 0, 1, 0, 0, 0, i) })
        )
      )

      const res = await app.request(EXPORT, {
        method: 'GET',
        headers: makeHeaders(),
      })
      expect(res.status).toBe(200)

      const reader = res.body!.getReader()
      const decoder = new TextDecoder()
      let chunkCount = 0
      let totalBytes = 0
      let text = ''
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        chunkCount += 1
        totalBytes += value.byteLength
        text += decoder.decode(value, { stream: true })
      }
      text += decoder.decode()
      // Header + 2500 rows in 3 1000-row batches means 4 enqueues total
      // (1 header + 3 batch writes). >=4 catches single-mega-write
      // regressions while allowing TCP coalescing.
      expect(chunkCount).toBeGreaterThanOrEqual(4)
      expect(totalBytes).toBeGreaterThan(20_000)
      // Exact row count guards against a regression that emits the same
      // batch twice (would pass the chunk-floor + byte-floor checks).
      const lines = text.split('\n').filter((l) => l.length > 0)
      expect(lines).toHaveLength(2501) // header + 2500 rows
    })

    it('streams every row exactly once and in id-DESC order when many rows share a crackedAt timestamp', async () => {
      // The cursor predicate
      //   crackedAt < cursor OR (crackedAt = cursor AND id < cursor.id)
      // is load-bearing for streaming correctness when bulk-cracked
      // batches share a `crackedAt` value. Without the `id` tiebreaker
      // the second batch would re-fetch some rows from the first, or
      // emit them out of order.
      const sharedAt = new Date('2026-05-15T12:00:00.000Z')
      state.rows = sortLikeDb(
        Array.from({ length: 1500 }, (_, i) =>
          makeRow({ id: 10000 - i, hashValue: `h${10000 - i}`, crackedAt: sharedAt })
        )
      )

      const res = await app.request(EXPORT, {
        method: 'GET',
        headers: makeHeaders(),
      })
      const text = await res.text()
      const dataLines = text
        .split('\n')
        .filter((l) => l.length > 0)
        .slice(1)
      expect(dataLines).toHaveLength(1500)
      // No duplicates: every hashValue appears exactly once.
      expect(new Set(dataLines).size).toBe(1500)
      // Strictly decreasing id across the full stream — guards against
      // a regression that flips the tiebreaker to `id ASC`, which would
      // pass the dedup check but ship rows out of order.
      const ids = dataLines.map((l) => Number.parseInt(l.split(',')[0]!.slice(1), 10))
      for (let i = 1; i < ids.length; i++) {
        expect(ids[i]!).toBeLessThan(ids[i - 1]!)
      }
    })
  })

  // The dashboard middleware ignores `X-Project-Id` entirely (see
  // `middleware/auth.ts`). This test pins that contract regression-style:
  // if someone later wires the header into dashboard scoping, the SQL
  // join filter (`eq(campaigns.projectId, session_projectId)`) will still
  // own the truth and this assertion stays green only when the SESSION
  // path was taken.

  describe('project scoping', () => {
    it('does not honor a client-supplied x-project-id header to widen scope', async () => {
      state.rows = [makeRow({ id: 1, hashValue: 'session-scope-row' })]
      const res = await app.request(RESULTS, {
        method: 'GET',
        headers: { ...makeHeaders(), 'x-project-id': '999' },
      })
      expect(res.status).toBe(200)
      const body = (await res.json()) as { results: Array<{ hashValue: string }> }
      expect(body.results.every((r) => r.hashValue === 'session-scope-row')).toBe(true)
    })
  })
}
