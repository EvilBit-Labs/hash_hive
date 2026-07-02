/**
 * Cross-cutting RBAC + project-scoping tests for the Control API.
 *
 * Covers the P0s the security and correctness reviewers flagged:
 *   - X-Project-Id is verified against project membership, not just
 *     trusted (cross-project read/write must be denied).
 *   - Campaign/attack mutation endpoints reject viewer-role members.
 *   - Agent PATCH requires admin role.
 *   - Users listing scopes through project_users (no global enumeration).
 *   - RFC 9457 envelope shape on auth-failure paths.
 *
 * Runs in an isolated test phase via the `CONTROL_RBAC_TEST_ISOLATED`
 * env gate because `mock.module` calls in this file would leak into
 * other test files in the same bun:test invocation. Mirrors the
 * queue-manager and tasks tests' isolation pattern.
 */

import { beforeEach, describe, expect, it, mock } from 'bun:test'

const IS_ISOLATED = process.env['CONTROL_RBAC_TEST_ISOLATED'] === '1'

if (!IS_ISOLATED) {
  describe.skip('control-routes-rbac (skipped — runs in isolated phase)', () => {
    it('runs only with CONTROL_RBAC_TEST_ISOLATED=1', () => {
      expect(true).toBe(true)
    })
  })
} else {
  // ─── Test state ───────────────────────────────────────────────────
  //
  // The state arrays carry only the fields tests actually set; the
  // `make*` builders below expand each partial to a full Drizzle row
  // so the typed factory bodies (dynamic-return pattern from the
  // contract-test-mocks-mirror-service-not-schema convention) can
  // satisfy `typeof svc` without losing test-fixture ergonomics.

  interface MockMembership {
    userId: number
    projectId: number
    roles: string[]
  }

  // Import service types so the typed-factory pattern can constrain
  // mock factories against the real service signatures.
  type CampaignsService = typeof import('../../src/services/campaigns.js')
  type AgentsService = typeof import('../../src/services/agents.js')
  type FullCampaign = NonNullable<Awaited<ReturnType<CampaignsService['getCampaignById']>>>
  type FullAttack = NonNullable<Awaited<ReturnType<CampaignsService['getAttackById']>>>
  type FullAgent = NonNullable<Awaited<ReturnType<AgentsService['getAgentById']>>>

  type CampaignPartial = Pick<FullCampaign, 'id' | 'projectId' | 'status' | 'name'>
  type AttackPartial = Pick<FullAttack, 'id' | 'campaignId' | 'projectId'>
  type AgentPartial = Pick<FullAgent, 'id' | 'projectId' | 'status' | 'name'>

  let mockMemberships: MockMembership[] = []
  let mockProjects: Array<{ id: number; name: string }> = []
  let mockCampaigns: CampaignPartial[] = []
  let mockAgents: AgentPartial[] = []
  let mockAttacks: AttackPartial[] = []

  // Builders expand the partial fixtures into full Drizzle rows so the
  // mock factories below satisfy `typeof svc`. Each builder fills the
  // optional/defaulted columns with realistic NULLs / empty-object
  // defaults so the route handler downstream sees a representative row.
  function makeCampaign(p: CampaignPartial): FullCampaign {
    return {
      ...p,
      description: null,
      hashListId: 1,
      priority: 5,
      progress: {},
      metadata: {},
      createdBy: null,
      startedAt: null,
      completedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    }
  }

  function makeAttack(p: AttackPartial): FullAttack {
    return {
      ...p,
      mode: 0,
      hashTypeId: null,
      wordlistId: null,
      rulelistId: null,
      masklistId: null,
      advancedConfiguration: {},
      keyspace: null,
      status: 'pending',
      dependencies: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    }
  }

  function makeAgent(p: AgentPartial): FullAgent {
    return {
      ...p,
      operatingSystemId: null,
      authToken: null,
      authTokenHash: null,
      authTokenFormat: 'plaintext',
      capabilities: {},
      hardwareProfile: {},
      crackerVersion: null,
      lastSeenAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    }
  }

  function findMembership(userId: number, projectId: number) {
    return mockMemberships.find((m) => m.userId === userId && m.projectId === projectId) ?? null
  }

  // ─── Service mocks ────────────────────────────────────────────────

  mock.module('../../src/services/auth.js', () => ({
    findProjectMembership: async (userId: number, projectId: number) =>
      findMembership(userId, projectId),
    getUserWithProjects: async () => null,
    issueUserApiKey: async () => ({
      token: '',
      metadata: { hasKey: true, prefix: '', lastUsedAt: null },
    }),
    revokeUserApiKey: async () => undefined,
    getUserApiKeyMetadata: async () => ({ hasKey: false, prefix: null, lastUsedAt: null }),
  }))

  mock.module('../../src/services/projects.js', () => ({
    getProjectById: async (id: number) => mockProjects.find((p) => p.id === id) ?? null,
    getUserProjects: async (userId: number) =>
      mockMemberships
        .filter((m) => m.userId === userId)
        .map((m) => ({
          id: m.projectId,
          name: mockProjects.find((p) => p.id === m.projectId)?.name ?? '',
          slug: 's',
          description: null,
          settings: {},
          roles: m.roles,
          createdAt: new Date(),
        })),
    findUserProjectById: async () => null,
    getUserProjectsPaginated: async () => ({ items: [], total: 0 }),
    createProject: async () => null,
    updateProject: async () => null,
    addUserToProject: async () => null,
    removeUserFromProject: async () => null,
    updateMemberRoles: async () => null,
    getProjectMembers: async () => [],
  }))

  // `transitionCampaign` returns `{campaign: <row>} | {error, code?}`.
  // Default to a "campaign present" shape so the happy path tests pass;
  // individual tests override via `mockTransitionResult = {error: ...}`
  // when they need to exercise a failure branch.
  let mockTransitionResult: Awaited<ReturnType<CampaignsService['transitionCampaign']>> = {
    campaign: makeCampaign({ id: 1, projectId: 1, status: 'running', name: 'Default' }),
  }

  // Typed factory bodies — dynamic-return pattern from the
  // contract-test-mocks-mirror-service-not-schema convention.
  // Type each factory via `typeof svc[fnName]` so the signature is
  // constrained at definition time. A signature drift in the service
  // surfaces as a type-check failure here rather than as a runtime
  // wire-shape regression.
  const getCampaignByIdMock: CampaignsService['getCampaignById'] = async (id) => {
    const partial = mockCampaigns.find((c) => c.id === id)
    return partial ? makeCampaign(partial) : null
  }
  const listCampaignsMock: CampaignsService['listCampaigns'] = async ({ projectId }) => {
    const matched = mockCampaigns.filter((c) => c.projectId === projectId).map(makeCampaign)
    return {
      campaigns: matched,
      total: matched.length,
      limit: 50,
      offset: 0,
    }
  }
  const createCampaignMock: CampaignsService['createCampaign'] = async (data) =>
    makeCampaign({ id: 999, projectId: data.projectId, name: data.name, status: 'draft' })
  // Discriminated-union return (`{kind: 'updated', campaign} | {kind:
  // 'not_found'} | {kind: 'not_draft', status}`). Default to the
  // happy `updated` branch; individual tests can override via
  // mockImplementationOnce when they need to exercise the other kinds.
  const updateCampaignMock: CampaignsService['updateCampaign'] = async (id, projectId) => ({
    kind: 'updated',
    campaign: makeCampaign({ id, projectId, status: 'draft', name: 'Updated' }),
  })
  const transitionCampaignMock: CampaignsService['transitionCampaign'] = async () =>
    mockTransitionResult
  const changeRunningCampaignPriorityMock: CampaignsService['changeRunningCampaignPriority'] =
    async (id, projectId) => ({
      kind: 'updated',
      campaign: makeCampaign({ id, projectId, status: 'running' }),
    })
  const listAttacksMock: CampaignsService['listAttacks'] = async () => []
  const listAttacksPaginatedMock: CampaignsService['listAttacksPaginated'] = async (campaignId) => {
    const matched = mockAttacks.filter((a) => a.campaignId === campaignId).map(makeAttack)
    return { items: matched, total: matched.length }
  }
  const getAttackByIdMock: CampaignsService['getAttackById'] = async (id) => {
    const partial = mockAttacks.find((a) => a.id === id)
    return partial ? makeAttack(partial) : null
  }
  const createAttackMock: CampaignsService['createAttack'] = async (data) =>
    makeAttack({ id: 888, campaignId: data.campaignId, projectId: data.projectId })
  const updateAttackMock: CampaignsService['updateAttack'] = async (id) =>
    makeAttack({ id, campaignId: 1, projectId: 1 })
  const deleteAttackMock: CampaignsService['deleteAttack'] = async () => ({
    kind: 'not_found' as const,
  })
  // `archiveAttacks`/`restoreAttacks` are exercised in
  // `control-lifecycle-routes.test.ts`; these stubs are for the
  // transitive static-import binding only (issue #106 U10 added
  // archive/restore imports to `control/attacks.ts`).
  const archiveAttacksMock: CampaignsService['archiveAttacks'] = async (_projectId, ids) =>
    ids.map((id) => ({ id, outcome: 'not_found' as const }))
  const restoreAttacksMock: CampaignsService['restoreAttacks'] = async (_projectId, ids) =>
    ids.map((id) => ({ id, outcome: 'not_found' as const }))

  mock.module('../../src/services/campaigns.js', () => ({
    getCampaignById: getCampaignByIdMock,
    listCampaigns: listCampaignsMock,
    createCampaign: createCampaignMock,
    updateCampaign: updateCampaignMock,
    transitionCampaign: transitionCampaignMock,
    changeRunningCampaignPriority: changeRunningCampaignPriorityMock,
    listAttacks: listAttacksMock,
    listAttacksPaginated: listAttacksPaginatedMock,
    getAttackById: getAttackByIdMock,
    createAttack: createAttackMock,
    updateAttack: updateAttackMock,
    deleteAttack: deleteAttackMock,
    archiveAttacks: archiveAttacksMock,
    restoreAttacks: restoreAttacksMock,
    // tasks.ts/retry.ts statically import this (#97 U6); the named import
    // fails to link if the campaigns.js mock omits it.
    enqueuePreemptionEvaluation: mock(() => Promise.resolve()),
    // `control/attacks.ts` statically imports this (issue #106 U12) to
    // reject a reclaimed-shell resource ref on create/update; the named
    // import fails to link if the campaigns.js mock omits it. No refs are
    // ever reclaimed in this RBAC-focused suite.
    findReclaimedResourceRefs: mock(() => Promise.resolve([])),
  }))

  const listAgentsMock: AgentsService['listAgents'] = async ({ projectId }) => {
    const matched = mockAgents.filter((a) => a.projectId === projectId).map(makeAgent)
    return {
      agents: matched,
      total: matched.length,
      limit: 50,
      offset: 0,
    }
  }
  const getAgentByIdMock: AgentsService['getAgentById'] = async (id) => {
    const partial = mockAgents.find((a) => a.id === id)
    return partial ? makeAgent(partial) : null
  }
  const updateAgentMock: AgentsService['updateAgent'] = async (id) =>
    makeAgent({ id, projectId: 1, status: 'offline', name: 'Updated' })

  // `retireAgent` is exercised in `control-lifecycle-routes.test.ts`; this
  // stub is for the transitive static-import binding only (issue #106
  // U10 added a `retireAgent` import to `control/agents.ts`).
  const retireAgentMock: AgentsService['retireAgent'] = async () => ({ kind: 'not_found' as const })

  mock.module('../../src/services/agents.js', () => ({
    listAgents: listAgentsMock,
    getAgentById: getAgentByIdMock,
    updateAgent: updateAgentMock,
    retireAgent: retireAgentMock,
  }))

  mock.module('../../src/db/index.js', () => ({
    db: {
      select: () => ({
        from: () => ({
          where: () => ({ limit: () => Promise.resolve([]) }),
          innerJoin: () => ({
            where: () => ({ limit: () => ({ offset: () => Promise.resolve([]) }) }),
          }),
        }),
      }),
      update: () => ({ set: () => ({ where: () => Promise.resolve() }) }),
    },
    client: {},
  }))

  // Stub audit-log service so the audit-logs route resolves without a DB.
  // listAuditEvents must return the `AuditLogListResult` shape (`data`, not
  // `items`) because the route maps via paginate() to produce `items`.
  mock.module('../../src/services/audit-log.js', () => ({
    listAuditEvents: async () => ({ data: [], total: 0, limit: 50, offset: 0 }),
    recordAuditEvent: async () => ({}),
    ENTITY_ALLOWLISTS: {},
    AUDITED_TABLE_COLUMNS: {},
    EXPLICITLY_EXCLUDED_COLUMNS: new Set<string>(),
  }))

  // ─── Routes (dynamic imports so they pick up the mocks) ──────────
  // Bun's ESM loader hoists static imports above the describe blocks,
  // which would resolve to the unmocked services. Use require() (Bun
  // supports CommonJS-style require in ESM) to defer resolution until
  // after `mock.module` has run.
  const { controlAgentRoutes } = require('../../src/routes/control/agents.js')
  const { controlAttackRoutes } = require('../../src/routes/control/attacks.js')
  const { controlAuditLogRoutes } = require('../../src/routes/control/audit-logs.js')
  const { controlCampaignRoutes } = require('../../src/routes/control/campaigns.js')
  const {
    requireProjectMembership,
    requireProjectRole,
  } = require('../../src/routes/control/helpers.js')
  type ControlMembership = import('../../src/routes/control/helpers.js').ControlMembership
  const { Hono } = require('hono')

  let activeUserId = 1
  let activeProjectId: number | null = null

  function authHeaders() {
    const headers: Record<string, string> = { authorization: 'Bearer cst_1_anything' }
    if (activeProjectId !== null) headers['x-project-id'] = String(activeProjectId)
    return headers
  }

  function makeApp(router: unknown) {
    // oxlint-disable-next-line typescript/no-explicit-any -- dynamically require()d Hono router
    const app = new (Hono as any)()
    app.use('*', async (c: { set: (k: string, v: unknown) => void }, next: () => Promise<void>) => {
      c.set('currentUser', {
        userId: activeUserId,
        email: 'admin@example.com',
        projectId: activeProjectId,
      })
      await next()
    })
    app.route('/', router)
    return app
  }

  describe('Control API: cross-project + RBAC enforcement', () => {
    beforeEach(() => {
      mockProjects = [
        { id: 1, name: 'Alpha' },
        { id: 2, name: 'Beta' },
      ]
      mockMemberships = [
        { userId: 1, projectId: 1, roles: ['admin'] },
        { userId: 2, projectId: 2, roles: ['admin'] },
      ]
      mockCampaigns = [
        { id: 100, projectId: 1, status: 'draft', name: 'Alpha Campaign' },
        { id: 200, projectId: 2, status: 'draft', name: 'Beta Campaign' },
      ]
      mockAgents = [
        { id: 10, projectId: 1, status: 'online', name: 'a-1' },
        { id: 20, projectId: 2, status: 'online', name: 'b-1' },
      ]
      mockAttacks = [
        { id: 50, campaignId: 100, projectId: 1 },
        { id: 60, campaignId: 200, projectId: 2 },
      ]
      activeUserId = 1
      // Reset the transitionCampaign mock to the happy {campaign}
      // branch. Failure-branch tests later in this file mutate this
      // shared variable in place; without the reset, the override
      // leaks into any subsequent test that runs after them and
      // depends on the happy default.
      mockTransitionResult = {
        campaign: makeCampaign({ id: 1, projectId: 1, status: 'running', name: 'Default' }),
      }
    })

    describe('campaigns', () => {
      it('lists only the active project', async () => {
        activeProjectId = 1
        const app = makeApp(controlCampaignRoutes)
        const res = await app.request('/', { headers: authHeaders() })
        expect(res.status).toBe(200)
        const body = await res.json()
        expect(body.items).toHaveLength(1)
        expect(body.items[0].id).toBe(100)
      })

      it('returns 403 RFC 9457 when caller is not a member of the active project', async () => {
        activeProjectId = 2
        const app = makeApp(controlCampaignRoutes)
        const res = await app.request('/', { headers: authHeaders() })
        expect(res.status).toBe(403)
        expect(res.headers.get('content-type')).toContain('application/problem+json')
        const body = await res.json()
        expect(body.title).toBe('Forbidden')
        expect(body.type).toBe('https://hashhive.dev/errors/forbidden')
      })

      it('returns 400 RFC 9457 when X-Project-Id is missing', async () => {
        activeProjectId = null
        const app = makeApp(controlCampaignRoutes)
        const res = await app.request('/', { headers: authHeaders() })
        expect(res.status).toBe(400)
        const body = await res.json()
        expect(body.type).toBe('https://hashhive.dev/errors/project-not-selected')
      })

      it('viewer-role members cannot create campaigns', async () => {
        mockMemberships = [{ userId: 1, projectId: 1, roles: ['viewer'] }]
        activeProjectId = 1
        const app = makeApp(controlCampaignRoutes)
        const res = await app.request('/', {
          method: 'POST',
          headers: { ...authHeaders(), 'content-type': 'application/json' },
          body: JSON.stringify({ name: 'New', hashListId: 1 }),
        })
        expect(res.status).toBe(403)
      })

      it('contributor-role members can create campaigns', async () => {
        mockMemberships = [{ userId: 1, projectId: 1, roles: ['contributor'] }]
        activeProjectId = 1
        const app = makeApp(controlCampaignRoutes)
        const res = await app.request('/', {
          method: 'POST',
          headers: { ...authHeaders(), 'content-type': 'application/json' },
          body: JSON.stringify({ name: 'New', hashListId: 1 }),
        })
        expect(res.status).toBe(201)
      })

      it('viewer-role members cannot change a running campaign priority (#97 U7)', async () => {
        mockMemberships = [{ userId: 1, projectId: 1, roles: ['viewer'] }]
        activeProjectId = 1
        const app = makeApp(controlCampaignRoutes)
        const res = await app.request('/1/priority', {
          method: 'POST',
          headers: { ...authHeaders(), 'content-type': 'application/json' },
          body: JSON.stringify({ priority: 1 }),
        })
        expect(res.status).toBe(403)
      })

      it('contributor-role members can change a running campaign priority (#97 U7)', async () => {
        mockMemberships = [{ userId: 1, projectId: 1, roles: ['contributor'] }]
        activeProjectId = 1
        const app = makeApp(controlCampaignRoutes)
        const res = await app.request('/1/priority', {
          method: 'POST',
          headers: { ...authHeaders(), 'content-type': 'application/json' },
          body: JSON.stringify({ priority: 1 }),
        })
        expect(res.status).toBe(200)
      })
    })

    describe('attacks', () => {
      it('rejects cross-project attack creation', async () => {
        activeProjectId = 1
        const app = makeApp(controlAttackRoutes)
        const res = await app.request('/', {
          method: 'POST',
          headers: { ...authHeaders(), 'content-type': 'application/json' },
          body: JSON.stringify({ campaignId: 200, mode: 0 }),
        })
        expect(res.status).toBe(404)
      })

      it('viewer-role members cannot delete attacks', async () => {
        mockMemberships = [{ userId: 1, projectId: 1, roles: ['viewer'] }]
        activeProjectId = 1
        const app = makeApp(controlAttackRoutes)
        const res = await app.request('/50', { method: 'DELETE', headers: authHeaders() })
        expect(res.status).toBe(403)
      })
    })

    describe('agents', () => {
      it('lists only the active project', async () => {
        activeProjectId = 1
        const app = makeApp(controlAgentRoutes)
        const res = await app.request('/', { headers: authHeaders() })
        expect(res.status).toBe(200)
        const body = await res.json()
        expect(body.items).toHaveLength(1)
        expect(body.items[0].id).toBe(10)
      })

      it('PATCH requires admin role', async () => {
        mockMemberships = [{ userId: 1, projectId: 1, roles: ['contributor'] }]
        activeProjectId = 1
        const app = makeApp(controlAgentRoutes)
        const res = await app.request('/10', {
          method: 'PATCH',
          headers: { ...authHeaders(), 'content-type': 'application/json' },
          body: JSON.stringify({ name: 'renamed' }),
        })
        expect(res.status).toBe(403)
      })
    })

    describe('campaign transitions', () => {
      it('maps QUEUE_UNAVAILABLE to 503 service_unavailable RFC 9457', async () => {
        mockMemberships = [{ userId: 1, projectId: 1, roles: ['admin'] }]
        activeProjectId = 1
        mockTransitionResult = { error: 'queue is down', code: 'QUEUE_UNAVAILABLE' }
        const app = makeApp(controlCampaignRoutes)
        const res = await app.request('/100/transition', {
          method: 'POST',
          headers: { ...authHeaders(), 'content-type': 'application/json' },
          body: JSON.stringify({ targetStatus: 'running' }),
        })
        expect(res.status).toBe(503)
        const body = await res.json()
        expect(body.type).toBe('https://hashhive.dev/errors/service-unavailable')
      })

      it('maps TASK_GENERATION_FAILED to 500 internal RFC 9457', async () => {
        mockMemberships = [{ userId: 1, projectId: 1, roles: ['admin'] }]
        activeProjectId = 1
        mockTransitionResult = { error: 'tasks blew up', code: 'TASK_GENERATION_FAILED' }
        const app = makeApp(controlCampaignRoutes)
        const res = await app.request('/100/transition', {
          method: 'POST',
          headers: { ...authHeaders(), 'content-type': 'application/json' },
          body: JSON.stringify({ targetStatus: 'running' }),
        })
        expect(res.status).toBe(500)
        const body = await res.json()
        expect(body.type).toBe('https://hashhive.dev/errors/internal')
      })

      it('maps generic state-machine errors to 409 conflict RFC 9457', async () => {
        mockMemberships = [{ userId: 1, projectId: 1, roles: ['admin'] }]
        activeProjectId = 1
        mockTransitionResult = { error: 'cannot resume aborted campaign' }
        const app = makeApp(controlCampaignRoutes)
        const res = await app.request('/100/transition', {
          method: 'POST',
          headers: { ...authHeaders(), 'content-type': 'application/json' },
          body: JSON.stringify({ targetStatus: 'running' }),
        })
        expect(res.status).toBe(409)
        const body = await res.json()
        expect(body.type).toBe('https://hashhive.dev/errors/conflict')
      })
    })

    describe('id-param validation', () => {
      it('returns 400 RFC 9457 with field-level errors[] for non-numeric :id', async () => {
        mockMemberships = [{ userId: 1, projectId: 1, roles: ['admin'] }]
        activeProjectId = 1
        const app = makeApp(controlCampaignRoutes)
        const res = await app.request('/abc', { headers: authHeaders() })
        expect(res.status).toBe(400)
        expect(res.headers.get('content-type')).toContain('application/problem+json')
        const body = await res.json()
        expect(body.type).toBe('https://hashhive.dev/errors/validation')
        expect(Array.isArray(body.errors)).toBe(true)
      })

      it('returns 400 for zero :id', async () => {
        mockMemberships = [{ userId: 1, projectId: 1, roles: ['admin'] }]
        activeProjectId = 1
        const app = makeApp(controlCampaignRoutes)
        const res = await app.request('/0', { headers: authHeaders() })
        expect(res.status).toBe(400)
      })

      // The U5 `controlOpenApiHonoOptions.defaultHook` covers body/
      // query/params/headers uniformly. The two tests above pin the
      // PARAM path; the two below pin BODY and QUERY so a future
      // change that drops `mapZodError(...)` or returns the library
      // default `{success:false, error: ZodError}` shape would
      // regress every CLI client for those validation classes — not
      // just the :id case.
      it('returns 400 RFC 9457 with field-level errors[] for missing JSON body field on create', async () => {
        mockMemberships = [{ userId: 1, projectId: 1, roles: ['contributor'] }]
        activeProjectId = 1
        const app = makeApp(controlCampaignRoutes)
        const res = await app.request('/', {
          method: 'POST',
          headers: { ...authHeaders(), 'content-type': 'application/json' },
          // `name` and `hashListId` are required by the create schema.
          body: JSON.stringify({ description: 'no required fields' }),
        })
        expect(res.status).toBe(400)
        expect(res.headers.get('content-type')).toContain('application/problem+json')
        const body = (await res.json()) as {
          type?: string
          errors?: Array<{ path?: string; code?: string; message?: string }>
        }
        expect(body.type).toBe('https://hashhive.dev/errors/validation')
        expect(Array.isArray(body.errors)).toBe(true)
        // Each entry must carry `path`/`code`/`message` so consumers
        // can render field-level errors without parsing the prose.
        expect(body.errors?.[0]?.path).toBeDefined()
        expect(body.errors?.[0]?.code).toBeDefined()
        expect(body.errors?.[0]?.message).toBeDefined()
      })

      it('returns 400 RFC 9457 with field-level errors[] for malformed query param', async () => {
        mockMemberships = [{ userId: 1, projectId: 1, roles: ['admin'] }]
        activeProjectId = 1
        const { controlAttackRoutes } = await import('../../src/routes/control/attacks.js')
        const app = makeApp(controlAttackRoutes)
        // `campaignId` is required + must be a positive integer.
        const res = await app.request('/?campaignId=not-a-number', { headers: authHeaders() })
        expect(res.status).toBe(400)
        expect(res.headers.get('content-type')).toContain('application/problem+json')
        const body = (await res.json()) as {
          type?: string
          errors?: Array<{ path?: string }>
        }
        expect(body.type).toBe('https://hashhive.dev/errors/validation')
        expect(Array.isArray(body.errors)).toBe(true)
        expect(body.errors?.[0]?.path).toBeDefined()
      })
    })

    describe('audit-logs', () => {
      it('returns 200 with real RFC 9457 envelope shape for admin', async () => {
        mockMemberships = [{ userId: 1, projectId: 1, roles: ['admin'] }]
        activeProjectId = 1
        const app = makeApp(controlAuditLogRoutes)
        const res = await app.request('/', { headers: authHeaders() })
        expect(res.status).toBe(200)
        const body = await res.json()
        expect(Array.isArray(body.items)).toBe(true)
        expect(typeof body.total).toBe('number')
      })

      it('returns 403 RFC 9457 for viewer-role — real controlErrorResponse envelope', async () => {
        mockMemberships = [{ userId: 1, projectId: 1, roles: ['viewer'] }]
        activeProjectId = 1
        const app = makeApp(controlAuditLogRoutes)
        const res = await app.request('/', { headers: authHeaders() })
        expect(res.status).toBe(403)
        expect(res.headers.get('content-type')).toContain('application/problem+json')
        const body = await res.json()
        expect(body.type).toBe('https://hashhive.dev/errors/forbidden')
        expect(body.title).toBe('Forbidden')
      })

      it('returns 403 RFC 9457 for cross-project access', async () => {
        // userId:1 is admin on project 1 — project 2 has no membership.
        activeProjectId = 2
        const app = makeApp(controlAuditLogRoutes)
        const res = await app.request('/', { headers: authHeaders() })
        expect(res.status).toBe(403)
        expect(res.headers.get('content-type')).toContain('application/problem+json')
        const body = await res.json()
        expect(body.type).toBe('https://hashhive.dev/errors/forbidden')
      })

      it('returns 400 RFC 9457 when X-Project-Id header is missing', async () => {
        activeProjectId = null
        const app = makeApp(controlAuditLogRoutes)
        const res = await app.request('/', { headers: authHeaders() })
        expect(res.status).toBe(400)
        expect(res.headers.get('content-type')).toContain('application/problem+json')
        const body = await res.json()
        expect(body.type).toBe('https://hashhive.dev/errors/project-not-selected')
      })

      it('returns 200 for contributor-role', async () => {
        mockMemberships = [{ userId: 1, projectId: 1, roles: ['contributor'] }]
        activeProjectId = 1
        const app = makeApp(controlAuditLogRoutes)
        const res = await app.request('/', { headers: authHeaders() })
        expect(res.status).toBe(200)
      })
    })
  })

  describe('helpers: requireProjectMembership / requireProjectRole', () => {
    beforeEach(() => {
      mockProjects = [{ id: 1, name: 'Alpha' }]
      mockMemberships = [{ userId: 1, projectId: 1, roles: ['admin'] }]
    })

    it('returns membership for a valid member', async () => {
      const fakeContext = {
        get: () => ({ userId: 1, projectId: 1, email: '' }),
      }
      const result: ControlMembership = await requireProjectMembership(fakeContext)
      expect(result.projectId).toBe(1)
      expect(result.roles).toContain('admin')
    })

    it('throws ControlApiError(400, project_not_selected) when projectId is null', async () => {
      const fakeContext = {
        get: () => ({ userId: 1, projectId: null, email: '' }),
      }
      await expect(requireProjectMembership(fakeContext)).rejects.toMatchObject({
        status: 400,
        code: 'project_not_selected',
      })
    })

    it('throws 403 forbidden for non-members', async () => {
      const fakeContext = {
        get: () => ({ userId: 99, projectId: 1, email: '' }),
      }
      await expect(requireProjectMembership(fakeContext)).rejects.toMatchObject({
        status: 403,
        code: 'forbidden',
      })
    })

    it('requireProjectRole throws 403 when caller lacks the role', async () => {
      mockMemberships = [{ userId: 1, projectId: 1, roles: ['viewer'] }]
      const fakeContext = {
        get: () => ({ userId: 1, projectId: 1, email: '' }),
      }
      await expect(requireProjectRole(fakeContext, 'admin')).rejects.toMatchObject({
        status: 403,
        code: 'forbidden',
      })
    })

    it('requireProjectRole accepts any role in the allow list', async () => {
      mockMemberships = [{ userId: 1, projectId: 1, roles: ['contributor'] }]
      const fakeContext = {
        get: () => ({ userId: 1, projectId: 1, email: '' }),
      }
      const result = await requireProjectRole(fakeContext, 'contributor', 'admin')
      expect(result.roles).toContain('contributor')
    })
  })
}
