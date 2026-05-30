/**
 * Agent API contract tests.
 *
 * These validate that route handlers return response shapes matching
 * the OpenAPI spec (agent-api.yaml). They use the Hono test client
 * (app.request) and mock the database layer to avoid needing a running
 * database.
 *
 * The middleware validates pre-shared tokens by querying the agents table.
 * We mock the DB to return a valid agent for our test token.
 */
import { agentHeartbeatResponseSchema } from '@hashhive/shared'
import { describe, expect, it, mock } from 'bun:test'

// Mock the DB so requireAgentToken middleware can resolve the pre-shared token.
// Service modules (tasks, campaigns, events) are also mocked to prevent real
// modules from entering bun's shared module cache, which would break mock
// isolation for other test files (e.g., campaign-transition.test.ts).
const TEST_AGENT_TOKEN = 'test-agent-preshared-token'

// Snake_case row kept as a reference for building the camelCase mock below.
// The actual snake→camelCase mapping is validated in tasks.test.ts.
const mockSnakeCaseTaskRow = {
  id: 42,
  attack_id: 7,
  campaign_id: 3,
  agent_id: 1,
  status: 'assigned',
  work_range: { start: 0, end: 10000000 },
  progress: {},
  result_stats: {},
  required_capabilities: {},
  assigned_at: '2026-03-24T00:00:00.000Z',
  started_at: null,
  completed_at: null,
  failure_reason: null,
  retry_count: 0,
  created_at: '2026-03-24T00:00:00.000Z',
  updated_at: '2026-03-24T00:00:00.000Z',
}

const mockAgent = {
  id: 1,
  projectId: 1,
  status: 'online',
  capabilities: {},
}

const mockSelect = mock(() => ({
  from: mock(() => ({
    where: mock(() => ({
      limit: mock(() => Promise.resolve([mockAgent])),
    })),
  })),
}))

const mockExecute = mock(() => Promise.resolve([mockSnakeCaseTaskRow]))

// Pull the real pure helpers in BEFORE mock.module runs so the mock
// factory can re-export them. `mock.module` is process-global in
// bun:test; without this re-export, `agents-service.test.ts` (which
// imports these symbols) gets `undefined` for them when its file is
// loaded *after* this one — a Linux/macOS-load-order CI flake. See
// GOTCHAS.md "Re-export the real implementation when you must mock
// siblings" and the crackers-routes.test.ts precedent.
import {
  classifyRecentErrors as realClassifyRecentErrors,
  classifyWorstSeverity as realClassifyWorstSeverity,
  decideHeartbeatTransition as realDecideHeartbeatTransition,
  pickCurrentTaskByAgent as realPickCurrentTaskByAgent,
  scrubAgentErrorContext as realScrubAgentErrorContext,
} from '../../src/services/agents.js'

mock.module('../../src/services/agents.js', () => ({
  processHeartbeat: mock(() => Promise.resolve({ hasHighPriorityTasks: false })),
  logAgentError: mock(() => Promise.resolve()),
  // Real impls re-exported so sibling tests see the genuine functions
  // regardless of which file bun loads first.
  classifyRecentErrors: realClassifyRecentErrors,
  classifyWorstSeverity: realClassifyWorstSeverity,
  decideHeartbeatTransition: realDecideHeartbeatTransition,
  pickCurrentTaskByAgent: realPickCurrentTaskByAgent,
  scrubAgentErrorContext: realScrubAgentErrorContext,
}))

// Mock events and tasks to prevent real modules from entering the shared bun
// module cache (which leaks across test files via mock.module merge behavior).
// campaigns.js is NOT mocked here — its mock.module overrides leak into other
// files' real campaigns.js via ESM export merging, replacing resolveGenerationStrategy.
// Partial mock: only what this test file needs. Listing every export
// here would replace the real `emit` / `broadcastSystemEvent` process-
// wide, breaking events.test.ts on Linux (where load order makes this
// file run before events.test.ts). Per GOTCHAS.md "Shared module cache":
// `mock.module` merges into the namespace — non-mocked exports pass
// through to the real module.
mock.module('../../src/services/events.js', () => ({
  emitCrackResult: mock(),
  emitTaskUpdate: mock(),
  emitCampaignStatus: mock(),
  emitResourceUpdate: mock(),
}))

// Mock tasks.js so the real module is never cached — the snake_case→camelCase
// mapping is validated in tasks.test.ts; here we only test the route contract.
// This also removes the need to mock campaigns.js (which tasks.js imported).
const mockCamelCaseTask = {
  id: mockSnakeCaseTaskRow.id,
  attackId: mockSnakeCaseTaskRow.attack_id,
  campaignId: mockSnakeCaseTaskRow.campaign_id,
  agentId: mockSnakeCaseTaskRow.agent_id,
  status: mockSnakeCaseTaskRow.status,
  workRange: mockSnakeCaseTaskRow.work_range,
  progress: mockSnakeCaseTaskRow.progress,
  resultStats: mockSnakeCaseTaskRow.result_stats,
  requiredCapabilities: mockSnakeCaseTaskRow.required_capabilities,
  assignedAt: mockSnakeCaseTaskRow.assigned_at,
  startedAt: mockSnakeCaseTaskRow.started_at,
  completedAt: mockSnakeCaseTaskRow.completed_at,
  failureReason: mockSnakeCaseTaskRow.failure_reason,
  retryCount: mockSnakeCaseTaskRow.retry_count,
  createdAt: mockSnakeCaseTaskRow.created_at,
  updatedAt: mockSnakeCaseTaskRow.updated_at,
}

// Pull the real pure helpers in BEFORE mock.module runs so the mock
// factory can re-export them. Without re-export, `agents-service.test.ts`
// would receive our stubs instead of the genuine implementations for
// any file bun loads after this one — the same Linux/macOS-load-order
// CI flake documented in GOTCHAS.md "Re-export the real implementation
// when you must mock siblings."
import {
  AGENT_TASK_ACTIVE_STATUSES as realAgentTaskActiveStatuses,
  projectAgentTaskRows as realProjectAgentTaskRows,
} from '../../src/services/tasks.js'

// Mock tasks.js so the real module is never cached — the snake_case→camelCase
// mapping is validated in tasks.test.ts; here we only test the route contract.
// This also removes the need to mock campaigns.js (which tasks.js imported).
mock.module('../../src/services/tasks.js', () => ({
  assignNextTask: mock(() => Promise.resolve(mockCamelCaseTask)),
  updateTaskProgress: mock(() => Promise.resolve({ acknowledged: true })),
  handleTaskFailure: mock(() => Promise.resolve({ retried: false })),
  generateTasksForAttack: mock(() => Promise.resolve({ tasks: [], count: 0 })),
  reassignStaleTasks: mock(() => Promise.resolve([])),
  getTaskById: mock(() => Promise.resolve(null)),
  listTasks: mock(() => Promise.resolve([])),
  getZapsForTask: mock(() => Promise.resolve({ taskId: 1, hashes: [] })),
  // Re-export real impls so sibling tests see the genuine functions.
  AGENT_TASK_ACTIVE_STATUSES: realAgentTaskActiveStatuses,
  projectAgentTaskRows: realProjectAgentTaskRows,
}))

// Pull the real pure helpers in BEFORE mock.module runs for crackers.js
// so the mock factory can re-export them. Without this, sibling tests
// (crackers-routes.test.ts and any compareCrackerVersions unit suite)
// would receive our stubs instead of the genuine impls — process-global
// mock.module merge per GOTCHAS.md "Re-export the real implementation
// when you must mock siblings."
import {
  compareCrackerVersions as realCompareCrackerVersions,
  isKnownEngine as realIsKnownEngine,
  normalizeEngineName as realNormalizeEngineName,
} from '../../src/services/crackers.js'

// Mock resources.js and crackers.js so the /resources and /cracker routes
// have reachable rejection paths in the contract test. The real modules
// touch the DB and object store; here we only validate the wire envelope
// and exercise the route-level catch with mockImplementationOnce.
mock.module('../../src/services/resources.js', () => ({
  getAgentDownloadUrl: mock(() =>
    Promise.resolve({ url: 'https://example.test/object', expiresIn: 600 })
  ),
}))

mock.module('../../src/services/crackers.js', () => ({
  // DB-touching surfaces get stubbed; pure helpers are re-exported real.
  getLatestCracker: mock(() => Promise.resolve(null)),
  getCrackerDownloadUrl: mock(() =>
    Promise.resolve({ url: 'https://example.test/cracker', expiresIn: 600 })
  ),
  compareCrackerVersions: realCompareCrackerVersions,
  isKnownEngine: realIsKnownEngine,
  normalizeEngineName: realNormalizeEngineName,
}))

mock.module('../../src/db/index.js', () => ({
  db: {
    select: mockSelect,
    execute: mockExecute,
  },
  client: {},
}))

// Mock the logger so route-layer log-shape assertions (the hasError
// branch on /heartbeat's failure-path log, and similar structured logs
// on other agent routes) can verify their argument shape without
// scraping stdout. Mirrors the integration test's pattern in
// tests/integration/agent-heartbeat.test.ts.
const loggerMock = {
  info: mock(),
  warn: mock(),
  error: mock(),
  debug: mock(),
}

mock.module('../../src/config/logger.js', () => ({
  logger: loggerMock,
}))

import { app } from '../../src/index.js'
import { agentToken } from '../fixtures.js'

const AGENT_BASE = '/api/v1/agent'

/**
 * Assert the documented Agent API validation-error envelope
 * (`{error: {code: 'VALIDATION_ERROR', message}}`). This is the contract
 * shape the route-level `agentValidationHook` produces; testing for it
 * (rather than the bare 400) catches regressions where the hook is
 * dropped and zValidator falls back to its `{success, error: ZodError}`
 * default.
 */
async function expectAgentValidationError(res: Response): Promise<void> {
  const body = (await res.json()) as Record<string, unknown>
  expect(body).toHaveProperty('error')
  const err = body['error'] as Record<string, unknown>
  expect(err['code']).toBe('VALIDATION_ERROR')
  expect(typeof err['message']).toBe('string')
}

// ─── POST /sessions — removed (should 404) ──────────────────────────

describe('Agent API: POST /sessions (removed)', () => {
  it('should return 404 since session endpoint no longer exists', async () => {
    const res = await app.request(`${AGENT_BASE}/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: 'some-token' }),
    })

    expect(res.status).toBe(404)
  })
})

// ─── POST /heartbeat — Agent Heartbeat ──────────────────────────────

describe('Agent API: POST /heartbeat', () => {
  it('should return 401 without auth token', async () => {
    const res = await app.request(`${AGENT_BASE}/heartbeat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'online' }),
    })

    expect(res.status).toBe(401)
    const body = await res.json()
    expect(body['error']).toBeDefined()
    expect(body['error']['code']).toBe('AUTH_TOKEN_INVALID')
  })

  it('should return 400 for invalid heartbeat status enum', async () => {
    const token = agentToken(TEST_AGENT_TOKEN)
    const res = await app.request(`${AGENT_BASE}/heartbeat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ status: 'invalid-status' }),
    })

    expect(res.status).toBe(400)
  })

  it('accepts a legacy heartbeat with status only (back-compat baseline)', async () => {
    // Arrange — locks in lenient policy. Existing agents in the wild
    // still post `{status: 'online'}` and nothing else; tightening the
    // schema (e.g., adding .strict()) would silently break them.
    const token = agentToken(TEST_AGENT_TOKEN)

    // Act
    const res = await app.request(`${AGENT_BASE}/heartbeat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ status: 'online' }),
    })

    // Assert
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body['acknowledged']).toBe(true)
    // Pin the omit-when-no-priority-work policy at the contract level.
    // The integration suite mirrors this in
    // `tests/integration/agent-heartbeat.test.ts` (the `.toBeUndefined()`
    // cases on the error-status / empty-hashModes / null-capabilities
    // paths inside the heartbeat-error-handling describe block).
    // Asserting it here keeps a regression where the route emits `false`
    // from slipping past the unit contract test before reaching the
    // integration layer.
    expect(body['hasHighPriorityTasks']).toBeUndefined()
    // Contract proof: the response body satisfies the shared Zod schema.
    // The OpenAPI HeartbeatResponse schema in agent-api.yaml mirrors
    // this Zod schema field-for-field, so a parse() success proves the
    // route handler ↔ shared schema ↔ OpenAPI triple stays in sync.
    expect(() => agentHeartbeatResponseSchema.parse(body)).not.toThrow()
  })

  it('returns hasHighPriorityTasks=true when service flags high-priority work', async () => {
    // Arrange — override the default mock for this single call so the
    // service reports high-priority work is available. The route is
    // expected to surface the flag verbatim per the heartbeat-response
    // contract documented in
    // `docs/issues/155-task-distribution-assignment-spec.md`.
    const { processHeartbeat } = await import('../../src/services/agents.js')
    ;(
      processHeartbeat as unknown as { mockImplementationOnce: (fn: () => unknown) => void }
    ).mockImplementationOnce(() => Promise.resolve({ hasHighPriorityTasks: true }))

    const token = agentToken(TEST_AGENT_TOKEN)

    // Act
    const res = await app.request(`${AGENT_BASE}/heartbeat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ status: 'online' }),
    })

    // Assert
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body['acknowledged']).toBe(true)
    expect(body['hasHighPriorityTasks']).toBe(true)
    // Contract proof against the shared schema (and via mirror, OpenAPI).
    const parsed = agentHeartbeatResponseSchema.parse(body)
    expect(parsed.hasHighPriorityTasks).toBe(true)
  })

  it('returns Agent-shaped envelope with HEARTBEAT_ERROR when processHeartbeat throws', async () => {
    // Arrange — force the service to reject so the route's failure path
    // is exercised. The negative-shape assertions on `timestamp` and
    // `requestId` discriminate the Agent envelope from the dashboard
    // envelope emitted by the global `app.onError`; without them a
    // regression that falls through to the global handler could still
    // satisfy `error.code === 'HEARTBEAT_ERROR'` by accident.
    const { processHeartbeat } = await import('../../src/services/agents.js')
    ;(
      processHeartbeat as unknown as { mockImplementationOnce: (fn: () => unknown) => void }
    ).mockImplementationOnce(() => Promise.reject(new Error('db down')))

    const token = agentToken(TEST_AGENT_TOKEN)

    // Act
    const res = await app.request(`${AGENT_BASE}/heartbeat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ status: 'online' }),
    })

    // Assert
    expect(res.status).toBe(500)
    const body = (await res.json()) as { error: Record<string, unknown> }
    expect(body.error.code).toBe('HEARTBEAT_ERROR')
    // Pin to the literal message. A regression that switches the wire
    // message to `err.message` (e.g., 'db down') would leak internal
    // diagnostic detail to agents; asserting the static string blocks
    // that class of change.
    expect(body.error.message).toBe('Failed to process heartbeat')
    // Negative shape: the Agent envelope omits `timestamp` and
    // `requestId`. Their presence would mean we fell through to the
    // dashboard envelope at `app.onError`.
    expect(body.error['timestamp']).toBeUndefined()
    expect(body.error['requestId']).toBeUndefined()
    // Log shape: the route logs the four documented keys (err, agentId,
    // status, hasError). No error payload was posted so hasError stays
    // false; the hasError=true branch is pinned by the next test.
    const heartbeatErrorLogs = loggerMock.error.mock.calls.filter((call) => {
      const arg = call[0] as Record<string, unknown> | undefined
      return arg?.['err'] !== undefined && arg?.['agentId'] === 1
    })
    expect(heartbeatErrorLogs).toHaveLength(1)
    const logCtx = heartbeatErrorLogs[0]?.[0] as Record<string, unknown>
    expect(logCtx['status']).toBe('online')
    expect(logCtx['hasError']).toBe(false)
  })

  it('logs hasError=true when heartbeat carries an error payload and processHeartbeat throws', async () => {
    // Arrange — pin the second branch of the route's failure-path log
    // (`hasError: Boolean(data.error)`). Without this test a regression
    // that always logs `hasError: false` would land green.
    loggerMock.error.mockClear()
    const { processHeartbeat } = await import('../../src/services/agents.js')
    ;(
      processHeartbeat as unknown as { mockImplementationOnce: (fn: () => unknown) => void }
    ).mockImplementationOnce(() => Promise.reject(new Error('db down')))

    const token = agentToken(TEST_AGENT_TOKEN)

    // Act
    const res = await app.request(`${AGENT_BASE}/heartbeat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        status: 'error',
        error: { severity: 'fatal', message: 'gpu hung' },
      }),
    })

    // Assert
    expect(res.status).toBe(500)
    const heartbeatErrorLogs = loggerMock.error.mock.calls.filter((call) => {
      const arg = call[0] as Record<string, unknown> | undefined
      return arg?.['err'] !== undefined && arg?.['agentId'] === 1
    })
    expect(heartbeatErrorLogs).toHaveLength(1)
    const logCtx = heartbeatErrorLogs[0]?.[0] as Record<string, unknown>
    expect(logCtx['status']).toBe('error')
    expect(logCtx['hasError']).toBe(true)
  })

  it('accepts a heartbeat with currentTask and warning error', async () => {
    // Arrange
    const token = agentToken(TEST_AGENT_TOKEN)

    // Act
    const res = await app.request(`${AGENT_BASE}/heartbeat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        status: 'online',
        currentTask: {
          taskId: 42,
          progress: 0.5,
          speed: 12345,
          temperature: 72,
        },
        error: {
          severity: 'warning',
          message: 'temperature spike',
          context: { gpuId: 0 },
        },
      }),
    })

    // Assert
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body['acknowledged']).toBe(true)
  })

  it('accepts a heartbeat with a fatal error and no currentTask', async () => {
    // Arrange
    const token = agentToken(TEST_AGENT_TOKEN)

    // Act
    const res = await app.request(`${AGENT_BASE}/heartbeat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        status: 'error',
        error: { severity: 'fatal', message: 'hashcat crashed' },
      }),
    })

    // Assert
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body['acknowledged']).toBe(true)
  })

  it('rejects an error.severity outside the warning|fatal enum', async () => {
    const token = agentToken(TEST_AGENT_TOKEN)
    const res = await app.request(`${AGENT_BASE}/heartbeat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        status: 'online',
        error: { severity: 'info', message: 'just a note' },
      }),
    })
    expect(res.status).toBe(400)
    await expectAgentValidationError(res)
  })

  it('rejects an empty error.message', async () => {
    const token = agentToken(TEST_AGENT_TOKEN)
    const res = await app.request(`${AGENT_BASE}/heartbeat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        status: 'online',
        error: { severity: 'warning', message: '' },
      }),
    })
    expect(res.status).toBe(400)
    await expectAgentValidationError(res)
  })

  it('rejects a non-positive currentTask.taskId', async () => {
    const token = agentToken(TEST_AGENT_TOKEN)
    const res = await app.request(`${AGENT_BASE}/heartbeat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        status: 'online',
        currentTask: { taskId: 0, progress: 0, speed: 0 },
      }),
    })
    expect(res.status).toBe(400)
    await expectAgentValidationError(res)
  })

  it('rejects a negative currentTask.progress', async () => {
    const token = agentToken(TEST_AGENT_TOKEN)
    const res = await app.request(`${AGENT_BASE}/heartbeat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        status: 'online',
        currentTask: { taskId: 42, progress: -0.1, speed: 0 },
      }),
    })
    expect(res.status).toBe(400)
    await expectAgentValidationError(res)
  })

  // ─── Size-cap boundaries on error.message and error.context ─────────
  // These guard the DoS-bound `.max(4096)` and `.refine()` 16K-char cap
  // on the heartbeat error block. A refactor that drops either would
  // ship silently without these tests.

  it('accepts an error.message at the 4096-character cap', async () => {
    // Arrange
    const token = agentToken(TEST_AGENT_TOKEN)
    const messageAtCap = 'a'.repeat(4096)

    // Act
    const res = await app.request(`${AGENT_BASE}/heartbeat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        status: 'online',
        error: { severity: 'warning', message: messageAtCap },
      }),
    })

    // Assert
    expect(res.status).toBe(200)
  })

  it('rejects an error.message that exceeds the 4096-character cap', async () => {
    // Arrange
    const token = agentToken(TEST_AGENT_TOKEN)
    const messageOverCap = 'a'.repeat(4097)

    // Act
    const res = await app.request(`${AGENT_BASE}/heartbeat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        status: 'online',
        error: { severity: 'warning', message: messageOverCap },
      }),
    })

    // Assert
    expect(res.status).toBe(400)
    await expectAgentValidationError(res)
  })

  it('rejects an error.context whose JSON serialization exceeds 16K characters', async () => {
    // Arrange — a single string value just past the 16K-char limit so
    // `JSON.stringify(context).length` exceeds HEARTBEAT_ERROR_CONTEXT_MAX_CHARS.
    const token = agentToken(TEST_AGENT_TOKEN)
    const oversized = { blob: 'x'.repeat(16 * 1024 + 1) }

    // Act
    const res = await app.request(`${AGENT_BASE}/heartbeat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        status: 'online',
        error: { severity: 'warning', message: 'big', context: oversized },
      }),
    })

    // Assert
    expect(res.status).toBe(400)
    await expectAgentValidationError(res)
  })

  // ─── Recovery from status='error' via heartbeat ─────────────────────
  // The heartbeat endpoint uses requireAgentTokenForHeartbeatRecovery so an
  // agent whose row was forced to status='error' by a prior fatal
  // heartbeat can post a clean heartbeat to come back online. Every
  // other agent endpoint stays strict (rejects error-state agents).

  it('allows an errored agent to post a recovery heartbeat', async () => {
    // Arrange — simulate an agent that was previously forced to
    // status='error' by a fatal heartbeat. The strict middleware would
    // reject this token; the recovery variant on /heartbeat admits it
    // so processHeartbeat can transition it back to 'online'.
    const token = agentToken(TEST_AGENT_TOKEN)
    const priorStatus = mockAgent.status
    mockAgent.status = 'error'

    try {
      // Act
      const res = await app.request(`${AGENT_BASE}/heartbeat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ status: 'online' }),
      })

      // Assert — the middleware admits the errored agent (200, not 401)
      // and the handler acknowledges.
      expect(res.status).toBe(200)
      const body = (await res.json()) as Record<string, unknown>
      expect(body['acknowledged']).toBe(true)
    } finally {
      mockAgent.status = priorStatus
    }
  })

  it('still rejects errored agents on work endpoints (strict middleware)', async () => {
    // Arrange — same errored row, but posting to /tasks/next (which
    // uses the strict requireAgentToken middleware). Confirms the
    // recovery exemption is heartbeat-only.
    const token = agentToken(TEST_AGENT_TOKEN)
    const priorStatus = mockAgent.status
    mockAgent.status = 'error'

    try {
      // Act
      const res = await app.request(`${AGENT_BASE}/tasks/next`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}` },
      })

      // Assert
      expect(res.status).toBe(401)
      const body = (await res.json()) as Record<string, unknown>
      expect((body['error'] as Record<string, unknown>)['code']).toBe('AUTH_TOKEN_INVALID')
    } finally {
      mockAgent.status = priorStatus
    }
  })
})

// ─── POST /tasks/next — Request Next Task ───────────────────────────

describe('Agent API: POST /tasks/next', () => {
  it('should return 401 without auth token', async () => {
    const res = await app.request(`${AGENT_BASE}/tasks/next`, {
      method: 'POST',
    })

    expect(res.status).toBe(401)
    const body = await res.json()
    expect(body['error']).toBeDefined()
  })

  it('returns camelCase task descriptor when task is available', async () => {
    const token = agentToken(TEST_AGENT_TOKEN)
    const res = await app.request(`${AGENT_BASE}/tasks/next`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
      },
    })

    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    const task = body['task'] as Record<string, unknown>

    // Task should be present
    expect(task).not.toBeNull()

    // camelCase keys should be defined
    expect(task['attackId']).toBeDefined()
    expect(task['campaignId']).toBeDefined()
    expect(task['workRange']).toBeDefined()

    // retryCount is part of the documented TaskDescriptor contract and
    // is always present (backed by a NOT NULL DEFAULT 0 column). Assert
    // the field is exposed with the expected value so generated agent
    // clients can rely on it.
    expect(task).toHaveProperty('retryCount')
    expect(task['retryCount']).toBe(mockSnakeCaseTaskRow.retry_count)

    // snake_case keys should be absent
    expect(task['attack_id']).toBeUndefined()
    expect(task['campaign_id']).toBeUndefined()
    expect(task['work_range']).toBeUndefined()
    expect(task['retry_count']).toBeUndefined()
  })

  it('round-trips a non-zero retryCount through the snake↔camel projection', async () => {
    // toHaveProperty passes even on an explicit undefined; assert a real
    // non-zero value so a regression that drops the column projection is
    // caught here rather than at runtime in the agent client.
    const tasksMod = await import('../../src/services/tasks.js')
    const assignNextTaskMock = tasksMod.assignNextTask as unknown as ReturnType<typeof mock>
    assignNextTaskMock.mockImplementationOnce(() =>
      Promise.resolve({ ...mockCamelCaseTask, retryCount: 2 })
    )

    const token = agentToken(TEST_AGENT_TOKEN)
    const res = await app.request(`${AGENT_BASE}/tasks/next`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
    })

    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    const task = body['task'] as Record<string, unknown>
    expect(task['retryCount']).toBe(2)
    expect(task['retryCount']).not.toBeUndefined()
  })
})

// ─── POST /tasks/:id/report — Report Task Progress ─────────────────

describe('Agent API: POST /tasks/:id/report', () => {
  it('should return 401 without auth token', async () => {
    const res = await app.request(`${AGENT_BASE}/tasks/1/report`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'running' }),
    })

    expect(res.status).toBe(401)
  })

  it('should return 400 for invalid status enum', async () => {
    const token = agentToken(TEST_AGENT_TOKEN)
    const res = await app.request(`${AGENT_BASE}/tasks/1/report`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ status: 'not-a-valid-status' }),
    })

    expect(res.status).toBe(400)
  })
})

// ─── POST /errors — Report Agent Error ──────────────────────────────

describe('Agent API: POST /errors', () => {
  it('should return 401 without auth token', async () => {
    const res = await app.request(`${AGENT_BASE}/errors`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ severity: 'error', message: 'test error' }),
    })

    expect(res.status).toBe(401)
  })

  it('should return 400 for missing required fields', async () => {
    const token = agentToken(TEST_AGENT_TOKEN)
    const res = await app.request(`${AGENT_BASE}/errors`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({}),
    })

    expect(res.status).toBe(400)
  })

  it('should return 400 for invalid severity enum', async () => {
    const token = agentToken(TEST_AGENT_TOKEN)
    const res = await app.request(`${AGENT_BASE}/errors`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ severity: 'invalid', message: 'test' }),
    })

    expect(res.status).toBe(400)
  })
})

// ─── Failure-path envelope contract across all wrapped agent routes ──
//
// Every agent route now wraps its primary service call in try/catch and
// returns the Agent envelope `{ error: { code, message } }` at HTTP 500
// instead of falling through to the global `app.onError` (which would
// emit the dashboard envelope). These tests pin each route's coarse
// code value AND assert the negative envelope shape — the same
// regression guard already in place for HEARTBEAT_ERROR.

/**
 * Verify that the response is the Agent envelope at HTTP 500 with the
 * expected coarse code. `timestamp`/`requestId` MUST be absent;
 * presence means we fell through to the dashboard envelope at
 * `app.onError`.
 */
async function expectAgentFailureEnvelope(res: Response, expectedCode: string): Promise<void> {
  expect(res.status).toBe(500)
  const body = (await res.json()) as { error: Record<string, unknown> }
  expect(body.error.code).toBe(expectedCode)
  expect(typeof body.error.message).toBe('string')
  expect((body.error.message as string).length).toBeGreaterThan(0)
  expect(body.error['timestamp']).toBeUndefined()
  expect(body.error['requestId']).toBeUndefined()
}

describe('Agent API: failure-path envelope shape', () => {
  it('POST /tasks/next returns TASK_ASSIGN_ERROR when assignNextTask throws', async () => {
    const tasksMod = await import('../../src/services/tasks.js')
    ;(
      tasksMod.assignNextTask as unknown as { mockImplementationOnce: (fn: () => unknown) => void }
    ).mockImplementationOnce(() => Promise.reject(new Error('db down')))

    const token = agentToken(TEST_AGENT_TOKEN)
    const res = await app.request(`${AGENT_BASE}/tasks/next`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
    })

    await expectAgentFailureEnvelope(res, 'TASK_ASSIGN_ERROR')
  })

  it('POST /tasks/:id/report returns TASK_REPORT_ERROR when updateTaskProgress throws', async () => {
    const tasksMod = await import('../../src/services/tasks.js')
    ;(
      tasksMod.updateTaskProgress as unknown as {
        mockImplementationOnce: (fn: () => unknown) => void
      }
    ).mockImplementationOnce(() => Promise.reject(new Error('db down')))

    const token = agentToken(TEST_AGENT_TOKEN)
    const res = await app.request(`${AGENT_BASE}/tasks/42/report`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ status: 'running' }),
    })

    await expectAgentFailureEnvelope(res, 'TASK_REPORT_ERROR')
  })

  it('GET /tasks/:id/zaps returns TASK_ZAP_ERROR when getZapsForTask throws', async () => {
    const tasksMod = await import('../../src/services/tasks.js')
    ;(
      tasksMod.getZapsForTask as unknown as { mockImplementationOnce: (fn: () => unknown) => void }
    ).mockImplementationOnce(() => Promise.reject(new Error('db down')))

    const token = agentToken(TEST_AGENT_TOKEN)
    const res = await app.request(`${AGENT_BASE}/tasks/42/zaps`, {
      method: 'GET',
      headers: { authorization: `Bearer ${token}` },
    })

    await expectAgentFailureEnvelope(res, 'TASK_ZAP_ERROR')
  })

  it('POST /errors returns ERROR_INGEST_ERROR when logAgentError throws', async () => {
    const agentsMod = await import('../../src/services/agents.js')
    ;(
      agentsMod.logAgentError as unknown as { mockImplementationOnce: (fn: () => unknown) => void }
    ).mockImplementationOnce(() => Promise.reject(new Error('db down')))

    const token = agentToken(TEST_AGENT_TOKEN)
    const res = await app.request(`${AGENT_BASE}/errors`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ severity: 'warning', message: 'test' }),
    })

    await expectAgentFailureEnvelope(res, 'ERROR_INGEST_ERROR')
  })

  it('GET /resources/:type/:id/download-url returns RESOURCE_URL_ERROR when getAgentDownloadUrl throws', async () => {
    const resourcesMod = await import('../../src/services/resources.js')
    ;(
      resourcesMod.getAgentDownloadUrl as unknown as {
        mockImplementationOnce: (fn: () => unknown) => void
      }
    ).mockImplementationOnce(() => Promise.reject(new Error('object store down')))

    const token = agentToken(TEST_AGENT_TOKEN)
    const res = await app.request(`${AGENT_BASE}/resources/wordlist/1/download-url`, {
      method: 'GET',
      headers: { authorization: `Bearer ${token}` },
    })

    await expectAgentFailureEnvelope(res, 'RESOURCE_URL_ERROR')
  })

  it('POST /cracker/check-update returns CRACKER_UPDATE_ERROR when getLatestCracker throws', async () => {
    const crackersMod = await import('../../src/services/crackers.js')
    ;(
      crackersMod.getLatestCracker as unknown as {
        mockImplementationOnce: (fn: () => unknown) => void
      }
    ).mockImplementationOnce(() => Promise.reject(new Error('db down')))

    const token = agentToken(TEST_AGENT_TOKEN)
    const res = await app.request(`${AGENT_BASE}/cracker/check-update`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ engine: 'hashcat', platform: 'linux-x86_64', version: '6.2.7' }),
    })

    await expectAgentFailureEnvelope(res, 'CRACKER_UPDATE_ERROR')
  })
})
