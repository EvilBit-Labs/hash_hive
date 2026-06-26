/**
 * Integration tests for GET /api/v1/agent/config (#104 U6).
 *
 * Scenarios:
 *   AC1  Happy path — authenticated agent gets its effective config;
 *        body round-trips through effectiveAgentConfigSchema.parse().
 *   AC2  Missing Authorization header → 401.
 *   AC3  Invalid (unknown) bearer token → 401.
 *   AC4  Scope — resolveEffectiveConfig is called with the token's agentId,
 *        never a caller-supplied value.
 *   AC5  Edge — no overrides + empty fleet default → engine defaults
 *        (empty tuning/hardware objects satisfy the schema).
 *
 * Mounts agentRoutes directly (like agent-enroll-routes.test.ts) rather
 * than importing the full app so we avoid the entire module graph and only
 * need to mock the collaborators the /config route actually touches.
 *
 * Uses Pattern B (isolated-phase env gate + dynamic import) because the
 * test mocks agent-config.js and db at module scope.
 * See docs/solutions/conventions/bun-test-mock-module-import-order.md
 */

import { effectiveAgentConfigSchema } from '@hashhive/shared'
import { OpenAPIHono } from '@hono/zod-openapi'
import { describe, expect, it, mock } from 'bun:test'

const IS_ISOLATED = process.env['AGENT_CONFIG_ROUTE_TEST_ISOLATED'] === '1'

if (!IS_ISOLATED) {
  describe('agent-config-route (skipped — runs in isolated phase)', () => {
    it('signals isolation phase is required', () => {
      // oxlint-disable-next-line no-console -- surface phase-gating drift in CI logs
      console.warn(
        '[agent-config-route] skipped — set AGENT_CONFIG_ROUTE_TEST_ISOLATED=1 to run; the agent config route suite did NOT execute in this phase.'
      )
      expect(process.env['AGENT_CONFIG_ROUTE_TEST_ISOLATED']).toBeUndefined()
    })
  })
} else {
  // ─── Fixtures ────────────────────────────────────────────────────────

  const TEST_TOKEN = 'test-agent-config-token'

  // Agent row returned by requireAgentToken's DB lookup for valid token.
  const mockAgent = {
    id: 42,
    projectId: 7,
    status: 'online',
    capabilities: {},
  }

  // Effective config fixture: one tuning knob set, no hardware overrides.
  type AgentConfigService = typeof import('../../src/services/agent-config.js')

  const EFFECTIVE_CONFIG_FIXTURE = {
    tuning: { hashcat: { workloadProfile: 3 } },
    hardware: {},
  } satisfies Awaited<ReturnType<AgentConfigService['resolveEffectiveConfig']>>

  // Engine-defaults fixture: no per-rig or fleet overrides → both objects empty.
  const EMPTY_EFFECTIVE_CONFIG_FIXTURE = {
    tuning: {},
    hardware: {},
  } satisfies Awaited<ReturnType<AgentConfigService['resolveEffectiveConfig']>>

  // ─── Mock DB — requireAgentToken resolves bearer tokens via db.select ─
  //
  // requireAgentToken queries: SELECT … FROM agents WHERE auth_token = ? LIMIT 1.
  // Return mockAgent for the known token; the mock is overridable per-test for
  // the invalid-token case (AC3).

  const mockSelect = mock(() => ({
    from: mock(() => ({
      where: mock(() => ({
        limit: mock(() => Promise.resolve([mockAgent])),
      })),
    })),
  }))

  mock.module('../../src/db/index.js', () => ({
    db: {
      select: mockSelect,
      execute: mock(() => Promise.resolve([])),
    },
    client: {},
  }))

  // ─── Mock agent-config service ────────────────────────────────────────
  //
  // resolveEffectiveConfig is the only service function the /config route
  // calls. The other exports are included so sibling tests that share the
  // bun module cache see the real service's shape, not undefined stubs.

  const resolveEffectiveConfigMock = mock<AgentConfigService['resolveEffectiveConfig']>(
    async () => EFFECTIVE_CONFIG_FIXTURE
  )

  mock.module('../../src/services/agent-config.js', () => ({
    resolveEffectiveConfig: resolveEffectiveConfigMock,
    resolveEffectiveWhitelist: mock(async () => []),
    getAgentConfig: mock(async () => ({})),
    getFleetDefault: mock(async () => ({})),
    updateAgentConfig: mock(async () => ({})),
    updateFleetDefault: mock(async () => ({})),
    mergeEffectiveConfig: mock(() => EFFECTIVE_CONFIG_FIXTURE),
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
  }))

  mock.module('../../src/config/logger.js', () => ({
    logger: {
      info: mock(),
      warn: mock(),
      error: mock(),
      debug: mock(),
    },
  }))

  // ─── Additional mocks required by the agent route module graph ────────
  //
  // agentRoutes imports several service modules at the top level.
  // Each must be mocked before the dynamic import so bun resolves the
  // stubs rather than the real modules (which would pull in db / redis).

  mock.module('../../src/services/agents.js', () => ({
    processHeartbeat: mock(async () => ({ agent: null, hasHighPriorityTasks: false })),
    logAgentError: mock(async () => {}),
    submitBenchmarks: mock(async () => {}),
    classifyRecentErrors: mock(() => ({ count: 0, worstSeverity: null })),
    classifyWorstSeverity: mock(() => null),
    decideHeartbeatTransition: mock(() => null),
    isSecretKey: mock(() => false),
    pickCurrentTaskByAgent: mock(() => new Map()),
    scrubAgentErrorContext: mock((v: unknown) => v),
    __resetWarnedEmptyCapsForTesting: mock(() => {}),
    getAgentById: mock(async () => null),
    listAgents: mock(async () => ({ agents: [], total: 0, limit: 50, offset: 0 })),
    getAgentErrors: mock(async () => []),
    getBenchmarksForAgent: mock(async () => []),
    getAgentBenchmarkForMode: mock(async () => null),
    rotateAgentToken: mock(async () => null),
    updateAgent: mock(async () => null),
    FATAL_SEVERITIES: ['fatal', 'critical', 'error'],
    WARNING_SEVERITIES: ['warning'],
  }))

  mock.module('../../src/services/tasks.js', () => ({
    assignNextTask: mock(async () => null),
    updateTaskProgress: mock(async () => ({ task: null })),
    handleTaskFailure: mock(async () => ({ task: null, retried: false })),
    generateTasksForAttack: mock(async () => ({ tasks: [], count: 0 })),
    reassignStaleTasks: mock(async () => ({
      reassigned: 0,
      rebalanced: 0,
      failedOverrun: 0,
      failedMaxRetries: 0,
      errored: 0,
    })),
    getTaskById: mock(async () => null),
    listTasks: mock(async () => ({ tasks: [], total: 0, limit: 50, offset: 0 })),
    getZapsForTask: mock(async () => ({ zaps: [], hasMore: false })),
    AGENT_TASK_ACTIVE_STATUSES: ['pending', 'assigned', 'running'] as const,
    projectAgentTaskRows: mock(),
    buildCapabilityPredicate: mock(() => ({ sql: 'TRUE' })),
    listTasksByAgent: mock(async () => []),
  }))

  mock.module('../../src/services/tasks/preemption.js', () => ({
    getStopTaskIdsForAgent: mock(async () => []),
  }))

  mock.module('../../src/services/events.js', () => ({
    emitCrackResult: mock(),
    emitTaskUpdate: mock(),
    emitCampaignStatus: mock(),
    emitResourceUpdate: mock(),
    emitAgentError: mock(),
    emitAgentStatus: mock(),
    emit: mock(),
    registerClient: mock(),
    unregisterClient: mock(),
    getClientCount: mock(() => 0),
    broadcastSystemEvent: mock(),
    broadcastSystemHealth: mock(),
    SYSTEM_EVENT_PROJECT_ID: 0 as const,
  }))

  mock.module('../../src/services/crackers.js', () => ({
    getLatestCracker: mock(async () => null),
    getCrackerDownloadUrl: mock(async () => null),
    compareCrackerVersions: mock(() => 0),
    isKnownEngine: mock(() => true),
    normalizeEngineName: mock((e: string) => e),
  }))

  mock.module('../../src/services/resources.js', () => ({
    getAgentDownloadUrl: mock(async () => null),
  }))

  mock.module('../../src/services/agents/whitelist.js', () => ({
    downgradeIfWhitelisted: mock((x: unknown) => x),
  }))

  mock.module('../../src/services/enrollment-tokens.js', () => ({
    claimEnrollmentToken: mock(async () => ({ ok: false, reason: 'invalid' })),
    ConcurrentEnrollmentError: class ConcurrentEnrollmentError extends Error {},
  }))

  // Dynamic import AFTER all mock.module calls (Pattern B).
  // Mount agentRoutes directly (not the full app) to avoid the entire app
  // module graph — mirrors agent-enroll-routes.test.ts.
  const { agentRoutes } = await import('../../src/routes/agent/index.js')
  const { agentToken } = await import('../fixtures.js')

  const app = new OpenAPIHono()
  app.route('/api/v1/agent', agentRoutes)

  const CONFIG_PATH = '/api/v1/agent/config'

  // ─── AC1: Happy path ─────────────────────────────────────────────────

  describe('GET /api/v1/agent/config', () => {
    it('AC1: authenticated agent receives effective config that round-trips the schema', async () => {
      // Arrange
      resolveEffectiveConfigMock.mockResolvedValueOnce(EFFECTIVE_CONFIG_FIXTURE)
      const token = agentToken(TEST_TOKEN)

      // Act
      const res = await app.request(CONFIG_PATH, {
        method: 'GET',
        headers: { authorization: `Bearer ${token}` },
      })

      // Assert
      expect(res.status).toBe(200)
      const body = await res.json()
      // Must round-trip through the shared schema without throwing.
      const parsed = effectiveAgentConfigSchema.parse(body)
      expect(parsed.tuning).toBeDefined()
      expect(parsed.hardware).toBeDefined()
      expect(
        (parsed.tuning as { hashcat?: { workloadProfile?: number } }).hashcat?.workloadProfile
      ).toBe(3)
    })

    // ─── AC2: Missing bearer token → 401 ─────────────────────────────

    it('AC2: missing Authorization header returns 401', async () => {
      // Act — no Authorization header
      const res = await app.request(CONFIG_PATH, {
        method: 'GET',
      })

      // Assert
      expect(res.status).toBe(401)
      const body = (await res.json()) as Record<string, unknown>
      expect(body).toHaveProperty('error')
      const err = body['error'] as Record<string, unknown>
      expect(typeof err['code']).toBe('string')
      expect(typeof err['message']).toBe('string')
    })

    // ─── AC3: Invalid bearer token → 401 ─────────────────────────────

    it('AC3: invalid bearer token returns 401', async () => {
      // Arrange — DB returns no agent for an unknown token.
      mockSelect.mockImplementationOnce(() => ({
        from: mock(() => ({
          where: mock(() => ({
            limit: mock(() => Promise.resolve([])),
          })),
        })),
      }))

      // Act
      const res = await app.request(CONFIG_PATH, {
        method: 'GET',
        headers: { authorization: 'Bearer unknown-bad-token' },
      })

      // Assert
      expect(res.status).toBe(401)
      const body = (await res.json()) as Record<string, unknown>
      const err = body['error'] as Record<string, unknown>
      expect(typeof err['code']).toBe('string')
    })

    // ─── AC4: Scope pinned to token's agent, not a caller-supplied id ─

    it('AC4: resolveEffectiveConfig is called with the token agent id', async () => {
      // Arrange
      resolveEffectiveConfigMock.mockResolvedValueOnce(EFFECTIVE_CONFIG_FIXTURE)
      const token = agentToken(TEST_TOKEN)

      // Act
      const res = await app.request(CONFIG_PATH, {
        method: 'GET',
        headers: { authorization: `Bearer ${token}` },
      })

      // Assert
      expect(res.status).toBe(200)
      // The handler must pass the agentId from the middleware context,
      // which is the id on the agent row the DB mock returns (id: 42).
      expect(resolveEffectiveConfigMock).toHaveBeenCalledWith(mockAgent.id)
    })

    // ─── AC5: No overrides + empty fleet default → engine defaults ────

    it('AC5: no overrides + empty fleet default returns schema-valid empty objects', async () => {
      // Arrange — service returns the minimal valid shape (both objects empty).
      resolveEffectiveConfigMock.mockResolvedValueOnce(EMPTY_EFFECTIVE_CONFIG_FIXTURE)
      const token = agentToken(TEST_TOKEN)

      // Act
      const res = await app.request(CONFIG_PATH, {
        method: 'GET',
        headers: { authorization: `Bearer ${token}` },
      })

      // Assert
      expect(res.status).toBe(200)
      const body = await res.json()
      // Must still parse through the schema (empty objects are valid).
      const parsed = effectiveAgentConfigSchema.parse(body)
      expect(parsed.tuning).toBeDefined()
      expect(parsed.hardware).toBeDefined()
    })
  })
}
