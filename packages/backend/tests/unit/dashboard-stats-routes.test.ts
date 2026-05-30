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
 * same way; this file follows that convention. The contract test in
 * `dashboard-api-contract.test.ts` adds the round-trip
 * `dashboardStatsSchema.parse()` proof so OpenAPI ↔ shared ↔ wire stay
 * in sync.
 */
import { agents, campaigns, dashboardStatsSchema, hashItems, tasks } from '@hashhive/shared'
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

const queryRows: {
  agents: StatusRow[]
  campaigns: StatusRow[]
  tasks: StatusRow[]
  cracked: CountOnlyRow[]
  whereSpies: {
    agents: number
    campaigns: number
    tasks: number
    cracked: number
  }
} = {
  agents: [],
  campaigns: [],
  tasks: [],
  cracked: [],
  whereSpies: { agents: 0, campaigns: 0, tasks: 0, cracked: 0 },
}

beforeEach(() => {
  queryRows.agents = []
  queryRows.campaigns = []
  queryRows.tasks = []
  queryRows.cracked = []
  queryRows.whereSpies = { agents: 0, campaigns: 0, tasks: 0, cracked: 0 }
})

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
          where: () => ReturnType<typeof makeChain>
          groupBy: () => Promise<unknown[]>
          innerJoin: () => ReturnType<typeof makeChain>
          then: (
            onFulfilled: (value: unknown[]) => unknown,
            onRejected?: (reason: unknown) => unknown
          ) => Promise<unknown>
        } {
          const chain = {
            where() {
              if (target === 'agents') queryRows.whereSpies.agents++
              else if (target === 'campaigns') queryRows.whereSpies.campaigns++
              else if (target === 'tasks') queryRows.whereSpies.tasks++
              else if (target === 'cracked') queryRows.whereSpies.cracked++
              return chain
            },
            groupBy() {
              return Promise.resolve(rowsFor(target))
            },
            innerJoin() {
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
  it('issues a where(...) clause on each of the four aggregate queries', async () => {
    const res = await app.request(STATS_URL, {
      headers: commonHeaders(ADMIN_COOKIE),
    })
    expect(res.status).toBe(200)
    // Each aggregate query must call .where(...) so it filters by
    // session.projectId; if a future refactor drops the filter on any
    // query, this spy reads 0 for that table and fails loudly.
    expect(queryRows.whereSpies.agents).toBe(1)
    expect(queryRows.whereSpies.campaigns).toBe(1)
    expect(queryRows.whereSpies.tasks).toBe(1)
    expect(queryRows.whereSpies.cracked).toBe(1)
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
