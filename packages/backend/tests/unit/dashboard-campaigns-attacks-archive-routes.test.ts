/**
 * Route-contract tests for the attack archive & restore endpoints
 * (ADR-0019, issue #106 U7) and the `showArchived` filter on
 * `GET /:id/attacks`. Mirrors `dashboard-campaigns-routes.test.ts`'s
 * "archive/restore" describe block, adapted to
 * `campaigns-attacks-archive.ts` (`POST /attacks/archive`,
 * `POST /attacks/restore`, mounted on the same `campaignRoutes` router,
 * not nested under `/:id/attacks`) and `campaigns-attacks.ts`'s
 * `listAttacksRoute`.
 *
 * Runs in an isolated test phase via
 * `DASHBOARD_CAMPAIGNS_ATTACKS_ARCHIVE_TEST_ISOLATED` because this file
 * mocks `services/campaigns.js` wholesale — the mock.module call leaks
 * process-wide and would clobber `dashboard-campaigns-routes.test.ts` /
 * `campaign-transition.test.ts`, which rely on different stub shapes for
 * the same module. Mirrors the dashboard-campaigns-routes isolation
 * pattern.
 */
import { describe, expect, it, mock } from 'bun:test'

const IS_ISOLATED = process.env['DASHBOARD_CAMPAIGNS_ATTACKS_ARCHIVE_TEST_ISOLATED'] === '1'

if (!IS_ISOLATED) {
  describe('dashboard-campaigns-attacks-archive-routes (skipped — runs in isolated phase)', () => {
    it('signals isolation phase is required', () => {
      // oxlint-disable-next-line no-console -- surface phase-gating drift in CI logs
      console.warn(
        '[dashboard-campaigns-attacks-archive-routes] skipped — set DASHBOARD_CAMPAIGNS_ATTACKS_ARCHIVE_TEST_ISOLATED=1 to run; the route suite did NOT execute in this phase.'
      )
      expect(process.env['DASHBOARD_CAMPAIGNS_ATTACKS_ARCHIVE_TEST_ISOLATED']).toBeUndefined()
    })
  })
} else {
  // ─── Mock BetterAuth ─────────────────────────────────────────────────

  const ADMIN_COOKIE = 'hh.session_token=valid-admin-session'
  const VIEWER_COOKIE = 'hh.session_token=valid-viewer-session'

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
          if (cookie.includes('valid-viewer-session')) {
            return {
              user: {
                id: '2',
                email: 'viewer@test.local',
                name: 'Viewer',
                emailVerified: true,
                image: null,
                roles: [],
              },
              session: {
                id: 'sess-viewer',
                userId: '2',
                token: 'tok-viewer',
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
        return { id: 2, projects: [{ projectId: 1, roles: ['viewer'] }] }
      }
      return null
    },
    findProjectMembership: async (userId: number, projectId: number) => {
      if (projectId !== 1) return null
      if (userId === 1) return { projectId: 1, roles: ['admin'] }
      if (userId === 2) return { projectId: 1, roles: ['viewer'] }
      return null
    },
    getUserLastProjectId: async () => null,
    setUserLastProjectIdIfMember: async () => 1,
    setUserLastProjectId: async () => undefined,
    issueUserApiKey: mock(async () => ({ apiKey: 'cst_test', metadata: null })),
    revokeUserApiKey: mock(async () => undefined),
    getUserApiKeyMetadata: mock(async () => null),
  }))

  // ─── Mock the Campaigns Service Layer ───────────────────────────────
  //
  // Every export the campaigns route surface touches at module scope
  // (campaigns.ts, campaigns-lifecycle.ts, campaigns-attacks.ts,
  // campaigns-archive.ts, campaigns-attacks-archive.ts) must be present
  // on the factory object below — Bun's mock.module fully replaces the
  // module; a missing named export throws a SyntaxError at import time.

  type CampaignRow = {
    id: number
    projectId: number
    status: string
    name: string
    hashListId: number
    priority: number
    isPermanent: boolean
    archivedAt: Date | null
  }

  const makeCampaign = (overrides: Partial<CampaignRow> = {}): CampaignRow => ({
    id: 100,
    projectId: 1,
    status: 'draft',
    name: 'Test Campaign',
    hashListId: 1,
    priority: 5,
    isPermanent: false,
    archivedAt: null,
    ...overrides,
  })

  const mockGetCampaignById = mock(async (id: number) => {
    if (id === 100) return makeCampaign()
    if (id === 200) return makeCampaign({ id: 200, projectId: 999 })
    return null
  })

  type AttackOutcome = { id: number; outcome: string }
  const mockArchiveAttacks = mock(async (_projectId: number, ids: number[], _actor?: unknown) =>
    ids.map((id): AttackOutcome => ({ id, outcome: 'archived' }))
  )
  const mockRestoreAttacks = mock(async (_projectId: number, ids: number[], _actor?: unknown) =>
    ids.map((id): AttackOutcome => ({ id, outcome: 'restored' }))
  )
  const mockListAttacks = mock(async (_campaignId: number, _opts?: unknown) => [] as unknown[])

  mock.module('../../src/db/index.js', () => ({
    db: {
      select: () => ({
        from: () => ({
          where: () => ({ limit: () => Promise.resolve([]) }),
        }),
      }),
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

  mock.module('../../src/services/campaigns.js', () => ({
    listCampaigns: mock(async () => ({ campaigns: [], total: 0, limit: 50, offset: 0 })),
    getCampaignById: mockGetCampaignById,
    getCampaignTaskStats: mock(async () => ({
      total: 0,
      pending: 0,
      running: 0,
      completed: 0,
      failed: 0,
    })),
    getCampaignAttacksWithRuntime: mock(async () => []),
    listActiveAgentsByCampaign: mock(async () => []),
    deleteCampaign: mock(async () => ({ kind: 'not_found' as const })),
    createCampaign: mock(async () => makeCampaign()),
    createCampaignWithAttacks: mock(async () => ({
      kind: 'created' as const,
      campaign: makeCampaign(),
      attacks: [],
    })),
    updateCampaign: mock(async () => ({ kind: 'not_found' as const })),
    changeRunningCampaignPriority: mock(async () => ({ kind: 'not_found' as const })),
    listAttacks: mockListAttacks,
    listAttacksPaginated: mock(async () => ({ attacks: [], total: 0, limit: 50, offset: 0 })),
    createAttack: mock(async () => ({ id: 555 })),
    getAttackById: mock(async () => null),
    updateAttack: mock(async () => ({ id: 555 })),
    deleteAttack: mock(async () => ({ kind: 'not_found' as const })),
    // Archive/restore (issue #106 U6/U7) — the exports under test.
    archiveAttacks: mockArchiveAttacks,
    restoreAttacks: mockRestoreAttacks,
    transitionCampaign: mock(async () => ({ campaign: makeCampaign() })),
    validateCampaignDAG: mock(async () => ({ valid: true })),
    validateCampaignResources: mock(async () => ({ valid: true })),
    // Issue #100 U5 — single-hash-mode-per-campaign guard. This file's
    // attack-write requests never exercise a mode conflict, so a static
    // valid stub is enough (mirrors the other exports above).
    checkSingleHashModePerCampaign: mock(async () => ({ valid: true })),
    // Issue #100 U1/U2 — campaign ETA rollup exports statically imported by
    // the dashboard campaigns route (loaded here via src/index.js). Never
    // invoked in this archive/restore suite; stubs exist only so the named
    // imports link (the campaigns.js mock-static-import gotcha).
    getCampaignEta: mock(async () => ({ state: 'estimating' as const })),
    getCampaignEtasBatch: mock(async () => new Map()),
    computeCampaignEtaState: mock(() => ({ state: 'estimating' as const })),
    // Issue #100 R1 code review fix — same named-import-must-link
    // reasoning as the eta-rollup stubs above.
    getArchivedAttackIds: mock(async () => new Set<number>()),
    validateProposedDAG: mock(() => ({ valid: true })),
    updateCampaignProgress: mock(async () => undefined),
    enqueuePreemptionEvaluation: mock(async () => undefined),
    latchAttackPermanent: mock(async () => undefined),
    resolveGenerationStrategy: () => 'inline' as const,
    INLINE_GENERATION_THRESHOLD: 100,
    _deps: {},
    // `control/attacks.ts` statically imports this (issue #106 U12); since
    // this file loads the full app (`src/index.ts`), the named import fails
    // to link if the campaigns.js mock omits it. No refs are ever reclaimed
    // or archived in this archive/restore-focused suite.
    findReclaimedResourceRefs: mock(async () => ({ reclaimed: [], archived: [] })),
  }))

  const { app } = await import('../../src/index.js')

  const DASH_CAMPAIGNS = '/api/v1/dashboard/campaigns'

  function makeHeaders(cookie: string = ADMIN_COOKIE, extra: Record<string, string> = {}) {
    return {
      cookie,
      'x-project-id': '1',
      origin: 'http://lab.local',
      host: 'lab.local',
      ...extra,
    }
  }

  function jsonHeaders(cookie: string = ADMIN_COOKIE) {
    return makeHeaders(cookie, { 'content-type': 'application/json' })
  }

  describe('POST /campaigns/attacks/archive', () => {
    it('archives attacks and returns per-id outcomes (admin)', async () => {
      mockArchiveAttacks.mockClear()
      const res = await app.request(`${DASH_CAMPAIGNS}/attacks/archive`, {
        method: 'POST',
        headers: jsonHeaders(),
        body: JSON.stringify({ ids: [7001, 7002] }),
      })
      expect(res.status).toBe(200)
      const body = (await res.json()) as { results?: AttackOutcome[] }
      expect(body.results).toEqual([
        { id: 7001, outcome: 'archived' },
        { id: 7002, outcome: 'archived' },
      ])
      expect(mockArchiveAttacks).toHaveBeenCalledWith(1, [7001, 7002], {
        actorType: 'user',
        actorId: 1,
      })
    })

    it('returns 403 when a viewer attempts to archive', async () => {
      const res = await app.request(`${DASH_CAMPAIGNS}/attacks/archive`, {
        method: 'POST',
        headers: jsonHeaders(VIEWER_COOKIE),
        body: JSON.stringify({ ids: [7001] }),
      })
      expect(res.status).toBe(403)
    })

    it('returns 400 when ids exceeds the 200-item bulk cap', async () => {
      const ids = Array.from({ length: 201 }, (_, i) => i + 1)
      const res = await app.request(`${DASH_CAMPAIGNS}/attacks/archive`, {
        method: 'POST',
        headers: jsonHeaders(),
        body: JSON.stringify({ ids }),
      })
      expect(res.status).toBe(400)
    })

    it('returns 400 on an empty ids array', async () => {
      const res = await app.request(`${DASH_CAMPAIGNS}/attacks/archive`, {
        method: 'POST',
        headers: jsonHeaders(),
        body: JSON.stringify({ ids: [] }),
      })
      expect(res.status).toBe(400)
    })
  })

  describe('POST /campaigns/attacks/restore', () => {
    it('restores attacks and returns per-id outcomes (admin)', async () => {
      const res = await app.request(`${DASH_CAMPAIGNS}/attacks/restore`, {
        method: 'POST',
        headers: jsonHeaders(),
        body: JSON.stringify({ ids: [7001] }),
      })
      expect(res.status).toBe(200)
      const body = (await res.json()) as { results?: AttackOutcome[] }
      expect(body.results).toEqual([{ id: 7001, outcome: 'restored' }])
    })

    it('returns 403 when a viewer attempts to restore', async () => {
      const res = await app.request(`${DASH_CAMPAIGNS}/attacks/restore`, {
        method: 'POST',
        headers: jsonHeaders(VIEWER_COOKIE),
        body: JSON.stringify({ ids: [7001] }),
      })
      expect(res.status).toBe(403)
    })
  })

  describe('GET /campaigns/:id/attacks showArchived filter', () => {
    it('defaults to excluding archived attacks', async () => {
      mockListAttacks.mockClear()
      const res = await app.request(`${DASH_CAMPAIGNS}/100/attacks`, {
        headers: makeHeaders(),
      })
      expect(res.status).toBe(200)
      expect(mockListAttacks).toHaveBeenCalledWith(100, { showArchived: false })
    })

    it('passes showArchived=true through to the service', async () => {
      mockListAttacks.mockClear()
      const res = await app.request(`${DASH_CAMPAIGNS}/100/attacks?showArchived=true`, {
        headers: makeHeaders(),
      })
      expect(res.status).toBe(200)
      expect(mockListAttacks).toHaveBeenCalledWith(100, { showArchived: true })
    })

    it('404s for a campaign outside the caller project scope', async () => {
      const res = await app.request(`${DASH_CAMPAIGNS}/200/attacks`, {
        headers: makeHeaders(),
      })
      expect(res.status).toBe(404)
    })
  })
}
