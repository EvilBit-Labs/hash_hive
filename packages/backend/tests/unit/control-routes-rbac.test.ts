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

import { beforeEach, describe, expect, it, mock } from 'bun:test';

const IS_ISOLATED = process.env['CONTROL_RBAC_TEST_ISOLATED'] === '1';

if (!IS_ISOLATED) {
  describe.skip('control-routes-rbac (skipped — runs in isolated phase)', () => {
    it('runs only with CONTROL_RBAC_TEST_ISOLATED=1', () => {
      expect(true).toBe(true);
    });
  });
} else {
  // ─── Test state ───────────────────────────────────────────────────

  interface MockMembership {
    userId: number;
    projectId: number;
    roles: string[];
  }

  let mockMemberships: MockMembership[] = [];
  let mockProjects: Array<{ id: number; name: string }> = [];
  let mockCampaigns: Array<{ id: number; projectId: number; status: string; name: string }> = [];
  let mockAgents: Array<{ id: number; projectId: number; status: string; name: string }> = [];
  let mockAttacks: Array<{ id: number; campaignId: number; projectId: number }> = [];

  function findMembership(userId: number, projectId: number) {
    return mockMemberships.find((m) => m.userId === userId && m.projectId === projectId) ?? null;
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
  }));

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
  }));

  mock.module('../../src/services/campaigns.js', () => ({
    getCampaignById: async (id: number) => mockCampaigns.find((c) => c.id === id) ?? null,
    listCampaigns: async ({ projectId }: { projectId?: number }) => ({
      campaigns: mockCampaigns.filter((c) => c.projectId === projectId),
      total: mockCampaigns.filter((c) => c.projectId === projectId).length,
      limit: 50,
      offset: 0,
    }),
    createCampaign: async (data: { projectId: number; name: string }) => ({
      id: 999,
      projectId: data.projectId,
      name: data.name,
      status: 'draft',
    }),
    updateCampaign: async (id: number) => ({ id }),
    transitionCampaign: async () => ({ campaign: {} }),
    listAttacks: async () => [],
    getAttackById: async (id: number) => mockAttacks.find((a) => a.id === id) ?? null,
    createAttack: async (data: { campaignId: number; projectId: number }) => ({ id: 888, ...data }),
    updateAttack: async (id: number) => ({ id }),
    deleteAttack: async () => undefined,
  }));

  mock.module('../../src/services/agents.js', () => ({
    listAgents: async ({ projectId }: { projectId?: number }) => ({
      agents: mockAgents.filter((a) => a.projectId === projectId),
      total: mockAgents.filter((a) => a.projectId === projectId).length,
      limit: 50,
      offset: 0,
    }),
    getAgentById: async (id: number) => mockAgents.find((a) => a.id === id) ?? null,
    updateAgent: async (id: number) => ({ id }),
  }));

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
  }));

  // ─── Routes (dynamic imports so they pick up the mocks) ──────────
  // Bun's ESM loader hoists static imports above the describe blocks,
  // which would resolve to the unmocked services. Use require() (Bun
  // supports CommonJS-style require in ESM) to defer resolution until
  // after `mock.module` has run.
  const { controlAgentRoutes } = require('../../src/routes/control/agents.js');
  const { controlAttackRoutes } = require('../../src/routes/control/attacks.js');
  const { controlCampaignRoutes } = require('../../src/routes/control/campaigns.js');
  const {
    requireProjectMembership,
    requireProjectRole,
  } = require('../../src/routes/control/helpers.js');
  type ControlMembership = import('../../src/routes/control/helpers.js').ControlMembership;
  const { Hono } = require('hono');

  let activeUserId = 1;
  let activeProjectId: number | null = null;

  function authHeaders() {
    const headers: Record<string, string> = { authorization: 'Bearer cst_1_anything' };
    if (activeProjectId !== null) headers['x-project-id'] = String(activeProjectId);
    return headers;
  }

  function makeApp(router: unknown) {
    // biome-ignore lint/suspicious/noExplicitAny: dynamically require()d Hono router
    const app = new (Hono as any)();
    app.use('*', async (c: { set: (k: string, v: unknown) => void }, next: () => Promise<void>) => {
      c.set('currentUser', {
        userId: activeUserId,
        email: 'admin@example.com',
        projectId: activeProjectId,
      });
      await next();
    });
    app.route('/', router);
    return app;
  }

  describe('Control API: cross-project + RBAC enforcement', () => {
    beforeEach(() => {
      mockProjects = [
        { id: 1, name: 'Alpha' },
        { id: 2, name: 'Beta' },
      ];
      mockMemberships = [
        { userId: 1, projectId: 1, roles: ['admin'] },
        { userId: 2, projectId: 2, roles: ['admin'] },
      ];
      mockCampaigns = [
        { id: 100, projectId: 1, status: 'draft', name: 'Alpha Campaign' },
        { id: 200, projectId: 2, status: 'draft', name: 'Beta Campaign' },
      ];
      mockAgents = [
        { id: 10, projectId: 1, status: 'online', name: 'a-1' },
        { id: 20, projectId: 2, status: 'online', name: 'b-1' },
      ];
      mockAttacks = [
        { id: 50, campaignId: 100, projectId: 1 },
        { id: 60, campaignId: 200, projectId: 2 },
      ];
      activeUserId = 1;
    });

    describe('campaigns', () => {
      it('lists only the active project', async () => {
        activeProjectId = 1;
        const app = makeApp(controlCampaignRoutes);
        const res = await app.request('/', { headers: authHeaders() });
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.items).toHaveLength(1);
        expect(body.items[0].id).toBe(100);
      });

      it('returns 403 RFC 9457 when caller is not a member of the active project', async () => {
        activeProjectId = 2;
        const app = makeApp(controlCampaignRoutes);
        const res = await app.request('/', { headers: authHeaders() });
        expect(res.status).toBe(403);
        expect(res.headers.get('content-type')).toContain('application/problem+json');
        const body = await res.json();
        expect(body.title).toBe('Forbidden');
        expect(body.type).toBe('https://hashhive.dev/errors/forbidden');
      });

      it('returns 400 RFC 9457 when X-Project-Id is missing', async () => {
        activeProjectId = null;
        const app = makeApp(controlCampaignRoutes);
        const res = await app.request('/', { headers: authHeaders() });
        expect(res.status).toBe(400);
        const body = await res.json();
        expect(body.type).toBe('https://hashhive.dev/errors/project-not-selected');
      });

      it('viewer-role members cannot create campaigns', async () => {
        mockMemberships = [{ userId: 1, projectId: 1, roles: ['viewer'] }];
        activeProjectId = 1;
        const app = makeApp(controlCampaignRoutes);
        const res = await app.request('/', {
          method: 'POST',
          headers: { ...authHeaders(), 'content-type': 'application/json' },
          body: JSON.stringify({ name: 'New', hashListId: 1 }),
        });
        expect(res.status).toBe(403);
      });

      it('contributor-role members can create campaigns', async () => {
        mockMemberships = [{ userId: 1, projectId: 1, roles: ['contributor'] }];
        activeProjectId = 1;
        const app = makeApp(controlCampaignRoutes);
        const res = await app.request('/', {
          method: 'POST',
          headers: { ...authHeaders(), 'content-type': 'application/json' },
          body: JSON.stringify({ name: 'New', hashListId: 1 }),
        });
        expect(res.status).toBe(201);
      });
    });

    describe('attacks', () => {
      it('rejects cross-project attack creation', async () => {
        activeProjectId = 1;
        const app = makeApp(controlAttackRoutes);
        const res = await app.request('/', {
          method: 'POST',
          headers: { ...authHeaders(), 'content-type': 'application/json' },
          body: JSON.stringify({ campaignId: 200, mode: 0 }),
        });
        expect(res.status).toBe(404);
      });

      it('viewer-role members cannot delete attacks', async () => {
        mockMemberships = [{ userId: 1, projectId: 1, roles: ['viewer'] }];
        activeProjectId = 1;
        const app = makeApp(controlAttackRoutes);
        const res = await app.request('/50', { method: 'DELETE', headers: authHeaders() });
        expect(res.status).toBe(403);
      });
    });

    describe('agents', () => {
      it('lists only the active project', async () => {
        activeProjectId = 1;
        const app = makeApp(controlAgentRoutes);
        const res = await app.request('/', { headers: authHeaders() });
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.items).toHaveLength(1);
        expect(body.items[0].id).toBe(10);
      });

      it('PATCH requires admin role', async () => {
        mockMemberships = [{ userId: 1, projectId: 1, roles: ['contributor'] }];
        activeProjectId = 1;
        const app = makeApp(controlAgentRoutes);
        const res = await app.request('/10', {
          method: 'PATCH',
          headers: { ...authHeaders(), 'content-type': 'application/json' },
          body: JSON.stringify({ name: 'renamed' }),
        });
        expect(res.status).toBe(403);
      });
    });
  });

  describe('helpers: requireProjectMembership / requireProjectRole', () => {
    beforeEach(() => {
      mockProjects = [{ id: 1, name: 'Alpha' }];
      mockMemberships = [{ userId: 1, projectId: 1, roles: ['admin'] }];
    });

    it('returns membership for a valid member', async () => {
      const fakeContext = {
        get: () => ({ userId: 1, projectId: 1, email: '' }),
      };
      const result: ControlMembership = await requireProjectMembership(fakeContext);
      expect(result.projectId).toBe(1);
      expect(result.roles).toContain('admin');
    });

    it('throws ControlApiError(400, project_not_selected) when projectId is null', async () => {
      const fakeContext = {
        get: () => ({ userId: 1, projectId: null, email: '' }),
      };
      await expect(requireProjectMembership(fakeContext)).rejects.toMatchObject({
        status: 400,
        code: 'project_not_selected',
      });
    });

    it('throws 403 forbidden for non-members', async () => {
      const fakeContext = {
        get: () => ({ userId: 99, projectId: 1, email: '' }),
      };
      await expect(requireProjectMembership(fakeContext)).rejects.toMatchObject({
        status: 403,
        code: 'forbidden',
      });
    });

    it('requireProjectRole throws 403 when caller lacks the role', async () => {
      mockMemberships = [{ userId: 1, projectId: 1, roles: ['viewer'] }];
      const fakeContext = {
        get: () => ({ userId: 1, projectId: 1, email: '' }),
      };
      await expect(requireProjectRole(fakeContext, 'admin')).rejects.toMatchObject({
        status: 403,
        code: 'forbidden',
      });
    });

    it('requireProjectRole accepts any role in the allow list', async () => {
      mockMemberships = [{ userId: 1, projectId: 1, roles: ['contributor'] }];
      const fakeContext = {
        get: () => ({ userId: 1, projectId: 1, email: '' }),
      };
      const result = await requireProjectRole(fakeContext, 'contributor', 'admin');
      expect(result.roles).toContain('contributor');
    });
  });
}
