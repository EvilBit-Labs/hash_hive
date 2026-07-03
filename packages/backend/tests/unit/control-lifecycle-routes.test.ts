/**
 * Control API archive/restore/retire route tests (issue #106 U10).
 *
 * Covers the single-resource Control-surface parity endpoints added
 * over the already-landed dashboard lifecycle services:
 *   - POST /hashlists/{id}/archive, /restore        (resources-archive.ts)
 *   - POST /resources/{kind}/{id}/archive, /restore  (resources-archive.ts)
 *   - POST /attacks/{id}/archive, /restore           (campaigns-attacks-archive.ts)
 *   - POST /agents/{id}/retire                       (agents-retire.ts)
 *
 * Per endpoint: happy path (200 + correct service call with a
 * single-element ids array), unknown id (404 problem+json), missing/
 * invalid `cst_` key (401 problem+json via the real `requireApiKey`
 * middleware), insufficient role (403), and a state-conflict outcome
 * (409 problem+json — see the outcome→status mapping doc comment in
 * `routes/control/attacks.ts`'s archive route).
 *
 * Runs in an isolated test phase via `CONTROL_LIFECYCLE_TEST_ISOLATED`
 * because this file mocks `services/resources.js`,
 * `services/resources-archive.js`, `services/campaigns.js`, and
 * `services/agents.js` wholesale — mirrors the isolation pattern in
 * `control-routes-rbac.test.ts` / `dashboard-resources-archive-routes.test.ts`.
 */
import { beforeEach, describe, expect, it, mock } from 'bun:test'

const IS_ISOLATED = process.env['CONTROL_LIFECYCLE_TEST_ISOLATED'] === '1'

if (!IS_ISOLATED) {
  describe.skip('control-lifecycle-routes (skipped - runs in isolated phase)', () => {
    it('runs only with CONTROL_LIFECYCLE_TEST_ISOLATED=1', () => {
      expect(true).toBe(true)
    })
  })
} else {
  // ─── Controllable membership state (drives requireProjectMembership /
  // requireProjectRole via the REAL helpers.js, exercising genuine RBAC) ──

  let activeMemberships: Array<{ userId: number; projectId: number; roles: string[] }> = []

  mock.module('../../src/services/auth.js', () => ({
    findProjectMembership: async (userId: number, projectId: number) =>
      activeMemberships.find((m) => m.userId === userId && m.projectId === projectId) ?? null,
    getUserWithProjects: async () => null,
    getUserLastProjectId: async () => null,
  }))

  // `middleware/api-key.js` imports `coerceRoles` from `middleware/auth.js`,
  // which imports the real `betterAuth(...)` instance from `lib/auth.js` —
  // standing that up needs a live DB adapter and env config neither of
  // which this unit test provides. Stub `lib/auth.js` so the transitive
  // import resolves without invoking real BetterAuth initialization
  // (mirrors `dashboard-resources-archive-routes.test.ts`).
  mock.module('../../src/lib/auth.js', () => ({
    auth: {
      api: { getSession: async () => null },
      handler: async () => new Response('ok'),
    },
  }))

  // ─── services/resources-archive.js — controllable per-test outcomes ──

  type Outcome = { id: number; outcome: string }

  const mockArchiveHashLists = mock(async (_projectId: number, ids: number[], _actor?: unknown) =>
    ids.map((id): Outcome => ({ id, outcome: 'archived' }))
  )
  const mockRestoreHashLists = mock(async (_projectId: number, ids: number[], _actor?: unknown) =>
    ids.map((id): Outcome => ({ id, outcome: 'restored' }))
  )
  const mockArchiveResources = mock(
    async (_table: unknown, _projectId: number, ids: number[], _actor?: unknown) =>
      ids.map((id): Outcome => ({ id, outcome: 'archived' }))
  )
  const mockRestoreResources = mock(
    async (_table: unknown, _projectId: number, ids: number[], _actor?: unknown) =>
      ids.map((id): Outcome => ({ id, outcome: 'restored' }))
  )

  mock.module('../../src/services/resources-archive.js', () => ({
    archiveHashLists: mockArchiveHashLists,
    restoreHashLists: mockRestoreHashLists,
    archiveResources: mockArchiveResources,
    restoreResources: mockRestoreResources,
    // `queue/workers/blob-reclamation.js` (issue #106 U11) imports
    // `attackFkColumnForTable` at module scope; if it (or anything else
    // pulling in `queue/manager.js`) loads in this process, the named
    // import fails to link if this mock omits it.
    attackFkColumnForTable: mock(() => ({}) as never),
  }))

  // ─── services/resources.js — inert stubs for the rest of the surface
  // that control/hashlists.ts and control/resources.ts import at module
  // scope (mock.module fully replaces the module; every named import
  // used elsewhere in those files must be present here or the import
  // fails to link).

  mock.module('../../src/services/resources.js', () => ({
    getHashListById: mock(async () => null),
    getHashListStats: mock(async () => ({ totalCount: 0, crackedCount: 0, crackRate: 0 })),
    listHashListsPaginated: mock(async () => ({ items: [], total: 0 })),
    setHashListType: mock(async () => null),
    isForeignKeyViolation: () => false,
    getResourceById: mock(async () => null),
    listHashTypes: mock(async () => []),
    listResourcesPaginated: mock(async () => ({ items: [], total: 0 })),
  }))

  // ─── services/campaigns.js — controllable archiveAttacks/restoreAttacks,
  // inert stubs for the rest of control/attacks.ts's module-scope imports.

  const mockArchiveAttacks = mock(async (_projectId: number, ids: number[], _actor?: unknown) =>
    ids.map((id): Outcome => ({ id, outcome: 'archived' }))
  )
  const mockRestoreAttacks = mock(async (_projectId: number, ids: number[], _actor?: unknown) =>
    ids.map((id): Outcome => ({ id, outcome: 'restored' }))
  )

  mock.module('../../src/services/campaigns.js', () => ({
    archiveAttacks: mockArchiveAttacks,
    restoreAttacks: mockRestoreAttacks,
    createAttack: mock(async () => null),
    deleteAttack: mock(async () => ({ kind: 'not_found' as const })),
    getAttackById: mock(async () => null),
    getCampaignById: mock(async () => null),
    listAttacksPaginated: mock(async () => ({ items: [], total: 0 })),
    updateAttack: mock(async () => null),
    // control/attacks.ts statically imports this (issue #106 U12); the named
    // import fails to link if the campaigns.js mock omits it. No refs are
    // ever reclaimed or archived in this lifecycle-focused suite.
    findReclaimedResourceRefs: mock(async () => ({ reclaimed: [], archived: [] })),
  }))

  // ─── services/agents.js — controllable retireAgent, inert stubs for
  // the rest of control/agents.ts's module-scope imports.

  type RetireResult =
    | { kind: 'retired'; agentId: number; releasedTaskIds: number[] }
    | { kind: 'already_retired' }
    | { kind: 'not_found' }

  const mockRetireAgent = mock(
    async (agentId: number, _projectId: number, _actor?: unknown): Promise<RetireResult> => ({
      kind: 'retired',
      agentId,
      releasedTaskIds: [],
    })
  )

  mock.module('../../src/services/agents.js', () => ({
    listAgents: mock(async () => ({ agents: [], total: 0, limit: 50, offset: 0 })),
    getAgentById: mock(async () => null),
    updateAgent: mock(async () => ({ kind: 'not_found' as const })),
    retireAgent: mockRetireAgent,
  }))

  // ─── db/index.js — never reached by the mocked services above, but
  // statically imported by `services/attacks/runtime.js` (deriveAttackRuntimes,
  // pulled in transitively by control/attacks.ts) and by the real
  // `requireApiKey` middleware used in the 401 tests below.

  interface MockUserRow {
    id: number
    email: string
    status: string
    apiKeyHash: string | null
    roles: string[]
  }
  let mockApiKeyUserRow: MockUserRow | null = null

  mock.module('../../src/db/index.js', () => ({
    db: {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: () => Promise.resolve(mockApiKeyUserRow ? [mockApiKeyUserRow] : []),
          }),
        }),
      }),
      update: () => ({ set: () => ({ where: () => Promise.resolve() }) }),
    },
    client: {},
  }))

  // ─── Routes (dynamic require so they pick up the mocks above) ──────

  // `middleware/api-key.js` has a top-level `await` (a pre-computed bcrypt
  // timing sentinel), which makes it an async ES module — `require()`
  // doesn't support that, so every dynamically-loaded module here uses
  // `await import()` for consistency.
  const { controlHashListRoutes } = await import('../../src/routes/control/hashlists.js')
  const { controlResourceRoutes } = await import('../../src/routes/control/resources.js')
  const { controlAttackRoutes } = await import('../../src/routes/control/attacks.js')
  const { controlAgentRoutes } = await import('../../src/routes/control/agents.js')
  const { requireApiKey } = await import('../../src/middleware/api-key.js')
  const { Hono } = await import('hono')

  let activeUserId = 1
  let activeProjectId: number | null = 1

  function authHeaders(extra: Record<string, string> = {}) {
    const headers: Record<string, string> = { authorization: 'Bearer cst_1_anything', ...extra }
    if (activeProjectId !== null) headers['x-project-id'] = String(activeProjectId)
    return headers
  }

  // Mounts a router with a stub middleware that sets `currentUser`
  // directly (bypasses `requireApiKey` so RBAC tests don't need real
  // bcrypt-verified tokens) — mirrors `control-routes-rbac.test.ts`.
  // oxlint-disable-next-line typescript/no-explicit-any -- dynamically import()d Hono router
  function makeApp(router: any) {
    // oxlint-disable-next-line typescript/no-explicit-any -- dynamically import()d Hono
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

  // Mounts a router behind the REAL `requireApiKey` middleware, for the
  // 401 (missing/invalid `cst_` key) tests only.
  // oxlint-disable-next-line typescript/no-explicit-any -- dynamically import()d Hono router
  function makeAuthedApp(router: any) {
    // oxlint-disable-next-line typescript/no-explicit-any -- dynamically import()d Hono
    const app = new (Hono as any)()
    app.use('*', requireApiKey)
    app.route('/', router)
    return app
  }

  beforeEach(() => {
    activeMemberships = [
      { userId: 1, projectId: 1, roles: ['admin'] },
      { userId: 2, projectId: 1, roles: ['viewer'] },
    ]
    activeUserId = 1
    activeProjectId = 1
    mockApiKeyUserRow = null
    mockArchiveHashLists.mockClear()
    mockRestoreHashLists.mockClear()
    mockArchiveResources.mockClear()
    mockRestoreResources.mockClear()
    mockArchiveAttacks.mockClear()
    mockRestoreAttacks.mockClear()
    mockRetireAgent.mockClear()
  })

  // ─── Hash lists ───────────────────────────────────────────────────

  describe('POST /hashlists/{id}/archive + /restore', () => {
    it('archives a hash list and calls the service with a single-element ids array', async () => {
      const app = makeApp(controlHashListRoutes)
      const res = await app.request('/10/archive', { method: 'POST', headers: authHeaders() })
      expect(res.status).toBe(200)
      const body = (await res.json()) as Outcome
      expect(body).toEqual({ id: 10, outcome: 'archived' })
      expect(mockArchiveHashLists).toHaveBeenCalledWith(1, [10], {
        actorType: 'user',
        actorId: 1,
      })
    })

    it('restores a hash list', async () => {
      const app = makeApp(controlHashListRoutes)
      const res = await app.request('/10/restore', { method: 'POST', headers: authHeaders() })
      expect(res.status).toBe(200)
      const body = (await res.json()) as Outcome
      expect(body).toEqual({ id: 10, outcome: 'restored' })
      expect(mockRestoreHashLists).toHaveBeenCalledWith(1, [10], {
        actorType: 'user',
        actorId: 1,
      })
    })

    it('returns 404 problem+json for an unknown id', async () => {
      mockArchiveHashLists.mockImplementationOnce(async (_p, ids) =>
        ids.map((id): Outcome => ({ id, outcome: 'not_found' }))
      )
      const app = makeApp(controlHashListRoutes)
      const res = await app.request('/999/archive', { method: 'POST', headers: authHeaders() })
      expect(res.status).toBe(404)
      expect(res.headers.get('content-type')).toContain('application/problem+json')
      const body = await res.json()
      expect(body.type).toBe('https://hashhive.dev/errors/not-found')
    })

    it('returns 409 conflict problem+json when the hash list is still in use', async () => {
      mockArchiveHashLists.mockImplementationOnce(async (_p, ids) =>
        ids.map((id): Outcome => ({ id, outcome: 'in_use' }))
      )
      const app = makeApp(controlHashListRoutes)
      const res = await app.request('/10/archive', { method: 'POST', headers: authHeaders() })
      expect(res.status).toBe(409)
      const body = await res.json()
      expect(body.type).toBe('https://hashhive.dev/errors/conflict')
    })

    it('returns 403 when a viewer attempts to archive', async () => {
      activeUserId = 2
      const app = makeApp(controlHashListRoutes)
      const res = await app.request('/10/archive', { method: 'POST', headers: authHeaders() })
      expect(res.status).toBe(403)
    })
  })

  // ─── Resources (wordlists/rulelists/masklists) ───────────────────

  describe('POST /resources/{kind}/{id}/archive + /restore', () => {
    it('archives a wordlist and calls the service with a single-element ids array', async () => {
      const app = makeApp(controlResourceRoutes)
      const res = await app.request('/wordlists/20/archive', {
        method: 'POST',
        headers: authHeaders(),
      })
      expect(res.status).toBe(200)
      const body = (await res.json()) as Outcome
      expect(body).toEqual({ id: 20, outcome: 'archived' })
      expect(mockArchiveResources).toHaveBeenCalledTimes(1)
      const call = mockArchiveResources.mock.calls[0]
      expect(call?.[1]).toBe(1) // projectId
      expect(call?.[2]).toEqual([20]) // ids
    })

    it('restores a rulelist entry', async () => {
      const app = makeApp(controlResourceRoutes)
      const res = await app.request('/rulelists/30/restore', {
        method: 'POST',
        headers: authHeaders(),
      })
      expect(res.status).toBe(200)
      const body = (await res.json()) as Outcome
      expect(body).toEqual({ id: 30, outcome: 'restored' })
    })

    it('returns 404 problem+json for an unknown masklist id', async () => {
      mockArchiveResources.mockImplementationOnce(async (_t, _p, ids) =>
        ids.map((id): Outcome => ({ id, outcome: 'not_found' }))
      )
      const app = makeApp(controlResourceRoutes)
      const res = await app.request('/masklists/999/archive', {
        method: 'POST',
        headers: authHeaders(),
      })
      expect(res.status).toBe(404)
      const body = await res.json()
      expect(body.type).toBe('https://hashhive.dev/errors/not-found')
    })

    it('returns 409 conflict problem+json when already archived', async () => {
      mockArchiveResources.mockImplementationOnce(async (_t, _p, ids) =>
        ids.map((id): Outcome => ({ id, outcome: 'already_archived' }))
      )
      const app = makeApp(controlResourceRoutes)
      const res = await app.request('/wordlists/20/archive', {
        method: 'POST',
        headers: authHeaders(),
      })
      expect(res.status).toBe(409)
      const body = await res.json()
      expect(body.type).toBe('https://hashhive.dev/errors/conflict')
    })

    it('returns 403 when a viewer attempts to restore', async () => {
      activeUserId = 2
      const app = makeApp(controlResourceRoutes)
      const res = await app.request('/wordlists/20/restore', {
        method: 'POST',
        headers: authHeaders(),
      })
      expect(res.status).toBe(403)
    })
  })

  // ─── Attacks ──────────────────────────────────────────────────────

  describe('POST /attacks/{id}/archive + /restore', () => {
    it('archives an attack and calls the service with a single-element ids array', async () => {
      const app = makeApp(controlAttackRoutes)
      const res = await app.request('/50/archive', { method: 'POST', headers: authHeaders() })
      expect(res.status).toBe(200)
      const body = (await res.json()) as Outcome
      expect(body).toEqual({ id: 50, outcome: 'archived' })
      expect(mockArchiveAttacks).toHaveBeenCalledWith(1, [50], {
        actorType: 'user',
        actorId: 1,
      })
    })

    it('restores an attack', async () => {
      const app = makeApp(controlAttackRoutes)
      const res = await app.request('/50/restore', { method: 'POST', headers: authHeaders() })
      expect(res.status).toBe(200)
      const body = (await res.json()) as Outcome
      expect(body).toEqual({ id: 50, outcome: 'restored' })
    })

    it('returns 404 problem+json for an unknown attack id', async () => {
      mockArchiveAttacks.mockImplementationOnce(async (_p, ids) =>
        ids.map((id): Outcome => ({ id, outcome: 'not_found' }))
      )
      const app = makeApp(controlAttackRoutes)
      const res = await app.request('/999/archive', { method: 'POST', headers: authHeaders() })
      expect(res.status).toBe(404)
      const body = await res.json()
      expect(body.type).toBe('https://hashhive.dev/errors/not-found')
    })

    it('returns 409 conflict problem+json for a task-less (never-latched) attack', async () => {
      mockArchiveAttacks.mockImplementationOnce(async (_p, ids) =>
        ids.map((id): Outcome => ({ id, outcome: 'not_archivable' }))
      )
      const app = makeApp(controlAttackRoutes)
      const res = await app.request('/50/archive', { method: 'POST', headers: authHeaders() })
      expect(res.status).toBe(409)
      const body = await res.json()
      expect(body.type).toBe('https://hashhive.dev/errors/conflict')
    })

    it('returns 403 when a viewer attempts to archive', async () => {
      activeUserId = 2
      const app = makeApp(controlAttackRoutes)
      const res = await app.request('/50/archive', { method: 'POST', headers: authHeaders() })
      expect(res.status).toBe(403)
    })

    it('returns 409 conflict problem+json when restoring an attack that references a reclaimed-shell resource (F2, issue #106 code review)', async () => {
      mockRestoreAttacks.mockImplementationOnce(async (_p, ids) =>
        ids.map((id): Outcome => ({ id, outcome: 'resource_reclaimed' }))
      )
      const app = makeApp(controlAttackRoutes)
      const res = await app.request('/50/restore', { method: 'POST', headers: authHeaders() })
      expect(res.status).toBe(409)
      const body = await res.json()
      expect(body.type).toBe('https://hashhive.dev/errors/conflict')
    })
  })

  // ─── Agent retire ─────────────────────────────────────────────────

  describe('POST /agents/{id}/retire', () => {
    it('retires an agent (admin) and returns the outcome + released task ids', async () => {
      mockRetireAgent.mockImplementationOnce(async (agentId) => ({
        kind: 'retired' as const,
        agentId,
        releasedTaskIds: [1, 2],
      }))
      const app = makeApp(controlAgentRoutes)
      const res = await app.request('/70/retire', { method: 'POST', headers: authHeaders() })
      expect(res.status).toBe(200)
      const body = (await res.json()) as { outcome: string; releasedTaskIds: number[] }
      expect(body).toEqual({ outcome: 'retired', releasedTaskIds: [1, 2] })
      expect(mockRetireAgent).toHaveBeenCalledWith(70, 1, { actorType: 'user', actorId: 1 })
    })

    it('returns 404 problem+json for an unknown agent id', async () => {
      mockRetireAgent.mockImplementationOnce(async () => ({ kind: 'not_found' as const }))
      const app = makeApp(controlAgentRoutes)
      const res = await app.request('/999/retire', { method: 'POST', headers: authHeaders() })
      expect(res.status).toBe(404)
      const body = await res.json()
      expect(body.type).toBe('https://hashhive.dev/errors/not-found')
    })

    it('returns 409 conflict problem+json when the agent is already retired', async () => {
      mockRetireAgent.mockImplementationOnce(async () => ({ kind: 'already_retired' as const }))
      const app = makeApp(controlAgentRoutes)
      const res = await app.request('/70/retire', { method: 'POST', headers: authHeaders() })
      expect(res.status).toBe(409)
      const body = await res.json()
      expect(body.type).toBe('https://hashhive.dev/errors/conflict')
    })

    it('returns 403 when a contributor (non-admin) attempts to retire', async () => {
      activeMemberships = [{ userId: 3, projectId: 1, roles: ['contributor'] }]
      activeUserId = 3
      const app = makeApp(controlAgentRoutes)
      const res = await app.request('/70/retire', { method: 'POST', headers: authHeaders() })
      expect(res.status).toBe(403)
      expect(mockRetireAgent).not.toHaveBeenCalled()
    })
  })

  // ─── 401: missing/invalid cst_ key (real requireApiKey middleware) ─

  describe('missing/invalid Control API key', () => {
    it('rejects an archive request with no Authorization header (401 problem+json)', async () => {
      const app = makeAuthedApp(controlHashListRoutes)
      const res = await app.request('/10/archive', { method: 'POST' })
      expect(res.status).toBe(401)
      expect(res.headers.get('content-type')).toContain('application/problem+json')
      const body = await res.json()
      expect(body.title).toBe('Authentication required')
      expect(mockArchiveHashLists).not.toHaveBeenCalled()
    })

    it('rejects a retire request with a malformed cst_ token (401 problem+json)', async () => {
      const app = makeAuthedApp(controlAgentRoutes)
      const res = await app.request('/70/retire', {
        method: 'POST',
        headers: { authorization: 'Bearer not-a-real-key' },
      })
      expect(res.status).toBe(401)
      expect(res.headers.get('content-type')).toContain('application/problem+json')
      expect(mockRetireAgent).not.toHaveBeenCalled()
    })
  })
} // end IS_ISOLATED
