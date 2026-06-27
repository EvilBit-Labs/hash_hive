/**
 * Dashboard agent-config routes integration tests (#104 U5).
 *
 * Tests:
 *   AE1  GET /agents/:id/config returns per-knob sources for a one-override rig
 *   AE2  GET /agents/:id/config returns 404 for a cross-project agent
 *   AE3  PATCH /agents/:id/config persists + round-trips the shared schema
 *   AE4  PATCH /agents/:id/config with invalid raw-flag returns typed 4xx not 500
 *   AE5  PATCH /fleet-agent-config returns 403 for a non-admin user
 *   AE6  GET /fleet-agent-config returns 200
 *   AE7  PATCH /fleet-agent-config returns 200 for an admin
 *
 * Uses Pattern B (isolated-phase env gate + dynamic import) because the
 * test mocks auth, DB, and service collaborators at module scope.
 * See docs/solutions/conventions/bun-test-mock-module-import-order.md
 */

import { beforeAll, describe, expect, it, mock } from 'bun:test'

const IS_ISOLATED = process.env['DASHBOARD_AGENT_CONFIG_TEST_ISOLATED'] === '1'

if (!IS_ISOLATED) {
  // Skip-stub: running without the isolation gate leaks module-scope
  // mock.module() calls into the catch-all bun test phase. The isolated
  // phase in package.json sets this env var before running this file.
  describe('dashboard-agent-config-routes (skipped — runs in isolated phase)', () => {
    it('signals isolation phase is required', () => {
      console.warn(
        '[dashboard-agent-config] skipped — set DASHBOARD_AGENT_CONFIG_TEST_ISOLATED=1 to run.'
      )
      expect(process.env['DASHBOARD_AGENT_CONFIG_TEST_ISOLATED']).toBeUndefined()
    })
  })
} else {
  // ─── Fixtures ────────────────────────────────────────────────────────

  const ADMIN_COOKIE = 'hh.session_token=valid-admin-session'
  const CONTRIBUTOR_COOKIE = 'hh.session_token=valid-contributor-session'
  // A project member whose membership role is below 'contributor' (viewer):
  // used to prove the per-rig PATCH gate rejects read-only members.
  const VIEWER_COOKIE = 'hh.session_token=valid-viewer-session'

  // ─── Mock BetterAuth ─────────────────────────────────────────────────

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
                id: 'sess-admin',
                userId: '1',
                token: 'tok-admin',
                expiresAt: new Date(Date.now() + 3600000),
                projectId: 1,
              },
            }
          }
          if (cookie.includes('valid-contributor-session')) {
            return {
              user: {
                id: '2',
                email: 'contrib@test.local',
                name: 'Contributor',
                emailVerified: true,
                image: null,
                // analyst role — not 'admin', so PATCH /fleet-agent-config -> 403
                roles: ['analyst'],
              },
              session: {
                id: 'sess-contrib',
                userId: '2',
                token: 'tok-contrib',
                expiresAt: new Date(Date.now() + 3600000),
                projectId: 1,
              },
            }
          }
          if (cookie.includes('valid-viewer-session')) {
            return {
              user: {
                id: '3',
                email: 'viewer@test.local',
                name: 'Viewer',
                emailVerified: true,
                image: null,
                roles: ['analyst'],
              },
              session: {
                id: 'sess-viewer',
                userId: '3',
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

  // ─── Mock Auth Service (project membership) ──────────────────────────

  mock.module('../../src/services/auth.js', () => ({
    getUserWithProjects: async (userId: number) => {
      if (userId === 1) return { id: 1, projects: [{ projectId: 1, roles: ['admin'] }] }
      if (userId === 2) return { id: 2, projects: [{ projectId: 1, roles: ['contributor'] }] }
      if (userId === 3) return { id: 3, projects: [{ projectId: 1, roles: ['viewer'] }] }
      return null
    },
    findProjectMembership: async (userId: number, projectId: number) => {
      if (projectId !== 1) return null
      if (userId === 1) return { projectId: 1, roles: ['admin'] }
      if (userId === 2) return { projectId: 1, roles: ['contributor'] }
      if (userId === 3) return { projectId: 1, roles: ['viewer'] }
      return null
    },
    getUserLastProjectId: async () => null,
    setUserLastProjectIdIfMember: async () => 1,
    setUserLastProjectId: async () => undefined,
    getUserApiKeyMetadata: async () => ({ hasKey: false }),
    issueUserApiKey: async () => ({ token: 'stub', metadata: { hasKey: false } }),
    revokeUserApiKey: async () => undefined,
  }))

  // ─── Per-rig config fixture (AE1, AE3, AE4) ─────────────────────────
  // Agent 100 is in project 1, has a single override (workloadProfile=3).
  // Agent 200 is in project 999 (cross-project), used for AE2.

  const RIG_100_CONFIG = { tuning: { hashcat: { workloadProfile: 3 } } }
  const FLEET_CONFIG = { tuning: { hashcat: { kernelAccel: 8 } } }

  // ─── Mock Agents Service ──────────────────────────────────────────────

  type AgentsService = typeof import('../../src/services/agents.js')
  type AgentRow = NonNullable<Awaited<ReturnType<AgentsService['getAgentById']>>>

  function makeAgent(p: Partial<AgentRow> & Pick<AgentRow, 'id' | 'projectId'>): AgentRow {
    return {
      id: p.id,
      projectId: p.projectId,
      name: p.name ?? `Agent ${p.id}`,
      status: p.status ?? 'online',
      operatingSystemId: p.operatingSystemId ?? null,
      authToken: p.authToken ?? 'tok',
      authTokenHash: p.authTokenHash ?? null,
      authTokenFormat: p.authTokenFormat ?? 'plaintext',
      capabilities: p.capabilities ?? {},
      hardwareProfile: p.hardwareProfile ?? {},
      crackerVersion: p.crackerVersion ?? null,
      lastSeenAt: p.lastSeenAt ?? new Date(),
      createdAt: p.createdAt ?? new Date(),
      updatedAt: p.updatedAt ?? new Date(),
    }
  }

  mock.module('../../src/services/agents.js', () => ({
    getAgentById: mock(async (id: number) => {
      if (id === 100) return makeAgent({ id: 100, projectId: 1, name: 'Rig Alpha' })
      if (id === 200) return makeAgent({ id: 200, projectId: 999, name: 'Rig Beta' })
      return null
    }),
    listAgents: mock(async () => ({ agents: [], total: 0, limit: 50, offset: 0 })),
    getAgentErrors: mock(async () => []),
    getBenchmarksForAgent: mock(async () => []),
    getAgentBenchmarkForMode: mock(async () => null),
    rotateAgentToken: mock(async () => null),
    updateAgent: mock(async () => null),
    logAgentError: mock(async () => {}),
    submitBenchmarks: mock(async () => {}),
    classifyWorstSeverity: mock(() => null),
    classifyRecentErrors: mock(() => ({ count: 0, worstSeverity: null })),
    pickCurrentTaskByAgent: mock(() => new Map()),
    decideHeartbeatTransition: mock(() => null),
    isSecretKey: mock(() => false),
    scrubAgentErrorContext: mock((v: unknown) => v),
    processHeartbeat: mock(async () => {}),
    __resetWarnedEmptyCapsForTesting: mock(() => {}),
    FATAL_SEVERITIES: ['fatal', 'critical', 'error'],
    WARNING_SEVERITIES: ['warning'],
  }))

  // ─── Mock Agent Config Service ────────────────────────────────────────
  //
  // Mock pins mirror the service's ReturnType per the contract-test-mocks
  // convention (AGENTS.md: "mocking against the route schema means the schema
  // is testing itself").

  type AgentConfigService = typeof import('../../src/services/agent-config.js')

  let updateAgentConfigImpl: AgentConfigService['updateAgentConfig'] = mock(
    async () =>
      ({ tuning: { hashcat: { workloadProfile: 3 } } }) satisfies Awaited<
        ReturnType<AgentConfigService['updateAgentConfig']>
      >
  )

  let updateFleetDefaultImpl: AgentConfigService['updateFleetDefault'] = mock(
    async () =>
      ({ tuning: { hashcat: { kernelAccel: 8 } } }) satisfies Awaited<
        ReturnType<AgentConfigService['updateFleetDefault']>
      >
  )

  mock.module('../../src/services/agent-config.js', () => ({
    getAgentConfig: mock(
      async (agentId: number) =>
        (agentId === 100 ? RIG_100_CONFIG : {}) satisfies Awaited<
          ReturnType<AgentConfigService['getAgentConfig']>
        >
    ),
    getFleetDefault: mock(
      async () => FLEET_CONFIG satisfies Awaited<ReturnType<AgentConfigService['getFleetDefault']>>
    ),
    updateAgentConfig: mock(async (...args: Parameters<AgentConfigService['updateAgentConfig']>) =>
      updateAgentConfigImpl(...args)
    ),
    updateFleetDefault: mock(
      async (...args: Parameters<AgentConfigService['updateFleetDefault']>) =>
        updateFleetDefaultImpl(...args)
    ),
    resolveEffectiveConfig: mock(
      async () =>
        ({ tuning: { hashcat: {} }, hardware: {} }) satisfies Awaited<
          ReturnType<AgentConfigService['resolveEffectiveConfig']>
        >
    ),
    mergeEffectiveConfig: mock(
      (
        perRig: Parameters<AgentConfigService['mergeEffectiveConfig']>[0],
        fleet: Parameters<AgentConfigService['mergeEffectiveConfig']>[1]
      ) => {
        const fleetHashcat = fleet.tuning?.hashcat
        const rigHashcat = perRig.tuning?.hashcat
        const mergedHashcat =
          fleetHashcat !== undefined || rigHashcat !== undefined
            ? { ...fleetHashcat, ...rigHashcat }
            : undefined
        const tuning = mergedHashcat !== undefined ? { hashcat: mergedHashcat } : {}
        return { tuning, hardware: perRig.hardware ?? {} }
      }
    ),
    mergeWhitelist: mock(() => []),
    validateRawFlags: mock(() => ({ ok: true })),
    AgentNotFoundError: class AgentNotFoundError extends Error {
      constructor(agentId: number) {
        super(`Agent ${agentId} not found`)
        this.name = 'AgentNotFoundError'
      }
    },
    RawFlagValidationError: class RawFlagValidationError extends Error {
      readonly code: string
      constructor(code: string, message: string) {
        super(message)
        this.name = 'RawFlagValidationError'
        this.code = code
      }
    },
    resolveEffectiveWhitelist: mock(async () => []),
  }))

  // ─── Mock DB / Redis (module graph needs them resolvable) ─────────────

  mock.module('../../src/db/index.js', () => ({
    db: {
      select: () => ({
        from: () => ({
          where: () => ({ limit: () => Promise.resolve([]) }),
          innerJoin: () => ({ where: () => Promise.resolve([]) }),
        }),
      }),
      insert: () => ({ values: () => ({ returning: () => Promise.resolve([]) }) }),
      update: () => ({
        set: () => ({ where: () => ({ returning: () => Promise.resolve([]) }) }),
      }),
      transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn({}),
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

  // ─── Dynamic import (must come after all mock.module calls) ──────────

  let app: Awaited<typeof import('../../src/index.js')>['app']

  beforeAll(async () => {
    ;({ app } = await import('../../src/index.js'))
  })

  const DASH = '/api/v1/dashboard'

  // ─── AE1: GET /agents/:id/config — per-knob source map ───────────────

  describe('GET /agents/:id/config', () => {
    it('AE1: returns per-knob sources for a one-override rig', async () => {
      const res = await app.request(`${DASH}/agents/100/config`, {
        headers: {
          cookie: ADMIN_COOKIE,
          origin: 'http://lab.local',
          host: 'lab.local',
        },
      })
      expect(res.status).toBe(200)
      const body = (await res.json()) as {
        config: unknown
        effective: unknown
        sources: {
          tuning?: { hashcat?: { workloadProfile?: string; kernelAccel?: string } }
        }
      }
      // workloadProfile comes from the rig → 'override'
      expect(body.sources.tuning?.hashcat?.workloadProfile).toBe('override')
      // kernelAccel comes from the fleet only → 'fleet'
      expect(body.sources.tuning?.hashcat?.kernelAccel).toBe('fleet')
    })

    it('AE2: returns 404 for a cross-project agent', async () => {
      const res = await app.request(`${DASH}/agents/200/config`, {
        headers: {
          cookie: ADMIN_COOKIE,
          origin: 'http://lab.local',
          host: 'lab.local',
        },
      })
      expect(res.status).toBe(404)
      const body = (await res.json()) as { error?: { code?: string } }
      expect(body.error?.code).toBe('RESOURCE_NOT_FOUND')
    })
  })

  // ─── AE3: PATCH /agents/:id/config — happy path ──────────────────────

  describe('PATCH /agents/:id/config', () => {
    it('AE3: happy path persists + round-trips via shared schema', async () => {
      const patch = { tuning: { hashcat: { workloadProfile: 4 } } }
      const res = await app.request(`${DASH}/agents/100/config`, {
        method: 'PATCH',
        headers: {
          cookie: ADMIN_COOKIE,
          origin: 'http://lab.local',
          host: 'lab.local',
          'content-type': 'application/json',
        },
        body: JSON.stringify(patch),
      })
      expect(res.status).toBe(200)
      const body = (await res.json()) as {
        config: { tuning?: { hashcat?: { workloadProfile?: number } } }
        effective: unknown
        sources: unknown
      }
      // The mock returns workloadProfile=3 (the stored value); the response
      // round-trips it through the shared agentConfigSchema.
      expect(typeof body.config.tuning?.hashcat?.workloadProfile).toBe('number')
    })

    it('AE4: invalid raw-flag PATCH returns typed 400 not 500', async () => {
      // Override the mock to throw a RawFlagValidationError
      const { RawFlagValidationError: RFVError } =
        await import('../../src/services/agent-config.js')
      updateAgentConfigImpl = mock(async () => {
        throw new (RFVError as typeof import('../../src/services/agent-config.js').RawFlagValidationError)(
          'RAW_FLAGS_DENIED',
          'Flag "--outfile" is not permitted'
        )
      })

      const patch = { tuning: { hashcat: { rawFlags: '--outfile /tmp/x' } } }
      const res = await app.request(`${DASH}/agents/100/config`, {
        method: 'PATCH',
        headers: {
          cookie: ADMIN_COOKIE,
          origin: 'http://lab.local',
          host: 'lab.local',
          'content-type': 'application/json',
        },
        body: JSON.stringify(patch),
      })
      expect(res.status).toBe(400)
      const body = (await res.json()) as { error?: { code?: string; message?: string } }
      expect(body.error?.code).toBe('RAW_FLAG_INVALID')
      // Reset for subsequent tests
      updateAgentConfigImpl = mock(
        async () =>
          ({ tuning: { hashcat: { workloadProfile: 3 } } }) satisfies Awaited<
            ReturnType<AgentConfigService['updateAgentConfig']>
          >
      )
    })

    it('a viewer (below contributor) PATCH /agents/:id/config returns 403', async () => {
      // The per-rig PATCH gate is requireMembershipRole('admin','contributor');
      // a project member with only the 'viewer' role must be rejected. This is
      // distinct from the fleet PATCH global-admin gate (AE5).
      const res = await app.request(`${DASH}/agents/100/config`, {
        method: 'PATCH',
        headers: {
          cookie: VIEWER_COOKIE,
          origin: 'http://lab.local',
          host: 'lab.local',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ tuning: { hashcat: { workloadProfile: 2 } } }),
      })
      expect(res.status).toBe(403)
    })
  })

  // ─── AE5: PATCH /fleet-agent-config — non-admin gets 403 ─────────────

  describe('PATCH /fleet-agent-config', () => {
    it('AE5: non-admin PATCH /fleet-agent-config returns 403', async () => {
      const res = await app.request(`${DASH}/fleet-agent-config`, {
        method: 'PATCH',
        headers: {
          cookie: CONTRIBUTOR_COOKIE,
          origin: 'http://lab.local',
          host: 'lab.local',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ tuning: { hashcat: { workloadProfile: 2 } } }),
      })
      expect(res.status).toBe(403)
    })

    it('AE7: admin PATCH /fleet-agent-config returns 200', async () => {
      const res = await app.request(`${DASH}/fleet-agent-config`, {
        method: 'PATCH',
        headers: {
          cookie: ADMIN_COOKIE,
          origin: 'http://lab.local',
          host: 'lab.local',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ tuning: { hashcat: { kernelAccel: 16 } } }),
      })
      expect(res.status).toBe(200)
      const body = (await res.json()) as {
        config: { tuning?: { hashcat?: { kernelAccel?: number } } }
      }
      expect(body.config).toBeDefined()
    })
  })

  // ─── AE6: GET /fleet-agent-config ────────────────────────────────────

  describe('GET /fleet-agent-config', () => {
    it('AE6: returns 200 with fleet config', async () => {
      const res = await app.request(`${DASH}/fleet-agent-config`, {
        headers: {
          cookie: ADMIN_COOKIE,
          origin: 'http://lab.local',
          host: 'lab.local',
        },
      })
      expect(res.status).toBe(200)
      const body = (await res.json()) as { config: unknown }
      expect(body.config).toBeDefined()
    })
  })
} // end IS_ISOLATED branch
