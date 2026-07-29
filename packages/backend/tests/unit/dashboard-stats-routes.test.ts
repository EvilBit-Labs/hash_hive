/**
 * Dashboard stats route tests (issue #161 U2).
 *
 * The /stats route fans out four parallel aggregate queries via the
 * Drizzle query builder; the mock chain below discriminates by table
 * identity so each query returns its own controllable result set. Tests
 * cover the auth/membership guard layer, the structural project-scoping
 * invariant (the route's `where(...)` clauses must filter by
 * `session.projectId`), and the response shape (every agent/campaign/
 * task status literal lands on the wire, with the `assigned → running`
 * and `exhausted → completed` task bucketing matching `getCampaignTaskStats`).
 *
 * AGENTS.md gold-standard would be a real-DB integration test, but the
 * project's `tests/integration/` suite mocks the drizzle client the
 * same way; this file follows that convention. The OpenAPI ↔ shared ↔
 * wire round-trip is now enforced by the runtime spec — the dashboard
 * surface registers `dashboardStatsSchema` directly via
 * `.openapi('DashboardStats')` in `routes/dashboard/stats.ts`, so the
 * served `/openapi.json` is generated from the same Zod schema this
 * test exercises. Drift between the schema and the spec surfaces at
 * boot/request time when the cached spec is built, not as a separate
 * contract test.
 */
import {
  agents,
  campaigns,
  dashboardStatsSchema,
  hashItems,
  hashLists,
  projectCrackedHashes,
  tasks,
} from '@hashhive/shared'
import { beforeEach, describe, expect, it, mock } from 'bun:test'

// ─── Mock BetterAuth ─────────────────────────────────────────────────

const ADMIN_COOKIE = 'hh.session_token=valid-admin-session'
const ADMIN_NO_MEMBERSHIP_COOKIE = 'hh.session_token=valid-admin-no-membership'
const NO_PROJECT_COOKIE = 'hh.session_token=valid-session-no-project'

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
              // Active project scope set on the session (#159 U4).
              projectId: 1,
            },
          }
        }
        if (cookie.includes('valid-admin-no-membership')) {
          return {
            user: {
              id: '2',
              email: 'outsider@test.local',
              name: 'Outsider Admin',
              emailVerified: true,
              image: null,
              // Pins the global-admin-bypass guard: a user with the
              // global `admin` role who is NOT a member of the active
              // project must still get a 403 from the stats endpoint.
              roles: ['admin'],
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
        if (cookie.includes('valid-session-no-project')) {
          return {
            user: {
              id: '3',
              email: 'noscope@test.local',
              name: 'NoScope',
              emailVerified: true,
              image: null,
              roles: ['analyst'],
            },
            session: {
              id: 'sess-3',
              userId: '3',
              token: 'tok-3',
              expiresAt: new Date(Date.now() + 3600000),
              projectId: null,
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
      // Global admin with no project memberships — pins the
      // membership-vs-global-role gate.
      return { id: 2, projects: [] }
    }
    return null
  },
  findProjectMembership: async (userId: number, projectId: number) => {
    if (userId === 1 && projectId === 1) return { projectId: 1, roles: ['admin'] }
    return null
  },
  getUserLastProjectId: async () => null,
  setUserLastProjectIdIfMember: async () => 1,
  setUserLastProjectId: async () => undefined,
}))

// ─── Mock DB with table-discriminator chain ──────────────────────────
//
// The /stats route fans out four parallel aggregate queries against
// different tables. The mock chain identifies which table is being
// queried by comparing the `from(...)` argument against the imported
// table objects (identity match) and returns the per-query rows
// configured by the test. The chain object is both a Promise-like (so
// `Promise.all` can await it directly when the query ends at
// `.where(...)`) and a method chain (so `.where().groupBy(...)` and
// `.innerJoin(...).where(...).groupBy(...)` both flow through).

type StatusRow = { status: string; count: number }
type CountOnlyRow = { count: number }
type Predicate = { queryChunks?: unknown[] } & Record<string, unknown>

const queryRows: {
  agents: StatusRow[]
  campaigns: StatusRow[]
  tasks: StatusRow[]
  cracked: CountOnlyRow[]
  whereCalls: {
    agents: Predicate[]
    campaigns: Predicate[]
    tasks: Predicate[]
    cracked: Predicate[]
  }
  innerJoinCalls: {
    agents: Array<{ table: unknown; predicate: Predicate }>
    campaigns: Array<{ table: unknown; predicate: Predicate }>
    tasks: Array<{ table: unknown; predicate: Predicate }>
    cracked: Array<{ table: unknown; predicate: Predicate }>
  }
  leftJoinCalls: {
    agents: Array<{ table: unknown; predicate: Predicate }>
    campaigns: Array<{ table: unknown; predicate: Predicate }>
    tasks: Array<{ table: unknown; predicate: Predicate }>
    cracked: Array<{ table: unknown; predicate: Predicate }>
  }
} = {
  agents: [],
  campaigns: [],
  tasks: [],
  cracked: [],
  whereCalls: { agents: [], campaigns: [], tasks: [], cracked: [] },
  innerJoinCalls: { agents: [], campaigns: [], tasks: [], cracked: [] },
  leftJoinCalls: { agents: [], campaigns: [], tasks: [], cracked: [] },
}

beforeEach(() => {
  queryRows.agents = []
  queryRows.campaigns = []
  queryRows.tasks = []
  queryRows.cracked = []
  queryRows.whereCalls = { agents: [], campaigns: [], tasks: [], cracked: [] }
  queryRows.innerJoinCalls = { agents: [], campaigns: [], tasks: [], cracked: [] }
  queryRows.leftJoinCalls = { agents: [], campaigns: [], tasks: [], cracked: [] }
})

/**
 * Walk a Drizzle SQL predicate and collect every captured `Param`
 * value. The predicate is a tree of `queryChunks` containing column
 * refs, string literals, params, and nested SQL objects (from `and`,
 * `or`, etc.). Returns the values in left-to-right order.
 */
function paramValuesOf(predicate: Predicate): unknown[] {
  const out: unknown[] = []
  function walk(chunk: unknown): void {
    if (chunk === null || chunk === undefined) return
    if (typeof chunk !== 'object') return
    const c = chunk as Record<string, unknown>
    if ('value' in c && c['encoder']) {
      // Drizzle `Param` chunk shape.
      out.push(c['value'])
      return
    }
    if (Array.isArray(c['queryChunks'])) {
      for (const inner of c['queryChunks']) walk(inner)
    }
  }
  walk(predicate)
  return out
}

/**
 * Returns true when the predicate's `queryChunks` reference the given
 * column object by identity. Drizzle's `eq(col, value)` puts the
 * column object itself into `queryChunks` so `===` is the right test.
 */
function referencesColumn(predicate: Predicate, column: unknown): boolean {
  function walk(chunk: unknown): boolean {
    if (chunk === null || chunk === undefined) return false
    if (chunk === column) return true
    if (typeof chunk !== 'object') return false
    const c = chunk as Record<string, unknown>
    if (Array.isArray(c['queryChunks'])) {
      for (const inner of c['queryChunks']) {
        if (walk(inner)) return true
      }
    }
    return false
  }
  return walk(predicate)
}

/**
 * Returns true when `column` appears in a `queryChunks` array alongside
 * literal SQL text containing "is null" — i.e. the predicate applies
 * `column IS NULL`, not merely a predicate that happens to touch the
 * column. `referencesColumn` alone can't distinguish `isNull(col)` from
 * `eq(col, x)` or `isNotNull(col)`, since both put the column object
 * directly into `queryChunks`; this walks the same tree but additionally
 * inspects the sibling `StringChunk` text in the column's own SQL node.
 */
function referencesIsNullOnColumn(predicate: Predicate, column: unknown): boolean {
  function chunkText(chunk: unknown): string {
    if (chunk === null || typeof chunk !== 'object') return ''
    const value = (chunk as Record<string, unknown>)['value']
    return Array.isArray(value) && typeof value[0] === 'string' ? value.join('') : ''
  }
  function walk(chunk: unknown): boolean {
    if (chunk === null || chunk === undefined || typeof chunk !== 'object') return false
    const c = chunk as Record<string, unknown>
    if (!Array.isArray(c['queryChunks'])) return false
    const chunks = c['queryChunks'] as unknown[]
    if (chunks.includes(column)) {
      const text = chunks.map(chunkText).join('')
      if (/is null/i.test(text)) return true
    }
    return chunks.some((inner) => walk(inner))
  }
  return walk(predicate)
}

function discriminate(table: unknown): 'agents' | 'campaigns' | 'tasks' | 'cracked' | 'unknown' {
  if (table === agents) return 'agents'
  if (table === campaigns) return 'campaigns'
  if (table === tasks) return 'tasks'
  if (table === hashItems) return 'cracked'
  return 'unknown'
}

function rowsFor(target: 'agents' | 'campaigns' | 'tasks' | 'cracked' | 'unknown'): unknown[] {
  if (target === 'agents') return queryRows.agents
  if (target === 'campaigns') return queryRows.campaigns
  if (target === 'tasks') return queryRows.tasks
  if (target === 'cracked') return queryRows.cracked
  return []
}

mock.module('../../src/db/index.js', () => ({
  db: {
    select: () => ({
      from: (table: unknown) => {
        const target = discriminate(table)
        // Thenable-and-method object: `.then` makes Promise.all resolve
        // directly when the chain ends at `.where(...)`; `.where()` and
        // `.groupBy()` continue the chain when present.
        function makeChain(): {
          where: (predicate: Predicate) => ReturnType<typeof makeChain>
          groupBy: () => Promise<unknown[]>
          innerJoin: (table: unknown, predicate: Predicate) => ReturnType<typeof makeChain>
          leftJoin: (table: unknown, predicate: Predicate) => ReturnType<typeof makeChain>
          then: (
            onFulfilled: (value: unknown[]) => unknown,
            onRejected?: (reason: unknown) => unknown
          ) => Promise<unknown>
        } {
          const chain = {
            where(predicate: Predicate) {
              if (target !== 'unknown') queryRows.whereCalls[target].push(predicate)
              return chain
            },
            groupBy() {
              return Promise.resolve(rowsFor(target))
            },
            innerJoin(joinTable: unknown, predicate: Predicate) {
              if (target !== 'unknown') {
                queryRows.innerJoinCalls[target].push({ table: joinTable, predicate })
              }
              return chain
            },
            // U4/R15: the cracked-hash aggregate LEFT JOINs the per-project
            // cracked-set so crack state resolves across sibling hash lists.
            leftJoin(joinTable: unknown, predicate: Predicate) {
              if (target !== 'unknown') {
                queryRows.leftJoinCalls[target].push({ table: joinTable, predicate })
              }
              return chain
            },
            // The Drizzle query builder is intentionally PromiseLike at
            // every chain point so callers can `await` mid-chain. The
            // cracked-hash query in `routes/dashboard/stats.ts` ends at
            // `.where(...)` (no terminal `.groupBy`) and is awaited via
            // `Promise.all`, which calls `.then` on the chain object
            // directly. Mocking that shape requires the `then` method
            // here; the `no-thenable` rule's general concern (accidental
            // await on a non-promise type) does not apply to a deliberate
            // PromiseLike mock of an upstream PromiseLike API.
            // oxlint-disable-next-line no-thenable
            then(
              onFulfilled: (value: unknown[]) => unknown,
              onRejected?: (reason: unknown) => unknown
            ) {
              return Promise.resolve(rowsFor(target)).then(onFulfilled, onRejected)
            },
          }
          return chain
        }
        return makeChain()
      },
    }),
  },
  client: {},
}))

// ─── Misc transitive mocks ───────────────────────────────────────────

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

import { app } from '../../src/index.js'

const STATS_URL = '/api/v1/dashboard/stats'

function commonHeaders(cookie: string): HeadersInit {
  return {
    cookie,
    origin: 'http://lab.local',
    host: 'lab.local',
  }
}

describe('Dashboard stats route — auth and membership gates', () => {
  it('returns 401 without a session', async () => {
    const res = await app.request(STATS_URL)
    expect(res.status).toBe(401)
  })

  it('returns 400 with PROJECT_NOT_SELECTED when session has no projectId', async () => {
    const res = await app.request(STATS_URL, {
      headers: commonHeaders(NO_PROJECT_COOKIE),
    })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error?: { code?: string } }
    expect(body.error?.code).toBe('PROJECT_NOT_SELECTED')
  })

  it('returns 403 with AUTHZ_PROJECT_ACCESS_DENIED when global admin is not a member of session.projectId', async () => {
    // Pins the membership-vs-global-role gate: requireProjectAccess()
    // must reject a global admin who lacks project membership. A future
    // change that stacks requireRole('admin') would otherwise create a
    // silent bypass on this endpoint.
    const res = await app.request(STATS_URL, {
      headers: commonHeaders(ADMIN_NO_MEMBERSHIP_COOKIE),
    })
    expect(res.status).toBe(403)
    const body = (await res.json()) as { error?: { code?: string } }
    expect(body.error?.code).toBe('AUTHZ_PROJECT_ACCESS_DENIED')
  })
})

describe('Dashboard stats route — project-scoped query construction', () => {
  it('agents query: where(...) scopes to session.projectId and excludes retired agents', async () => {
    const res = await app.request(STATS_URL, { headers: commonHeaders(ADMIN_COOKIE) })
    expect(res.status).toBe(200)
    expect(queryRows.whereCalls.agents.length).toBe(1)
    const predicate = queryRows.whereCalls.agents[0]!
    expect(referencesColumn(predicate, agents.projectId)).toBe(true)
    // Retired agents are decommissioned and excluded from the active-fleet
    // stats (ADR-0019 / #106), so the predicate also references agents.status.
    expect(referencesColumn(predicate, agents.status)).toBe(true)
    expect(paramValuesOf(predicate)).toEqual([1, 'retired'])
  })

  it('campaigns query: where(...) references campaigns.projectId === session.projectId', async () => {
    const res = await app.request(STATS_URL, { headers: commonHeaders(ADMIN_COOKIE) })
    expect(res.status).toBe(200)
    expect(queryRows.whereCalls.campaigns.length).toBe(1)
    const predicate = queryRows.whereCalls.campaigns[0]!
    expect(referencesColumn(predicate, campaigns.projectId)).toBe(true)
    expect(paramValuesOf(predicate)).toEqual([1])
  })

  it('campaigns query: where(...) also excludes split sub-campaigns (parentCampaignId IS NOT NULL)', async () => {
    // A split campaign (issue #202 second half) is 1 parent + N sub-campaigns
    // sharing the same status — without this filter the status breakdown
    // would count a single split campaign N+1 times.
    const res = await app.request(STATS_URL, { headers: commonHeaders(ADMIN_COOKIE) })
    expect(res.status).toBe(200)
    expect(queryRows.whereCalls.campaigns.length).toBe(1)
    const predicate = queryRows.whereCalls.campaigns[0]!
    // `referencesColumn` alone would pass even if a regression swapped
    // `isNull` for `isNotNull`/`eq` — assert the actual `IS NULL` operator.
    expect(referencesIsNullOnColumn(predicate, campaigns.parentCampaignId)).toBe(true)
  })

  it('tasks query: joins through campaigns and filters where campaigns.projectId === session.projectId', async () => {
    const res = await app.request(STATS_URL, { headers: commonHeaders(ADMIN_COOKIE) })
    expect(res.status).toBe(200)
    expect(queryRows.innerJoinCalls.tasks.length).toBe(1)
    expect(queryRows.innerJoinCalls.tasks[0]!.table).toBe(campaigns)
    expect(queryRows.whereCalls.tasks.length).toBe(1)
    const wherePredicate = queryRows.whereCalls.tasks[0]!
    expect(referencesColumn(wherePredicate, campaigns.projectId)).toBe(true)
    expect(paramValuesOf(wherePredicate)).toEqual([1])
  })

  it('cracked query: scopes by hash-list ownership (innerJoin hashLists, where hashLists.projectId === session.projectId)', async () => {
    // The cracked query intentionally joins through `hashLists` rather
    // than `campaigns` because `hashItems.campaignId` is nullable
    // (ON DELETE SET NULL — see packages/shared/src/db/schema.ts). The
    // hash-list scope matches the contract intent on
    // `dashboardStatsSchema` ("count hash items with non-null
    // `crackedAt` across the project's hash lists") and includes
    // cracked rows orphaned by campaign deletion.
    const res = await app.request(STATS_URL, { headers: commonHeaders(ADMIN_COOKIE) })
    expect(res.status).toBe(200)
    expect(queryRows.innerJoinCalls.cracked.length).toBe(1)
    const join = queryRows.innerJoinCalls.cracked[0]!
    expect(join.table).toBe(hashLists)
    expect(referencesColumn(join.predicate, hashItems.hashListId)).toBe(true)
    expect(referencesColumn(join.predicate, hashLists.id)).toBe(true)
    // U4/R15: the terminal .where(...) now scopes on hashLists.projectId
    // ALONE. The `crackedAt IS NOT NULL` filter moved into the counted
    // expression (`count(distinct RESOLVED_CRACKED_VALUE)`), which resolves
    // through the cracked-set — filtering it in the WHERE would drop the very
    // rows this unit exists to include (uncracked in their own row, cracked in
    // a sibling list).
    expect(queryRows.whereCalls.cracked.length).toBe(1)
    const wherePred = queryRows.whereCalls.cracked[0]!
    expect(referencesColumn(wherePred, hashLists.projectId)).toBe(true)
    expect(paramValuesOf(wherePred)).toContain(1)
    expect(referencesColumn(wherePred, hashItems.crackedAt)).toBe(false)
  })

  it('cracked query: LEFT JOINs the per-project cracked-set on (projectId, detectedHashcatMode, hashValue) — U4/R15', async () => {
    const res = await app.request(STATS_URL, { headers: commonHeaders(ADMIN_COOKIE) })
    expect(res.status).toBe(200)
    expect(queryRows.leftJoinCalls.cracked.length).toBe(1)
    const join = queryRows.leftJoinCalls.cracked[0]!
    expect(join.table).toBe(projectCrackedHashes)
    // KTD3: the mode side of the key is the ONE authoritative column the write
    // path stamps — never a campaign-latched or re-detected mode.
    expect(referencesColumn(join.predicate, hashItems.detectedHashcatMode)).toBe(true)
    expect(referencesColumn(join.predicate, projectCrackedHashes.hashcatMode)).toBe(true)
    expect(referencesColumn(join.predicate, hashItems.hashValue)).toBe(true)
    expect(referencesColumn(join.predicate, projectCrackedHashes.hashValue)).toBe(true)
    // Project-scoped: a cracked-set row from another project can never match.
    expect(referencesColumn(join.predicate, projectCrackedHashes.projectId)).toBe(true)
    expect(paramValuesOf(join.predicate)).toContain(1)
  })
})

describe('Dashboard stats route — response shape', () => {
  it('zero-fills every status bucket when the project is empty', async () => {
    const res = await app.request(STATS_URL, {
      headers: commonHeaders(ADMIN_COOKIE),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as unknown
    const parsed = dashboardStatsSchema.parse(body)
    expect(parsed.agents.total).toBe(0)
    expect(parsed.agents.online).toBe(0)
    expect(parsed.agents.offline).toBe(0)
    expect(parsed.agents.busy).toBe(0)
    expect(parsed.agents.error).toBe(0)
    expect(parsed.agents.benchmarked).toBe(0)
    expect(parsed.campaigns.total).toBe(0)
    expect(parsed.campaigns.draft).toBe(0)
    expect(parsed.campaigns.running).toBe(0)
    expect(parsed.campaigns.paused).toBe(0)
    expect(parsed.campaigns.completed).toBe(0)
    expect(parsed.campaigns.cancelled).toBe(0)
    expect(parsed.tasks.total).toBe(0)
    expect(parsed.tasks.pending).toBe(0)
    expect(parsed.tasks.running).toBe(0)
    expect(parsed.tasks.completed).toBe(0)
    expect(parsed.tasks.failed).toBe(0)
    expect(parsed.cracked.total).toBe(0)
  })

  it('surfaces every agent status literal — no silent drop of busy/benchmarked', async () => {
    queryRows.agents = [
      { status: 'online', count: 3 },
      { status: 'offline', count: 2 },
      { status: 'busy', count: 4 },
      { status: 'error', count: 1 },
      { status: 'benchmarked', count: 5 },
    ]
    const res = await app.request(STATS_URL, {
      headers: commonHeaders(ADMIN_COOKIE),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as unknown
    const parsed = dashboardStatsSchema.parse(body)
    expect(parsed.agents).toEqual({
      total: 15,
      online: 3,
      offline: 2,
      busy: 4,
      error: 1,
      benchmarked: 5,
    })
  })

  it('surfaces every campaign status literal including cancelled', async () => {
    queryRows.campaigns = [
      { status: 'draft', count: 1 },
      { status: 'running', count: 2 },
      { status: 'paused', count: 3 },
      { status: 'completed', count: 4 },
      { status: 'cancelled', count: 5 },
    ]
    const res = await app.request(STATS_URL, {
      headers: commonHeaders(ADMIN_COOKIE),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as unknown
    const parsed = dashboardStatsSchema.parse(body)
    expect(parsed.campaigns).toEqual({
      total: 15,
      draft: 1,
      running: 2,
      paused: 3,
      completed: 4,
      cancelled: 5,
    })
  })

  it('buckets task DB statuses into operator-facing fields (assigned → running, exhausted → completed, cancelled → failed)', async () => {
    queryRows.tasks = [
      { status: 'pending', count: 1 },
      { status: 'assigned', count: 2 },
      { status: 'running', count: 3 },
      { status: 'completed', count: 4 },
      { status: 'exhausted', count: 5 },
      { status: 'failed', count: 6 },
      { status: 'cancelled', count: 7 },
    ]
    const res = await app.request(STATS_URL, {
      headers: commonHeaders(ADMIN_COOKIE),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as unknown
    const parsed = dashboardStatsSchema.parse(body)
    expect(parsed.tasks.total).toBe(28)
    expect(parsed.tasks.pending).toBe(1)
    expect(parsed.tasks.running).toBe(5) // assigned + running
    expect(parsed.tasks.completed).toBe(9) // completed + exhausted
    expect(parsed.tasks.failed).toBe(13) // failed + cancelled
  })

  it('passes unknown task DB statuses into total only', async () => {
    // A future migration could add a literal not yet in the bucket
    // mapping. `total` must still reflect the actual DB row count so
    // operators don't see a stale cards aggregate.
    queryRows.tasks = [
      { status: 'pending', count: 2 },
      { status: 'frozen', count: 7 },
    ]
    const res = await app.request(STATS_URL, {
      headers: commonHeaders(ADMIN_COOKIE),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as unknown
    const parsed = dashboardStatsSchema.parse(body)
    expect(parsed.tasks.total).toBe(9)
    expect(parsed.tasks.pending).toBe(2)
    expect(parsed.tasks.running).toBe(0)
    expect(parsed.tasks.completed).toBe(0)
    expect(parsed.tasks.failed).toBe(0)
  })

  it('surfaces the cracked-hash total from the single-row aggregate', async () => {
    queryRows.cracked = [{ count: 42 }]
    const res = await app.request(STATS_URL, {
      headers: commonHeaders(ADMIN_COOKIE),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as unknown
    const parsed = dashboardStatsSchema.parse(body)
    expect(parsed.cracked.total).toBe(42)
  })
})
