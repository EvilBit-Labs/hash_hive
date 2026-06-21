/**
 * Dashboard campaigns route contract tests. Covers the list endpoint
 * query params (priority, sort, order), the enriched detail payload
 * (taskStats + activeAgents), and the draft-only DELETE.
 *
 * Runs in an isolated test phase via the `DASHBOARD_CAMPAIGNS_TEST_ISOLATED`
 * env gate because this file mocks `services/campaigns.js` wholesale, and
 * the mock.module call leaks process-wide. campaign-transition.test.ts
 * relies on the real `transitionCampaign` + `listAttacks` from the same
 * module, so the two cannot coexist in a single `bun test` invocation.
 * Mirrors the control-routes-rbac, tasks, queue-manager isolation pattern.
 */
import { describe, expect, it, mock } from 'bun:test'

const IS_ISOLATED = process.env['DASHBOARD_CAMPAIGNS_TEST_ISOLATED'] === '1'

if (!IS_ISOLATED) {
  // Surface a fail-soft signal when this file runs outside the isolated
  // phase. A passing skip-stub would silently hide the fact that the
  // route coverage never ran in the broader suite; emit a warn and
  // assert the env gate so CI flags any drift in the phase wiring.
  describe('dashboard-campaigns-routes (skipped — runs in isolated phase)', () => {
    it('signals isolation phase is required', () => {
      // oxlint-disable-next-line no-console -- surface phase-gating drift in CI logs
      console.warn(
        '[dashboard-campaigns-routes] skipped — set DASHBOARD_CAMPAIGNS_TEST_ISOLATED=1 to run; the route suite did NOT execute in this phase.'
      )
      // Assert the env gate so a CI misconfiguration cannot silently
      // drop the suite while the test result still reads green.
      expect(process.env['DASHBOARD_CAMPAIGNS_TEST_ISOLATED']).toBeUndefined()
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
                // Server-managed scope (issue #159 U4).
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
    // Issue #159 U3 / U6: stub the preference helpers so projects.ts
    // and lib/auth.ts module imports resolve without errors.
    getUserLastProjectId: async () => null,
    setUserLastProjectIdIfMember: async () => 1,
    setUserLastProjectId: async () => undefined,
    issueUserApiKey: mock(async () => ({ apiKey: 'cst_test', metadata: null })),
    revokeUserApiKey: mock(async () => undefined),
    getUserApiKeyMetadata: mock(async () => null),
  }))

  // ─── Mock the Campaigns Service Layer ───────────────────────────────
  //
  // Per the contract-test-mocks-mirror-service-not-schema convention:
  // local type aliases derive from the real service return types so a
  // signature drift in the service surfaces here as a type-check
  // failure rather than as a wire-shape regression. Every dynamic-return
  // mock below is typed via `mock<CampaignsService['fnName']>(...)` per
  // the convention's dynamic-return pattern; the type aliases (CampaignRow,
  // UpdateCampaignResult, etc.) exist for the row builder and per-test
  // assertions that need to name the shape directly.
  type CampaignsService = typeof import('../../src/services/campaigns.js')
  type CampaignRow = NonNullable<Awaited<ReturnType<CampaignsService['getCampaignById']>>>
  type CreateWithAttacksResult = Awaited<ReturnType<CampaignsService['createCampaignWithAttacks']>>

  const mockListCampaigns = mock<CampaignsService['listCampaigns']>(async () => ({
    campaigns: [],
    total: 0,
    limit: 50,
    offset: 0,
  }))

  const makeCampaign = (overrides: Partial<CampaignRow> = {}): CampaignRow => ({
    id: 100,
    projectId: 1,
    status: 'draft',
    name: 'Test Campaign',
    hashListId: 1,
    priority: 5,
    description: null,
    progress: {},
    metadata: {},
    createdAt: new Date('2026-01-01'),
    startedAt: null,
    completedAt: null,
    updatedAt: new Date('2026-01-01'),
    createdBy: 1,
    isPermanent: false,
    archivedAt: null,
    ...overrides,
  })

  const mockGetCampaignById = mock<CampaignsService['getCampaignById']>(async (id) => {
    if (id === 100) return makeCampaign()
    if (id === 101) return makeCampaign({ id: 101, status: 'running' })
    if (id === 102) return makeCampaign({ id: 102 })
    if (id === 200) return makeCampaign({ id: 200, projectId: 999 })
    return null
  })

  const mockDeleteCampaign = mock<CampaignsService['deleteCampaign']>(async (id) => {
    if (id === 100) return { kind: 'deleted', id: 100, projectId: 1 }
    if (id === 101) return { kind: 'not_draft', status: 'running' }
    // A campaign that has run is permanent: deletable returns not_deletable.
    if (id === 102) return { kind: 'not_deletable' }
    return { kind: 'not_found' }
  })

  const mockUpdateCampaign = mock<CampaignsService['updateCampaign']>(
    async (id, _projectId, data) => {
      if (id === 100) {
        return { kind: 'updated', campaign: makeCampaign({ ...(data as Partial<CampaignRow>) }) }
      }
      if (id === 101) return { kind: 'not_draft', status: 'running' }
      return { kind: 'not_found' }
    }
  )

  const mockChangeRunningCampaignPriority = mock<CampaignsService['changeRunningCampaignPriority']>(
    async (id, projectId) => {
      if (id === 100) {
        return { kind: 'updated', campaign: makeCampaign({ id, projectId, status: 'running' }) }
      }
      if (id === 101) return { kind: 'not_active', status: 'completed' }
      return { kind: 'not_found' }
    }
  )

  const mockGetCampaignTaskStats = mock(async (_id: number) => ({
    total: 10,
    pending: 2,
    running: 3,
    completed: 4,
    failed: 1,
  }))

  const mockTransitionCampaign = mock<CampaignsService['transitionCampaign']>(async () => ({
    campaign: makeCampaign(),
  }))

  const mockListActiveAgentsByCampaign = mock(async (_id: number) => [
    {
      agentId: 11,
      agentName: 'Rig One',
      taskId: 5001,
      attackId: 7001,
      attackMode: 0,
      progress: { speedHs: 1234567 },
      speedHs: 1234567,
    },
  ])

  // Per-test mock of listAttacks: defaults to empty so existing tests
  // are unaffected; DAG-validation tests override it via .mockResolvedValueOnce.
  const mockListAttacks = mock(
    async (_campaignId: number) =>
      [] as Array<{
        id: number
        dependencies: number[] | null
      }>
  )

  type ResourceCheckResult = { valid: true } | { valid: false; missing: string[] }
  const mockValidateCampaignResources = mock(
    async (
      _campaign: { projectId: number; hashListId: number | null },
      _attacks: ReadonlyArray<Record<string, unknown>>
    ): Promise<ResourceCheckResult> => ({ valid: true })
  )

  const mockCreateCampaign = mock<CampaignsService['createCampaign']>(async (data) =>
    makeCampaign({ name: data.name, projectId: data.projectId, hashListId: data.hashListId })
  )

  const mockCreateCampaignWithAttacks = mock<CampaignsService['createCampaignWithAttacks']>(
    async () =>
      ({
        kind: 'created',
        campaign: makeCampaign(),
        attacks: [],
      }) satisfies CreateWithAttacksResult
  )

  const mockCreateAttack = mock(async () => ({ id: 555 }))
  const mockUpdateAttackImpl = mock(async () => ({ id: 555 }))
  const mockGetAttackByIdImpl = mock(
    async (_id: number) =>
      null as { id: number; campaignId: number; dependencies: number[] | null } | null
  )

  // Mock db + ioredis BEFORE importing the real campaigns module so
  // that the real `validateProposedDAG` (pure, no DB) can be lifted out
  // and used inside the campaigns mock. Without this, the campaigns
  // module would resolve db to the real driver during the dynamic
  // import below and fail to load.
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

  // Pull the REAL validateProposedDAG from the production module so the
  // route mock below uses the same Kahn implementation that ships, not
  // a hand-ported test stub. Per bun:test mock.module ordering (see
  // GOTCHAS.md), this dynamic-import must happen AFTER the db/ioredis
  // mocks but BEFORE the campaigns mock.module — once the campaigns
  // wholesale mock is registered, any subsequent import resolves to
  // the mock, not the real exports.
  const { validateProposedDAG: realValidateProposedDAG } =
    await import('../../src/services/campaigns.js')

  mock.module('../../src/services/campaigns.js', () => ({
    // Test-driven stubs.
    listCampaigns: mockListCampaigns,
    getCampaignById: mockGetCampaignById,
    getCampaignTaskStats: mockGetCampaignTaskStats,
    getCampaignAttacksWithRuntime: mock(async () => []),
    listActiveAgentsByCampaign: mockListActiveAgentsByCampaign,
    deleteCampaign: mockDeleteCampaign,
    // Inert stubs for sibling exports the routes module imports.
    createCampaign: mockCreateCampaign,
    createCampaignWithAttacks: mockCreateCampaignWithAttacks,
    updateCampaign: mockUpdateCampaign,
    changeRunningCampaignPriority: mockChangeRunningCampaignPriority,
    listAttacks: mockListAttacks,
    listAttacksPaginated: mock(async () => ({ attacks: [], total: 0, limit: 50, offset: 0 })),
    createAttack: mockCreateAttack,
    getAttackById: mockGetAttackByIdImpl,
    updateAttack: mockUpdateAttackImpl,
    deleteAttack: mock(async () => null),
    transitionCampaign: mockTransitionCampaign,
    validateCampaignDAG: mock(async () => ({ valid: true })),
    // Cross-project resource pre-check on draft writes. Default to
    // valid; individual tests override per case via mockResolvedValueOnce.
    validateCampaignResources: mockValidateCampaignResources,
    // Real production implementation — caught by the dynamic-import
    // above. Production drift now fails the tests immediately instead
    // of silently diverging from a hand-ported stub.
    validateProposedDAG: realValidateProposedDAG,
    // Required by tasks.ts (static import resolves to this mocked module
    // because mock.module is process-global).
    updateCampaignProgress: mock(async () => undefined),
    // Likewise required by tasks.ts/retry.ts (#97 U6 completion trigger).
    enqueuePreemptionEvaluation: mock(async () => undefined),
    resolveGenerationStrategy: () => 'inline' as const,
    INLINE_GENERATION_THRESHOLD: 100,
    _deps: {},
  }))

  // Archive/restore live in campaign-dashboard.js and the archive route imports
  // them directly (not via the campaigns.js facade), so mock that module too.
  // Spread the REAL module first so every other export (getCampaignTaskStats,
  // deleteCampaign, ...) keeps real behavior — only archive/restore are stubbed
  // (GOTCHAS.md backend-testing pattern; the db mock above is already in place,
  // so importing the real module here is side-effect-free).
  type CampaignDashboardService = typeof import('../../src/services/campaign-dashboard.js')
  const mockArchiveCampaigns = mock<CampaignDashboardService['archiveCampaigns']>(
    async (_projectId, ids) =>
      ids.map((id) => ({
        id,
        outcome: id === 100 ? ('archived' as const) : ('not_archivable' as const),
      }))
  )
  const mockRestoreCampaigns = mock<CampaignDashboardService['restoreCampaigns']>(
    async (_projectId, ids) => ids.map((id) => ({ id, outcome: 'restored' as const }))
  )
  const realCampaignDashboard = await import('../../src/services/campaign-dashboard.js')
  mock.module('../../src/services/campaign-dashboard.js', () => ({
    ...realCampaignDashboard,
    archiveCampaigns: mockArchiveCampaigns,
    restoreCampaigns: mockRestoreCampaigns,
  }))

  // Dynamically import so the app module loads AFTER the mock.module calls
  // above. A static `import { app }` would still resolve as part of the same
  // module-graph evaluation pass, before mock.module hoisting takes effect.
  const { app } = await import('../../src/index.js')

  const DASH_CAMPAIGNS = '/api/v1/dashboard/campaigns'

  // Origin + Host satisfy the CSRF same-origin guard mounted on the
  // dashboard surface (PR review S-H4 follow-up). The fixture uses
  // matching values; tests intentionally exercising a cross-origin
  // attempt would override these.
  function makeHeaders(cookie: string = ADMIN_COOKIE) {
    return {
      cookie,
      'x-project-id': '1',
      origin: 'http://lab.local',
      host: 'lab.local',
    }
  }

  describe('Dashboard campaigns list: query params', () => {
    it('passes showArchived=true through to the service', async () => {
      mockListCampaigns.mockClear()
      const res = await app.request(`${DASH_CAMPAIGNS}?showArchived=true`, {
        headers: makeHeaders(),
      })
      expect(res.status).toBe(200)
      expect(mockListCampaigns).toHaveBeenCalledWith(
        expect.objectContaining({ showArchived: true })
      )
    })

    it('accepts the default request and passes projectId to the service', async () => {
      mockListCampaigns.mockClear()
      const res = await app.request(DASH_CAMPAIGNS, { headers: makeHeaders() })
      expect(res.status).toBe(200)
      expect(mockListCampaigns).toHaveBeenCalledTimes(1)
      const args = mockListCampaigns.mock.calls[0]?.[0] as { projectId?: number }
      expect(args?.projectId).toBe(1)
    })

    it('passes status filter through to the service', async () => {
      mockListCampaigns.mockClear()
      const res = await app.request(`${DASH_CAMPAIGNS}?status=running`, { headers: makeHeaders() })
      expect(res.status).toBe(200)
      const args = mockListCampaigns.mock.calls[0]?.[0] as { status?: string }
      expect(args?.status).toBe('running')
    })

    it('accepts priority=1 (high) and passes through', async () => {
      mockListCampaigns.mockClear()
      const res = await app.request(`${DASH_CAMPAIGNS}?priority=1`, { headers: makeHeaders() })
      expect(res.status).toBe(200)
      const args = mockListCampaigns.mock.calls[0]?.[0] as { priority?: number }
      expect(args?.priority).toBe(1)
    })

    it('accepts priority=5 (normal)', async () => {
      mockListCampaigns.mockClear()
      const res = await app.request(`${DASH_CAMPAIGNS}?priority=5`, { headers: makeHeaders() })
      expect(res.status).toBe(200)
      const args = mockListCampaigns.mock.calls[0]?.[0] as { priority?: number }
      expect(args?.priority).toBe(5)
    })

    it('accepts priority=10 (low)', async () => {
      mockListCampaigns.mockClear()
      const res = await app.request(`${DASH_CAMPAIGNS}?priority=10`, { headers: makeHeaders() })
      expect(res.status).toBe(200)
      const args = mockListCampaigns.mock.calls[0]?.[0] as { priority?: number }
      expect(args?.priority).toBe(10)
    })

    it('rejects invalid priority=3 with 400', async () => {
      mockListCampaigns.mockClear()
      const res = await app.request(`${DASH_CAMPAIGNS}?priority=3`, { headers: makeHeaders() })
      expect(res.status).toBe(400)
      const body = (await res.json()) as { error?: { code?: string } }
      expect(body.error?.code).toBe('VALIDATION_ERROR')
      expect(mockListCampaigns).not.toHaveBeenCalled()
    })

    it('accepts sort=name&order=asc', async () => {
      mockListCampaigns.mockClear()
      const res = await app.request(`${DASH_CAMPAIGNS}?sort=name&order=asc`, {
        headers: makeHeaders(),
      })
      expect(res.status).toBe(200)
      const args = mockListCampaigns.mock.calls[0]?.[0] as { sort?: string; order?: string }
      expect(args?.sort).toBe('name')
      expect(args?.order).toBe('asc')
    })

    it('accepts sort=priority', async () => {
      mockListCampaigns.mockClear()
      const res = await app.request(`${DASH_CAMPAIGNS}?sort=priority`, { headers: makeHeaders() })
      expect(res.status).toBe(200)
      const args = mockListCampaigns.mock.calls[0]?.[0] as { sort?: string }
      expect(args?.sort).toBe('priority')
    })

    it('accepts sort=createdAt (default field)', async () => {
      mockListCampaigns.mockClear()
      const res = await app.request(`${DASH_CAMPAIGNS}?sort=createdAt`, { headers: makeHeaders() })
      expect(res.status).toBe(200)
      const args = mockListCampaigns.mock.calls[0]?.[0] as { sort?: string }
      expect(args?.sort).toBe('createdAt')
    })

    it('rejects invalid sort value with 400', async () => {
      mockListCampaigns.mockClear()
      const res = await app.request(`${DASH_CAMPAIGNS}?sort=evil`, { headers: makeHeaders() })
      expect(res.status).toBe(400)
      const body = (await res.json()) as { error?: { code?: string } }
      expect(body.error?.code).toBe('VALIDATION_ERROR')
      expect(mockListCampaigns).not.toHaveBeenCalled()
    })

    it('rejects invalid order value with 400', async () => {
      mockListCampaigns.mockClear()
      const res = await app.request(`${DASH_CAMPAIGNS}?order=sideways`, { headers: makeHeaders() })
      expect(res.status).toBe(400)
      const body = (await res.json()) as { error?: { code?: string } }
      expect(body.error?.code).toBe('VALIDATION_ERROR')
    })

    it('preserves project scoping across filter and sort combinations', async () => {
      mockListCampaigns.mockClear()
      const res = await app.request(
        `${DASH_CAMPAIGNS}?status=running&priority=1&sort=name&order=asc`,
        { headers: makeHeaders() }
      )
      expect(res.status).toBe(200)
      const args = mockListCampaigns.mock.calls[0]?.[0] as { projectId?: number }
      expect(args?.projectId).toBe(1)
    })
  })

  describe('Dashboard campaigns detail: enriched payload', () => {
    it('returns campaign + attacks + taskStats + activeAgents in one round-trip', async () => {
      const res = await app.request(`${DASH_CAMPAIGNS}/100`, { headers: makeHeaders() })
      expect(res.status).toBe(200)
      const body = (await res.json()) as {
        campaign: { id: number }
        attacks: unknown[]
        taskStats: {
          total: number
          pending: number
          running: number
          completed: number
          failed: number
        }
        activeAgents: Array<{ agentId: number; agentName: string }>
      }
      expect(body.campaign.id).toBe(100)
      expect(body.taskStats).toEqual({
        total: 10,
        pending: 2,
        running: 3,
        completed: 4,
        failed: 1,
      })
      expect(body.activeAgents).toHaveLength(1)
      expect(body.activeAgents[0]?.agentName).toBe('Rig One')
    })

    it('returns 400 on non-integer id', async () => {
      const res = await app.request(`${DASH_CAMPAIGNS}/abc`, { headers: makeHeaders() })
      expect(res.status).toBe(400)
      const body = (await res.json()) as { error?: { code?: string } }
      expect(body.error?.code).toBe('VALIDATION_ERROR')
    })

    it('returns 404 when campaign belongs to a different project', async () => {
      const res = await app.request(`${DASH_CAMPAIGNS}/200`, { headers: makeHeaders() })
      expect(res.status).toBe(404)
      const body = (await res.json()) as { error?: { code?: string } }
      expect(body.error?.code).toBe('RESOURCE_NOT_FOUND')
    })

    it('returns 404 for unknown id', async () => {
      const res = await app.request(`${DASH_CAMPAIGNS}/9999`, { headers: makeHeaders() })
      expect(res.status).toBe(404)
    })
  })

  describe('Dashboard campaigns delete: draft-only', () => {
    it('deletes a draft campaign and returns 200', async () => {
      mockDeleteCampaign.mockClear()
      const res = await app.request(`${DASH_CAMPAIGNS}/100`, {
        method: 'DELETE',
        headers: makeHeaders(),
      })
      expect(res.status).toBe(200)
      const body = (await res.json()) as { deleted?: boolean; id?: number }
      expect(body.deleted).toBe(true)
      expect(body.id).toBe(100)
      expect(mockDeleteCampaign).toHaveBeenCalledTimes(1)
    })

    it('returns 409 with NOT_DRAFT when campaign is not in draft status', async () => {
      const res = await app.request(`${DASH_CAMPAIGNS}/101`, {
        method: 'DELETE',
        headers: makeHeaders(),
      })
      expect(res.status).toBe(409)
      const body = (await res.json()) as { error?: { code?: string; message?: string } }
      expect(body.error?.code).toBe('NOT_DRAFT')
      expect(body.error?.message).toContain('running')
    })

    it('returns 409 with NOT_DELETABLE when the campaign is permanent', async () => {
      const res = await app.request(`${DASH_CAMPAIGNS}/102`, {
        method: 'DELETE',
        headers: makeHeaders(),
      })
      expect(res.status).toBe(409)
      const body = (await res.json()) as { error?: { code?: string } }
      expect(body.error?.code).toBe('NOT_DELETABLE')
    })

    it('returns 404 when campaign belongs to a different project', async () => {
      const res = await app.request(`${DASH_CAMPAIGNS}/200`, {
        method: 'DELETE',
        headers: makeHeaders(),
      })
      expect(res.status).toBe(404)
      const body = (await res.json()) as { error?: { code?: string } }
      expect(body.error?.code).toBe('RESOURCE_NOT_FOUND')
    })

    it('returns 400 on invalid id', async () => {
      const res = await app.request(`${DASH_CAMPAIGNS}/abc`, {
        method: 'DELETE',
        headers: makeHeaders(),
      })
      expect(res.status).toBe(400)
      const body = (await res.json()) as { error?: { code?: string } }
      expect(body.error?.code).toBe('VALIDATION_ERROR')
    })
  })

  describe('Dashboard campaigns archive/restore (ADR-0019)', () => {
    it('archives campaigns and returns per-id outcomes (admin)', async () => {
      mockArchiveCampaigns.mockClear()
      const res = await app.request(`${DASH_CAMPAIGNS}/archive`, {
        method: 'POST',
        headers: { ...makeHeaders(), 'content-type': 'application/json' },
        body: JSON.stringify({ ids: [100, 101] }),
      })
      expect(res.status).toBe(200)
      const body = (await res.json()) as { results?: { id: number; outcome: string }[] }
      expect(body.results).toEqual([
        { id: 100, outcome: 'archived' },
        { id: 101, outcome: 'not_archivable' },
      ])
      expect(mockArchiveCampaigns).toHaveBeenCalledWith(1, [100, 101])
    })

    it('restores campaigns (admin)', async () => {
      const res = await app.request(`${DASH_CAMPAIGNS}/restore`, {
        method: 'POST',
        headers: { ...makeHeaders(), 'content-type': 'application/json' },
        body: JSON.stringify({ ids: [100] }),
      })
      expect(res.status).toBe(200)
      const body = (await res.json()) as { results?: { id: number; outcome: string }[] }
      expect(body.results).toEqual([{ id: 100, outcome: 'restored' }])
    })

    it('returns 403 when a viewer attempts to archive', async () => {
      const res = await app.request(`${DASH_CAMPAIGNS}/archive`, {
        method: 'POST',
        headers: { ...makeHeaders(VIEWER_COOKIE), 'content-type': 'application/json' },
        body: JSON.stringify({ ids: [100] }),
      })
      expect(res.status).toBe(403)
    })

    it('returns 400 on an empty ids array', async () => {
      const res = await app.request(`${DASH_CAMPAIGNS}/archive`, {
        method: 'POST',
        headers: { ...makeHeaders(), 'content-type': 'application/json' },
        body: JSON.stringify({ ids: [] }),
      })
      expect(res.status).toBe(400)
    })
  })

  describe('Dashboard campaigns update: draft-only (PATCH/PUT)', () => {
    function updateBody(method: 'PATCH' | 'PUT', id: number, body: Record<string, unknown>) {
      return app.request(`${DASH_CAMPAIGNS}/${id}`, {
        method,
        headers: { ...makeHeaders(), 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
    }

    // PATCH is partial: any field optional. PUT is full-replace: name +
    // priority required; description optional (null means "explicit clear").
    const patchBody = { name: 'New name' }
    const putBody = { name: 'New name', description: 'Updated', priority: 5 }

    it('PATCH updates a draft campaign with a partial body and returns 200', async () => {
      mockUpdateCampaign.mockClear()
      const res = await updateBody('PATCH', 100, patchBody)
      expect(res.status).toBe(200)
      const body = (await res.json()) as { campaign?: { name?: string } }
      expect(body.campaign?.name).toBe('New name')
      expect(mockUpdateCampaign).toHaveBeenCalledTimes(1)
    })

    it('PUT updates a draft campaign with a full body and returns 200', async () => {
      mockUpdateCampaign.mockClear()
      const res = await updateBody('PUT', 100, putBody)
      expect(res.status).toBe(200)
      const body = (await res.json()) as { campaign?: { name?: string } }
      expect(body.campaign?.name).toBe('New name')
      expect(mockUpdateCampaign).toHaveBeenCalledTimes(1)
    })

    it('PUT with missing required field (priority) returns 400 VALIDATION_ERROR', async () => {
      const res = await updateBody('PUT', 100, { name: 'Incomplete' })
      expect(res.status).toBe(400)
      const body = (await res.json()) as { error?: { code?: string } }
      expect(body.error?.code).toBe('VALIDATION_ERROR')
    })

    it('PATCH /{id}/priority changes a running campaign and returns 200 (#97 U7)', async () => {
      // Clear any prior calls so the call-count assertion is isolated.
      mockChangeRunningCampaignPriority.mockClear()
      const res = await app.request(`${DASH_CAMPAIGNS}/100/priority`, {
        method: 'PATCH',
        headers: { ...makeHeaders(), 'content-type': 'application/json' },
        body: JSON.stringify({ priority: 1 }),
      })
      expect(res.status).toBe(200)
      expect(mockChangeRunningCampaignPriority).toHaveBeenCalledTimes(1)
    })

    it('PATCH /{id}/priority on a non-active campaign returns 409 NOT_ACTIVE (#97 U7)', async () => {
      const res = await app.request(`${DASH_CAMPAIGNS}/101/priority`, {
        method: 'PATCH',
        headers: { ...makeHeaders(), 'content-type': 'application/json' },
        body: JSON.stringify({ priority: 1 }),
      })
      expect(res.status).toBe(409)
      const body = (await res.json()) as { error?: { code?: string } }
      expect(body.error?.code).toBe('NOT_ACTIVE')
    })

    it('PUT with missing required field (name) returns 400 VALIDATION_ERROR', async () => {
      const res = await updateBody('PUT', 100, { priority: 5 })
      expect(res.status).toBe(400)
      const body = (await res.json()) as { error?: { code?: string } }
      expect(body.error?.code).toBe('VALIDATION_ERROR')
    })

    it('PUT with explicit description: null clears the field', async () => {
      mockUpdateCampaign.mockClear()
      const res = await updateBody('PUT', 100, {
        name: 'Clear desc',
        priority: 5,
        description: null,
      })
      expect(res.status).toBe(200)
      const calls = mockUpdateCampaign.mock.calls
      const lastCall = calls[calls.length - 1]
      expect(lastCall).toBeDefined()
      // updateCampaign signature: (id, projectId, data). `description`
      // lives on the data object at position [2].
      expect((lastCall![2] as { description?: string | null }).description).toBeNull()
    })

    for (const method of ['PATCH', 'PUT'] as const) {
      it(`${method} on running campaign returns 409 NOT_DRAFT`, async () => {
        const body = method === 'PUT' ? putBody : patchBody
        const res = await updateBody(method, 101, body)
        expect(res.status).toBe(409)
        const parsed = (await res.json()) as { error?: { code?: string; message?: string } }
        expect(parsed.error?.code).toBe('NOT_DRAFT')
        expect(parsed.error?.message).toContain('running')
      })
    }

    it('PATCH on unknown id returns 404', async () => {
      const res = await updateBody('PATCH', 9999, { name: 'Nope' })
      expect(res.status).toBe(404)
      const body = (await res.json()) as { error?: { code?: string } }
      expect(body.error?.code).toBe('RESOURCE_NOT_FOUND')
    })

    it('PATCH on campaign in a different project returns 404', async () => {
      const res = await updateBody('PATCH', 200, { name: 'Cross-project' })
      expect(res.status).toBe(404)
      const body = (await res.json()) as { error?: { code?: string } }
      expect(body.error?.code).toBe('RESOURCE_NOT_FOUND')
    })

    it('PATCH on non-integer id returns 400 VALIDATION_ERROR', async () => {
      const res = await updateBody('PATCH', 'abc' as unknown as number, { name: 'Bad id' })
      expect(res.status).toBe(400)
      const body = (await res.json()) as { error?: { code?: string } }
      expect(body.error?.code).toBe('VALIDATION_ERROR')
    })

    it('PATCH with invalid body returns 400 VALIDATION_ERROR', async () => {
      const res = await updateBody('PATCH', 100, { priority: 99 })
      expect(res.status).toBe(400)
      const body = (await res.json()) as { error?: { code?: string } }
      expect(body.error?.code).toBe('VALIDATION_ERROR')
    })
  })

  describe('Dashboard campaign lifecycle: queue-availability mapping', () => {
    it('maps QUEUE_UNAVAILABLE → 503 SERVICE_UNAVAILABLE', async () => {
      mockTransitionCampaign.mockResolvedValueOnce({
        error: 'Queue unavailable — cannot start campaign',
        code: 'QUEUE_UNAVAILABLE',
      })

      const res = await app.request(`${DASH_CAMPAIGNS}/100/lifecycle`, {
        method: 'POST',
        headers: { ...makeHeaders(), 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'start' }),
      })

      expect(res.status).toBe(503)
      const body = (await res.json()) as { error?: { code?: string; message?: string } }
      expect(body.error?.code).toBe('SERVICE_UNAVAILABLE')
      expect(body.error?.message).toContain('Queue unavailable')
    })

    it('still maps non-queue transition errors to 400 INVALID_TRANSITION', async () => {
      mockTransitionCampaign.mockResolvedValueOnce({
        error: "Cannot transition from 'running' to 'running'",
      })

      const res = await app.request(`${DASH_CAMPAIGNS}/100/lifecycle`, {
        method: 'POST',
        headers: { ...makeHeaders(), 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'start' }),
      })

      expect(res.status).toBe(400)
      const body = (await res.json()) as { error?: { code?: string } }
      expect(body.error?.code).toBe('INVALID_TRANSITION')
    })

    it('maps RESOURCE_MISSING → 409 Conflict with specific missing-id message', async () => {
      mockTransitionCampaign.mockResolvedValueOnce({
        error: 'Referenced resources missing: wordlist(99)',
        code: 'RESOURCE_MISSING',
      })
      const res = await app.request(`${DASH_CAMPAIGNS}/100/lifecycle`, {
        method: 'POST',
        headers: { ...makeHeaders(), 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'start' }),
      })
      // 409 Conflict — the request is well-formed; the state is.
      expect(res.status).toBe(409)
      const body = (await res.json()) as { error?: { code?: string; message?: string } }
      expect(body.error?.code).toBe('RESOURCE_MISSING')
      expect(body.error?.message).toContain('wordlist(99)')
    })

    it('maps STALE_STATE → 409 Conflict when source-status guard rejects', async () => {
      mockTransitionCampaign.mockResolvedValueOnce({
        error:
          "Campaign status changed during transition (was 'running'); retry against the current state",
        code: 'STALE_STATE',
      })
      const res = await app.request(`${DASH_CAMPAIGNS}/100/lifecycle`, {
        method: 'POST',
        headers: { ...makeHeaders(), 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'pause' }),
      })
      expect(res.status).toBe(409)
      const body = (await res.json()) as { error?: { code?: string } }
      expect(body.error?.code).toBe('STALE_STATE')
    })

    it('returns 404 RESOURCE_NOT_FOUND on cross-project campaign without consuming the transition mock', async () => {
      mockTransitionCampaign.mockReset()
      const res = await app.request(`${DASH_CAMPAIGNS}/200/lifecycle`, {
        method: 'POST',
        headers: { ...makeHeaders(), 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'start' }),
      })
      expect(res.status).toBe(404)
      const body = (await res.json()) as { error?: { code?: string } }
      expect(body.error?.code).toBe('RESOURCE_NOT_FOUND')
      // The 404 fires BEFORE transitionCampaign, mirroring alias handlers.
      expect(mockTransitionCampaign).toHaveBeenCalledTimes(0)
    })

    it('returns 404 RESOURCE_NOT_FOUND for unknown id', async () => {
      mockTransitionCampaign.mockReset()
      const res = await app.request(`${DASH_CAMPAIGNS}/9999/lifecycle`, {
        method: 'POST',
        headers: { ...makeHeaders(), 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'start' }),
      })
      expect(res.status).toBe(404)
      expect(mockTransitionCampaign).toHaveBeenCalledTimes(0)
    })

    it('returns 400 VALIDATION_ERROR for non-integer id', async () => {
      const res = await app.request(`${DASH_CAMPAIGNS}/abc/lifecycle`, {
        method: 'POST',
        headers: { ...makeHeaders(), 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'start' }),
      })
      expect(res.status).toBe(400)
      const body = (await res.json()) as { error?: { code?: string } }
      expect(body.error?.code).toBe('VALIDATION_ERROR')
    })
  })

  describe('POST /campaigns: transactional create with inline attacks', () => {
    function postCampaign(body: Record<string, unknown>) {
      return app.request(DASH_CAMPAIGNS, {
        method: 'POST',
        headers: { ...makeHeaders(), 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
    }

    it('without attacks: routes to legacy createCampaign and returns 201', async () => {
      mockCreateCampaign.mockClear()
      mockCreateCampaignWithAttacks.mockClear()
      const res = await postCampaign({ name: 'Legacy', hashListId: 1 })
      expect(res.status).toBe(201)
      expect(mockCreateCampaign).toHaveBeenCalledTimes(1)
      expect(mockCreateCampaignWithAttacks).toHaveBeenCalledTimes(0)
    })

    it('with empty attacks[]: still routes to legacy createCampaign', async () => {
      mockCreateCampaign.mockClear()
      mockCreateCampaignWithAttacks.mockClear()
      const res = await postCampaign({ name: 'Empty attacks', hashListId: 1, attacks: [] })
      expect(res.status).toBe(201)
      expect(mockCreateCampaign).toHaveBeenCalledTimes(1)
      expect(mockCreateCampaignWithAttacks).toHaveBeenCalledTimes(0)
    })

    it('with attacks: routes to createCampaignWithAttacks and returns 201', async () => {
      mockCreateCampaign.mockClear()
      mockCreateCampaignWithAttacks.mockClear()
      mockCreateCampaignWithAttacks.mockResolvedValueOnce({
        kind: 'created',
        campaign: makeCampaign({ name: 'With attacks' }),
        attacks: [
          { id: 700, dependencies: null },
          { id: 701, dependencies: [700] },
        ],
      })
      const res = await postCampaign({
        name: 'With attacks',
        hashListId: 1,
        attacks: [
          { mode: 0, wordlistId: 1 },
          { mode: 0, wordlistId: 2, dependencyIndices: [0] },
        ],
      })
      expect(res.status).toBe(201)
      expect(mockCreateCampaignWithAttacks).toHaveBeenCalledTimes(1)
      expect(mockCreateCampaign).toHaveBeenCalledTimes(0)
      const body = (await res.json()) as {
        attacks?: Array<{ id?: number; dependencies?: number[] | null }>
      }
      expect(body.attacks).toHaveLength(2)
      expect(body.attacks?.[1]?.dependencies).toEqual([700])
    })

    it('with cycle in inline attacks: returns 400 DAG_INVALID', async () => {
      mockCreateCampaignWithAttacks.mockResolvedValueOnce({
        kind: 'dag_invalid',
        error: 'Circular dependency detected among attacks',
      })
      const res = await postCampaign({
        name: 'Cycle',
        hashListId: 1,
        attacks: [
          { mode: 0, dependencyIndices: [1] },
          { mode: 0, dependencyIndices: [0] },
        ],
      })
      expect(res.status).toBe(400)
      const body = (await res.json()) as { error?: { code?: string; message?: string } }
      expect(body.error?.code).toBe('DAG_INVALID')
      expect(body.error?.message).toContain('Circular')
    })

    it('with out-of-range dependency index: surfaces DAG_INVALID', async () => {
      mockCreateCampaignWithAttacks.mockResolvedValueOnce({
        kind: 'dag_invalid',
        error: 'Attack 5 depends on non-existent attack 99',
      })
      const res = await postCampaign({
        name: 'Bad ref',
        hashListId: 1,
        attacks: [{ mode: 0, dependencyIndices: [5] }],
      })
      expect(res.status).toBe(400)
      const body = (await res.json()) as { error?: { code?: string } }
      expect(body.error?.code).toBe('DAG_INVALID')
    })

    it('rejects malformed body (missing hashListId) with 400', async () => {
      const res = await postCampaign({ name: 'Missing field' })
      expect(res.status).toBe(400)
    })

    it('rejects negative dependencyIndices at the schema layer', async () => {
      const res = await postCampaign({
        name: 'Bad index',
        hashListId: 1,
        attacks: [{ mode: 0, dependencyIndices: [-1] }],
      })
      expect(res.status).toBe(400)
    })

    it('returns 409 RESOURCE_MISSING when transactional create surfaces a cross-project ref', async () => {
      mockCreateCampaignWithAttacks.mockResolvedValueOnce({
        kind: 'resource_missing',
        missing: ['wordlist(42)'],
      })
      const res = await postCampaign({
        name: 'Cross-project',
        hashListId: 1,
        attacks: [{ mode: 0, wordlistId: 42 }],
      })
      expect(res.status).toBe(409)
      const body = (await res.json()) as { error?: { code?: string; message?: string } }
      expect(body.error?.code).toBe('RESOURCE_MISSING')
      expect(body.error?.message).toContain('wordlist(42)')
    })
  })

  describe('Attack-write-time cross-project resource validation', () => {
    it('POST /:id/attacks returns 409 RESOURCE_MISSING when validator rejects', async () => {
      mockValidateCampaignResources.mockResolvedValueOnce({
        valid: false,
        missing: ['wordlist(99)'],
      })
      const res = await app.request(`${DASH_CAMPAIGNS}/100/attacks`, {
        method: 'POST',
        headers: { ...makeHeaders(), 'content-type': 'application/json' },
        body: JSON.stringify({ mode: 0, wordlistId: 99 }),
      })
      expect(res.status).toBe(409)
      const body = (await res.json()) as { error?: { code?: string; message?: string } }
      expect(body.error?.code).toBe('RESOURCE_MISSING')
      expect(body.error?.message).toContain('wordlist(99)')
    })

    it('POST /:id/attacks skips validator when no resource refs are supplied', async () => {
      mockValidateCampaignResources.mockReset()
      const res = await app.request(`${DASH_CAMPAIGNS}/100/attacks`, {
        method: 'POST',
        headers: { ...makeHeaders(), 'content-type': 'application/json' },
        body: JSON.stringify({ mode: 0 }),
      })
      expect(res.status).toBe(201)
      expect(mockValidateCampaignResources).toHaveBeenCalledTimes(0)
    })

    it('PATCH /:id/attacks/:attackId returns 409 RESOURCE_MISSING when validator rejects a changed resource', async () => {
      mockGetAttackByIdImpl.mockResolvedValueOnce({ id: 5, campaignId: 100, dependencies: [] })
      mockValidateCampaignResources.mockResolvedValueOnce({
        valid: false,
        missing: ['rulelist(13)'],
      })
      const res = await app.request(`${DASH_CAMPAIGNS}/100/attacks/5`, {
        method: 'PATCH',
        headers: { ...makeHeaders(), 'content-type': 'application/json' },
        body: JSON.stringify({ rulelistId: 13 }),
      })
      expect(res.status).toBe(409)
      const body = (await res.json()) as { error?: { code?: string; message?: string } }
      expect(body.error?.code).toBe('RESOURCE_MISSING')
      expect(body.error?.message).toContain('rulelist(13)')
    })

    it('PATCH /:id/attacks/:attackId skips validator when no resource fields are changed', async () => {
      mockGetAttackByIdImpl.mockResolvedValueOnce({ id: 5, campaignId: 100, dependencies: [] })
      mockValidateCampaignResources.mockReset()
      const res = await app.request(`${DASH_CAMPAIGNS}/100/attacks/5`, {
        method: 'PATCH',
        headers: { ...makeHeaders(), 'content-type': 'application/json' },
        body: JSON.stringify({ mode: 3 }),
      })
      expect(res.status).toBe(200)
      expect(mockValidateCampaignResources).toHaveBeenCalledTimes(0)
    })

    it('POST /:id/attacks returns 503 SERVICE_UNAVAILABLE when validator throws (DB blip)', async () => {
      mockValidateCampaignResources.mockReset()
      mockValidateCampaignResources.mockRejectedValueOnce(new Error('ECONNRESET'))
      const res = await app.request(`${DASH_CAMPAIGNS}/100/attacks`, {
        method: 'POST',
        headers: { ...makeHeaders(), 'content-type': 'application/json' },
        body: JSON.stringify({ mode: 0, wordlistId: 99 }),
      })
      expect(res.status).toBe(503)
      const body = (await res.json()) as { error?: { code?: string; message?: string } }
      expect(body.error?.code).toBe('SERVICE_UNAVAILABLE')
    })

    it('PATCH /:id/attacks/:attackId returns 503 SERVICE_UNAVAILABLE when validator throws', async () => {
      mockGetAttackByIdImpl.mockResolvedValueOnce({ id: 5, campaignId: 100, dependencies: [] })
      mockValidateCampaignResources.mockReset()
      mockValidateCampaignResources.mockRejectedValueOnce(new Error('ECONNRESET'))
      const res = await app.request(`${DASH_CAMPAIGNS}/100/attacks/5`, {
        method: 'PATCH',
        headers: { ...makeHeaders(), 'content-type': 'application/json' },
        body: JSON.stringify({ rulelistId: 13 }),
      })
      expect(res.status).toBe(503)
      const body = (await res.json()) as { error?: { code?: string } }
      expect(body.error?.code).toBe('SERVICE_UNAVAILABLE')
    })
  })

  describe('Attack-write-time project-scope guards', () => {
    it('POST /:id/attacks returns 404 RESOURCE_NOT_FOUND on cross-project campaign', async () => {
      const res = await app.request(`${DASH_CAMPAIGNS}/200/attacks`, {
        method: 'POST',
        headers: { ...makeHeaders(), 'content-type': 'application/json' },
        body: JSON.stringify({ mode: 0 }),
      })
      expect(res.status).toBe(404)
      const body = (await res.json()) as { error?: { code?: string } }
      expect(body.error?.code).toBe('RESOURCE_NOT_FOUND')
    })

    it('POST /:id/attacks returns 404 on unknown campaign id', async () => {
      const res = await app.request(`${DASH_CAMPAIGNS}/9999/attacks`, {
        method: 'POST',
        headers: { ...makeHeaders(), 'content-type': 'application/json' },
        body: JSON.stringify({ mode: 0 }),
      })
      expect(res.status).toBe(404)
    })

    it('POST /:id/attacks returns 400 on non-integer campaign id', async () => {
      const res = await app.request(`${DASH_CAMPAIGNS}/abc/attacks`, {
        method: 'POST',
        headers: { ...makeHeaders(), 'content-type': 'application/json' },
        body: JSON.stringify({ mode: 0 }),
      })
      expect(res.status).toBe(400)
      const body = (await res.json()) as { error?: { code?: string } }
      expect(body.error?.code).toBe('VALIDATION_ERROR')
    })

    it('PATCH /:id/attacks/:attackId returns 404 on cross-project campaign even without resource ref changes', async () => {
      // Important: project guard fires BEFORE the resource-ref check, so
      // a mode-only PATCH on a cross-project campaign must still 404.
      const res = await app.request(`${DASH_CAMPAIGNS}/200/attacks/5`, {
        method: 'PATCH',
        headers: { ...makeHeaders(), 'content-type': 'application/json' },
        body: JSON.stringify({ mode: 3 }),
      })
      expect(res.status).toBe(404)
      const body = (await res.json()) as { error?: { code?: string } }
      expect(body.error?.code).toBe('RESOURCE_NOT_FOUND')
    })

    it('PATCH /:id/attacks/:attackId returns 404 on unknown campaign id', async () => {
      const res = await app.request(`${DASH_CAMPAIGNS}/9999/attacks/5`, {
        method: 'PATCH',
        headers: { ...makeHeaders(), 'content-type': 'application/json' },
        body: JSON.stringify({ mode: 3 }),
      })
      expect(res.status).toBe(404)
    })
  })

  describe('POST /campaigns: transactional create error handling', () => {
    it('returns 503 SERVICE_UNAVAILABLE when createCampaignWithAttacks throws', async () => {
      mockCreateCampaignWithAttacks.mockRejectedValueOnce(new Error('ECONNRESET during txn'))
      const res = await app.request(DASH_CAMPAIGNS, {
        method: 'POST',
        headers: { ...makeHeaders(), 'content-type': 'application/json' },
        body: JSON.stringify({
          name: 'DB blip',
          hashListId: 1,
          attacks: [{ mode: 0, wordlistId: 99 }],
        }),
      })
      expect(res.status).toBe(503)
      const body = (await res.json()) as { error?: { code?: string } }
      expect(body.error?.code).toBe('SERVICE_UNAVAILABLE')
    })
  })

  describe('Attack write-time DAG validation', () => {
    function postAttack(campaignId: number, body: Record<string, unknown>) {
      return app.request(`${DASH_CAMPAIGNS}/${campaignId}/attacks`, {
        method: 'POST',
        headers: { ...makeHeaders(), 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
    }
    function patchAttack(campaignId: number, attackId: number, body: Record<string, unknown>) {
      return app.request(`${DASH_CAMPAIGNS}/${campaignId}/attacks/${attackId}`, {
        method: 'PATCH',
        headers: { ...makeHeaders(), 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
    }

    it('POST: valid dependency on existing attack returns 201', async () => {
      mockListAttacks.mockResolvedValueOnce([{ id: 1, dependencies: null }])
      const res = await postAttack(100, { mode: 0, dependencies: [1] })
      expect(res.status).toBe(201)
    })

    it('POST: dependency on non-existent attack id returns 400 DAG_INVALID', async () => {
      mockListAttacks.mockResolvedValueOnce([{ id: 1, dependencies: null }])
      const res = await postAttack(100, { mode: 0, dependencies: [99] })
      expect(res.status).toBe(400)
      const body = (await res.json()) as { error?: { code?: string; message?: string } }
      expect(body.error?.code).toBe('DAG_INVALID')
      expect(body.error?.message).toContain('non-existent')
    })

    it('POST: new attack creating a cycle returns 400 DAG_INVALID', async () => {
      // Existing attack #1 depends on the synthetic new attack id (-1).
      // Adding a new attack that depends on #1 closes the cycle.
      mockListAttacks.mockResolvedValueOnce([{ id: 1, dependencies: [-1] }])
      const res = await postAttack(100, { mode: 0, dependencies: [1] })
      expect(res.status).toBe(400)
      const body = (await res.json()) as { error?: { code?: string; message?: string } }
      expect(body.error?.code).toBe('DAG_INVALID')
      expect(body.error?.message).toContain('Circular')
    })

    it('POST: with no dependencies skips the DAG pre-check listAttacks read', async () => {
      mockListAttacks.mockClear()
      const res = await postAttack(100, { mode: 0 })
      expect(res.status).toBe(201)
      // Optimization: a dependency-less attack can't introduce a cycle,
      // so we don't load the campaign's attack list on this hot path.
      expect(mockListAttacks).toHaveBeenCalledTimes(0)
    })

    it('PATCH: self-loop on dependencies returns 400 DAG_INVALID', async () => {
      mockGetAttackByIdImpl.mockResolvedValueOnce({ id: 5, campaignId: 100, dependencies: [] })
      mockListAttacks.mockResolvedValueOnce([{ id: 5, dependencies: [] }])
      const res = await patchAttack(100, 5, { dependencies: [5] })
      expect(res.status).toBe(400)
      const body = (await res.json()) as { error?: { code?: string } }
      expect(body.error?.code).toBe('DAG_INVALID')
    })

    it('PATCH: adding a dep that closes a 3-cycle returns 400 DAG_INVALID', async () => {
      // Current: 1 -> 2 -> 3 (deps mean "I depend on"); editing 1 to depend on 3 closes the loop.
      mockGetAttackByIdImpl.mockResolvedValueOnce({ id: 1, campaignId: 100, dependencies: [] })
      mockListAttacks.mockResolvedValueOnce([
        { id: 1, dependencies: [] },
        { id: 2, dependencies: [1] },
        { id: 3, dependencies: [2] },
      ])
      const res = await patchAttack(100, 1, { dependencies: [3] })
      expect(res.status).toBe(400)
      const body = (await res.json()) as { error?: { code?: string } }
      expect(body.error?.code).toBe('DAG_INVALID')
    })

    it('PATCH: changing non-dep fields skips DAG validation (no listAttacks call)', async () => {
      mockGetAttackByIdImpl.mockResolvedValueOnce({ id: 5, campaignId: 100, dependencies: [] })
      mockListAttacks.mockClear()
      const res = await patchAttack(100, 5, { mode: 3 })
      expect(res.status).toBe(200)
      expect(mockListAttacks).toHaveBeenCalledTimes(0)
    })

    it('PATCH: dependency change to a valid graph returns 200', async () => {
      mockGetAttackByIdImpl.mockResolvedValueOnce({ id: 2, campaignId: 100, dependencies: [] })
      mockListAttacks.mockResolvedValueOnce([
        { id: 1, dependencies: [] },
        { id: 2, dependencies: [] },
      ])
      const res = await patchAttack(100, 2, { dependencies: [1] })
      expect(res.status).toBe(200)
    })
  })

  describe('Dashboard campaign lifecycle aliases: /start /pause /resume /stop /cancel', () => {
    function lifecyclePost(id: number, action: 'start' | 'pause' | 'resume' | 'stop' | 'cancel') {
      return app.request(`${DASH_CAMPAIGNS}/${id}/${action}`, {
        method: 'POST',
        headers: makeHeaders(),
      })
    }

    const aliasTransitionTarget = {
      start: 'running',
      pause: 'paused',
      resume: 'running',
      stop: 'draft',
      cancel: 'cancelled',
    } as const

    for (const action of ['start', 'pause', 'resume', 'stop', 'cancel'] as const) {
      it(`POST /:id/${action} delegates to transitionCampaign with the right target status`, async () => {
        mockTransitionCampaign.mockReset()
        mockTransitionCampaign.mockResolvedValueOnce({
          campaign: { id: 100, status: aliasTransitionTarget[action] },
        })

        const res = await lifecyclePost(100, action)
        expect(res.status).toBe(200)
        expect(mockTransitionCampaign).toHaveBeenCalledTimes(1)
        const args = mockTransitionCampaign.mock.calls[0]
        expect(args?.[0]).toBe(100)
        expect(args?.[1]).toBe(aliasTransitionTarget[action])
      })

      it(`POST /:id/${action} maps INVALID_TRANSITION → 400`, async () => {
        mockTransitionCampaign.mockResolvedValueOnce({
          error: `Cannot transition from 'wrong' to '${aliasTransitionTarget[action]}'`,
        })
        const res = await lifecyclePost(100, action)
        expect(res.status).toBe(400)
        const body = (await res.json()) as { error?: { code?: string } }
        expect(body.error?.code).toBe('INVALID_TRANSITION')
      })

      it(`POST /:id/${action} maps QUEUE_UNAVAILABLE → 503`, async () => {
        mockTransitionCampaign.mockResolvedValueOnce({
          error: 'Queue unavailable',
          code: 'QUEUE_UNAVAILABLE',
        })
        const res = await lifecyclePost(100, action)
        expect(res.status).toBe(503)
        const body = (await res.json()) as { error?: { code?: string } }
        expect(body.error?.code).toBe('SERVICE_UNAVAILABLE')
      })

      it(`POST /:id/${action} maps RESOURCE_MISSING → 409 Conflict`, async () => {
        mockTransitionCampaign.mockResolvedValueOnce({
          error: 'Referenced resources missing: hashList(42), wordlist(7)',
          code: 'RESOURCE_MISSING',
        })
        const res = await lifecyclePost(100, action)
        expect(res.status).toBe(409)
        const body = (await res.json()) as { error?: { code?: string; message?: string } }
        expect(body.error?.code).toBe('RESOURCE_MISSING')
        expect(body.error?.message).toContain('hashList(42)')
        expect(body.error?.message).toContain('wordlist(7)')
      })

      it(`POST /:id/${action} maps STALE_STATE → 409 Conflict`, async () => {
        mockTransitionCampaign.mockResolvedValueOnce({
          error:
            "Campaign status changed during transition (was 'running'); retry against the current state",
          code: 'STALE_STATE',
        })
        const res = await lifecyclePost(100, action)
        expect(res.status).toBe(409)
        const body = (await res.json()) as { error?: { code?: string } }
        expect(body.error?.code).toBe('STALE_STATE')
      })

      it(`POST /:id/${action} on cross-project campaign returns 404`, async () => {
        const res = await lifecyclePost(200, action)
        expect(res.status).toBe(404)
        const body = (await res.json()) as { error?: { code?: string } }
        expect(body.error?.code).toBe('RESOURCE_NOT_FOUND')
      })

      it(`POST /:id/${action} on unknown id returns 404`, async () => {
        const res = await lifecyclePost(9999, action)
        expect(res.status).toBe(404)
      })
    }
  })
} // end IS_ISOLATED
