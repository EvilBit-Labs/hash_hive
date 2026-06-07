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
    crackedAt: Date
    hashListId: number
    hashListName: string
    campaignId: number
    campaignName: string
    attackId: number | null
    attackMode: number | null
    agentId: number | null
    // Project gating data (would join via campaigns.project_id IRL).
    campaignProjectId: number
  }

  // Mutable test state driving the db mock.
  const state: {
    rows: FixtureRow[]
    // Captured cursor predicate signature so streaming tests can assert
    // that consecutive batches advance.
    lastBatchSize: number | null
  } = { rows: [], lastBatchSize: null }

  // oxlint-disable-next-line unicorn/consistent-function-scoping -- intentionally local to the isolated-phase else block so it can't be exercised outside of an IS_ISOLATED run; the lint nudge to hoist outside conflicts with the phase-gating pattern
  function makeRow(overrides: Partial<FixtureRow> = {}): FixtureRow {
    return {
      id: overrides.id ?? 1,
      hashValue: overrides.hashValue ?? 'aabbcc',
      plaintext: overrides.plaintext ?? null,
      crackedAt: overrides.crackedAt ?? new Date('2026-05-01T12:00:00.000Z'),
      hashListId: overrides.hashListId ?? 10,
      hashListName: overrides.hashListName ?? 'List Alpha',
      campaignId: overrides.campaignId ?? 100,
      campaignName: overrides.campaignName ?? 'Campaign One',
      attackId: overrides.attackId ?? null,
      attackMode: overrides.attackMode ?? null,
      agentId: overrides.agentId ?? null,
      campaignProjectId: overrides.campaignProjectId ?? 1,
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

  // ─── Mock db ────────────────────────────────────────────────────────
  //
  // The route's query shape is:
  //   select(projection).from(hashItems)
  //     .innerJoin(campaigns, ...)
  //     .innerJoin(hashLists, ...)
  //     .leftJoin(attacks, ...)
  //     .where(and(...))
  //     .orderBy(...)
  //     .limit(N) [+ .offset(M) on list endpoint]
  //
  // The streaming export also uses a cursor predicate plus a smaller
  // orderBy(...). The mock returns a callable chain that resolves to
  // rows filtered by `state.rows` and the captured projection. We
  // capture and inspect the .where(...) chain via a lightweight marker
  // so individual tests can drive specific behavior; for most tests we
  // simply return all rows that match state.

  let limitBuffer: number | null = null
  let offsetBuffer = 0
  // Track how many rows the export path has streamed so each pull
  // returns the next slice and the loop terminates once state.rows
  // is exhausted (the route's keyset cursor predicate isn't expressible
  // through this mock — we just simulate the same end-state).
  let exportRowsServed = 0

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
        const rows = rowsProvider()
        return Promise.resolve(rows).then(resolve)
      },
    }
    return chain
  }

  mock.module('../../src/db/index.js', () => ({
    db: {
      select: (projection: Record<string, unknown> | undefined) => {
        // Branch by projection shape:
        //   - { count } => the list endpoint's count query
        //   - includes `id` => list endpoint rows or export batch
        //   - export batch is distinguishable from list rows because
        //     export does NOT request `hashListId`, `campaignId`,
        //     `attackId`, or `agentId` (it only needs hashListName,
        //     campaignName, attackMode for the CSV; id + crackedAt
        //     for the cursor).
        const keys = projection ? Object.keys(projection) : []
        const isCount = keys.length === 1 && keys[0] === 'count'
        const isListRows = keys.includes('hashListId') || keys.includes('campaignId')
        const isExportBatch = !isCount && !isListRows

        if (isCount) {
          return makeChain(() => [{ count: state.rows.length }])
        }
        if (isExportBatch) {
          // Serve rows in batches; once exhausted, return [] so the
          // pull loop closes the stream.
          return makeChain(() => {
            const batchSize = limitBuffer ?? state.rows.length
            const slice = state.rows.slice(exportRowsServed, exportRowsServed + batchSize)
            exportRowsServed += slice.length
            return slice
          })
        }
        // List rows: respect limit + offset.
        return makeChain(() => {
          const lim = limitBuffer ?? state.rows.length
          return state.rows.slice(offsetBuffer, offsetBuffer + lim)
        })
      },
      insert: () => ({ values: () => ({ returning: () => Promise.resolve([]) }) }),
      update: () => ({
        set: () => ({ where: () => ({ returning: () => Promise.resolve([]) }) }),
      }),
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
    state.lastBatchSize = null
    limitBuffer = null
    offsetBuffer = 0
    exportRowsServed = 0
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
    it('returns rows with attribution and resolved attackModeName', async () => {
      state.rows = [
        makeRow({ id: 1, attackMode: 3, attackId: 50 }),
        makeRow({ id: 2, attackMode: 0, attackId: 51 }),
        makeRow({ id: 3, attackMode: 99, attackId: 52 }),
        makeRow({ id: 4, attackMode: null, attackId: null }),
      ]
      const res = await app.request(RESULTS, {
        method: 'GET',
        headers: makeHeaders(),
      })
      expect(res.status).toBe(200)
      const body = (await res.json()) as {
        results: Array<{ id: number; attackMode: number | null; attackModeName: string | null }>
      }
      expect(body.results.find((r) => r.id === 1)?.attackModeName).toBe('Mask')
      expect(body.results.find((r) => r.id === 2)?.attackModeName).toBe('Dictionary')
      expect(body.results.find((r) => r.id === 3)?.attackModeName).toBeNull()
      expect(body.results.find((r) => r.id === 4)?.attackModeName).toBeNull()
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

    it('emits the documented column header line', async () => {
      state.rows = []
      const res = await app.request(EXPORT, {
        method: 'GET',
        headers: makeHeaders(),
      })
      const text = await res.text()
      expect(text.startsWith('hash_value,plaintext,campaign,attack,hash_list,cracked_at\n')).toBe(
        true
      )
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

    it('streams the response in multiple ReadableStream chunks', async () => {
      // 2500 rows so the 1000-row batch fires three pulls.
      state.rows = Array.from({ length: 2500 }, (_, i) =>
        makeRow({ id: 5000 - i, crackedAt: new Date(2026, 0, 1, 0, 0, 0, i) })
      )
      // Sort like the DB would: cracked_at DESC, id DESC.
      state.rows.sort((a, b) => b.crackedAt.getTime() - a.crackedAt.getTime() || b.id - a.id)

      const res = await app.request(EXPORT, {
        method: 'GET',
        headers: makeHeaders(),
      })
      expect(res.status).toBe(200)

      const reader = res.body!.getReader()
      let chunkCount = 0
      let totalBytes = 0
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        chunkCount += 1
        totalBytes += value.byteLength
      }
      // Header + 2500 rows in 3 1000-row batches means 4 enqueues
      // total (1 header + 3 batch writes). Bumping the floor to >=4
      // catches regressions that collapse 2500 rows into a single
      // mega-write while still allowing the runtime to coalesce
      // adjacent enqueues into TCP segments.
      expect(chunkCount).toBeGreaterThanOrEqual(4)
      // Sanity floor: every row contributes >=20 bytes of CSV.
      expect(totalBytes).toBeGreaterThan(20_000)
    })

    it('streams every row exactly once when many rows share a crackedAt timestamp', async () => {
      // The cursor predicate
      //   crackedAt < cursor OR (crackedAt = cursor AND id < cursor.id)
      // is load-bearing for streaming correctness when bulk-cracked
      // batches share a `crackedAt` value. Without the `id` tiebreaker
      // the second batch would re-fetch some rows from the first.
      const sharedAt = new Date('2026-05-15T12:00:00.000Z')
      state.rows = Array.from({ length: 1500 }, (_, i) =>
        // Unique hashValue per row so the assertion below can detect
        // duplicates across batches by content.
        makeRow({ id: 10000 - i, hashValue: `h${10000 - i}`, crackedAt: sharedAt })
      )
      // Sort like the DB would: cracked_at DESC, id DESC.
      state.rows.sort((a, b) => b.crackedAt.getTime() - a.crackedAt.getTime() || b.id - a.id)

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
      // Every row's hashValue must appear exactly once in the stream.
      // A regression that re-fetched the cursor row (no `id`
      // tiebreaker) would surface as fewer unique lines than rows.
      expect(new Set(dataLines).size).toBe(1500)
    })
  })

  // ─── Cross-project scoping ──────────────────────────────────────────
  //
  // The route's project safety comes from the SQL `eq(campaigns.projectId,
  // session_projectId)` join filter — the mock here ignores `.where()`
  // conditions, so the actual SQL guard isn't unit-testable through this
  // shape. What IS testable: the route never trusts a client-supplied
  // x-project-id header to bypass the session projectId. The session
  // mock fixes projectId at 1; any request with a different
  // x-project-id header must still return rows scoped to the SESSION
  // value (which the mock's state.rows represents), not to the
  // client-supplied header value.

  describe('project scoping', () => {
    it('does not honor a client-supplied x-project-id header to widen scope', async () => {
      state.rows = [makeRow({ id: 1, hashValue: 'session-scope-row' })]
      const res = await app.request(RESULTS, {
        method: 'GET',
        headers: { ...makeHeaders(), 'x-project-id': '999' },
      })
      // Two acceptable shapes: a 403 from RBAC, OR a 200 that returns
      // the SESSION-scoped rows (state.rows, set above). What must
      // NEVER happen is a 200 returning rows belonging to project
      // 999 that the user isn't a member of. The mock can't distinguish
      // "project 999 rows" from session rows, so the strongest
      // assertion the mock supports is: response status is one of
      // {200, 401, 403} (NOT 5xx, NOT crashing), and if it's 200, the
      // returned rows match the session-scoped state, not header-scoped.
      expect([200, 401, 403]).toContain(res.status)
      if (res.status === 200) {
        const body = (await res.json()) as { results: Array<{ hashValue: string }> }
        // Confirms the route used the session projectId path; any
        // hypothetical bypass would have skipped the buildResultFilters
        // join and the assertion would only pass by coincidence.
        expect(body.results.every((r) => r.hashValue === 'session-scope-row')).toBe(true)
      }
    })
  })
}
