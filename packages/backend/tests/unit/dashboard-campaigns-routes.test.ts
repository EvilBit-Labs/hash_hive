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
import { describe, expect, it, mock } from 'bun:test';

const IS_ISOLATED = process.env['DASHBOARD_CAMPAIGNS_TEST_ISOLATED'] === '1';

if (!IS_ISOLATED) {
  // Surface a fail-soft signal when this file runs outside the isolated
  // phase. A passing skip-stub would silently hide the fact that the
  // route coverage never ran in the broader suite; emit a warn and
  // assert the env gate so CI flags any drift in the phase wiring.
  describe('dashboard-campaigns-routes (skipped — runs in isolated phase)', () => {
    it('signals isolation phase is required', () => {
      // biome-ignore lint/suspicious/noConsole: surface phase-gating drift in CI logs
      console.warn(
        '[dashboard-campaigns-routes] skipped — set DASHBOARD_CAMPAIGNS_TEST_ISOLATED=1 to run; the route suite did NOT execute in this phase.'
      );
      // Assert the env gate so a CI misconfiguration cannot silently
      // drop the suite while the test result still reads green.
      expect(process.env['DASHBOARD_CAMPAIGNS_TEST_ISOLATED']).toBeUndefined();
    });
  });
} else {
  // ─── Mock BetterAuth ─────────────────────────────────────────────────

  const ADMIN_COOKIE = 'hh.session_token=valid-admin-session';

  mock.module('../../src/lib/auth.js', () => ({
    auth: {
      api: {
        getSession: async ({ headers }: { headers: Headers }) => {
          const cookie = headers.get('cookie') ?? '';
          if (cookie.includes('valid-admin-session')) {
            return {
              user: {
                id: '1',
                email: 'admin@test.local',
                name: 'Admin',
                emailVerified: true,
                image: null,
              },
              session: {
                id: 'sess',
                userId: '1',
                token: 'tok',
                expiresAt: new Date(Date.now() + 3600000),
              },
            };
          }
          return null;
        },
      },
      handler: async () => new Response('ok'),
    },
  }));

  mock.module('../../src/services/auth.js', () => ({
    getUserWithProjects: async (userId: number) => {
      if (userId === 1) {
        return { id: 1, projects: [{ projectId: 1, roles: ['admin'] }] };
      }
      return null;
    },
    findProjectMembership: async (userId: number, projectId: number) => {
      if (projectId !== 1) return null;
      if (userId === 1) return { projectId: 1, roles: ['admin'] };
      return null;
    },
    issueUserApiKey: mock(async () => ({ apiKey: 'cst_test', metadata: null })),
    revokeUserApiKey: mock(async () => undefined),
    getUserApiKeyMetadata: mock(async () => null),
  }));

  // ─── Mock the Campaigns Service Layer ───────────────────────────────

  const mockListCampaigns = mock(
    async (_filters: Record<string, unknown>) =>
      ({ campaigns: [], total: 0, limit: 50, offset: 0 }) as const
  );

  interface CampaignRow {
    id: number;
    projectId: number;
    status: string;
    name: string;
    hashListId: number;
    priority: number;
    description: string | null;
    progress: Record<string, unknown> | null;
    createdAt: Date;
    startedAt: Date | null;
    completedAt: Date | null;
    updatedAt: Date;
    createdBy: number | null;
  }

  const makeCampaign = (overrides: Partial<CampaignRow> = {}): CampaignRow => ({
    id: 100,
    projectId: 1,
    status: 'draft',
    name: 'Test Campaign',
    hashListId: 1,
    priority: 5,
    description: null,
    progress: {},
    createdAt: new Date('2026-01-01'),
    startedAt: null,
    completedAt: null,
    updatedAt: new Date('2026-01-01'),
    createdBy: 1,
    ...overrides,
  });

  const mockGetCampaignById = mock(async (id: number): Promise<CampaignRow | null> => {
    if (id === 100) return makeCampaign();
    if (id === 101) return makeCampaign({ id: 101, status: 'running' });
    if (id === 200) return makeCampaign({ id: 200, projectId: 999 });
    return null;
  });

  const mockDeleteCampaign = mock(
    async (
      id: number
    ): Promise<
      | { kind: 'deleted'; id: number; projectId: number }
      | { kind: 'not_found' }
      | { kind: 'not_draft'; status: string }
    > => {
      if (id === 100) return { kind: 'deleted', id: 100, projectId: 1 };
      if (id === 101) return { kind: 'not_draft', status: 'running' };
      return { kind: 'not_found' };
    }
  );

  type UpdateCampaignResult =
    | { kind: 'updated'; campaign: CampaignRow }
    | { kind: 'not_found' }
    | { kind: 'not_draft'; status: string };

  const mockUpdateCampaign = mock(
    async (id: number, data: Record<string, unknown>): Promise<UpdateCampaignResult> => {
      if (id === 100) {
        return { kind: 'updated', campaign: makeCampaign({ ...data }) };
      }
      if (id === 101) return { kind: 'not_draft', status: 'running' };
      return { kind: 'not_found' };
    }
  );

  const mockGetCampaignTaskStats = mock(async (_id: number) => ({
    total: 10,
    pending: 2,
    running: 3,
    completed: 4,
    failed: 1,
  }));

  type TransitionErrorCode =
    | 'QUEUE_UNAVAILABLE'
    | 'INVALID_TRANSITION'
    | 'NOT_FOUND'
    | 'RESOURCE_MISSING'
    | 'TASK_GENERATION_FAILED';
  type TransitionResult =
    | { campaign: { id: number; status: string } | null }
    | { error: string; code?: TransitionErrorCode };
  const mockTransitionCampaign = mock<(id: number, target: string) => Promise<TransitionResult>>(
    async () => ({ campaign: null })
  );

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
  ]);

  // Per-test mock of listAttacks: defaults to empty so existing tests
  // are unaffected; DAG-validation tests override it via .mockResolvedValueOnce.
  const mockListAttacks = mock(
    async (_campaignId: number) =>
      [] as Array<{
        id: number;
        dependencies: number[] | null;
      }>
  );

  type CreateWithAttacksResult =
    | {
        kind: 'created';
        campaign: CampaignRow;
        attacks: Array<{ id: number; dependencies: number[] | null }>;
      }
    | { kind: 'dag_invalid'; error: string };

  const mockCreateCampaign = mock(
    async (data: { name: string; projectId: number; hashListId: number }) =>
      makeCampaign({ name: data.name, projectId: data.projectId, hashListId: data.hashListId })
  );

  const mockCreateCampaignWithAttacks = mock(
    async (_input: {
      attacks: ReadonlyArray<{ dependencies?: number[] | undefined }>;
    }): Promise<CreateWithAttacksResult> => ({
      kind: 'created',
      campaign: makeCampaign(),
      attacks: [],
    })
  );

  const mockCreateAttack = mock(async () => ({ id: 555 }));
  const mockUpdateAttackImpl = mock(async () => ({ id: 555 }));
  const mockGetAttackByIdImpl = mock(
    async (_id: number) =>
      null as { id: number; campaignId: number; dependencies: number[] | null } | null
  );

  mock.module('../../src/services/campaigns.js', () => ({
    // Test-driven stubs.
    listCampaigns: mockListCampaigns,
    getCampaignById: mockGetCampaignById,
    getCampaignTaskStats: mockGetCampaignTaskStats,
    listActiveAgentsByCampaign: mockListActiveAgentsByCampaign,
    deleteCampaign: mockDeleteCampaign,
    // Inert stubs for sibling exports the routes module imports.
    createCampaign: mockCreateCampaign,
    createCampaignWithAttacks: mockCreateCampaignWithAttacks,
    updateCampaign: mockUpdateCampaign,
    listAttacks: mockListAttacks,
    listAttacksPaginated: mock(async () => ({ attacks: [], total: 0, limit: 50, offset: 0 })),
    createAttack: mockCreateAttack,
    getAttackById: mockGetAttackByIdImpl,
    updateAttack: mockUpdateAttackImpl,
    deleteAttack: mock(async () => null),
    transitionCampaign: mockTransitionCampaign,
    validateCampaignDAG: mock(async () => ({ valid: true })),
    // Pure cycle detector — used by attack write-path DAG validation.
    // Re-export the real implementation so route tests exercise the
    // production algorithm rather than a stub.
    validateProposedDAG: (
      proposed: ReadonlyArray<{ id: number; dependencies: number[] | null }>
    ) => {
      if (proposed.length === 0) return { valid: true };
      const ids = new Set(proposed.map((p) => p.id));
      const inDegree = new Map<number, number>();
      const adj = new Map<number, number[]>();
      for (const p of proposed) {
        inDegree.set(p.id, 0);
        adj.set(p.id, []);
      }
      for (const p of proposed) {
        for (const d of p.dependencies ?? []) {
          if (!ids.has(d))
            return {
              valid: false,
              error: `Attack ${p.id} depends on non-existent attack ${d}`,
            };
          adj.get(d)?.push(p.id);
          inDegree.set(p.id, (inDegree.get(p.id) ?? 0) + 1);
        }
      }
      const q: number[] = [];
      for (const [id, deg] of inDegree) if (deg === 0) q.push(id);
      let processed = 0;
      while (q.length > 0) {
        // biome-ignore lint/style/noNonNullAssertion: q.length > 0
        const cur = q.shift()!;
        processed++;
        for (const n of adj.get(cur) ?? []) {
          const nd = (inDegree.get(n) ?? 1) - 1;
          inDegree.set(n, nd);
          if (nd === 0) q.push(n);
        }
      }
      return processed === proposed.length
        ? { valid: true }
        : { valid: false, error: 'Circular dependency detected among attacks' };
    },
    // Required by tasks.ts (static import resolves to this mocked module
    // because mock.module is process-global).
    updateCampaignProgress: mock(async () => undefined),
    resolveGenerationStrategy: () => 'inline' as const,
    INLINE_GENERATION_THRESHOLD: 100,
    _deps: {},
  }));

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
  }));

  mock.module('ioredis', () => ({
    default: class MockRedis {
      ping() {
        return Promise.resolve('PONG');
      }
      on() {
        return this;
      }
      disconnect() {}
    },
  }));

  // Dynamically import so the app module loads AFTER the mock.module calls
  // above. A static `import { app }` would still resolve as part of the same
  // module-graph evaluation pass, before mock.module hoisting takes effect.
  const { app } = await import('../../src/index.js');

  const DASH_CAMPAIGNS = '/api/v1/dashboard/campaigns';

  function makeHeaders() {
    return { cookie: ADMIN_COOKIE, 'x-project-id': '1' };
  }

  describe('Dashboard campaigns list: query params', () => {
    it('accepts the default request and passes projectId to the service', async () => {
      mockListCampaigns.mockClear();
      const res = await app.request(DASH_CAMPAIGNS, { headers: makeHeaders() });
      expect(res.status).toBe(200);
      expect(mockListCampaigns).toHaveBeenCalledTimes(1);
      const args = mockListCampaigns.mock.calls[0]?.[0] as { projectId?: number };
      expect(args?.projectId).toBe(1);
    });

    it('passes status filter through to the service', async () => {
      mockListCampaigns.mockClear();
      const res = await app.request(`${DASH_CAMPAIGNS}?status=running`, { headers: makeHeaders() });
      expect(res.status).toBe(200);
      const args = mockListCampaigns.mock.calls[0]?.[0] as { status?: string };
      expect(args?.status).toBe('running');
    });

    it('accepts priority=1 (high) and passes through', async () => {
      mockListCampaigns.mockClear();
      const res = await app.request(`${DASH_CAMPAIGNS}?priority=1`, { headers: makeHeaders() });
      expect(res.status).toBe(200);
      const args = mockListCampaigns.mock.calls[0]?.[0] as { priority?: number };
      expect(args?.priority).toBe(1);
    });

    it('accepts priority=5 (normal)', async () => {
      mockListCampaigns.mockClear();
      const res = await app.request(`${DASH_CAMPAIGNS}?priority=5`, { headers: makeHeaders() });
      expect(res.status).toBe(200);
      const args = mockListCampaigns.mock.calls[0]?.[0] as { priority?: number };
      expect(args?.priority).toBe(5);
    });

    it('accepts priority=10 (low)', async () => {
      mockListCampaigns.mockClear();
      const res = await app.request(`${DASH_CAMPAIGNS}?priority=10`, { headers: makeHeaders() });
      expect(res.status).toBe(200);
      const args = mockListCampaigns.mock.calls[0]?.[0] as { priority?: number };
      expect(args?.priority).toBe(10);
    });

    it('rejects invalid priority=3 with 400', async () => {
      mockListCampaigns.mockClear();
      const res = await app.request(`${DASH_CAMPAIGNS}?priority=3`, { headers: makeHeaders() });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error?: { code?: string } };
      expect(body.error?.code).toBe('VALIDATION_ERROR');
      expect(mockListCampaigns).not.toHaveBeenCalled();
    });

    it('accepts sort=name&order=asc', async () => {
      mockListCampaigns.mockClear();
      const res = await app.request(`${DASH_CAMPAIGNS}?sort=name&order=asc`, {
        headers: makeHeaders(),
      });
      expect(res.status).toBe(200);
      const args = mockListCampaigns.mock.calls[0]?.[0] as { sort?: string; order?: string };
      expect(args?.sort).toBe('name');
      expect(args?.order).toBe('asc');
    });

    it('accepts sort=priority', async () => {
      mockListCampaigns.mockClear();
      const res = await app.request(`${DASH_CAMPAIGNS}?sort=priority`, { headers: makeHeaders() });
      expect(res.status).toBe(200);
      const args = mockListCampaigns.mock.calls[0]?.[0] as { sort?: string };
      expect(args?.sort).toBe('priority');
    });

    it('accepts sort=createdAt (default field)', async () => {
      mockListCampaigns.mockClear();
      const res = await app.request(`${DASH_CAMPAIGNS}?sort=createdAt`, { headers: makeHeaders() });
      expect(res.status).toBe(200);
      const args = mockListCampaigns.mock.calls[0]?.[0] as { sort?: string };
      expect(args?.sort).toBe('createdAt');
    });

    it('rejects invalid sort value with 400', async () => {
      mockListCampaigns.mockClear();
      const res = await app.request(`${DASH_CAMPAIGNS}?sort=evil`, { headers: makeHeaders() });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error?: { code?: string } };
      expect(body.error?.code).toBe('VALIDATION_ERROR');
      expect(mockListCampaigns).not.toHaveBeenCalled();
    });

    it('rejects invalid order value with 400', async () => {
      mockListCampaigns.mockClear();
      const res = await app.request(`${DASH_CAMPAIGNS}?order=sideways`, { headers: makeHeaders() });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error?: { code?: string } };
      expect(body.error?.code).toBe('VALIDATION_ERROR');
    });

    it('preserves project scoping across filter and sort combinations', async () => {
      mockListCampaigns.mockClear();
      const res = await app.request(
        `${DASH_CAMPAIGNS}?status=running&priority=1&sort=name&order=asc`,
        { headers: makeHeaders() }
      );
      expect(res.status).toBe(200);
      const args = mockListCampaigns.mock.calls[0]?.[0] as { projectId?: number };
      expect(args?.projectId).toBe(1);
    });
  });

  describe('Dashboard campaigns detail: enriched payload', () => {
    it('returns campaign + attacks + taskStats + activeAgents in one round-trip', async () => {
      const res = await app.request(`${DASH_CAMPAIGNS}/100`, { headers: makeHeaders() });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        campaign: { id: number };
        attacks: unknown[];
        taskStats: {
          total: number;
          pending: number;
          running: number;
          completed: number;
          failed: number;
        };
        activeAgents: Array<{ agentId: number; agentName: string }>;
      };
      expect(body.campaign.id).toBe(100);
      expect(body.taskStats).toEqual({
        total: 10,
        pending: 2,
        running: 3,
        completed: 4,
        failed: 1,
      });
      expect(body.activeAgents).toHaveLength(1);
      expect(body.activeAgents[0]?.agentName).toBe('Rig One');
    });

    it('returns 400 on non-integer id', async () => {
      const res = await app.request(`${DASH_CAMPAIGNS}/abc`, { headers: makeHeaders() });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error?: { code?: string } };
      expect(body.error?.code).toBe('VALIDATION_ERROR');
    });

    it('returns 404 when campaign belongs to a different project', async () => {
      const res = await app.request(`${DASH_CAMPAIGNS}/200`, { headers: makeHeaders() });
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error?: { code?: string } };
      expect(body.error?.code).toBe('RESOURCE_NOT_FOUND');
    });

    it('returns 404 for unknown id', async () => {
      const res = await app.request(`${DASH_CAMPAIGNS}/9999`, { headers: makeHeaders() });
      expect(res.status).toBe(404);
    });
  });

  describe('Dashboard campaigns delete: draft-only', () => {
    it('deletes a draft campaign and returns 200', async () => {
      mockDeleteCampaign.mockClear();
      const res = await app.request(`${DASH_CAMPAIGNS}/100`, {
        method: 'DELETE',
        headers: makeHeaders(),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { deleted?: boolean; id?: number };
      expect(body.deleted).toBe(true);
      expect(body.id).toBe(100);
      expect(mockDeleteCampaign).toHaveBeenCalledTimes(1);
    });

    it('returns 409 with NOT_DRAFT when campaign is not in draft status', async () => {
      const res = await app.request(`${DASH_CAMPAIGNS}/101`, {
        method: 'DELETE',
        headers: makeHeaders(),
      });
      expect(res.status).toBe(409);
      const body = (await res.json()) as { error?: { code?: string; message?: string } };
      expect(body.error?.code).toBe('NOT_DRAFT');
      expect(body.error?.message).toContain('running');
    });

    it('returns 404 when campaign belongs to a different project', async () => {
      const res = await app.request(`${DASH_CAMPAIGNS}/200`, {
        method: 'DELETE',
        headers: makeHeaders(),
      });
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error?: { code?: string } };
      expect(body.error?.code).toBe('RESOURCE_NOT_FOUND');
    });

    it('returns 400 on invalid id', async () => {
      const res = await app.request(`${DASH_CAMPAIGNS}/abc`, {
        method: 'DELETE',
        headers: makeHeaders(),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error?: { code?: string } };
      expect(body.error?.code).toBe('VALIDATION_ERROR');
    });
  });

  describe('Dashboard campaigns update: draft-only (PATCH/PUT)', () => {
    function updateBody(method: 'PATCH' | 'PUT', id: number, body: Record<string, unknown>) {
      return app.request(`${DASH_CAMPAIGNS}/${id}`, {
        method,
        headers: { ...makeHeaders(), 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    }

    for (const method of ['PATCH', 'PUT'] as const) {
      it(`${method} updates a draft campaign and returns 200`, async () => {
        mockUpdateCampaign.mockClear();
        const res = await updateBody(method, 100, { name: 'New name' });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { campaign?: { name?: string } };
        expect(body.campaign?.name).toBe('New name');
        expect(mockUpdateCampaign).toHaveBeenCalledTimes(1);
      });

      it(`${method} on running campaign returns 409 NOT_DRAFT`, async () => {
        const res = await updateBody(method, 101, { name: 'Should fail' });
        expect(res.status).toBe(409);
        const body = (await res.json()) as { error?: { code?: string; message?: string } };
        expect(body.error?.code).toBe('NOT_DRAFT');
        expect(body.error?.message).toContain('running');
      });
    }

    it('PATCH on unknown id returns 404', async () => {
      const res = await updateBody('PATCH', 9999, { name: 'Nope' });
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error?: { code?: string } };
      expect(body.error?.code).toBe('RESOURCE_NOT_FOUND');
    });

    it('PATCH on campaign in a different project returns 404', async () => {
      const res = await updateBody('PATCH', 200, { name: 'Cross-project' });
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error?: { code?: string } };
      expect(body.error?.code).toBe('RESOURCE_NOT_FOUND');
    });

    it('PATCH on non-integer id returns 400 VALIDATION_ERROR', async () => {
      const res = await updateBody('PATCH', 'abc' as unknown as number, { name: 'Bad id' });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error?: { code?: string } };
      expect(body.error?.code).toBe('VALIDATION_ERROR');
    });

    it('PATCH with invalid body returns 400 VALIDATION_ERROR', async () => {
      const res = await updateBody('PATCH', 100, { priority: 99 });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error?: { code?: string } };
      expect(body.error?.code).toBe('VALIDATION_ERROR');
    });
  });

  describe('Dashboard campaign lifecycle: queue-availability mapping', () => {
    it('maps QUEUE_UNAVAILABLE → 503 SERVICE_UNAVAILABLE', async () => {
      mockTransitionCampaign.mockResolvedValueOnce({
        error: 'Queue unavailable — cannot start campaign',
        code: 'QUEUE_UNAVAILABLE',
      });

      const res = await app.request(`${DASH_CAMPAIGNS}/1/lifecycle`, {
        method: 'POST',
        headers: { ...makeHeaders(), 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'start' }),
      });

      expect(res.status).toBe(503);
      const body = (await res.json()) as { error?: { code?: string; message?: string } };
      expect(body.error?.code).toBe('SERVICE_UNAVAILABLE');
      expect(body.error?.message).toContain('Queue unavailable');
    });

    it('still maps non-queue transition errors to 400 INVALID_TRANSITION', async () => {
      mockTransitionCampaign.mockResolvedValueOnce({
        error: "Cannot transition from 'running' to 'running'",
      });

      const res = await app.request(`${DASH_CAMPAIGNS}/1/lifecycle`, {
        method: 'POST',
        headers: { ...makeHeaders(), 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'start' }),
      });

      expect(res.status).toBe(400);
      const body = (await res.json()) as { error?: { code?: string } };
      expect(body.error?.code).toBe('INVALID_TRANSITION');
    });

    it('maps RESOURCE_MISSING → 400 with specific missing-id message', async () => {
      mockTransitionCampaign.mockResolvedValueOnce({
        error: 'Referenced resources missing: wordlist(99)',
        code: 'RESOURCE_MISSING',
      });
      const res = await app.request(`${DASH_CAMPAIGNS}/1/lifecycle`, {
        method: 'POST',
        headers: { ...makeHeaders(), 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'start' }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error?: { code?: string; message?: string } };
      expect(body.error?.code).toBe('RESOURCE_MISSING');
      expect(body.error?.message).toContain('wordlist(99)');
    });
  });

  describe('POST /campaigns: transactional create with inline attacks', () => {
    function postCampaign(body: Record<string, unknown>) {
      return app.request(DASH_CAMPAIGNS, {
        method: 'POST',
        headers: { ...makeHeaders(), 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    }

    it('without attacks: routes to legacy createCampaign and returns 201', async () => {
      mockCreateCampaign.mockClear();
      mockCreateCampaignWithAttacks.mockClear();
      const res = await postCampaign({ name: 'Legacy', hashListId: 1 });
      expect(res.status).toBe(201);
      expect(mockCreateCampaign).toHaveBeenCalledTimes(1);
      expect(mockCreateCampaignWithAttacks).toHaveBeenCalledTimes(0);
    });

    it('with empty attacks[]: still routes to legacy createCampaign', async () => {
      mockCreateCampaign.mockClear();
      mockCreateCampaignWithAttacks.mockClear();
      const res = await postCampaign({ name: 'Empty attacks', hashListId: 1, attacks: [] });
      expect(res.status).toBe(201);
      expect(mockCreateCampaign).toHaveBeenCalledTimes(1);
      expect(mockCreateCampaignWithAttacks).toHaveBeenCalledTimes(0);
    });

    it('with attacks: routes to createCampaignWithAttacks and returns 201', async () => {
      mockCreateCampaign.mockClear();
      mockCreateCampaignWithAttacks.mockClear();
      mockCreateCampaignWithAttacks.mockResolvedValueOnce({
        kind: 'created',
        campaign: makeCampaign({ name: 'With attacks' }),
        attacks: [
          { id: 700, dependencies: null },
          { id: 701, dependencies: [700] },
        ],
      });
      const res = await postCampaign({
        name: 'With attacks',
        hashListId: 1,
        attacks: [
          { mode: 0, wordlistId: 1 },
          { mode: 0, wordlistId: 2, dependencies: [0] },
        ],
      });
      expect(res.status).toBe(201);
      expect(mockCreateCampaignWithAttacks).toHaveBeenCalledTimes(1);
      expect(mockCreateCampaign).toHaveBeenCalledTimes(0);
      const body = (await res.json()) as {
        attacks?: Array<{ id?: number; dependencies?: number[] | null }>;
      };
      expect(body.attacks).toHaveLength(2);
      expect(body.attacks?.[1]?.dependencies).toEqual([700]);
    });

    it('with cycle in inline attacks: returns 400 DAG_INVALID', async () => {
      mockCreateCampaignWithAttacks.mockResolvedValueOnce({
        kind: 'dag_invalid',
        error: 'Circular dependency detected among attacks',
      });
      const res = await postCampaign({
        name: 'Cycle',
        hashListId: 1,
        attacks: [
          { mode: 0, dependencies: [1] },
          { mode: 0, dependencies: [0] },
        ],
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error?: { code?: string; message?: string } };
      expect(body.error?.code).toBe('DAG_INVALID');
      expect(body.error?.message).toContain('Circular');
    });

    it('with out-of-range dependency index: surfaces DAG_INVALID', async () => {
      mockCreateCampaignWithAttacks.mockResolvedValueOnce({
        kind: 'dag_invalid',
        error: 'Attack 5 depends on non-existent attack 99',
      });
      const res = await postCampaign({
        name: 'Bad ref',
        hashListId: 1,
        attacks: [{ mode: 0, dependencies: [5] }],
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error?: { code?: string } };
      expect(body.error?.code).toBe('DAG_INVALID');
    });

    it('rejects malformed body (missing hashListId) with 400', async () => {
      const res = await postCampaign({ name: 'Missing field' });
      expect(res.status).toBe(400);
    });

    it('rejects negative dependency index at the schema layer', async () => {
      const res = await postCampaign({
        name: 'Bad index',
        hashListId: 1,
        attacks: [{ mode: 0, dependencies: [-1] }],
      });
      expect(res.status).toBe(400);
    });
  });

  describe('Attack write-time DAG validation', () => {
    function postAttack(campaignId: number, body: Record<string, unknown>) {
      return app.request(`${DASH_CAMPAIGNS}/${campaignId}/attacks`, {
        method: 'POST',
        headers: { ...makeHeaders(), 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    }
    function patchAttack(campaignId: number, attackId: number, body: Record<string, unknown>) {
      return app.request(`${DASH_CAMPAIGNS}/${campaignId}/attacks/${attackId}`, {
        method: 'PATCH',
        headers: { ...makeHeaders(), 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    }

    it('POST: valid dependency on existing attack returns 201', async () => {
      mockListAttacks.mockResolvedValueOnce([{ id: 1, dependencies: null }]);
      const res = await postAttack(100, { mode: 0, dependencies: [1] });
      expect(res.status).toBe(201);
    });

    it('POST: dependency on non-existent attack id returns 400 DAG_INVALID', async () => {
      mockListAttacks.mockResolvedValueOnce([{ id: 1, dependencies: null }]);
      const res = await postAttack(100, { mode: 0, dependencies: [99] });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error?: { code?: string; message?: string } };
      expect(body.error?.code).toBe('DAG_INVALID');
      expect(body.error?.message).toContain('non-existent');
    });

    it('POST: new attack creating a cycle returns 400 DAG_INVALID', async () => {
      // Existing attack #1 depends on the synthetic new attack id (-1).
      // Adding a new attack that depends on #1 closes the cycle.
      mockListAttacks.mockResolvedValueOnce([{ id: 1, dependencies: [-1] }]);
      const res = await postAttack(100, { mode: 0, dependencies: [1] });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error?: { code?: string; message?: string } };
      expect(body.error?.code).toBe('DAG_INVALID');
      expect(body.error?.message).toContain('Circular');
    });

    it('POST: with no dependencies on a fresh campaign returns 201', async () => {
      mockListAttacks.mockResolvedValueOnce([]);
      const res = await postAttack(100, { mode: 0 });
      expect(res.status).toBe(201);
    });

    it('PATCH: self-loop on dependencies returns 400 DAG_INVALID', async () => {
      mockGetAttackByIdImpl.mockResolvedValueOnce({ id: 5, campaignId: 100, dependencies: [] });
      mockListAttacks.mockResolvedValueOnce([{ id: 5, dependencies: [] }]);
      const res = await patchAttack(100, 5, { dependencies: [5] });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error?: { code?: string } };
      expect(body.error?.code).toBe('DAG_INVALID');
    });

    it('PATCH: adding a dep that closes a 3-cycle returns 400 DAG_INVALID', async () => {
      // Current: 1 -> 2 -> 3 (deps mean "I depend on"); editing 1 to depend on 3 closes the loop.
      mockGetAttackByIdImpl.mockResolvedValueOnce({ id: 1, campaignId: 100, dependencies: [] });
      mockListAttacks.mockResolvedValueOnce([
        { id: 1, dependencies: [] },
        { id: 2, dependencies: [1] },
        { id: 3, dependencies: [2] },
      ]);
      const res = await patchAttack(100, 1, { dependencies: [3] });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error?: { code?: string } };
      expect(body.error?.code).toBe('DAG_INVALID');
    });

    it('PATCH: changing non-dep fields skips DAG validation (no listAttacks call)', async () => {
      mockGetAttackByIdImpl.mockResolvedValueOnce({ id: 5, campaignId: 100, dependencies: [] });
      mockListAttacks.mockClear();
      const res = await patchAttack(100, 5, { mode: 3 });
      expect(res.status).toBe(200);
      expect(mockListAttacks).toHaveBeenCalledTimes(0);
    });

    it('PATCH: dependency change to a valid graph returns 200', async () => {
      mockGetAttackByIdImpl.mockResolvedValueOnce({ id: 2, campaignId: 100, dependencies: [] });
      mockListAttacks.mockResolvedValueOnce([
        { id: 1, dependencies: [] },
        { id: 2, dependencies: [] },
      ]);
      const res = await patchAttack(100, 2, { dependencies: [1] });
      expect(res.status).toBe(200);
    });
  });

  describe('Dashboard campaign lifecycle aliases: /start /pause /resume /stop', () => {
    function lifecyclePost(id: number, action: 'start' | 'pause' | 'resume' | 'stop') {
      return app.request(`${DASH_CAMPAIGNS}/${id}/${action}`, {
        method: 'POST',
        headers: makeHeaders(),
      });
    }

    const aliasTransitionTarget = {
      start: 'running',
      pause: 'paused',
      resume: 'running',
      stop: 'draft',
    } as const;

    for (const action of ['start', 'pause', 'resume', 'stop'] as const) {
      it(`POST /:id/${action} delegates to transitionCampaign with the right target status`, async () => {
        mockTransitionCampaign.mockClear();
        mockTransitionCampaign.mockResolvedValueOnce({
          campaign: { id: 100, status: aliasTransitionTarget[action] },
        });

        const res = await lifecyclePost(100, action);
        expect(res.status).toBe(200);
        expect(mockTransitionCampaign).toHaveBeenCalledTimes(1);
        const args = mockTransitionCampaign.mock.calls[0];
        expect(args?.[0]).toBe(100);
        expect(args?.[1]).toBe(aliasTransitionTarget[action]);
      });

      it(`POST /:id/${action} maps INVALID_TRANSITION → 400`, async () => {
        mockTransitionCampaign.mockResolvedValueOnce({
          error: `Cannot transition from 'wrong' to '${aliasTransitionTarget[action]}'`,
        });
        const res = await lifecyclePost(100, action);
        expect(res.status).toBe(400);
        const body = (await res.json()) as { error?: { code?: string } };
        expect(body.error?.code).toBe('INVALID_TRANSITION');
      });

      it(`POST /:id/${action} maps QUEUE_UNAVAILABLE → 503`, async () => {
        mockTransitionCampaign.mockResolvedValueOnce({
          error: 'Queue unavailable',
          code: 'QUEUE_UNAVAILABLE',
        });
        const res = await lifecyclePost(100, action);
        expect(res.status).toBe(503);
        const body = (await res.json()) as { error?: { code?: string } };
        expect(body.error?.code).toBe('SERVICE_UNAVAILABLE');
      });

      it(`POST /:id/${action} maps RESOURCE_MISSING → 400`, async () => {
        mockTransitionCampaign.mockResolvedValueOnce({
          error: 'Referenced resources missing: hashList(42), wordlist(7)',
          code: 'RESOURCE_MISSING',
        });
        const res = await lifecyclePost(100, action);
        expect(res.status).toBe(400);
        const body = (await res.json()) as { error?: { code?: string; message?: string } };
        expect(body.error?.code).toBe('RESOURCE_MISSING');
        expect(body.error?.message).toContain('hashList(42)');
        expect(body.error?.message).toContain('wordlist(7)');
      });

      it(`POST /:id/${action} on cross-project campaign returns 404`, async () => {
        const res = await lifecyclePost(200, action);
        expect(res.status).toBe(404);
        const body = (await res.json()) as { error?: { code?: string } };
        expect(body.error?.code).toBe('RESOURCE_NOT_FOUND');
      });

      it(`POST /:id/${action} on unknown id returns 404`, async () => {
        const res = await lifecyclePost(9999, action);
        expect(res.status).toBe(404);
      });
    }
  });
} // end IS_ISOLATED
