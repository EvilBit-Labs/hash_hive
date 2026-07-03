/**
 * Pure-helper tests for src/services/agents.ts.
 *
 * The list-endpoint enrichment policy (which severities count, which active
 * task wins the row, how the badge color is chosen) lives in two layers:
 * the SQL aggregate and the deterministic ORDER BY in fetchCurrentTasks.
 * Those layers are mirrored by two pure helpers (`classifyRecentErrors` /
 * `pickCurrentTaskByAgent`) exported for unit testing without a database.
 *
 * If these tests pass but the dashboard renders wrong, the bug is in the
 * SQL layer; if they fail, the policy itself drifted.
 */
import { describe, expect, it } from 'bun:test'

import {
  classifyRecentErrors,
  classifyWorstSeverity,
  decideHeartbeatTransition,
  pickCurrentTaskByAgent,
  scrubAgentErrorContext,
} from '../../src/services/agents.js'
import { AGENT_TASK_ACTIVE_STATUSES, projectAgentTaskRows } from '../../src/services/tasks.js'

describe('classifyRecentErrors', () => {
  it('returns count 0 and null worstSeverity when there are no rows', () => {
    expect(classifyRecentErrors([])).toEqual({ count: 0, worstSeverity: null })
  })

  it('classifies only-warning rows as worstSeverity=warning', () => {
    const result = classifyRecentErrors([{ severity: 'warning' }, { severity: 'WARNING' }])
    expect(result.count).toBe(2)
    expect(result.worstSeverity).toBe('warning')
  })

  it('classifies a single fatal/critical/error row as worstSeverity=fatal', () => {
    expect(classifyRecentErrors([{ severity: 'fatal' }]).worstSeverity).toBe('fatal')
    expect(classifyRecentErrors([{ severity: 'critical' }]).worstSeverity).toBe('fatal')
    expect(classifyRecentErrors([{ severity: 'error' }]).worstSeverity).toBe('fatal')
  })

  it('treats fatal as dominant over warning when both are present', () => {
    const result = classifyRecentErrors([
      { severity: 'warning' },
      { severity: 'error' },
      { severity: 'warning' },
    ])
    expect(result.count).toBe(3)
    expect(result.worstSeverity).toBe('fatal')
  })

  it('excludes unknown severities from count and worstSeverity', () => {
    const result = classifyRecentErrors([
      { severity: 'info' },
      { severity: 'debug' },
      { severity: 'notice' },
    ])
    expect(result.count).toBe(0)
    expect(result.worstSeverity).toBe(null)
  })

  it('counts only allowlisted severities even when unknown rows are present', () => {
    const result = classifyRecentErrors([
      { severity: 'info' },
      { severity: 'warning' },
      { severity: 'debug' },
      { severity: 'critical' },
    ])
    expect(result.count).toBe(2)
    expect(result.worstSeverity).toBe('fatal')
  })

  it('is case-insensitive for severity matching', () => {
    expect(classifyRecentErrors([{ severity: 'FATAL' }]).worstSeverity).toBe('fatal')
    expect(classifyRecentErrors([{ severity: 'Critical' }]).worstSeverity).toBe('fatal')
    expect(classifyRecentErrors([{ severity: 'WaRnInG' }]).worstSeverity).toBe('warning')
  })
})

describe('classifyWorstSeverity', () => {
  it('returns null when neither flag is set', () => {
    expect(classifyWorstSeverity({ hasFatal: false, hasWarning: false })).toBe(null)
  })

  it('returns warning when only warning is set', () => {
    expect(classifyWorstSeverity({ hasFatal: false, hasWarning: true })).toBe('warning')
  })

  it('returns fatal when fatal is set (regardless of warning)', () => {
    expect(classifyWorstSeverity({ hasFatal: true, hasWarning: false })).toBe('fatal')
    expect(classifyWorstSeverity({ hasFatal: true, hasWarning: true })).toBe('fatal')
  })
})

describe('pickCurrentTaskByAgent', () => {
  const baseTask = {
    campaignId: 7,
    campaignName: 'Audit',
    attackId: 9,
    attackMode: 0,
  } as const

  it('returns an empty map for no rows', () => {
    expect(pickCurrentTaskByAgent([]).size).toBe(0)
  })

  it('skips rows whose agentId is null', () => {
    const result = pickCurrentTaskByAgent([
      { taskId: 1, agentId: null, status: 'running', ...baseTask },
    ])
    expect(result.size).toBe(0)
  })

  it('prefers running over assigned for the same agent', () => {
    const result = pickCurrentTaskByAgent([
      {
        taskId: 1,
        agentId: 42,
        status: 'assigned',
        startedAt: null,
        assignedAt: new Date('2026-01-01T00:00:00Z'),
        ...baseTask,
      },
      {
        taskId: 2,
        agentId: 42,
        status: 'running',
        startedAt: new Date('2025-12-30T00:00:00Z'),
        assignedAt: new Date('2025-12-30T00:00:00Z'),
        ...baseTask,
      },
    ])
    expect(result.get(42)?.id).toBe(2)
    expect(result.get(42)?.status).toBe('running')
  })

  it('within the same status, prefers most recent startedAt', () => {
    const result = pickCurrentTaskByAgent([
      {
        taskId: 1,
        agentId: 42,
        status: 'running',
        startedAt: new Date('2026-01-01T00:00:00Z'),
        ...baseTask,
      },
      {
        taskId: 2,
        agentId: 42,
        status: 'running',
        startedAt: new Date('2026-01-05T00:00:00Z'),
        ...baseTask,
      },
    ])
    expect(result.get(42)?.id).toBe(2)
  })

  it('within the same status and no startedAt, falls back to assignedAt', () => {
    const result = pickCurrentTaskByAgent([
      {
        taskId: 1,
        agentId: 42,
        status: 'assigned',
        startedAt: null,
        assignedAt: new Date('2026-01-01T00:00:00Z'),
        ...baseTask,
      },
      {
        taskId: 2,
        agentId: 42,
        status: 'assigned',
        startedAt: null,
        assignedAt: new Date('2026-01-05T00:00:00Z'),
        ...baseTask,
      },
    ])
    expect(result.get(42)?.id).toBe(2)
  })

  it('keys results by agent — different agents get their own rows', () => {
    const result = pickCurrentTaskByAgent([
      {
        taskId: 1,
        agentId: 1,
        status: 'running',
        startedAt: new Date('2026-01-01T00:00:00Z'),
        ...baseTask,
      },
      {
        taskId: 2,
        agentId: 2,
        status: 'running',
        startedAt: new Date('2026-01-01T00:00:00Z'),
        ...baseTask,
      },
    ])
    expect(result.size).toBe(2)
    expect(result.get(1)?.id).toBe(1)
    expect(result.get(2)?.id).toBe(2)
  })

  it('accepts ISO-string timestamps as well as Date instances', () => {
    const result = pickCurrentTaskByAgent([
      {
        taskId: 1,
        agentId: 42,
        status: 'running',
        startedAt: '2026-01-01T00:00:00Z',
        ...baseTask,
      },
      {
        taskId: 2,
        agentId: 42,
        status: 'running',
        startedAt: '2026-01-05T00:00:00Z',
        ...baseTask,
      },
    ])
    expect(result.get(42)?.id).toBe(2)
  })
})

describe('projectAgentTaskRows', () => {
  it('converts Date startedAt/assignedAt to ISO strings', () => {
    const started = new Date('2026-03-01T10:00:00Z')
    const assigned = new Date('2026-03-01T09:00:00Z')
    const result = projectAgentTaskRows([
      {
        id: 1,
        campaignId: 7,
        campaignName: 'Audit',
        attackId: 3,
        attackMode: 0,
        status: 'running',
        progress: { percent: 50 },
        startedAt: started,
        assignedAt: assigned,
      },
    ])
    expect(result[0]?.startedAt).toBe(started.toISOString())
    expect(result[0]?.assignedAt).toBe(assigned.toISOString())
    expect(result[0]?.progress).toEqual({ percent: 50 })
  })

  it('preserves null startedAt/assignedAt without crashing', () => {
    const result = projectAgentTaskRows([
      {
        id: 1,
        campaignId: 7,
        campaignName: 'Audit',
        attackId: 3,
        attackMode: 0,
        status: 'pending',
        progress: null,
        startedAt: null,
        assignedAt: null,
      },
    ])
    expect(result[0]?.startedAt).toBe(null)
    expect(result[0]?.assignedAt).toBe(null)
    // null progress should be normalized to an empty object so consumers
    // don't have to handle the null case.
    expect(result[0]?.progress).toEqual({})
  })
})

describe('AGENT_TASK_ACTIVE_STATUSES', () => {
  it('includes pending so the detail page shows queued work for one agent', () => {
    // This is the contract that distinguishes the detail-page tasks list
    // (which shows the agent's full active queue) from the list-page
    // currentTask column (running/assigned only).
    expect([...AGENT_TASK_ACTIVE_STATUSES]).toEqual(['pending', 'assigned', 'running'])
  })
})

describe('decideHeartbeatTransition', () => {
  it('returns kind=transition with fatal_error reason when severity is fatal and prior differs', () => {
    // Arrange
    const input = {
      payloadStatus: 'online' as const,
      errorSeverity: 'fatal' as const,
      priorStatus: 'online',
    }

    // Act
    const result = decideHeartbeatTransition(input)

    // Assert — fatal flips effectiveStatus to 'error', which differs
    // from prior 'online' and so emits a transition.
    expect(result.kind).toBe('transition')
    expect(result.effectiveStatus).toBe('error')
    expect(result.isFatalError).toBe(true)
    if (result.kind === 'transition') {
      expect(result.reason).toBe('fatal_error')
      expect(result.fromStatus).toBe('online')
    }
  })

  it('returns kind=noop on a warning-severity error when status would not change', () => {
    // Arrange — online → online with a warning is the typical thermal-spike case.
    const input = {
      payloadStatus: 'online' as const,
      errorSeverity: 'warning' as const,
      priorStatus: 'online',
    }

    // Act
    const result = decideHeartbeatTransition(input)

    // Assert — warning is persisted by the caller via logAgentError but
    // does not move the agent, so the decision collapses to a no-op
    // (no audit-log line, no fromStatus exposed).
    expect(result.kind).toBe('noop')
    expect(result.effectiveStatus).toBe('online')
    expect(result.isFatalError).toBe(false)
  })

  it('returns kind=noop on a heartbeat that does not change status', () => {
    // Arrange
    const input = { payloadStatus: 'online' as const, priorStatus: 'online' }

    // Act
    const result = decideHeartbeatTransition(input)

    // Assert
    expect(result.kind).toBe('noop')
  })

  it('returns kind=transition with heartbeat_status reason when payload changes the status', () => {
    // Arrange — agent comes back online after the heartbeat-monitor marked it offline.
    const input = { payloadStatus: 'online' as const, priorStatus: 'offline' }

    // Act
    const result = decideHeartbeatTransition(input)

    // Assert
    expect(result.kind).toBe('transition')
    expect(result.effectiveStatus).toBe('online')
    if (result.kind === 'transition') {
      expect(result.reason).toBe('heartbeat_status')
      expect(result.fromStatus).toBe('offline')
    }
  })

  it('returns kind=noop on a fatal heartbeat when the agent is already in error state', () => {
    // Arrange — repeated fatal heartbeats from an already-errored agent
    // should not emit an audit-log line on every poll. effectiveStatus
    // stays 'error', prior is already 'error', so the transition
    // collapses to a no-op even though the heartbeat carries fatal
    // severity. The error itself is still persisted by the caller.
    const input = {
      payloadStatus: 'error' as const,
      errorSeverity: 'fatal' as const,
      priorStatus: 'error',
    }

    // Act
    const result = decideHeartbeatTransition(input)

    // Assert
    expect(result.kind).toBe('noop')
    expect(result.effectiveStatus).toBe('error')
    expect(result.isFatalError).toBe(true)
  })

  it('returns kind=noop when priorStatus is null (agent row missing)', () => {
    // Arrange — agent row vanished between auth and heartbeat handling.
    const input = { payloadStatus: 'online' as const, priorStatus: null }

    // Act
    const result = decideHeartbeatTransition(input)

    // Assert — processHeartbeat surfaces this case via logger.warn; the
    // pure decision stays silent.
    expect(result.kind).toBe('noop')
  })

  // ─── Terminal-status guard (issue #106 U8) ──────────────────────────
  //
  // A retired agent must never be un-retired by its own heartbeat. A
  // still-running rig that hasn't been told to stop keeps polling with
  // status:'online'; without this guard the payload status would win
  // (priorStatus 'retired' !== effectiveStatus 'online') and flip the row
  // back to 'online', making the agent claim-eligible again.

  it('returns kind=noop with effectiveStatus retired when priorStatus is retired and payload reports online', () => {
    // Arrange — the exact zombie-rig scenario the plan's review flagged.
    const input = { payloadStatus: 'online' as const, priorStatus: 'retired' }

    // Act
    const result = decideHeartbeatTransition(input)

    // Assert — status is pinned at 'retired', not overwritten to the
    // payload's 'online'.
    expect(result.kind).toBe('noop')
    expect(result.effectiveStatus).toBe('retired')
    expect(result.isFatalError).toBe(false)
  })

  it('ignores a fatal-severity error from a retired agent instead of flipping it to error', () => {
    // Arrange — a retired agent reporting a fatal error must not resurrect
    // into 'error' status either; retired is a dead end for every payload.
    const input = {
      payloadStatus: 'error' as const,
      errorSeverity: 'fatal' as const,
      priorStatus: 'retired',
    }

    // Act
    const result = decideHeartbeatTransition(input)

    // Assert
    expect(result.kind).toBe('noop')
    expect(result.effectiveStatus).toBe('retired')
    expect(result.isFatalError).toBe(false)
  })

  it('leaves status alone even when the payload also reports retired (idempotent no-op)', () => {
    // Arrange — defensive: agents never self-report 'retired' (it's not in
    // HeartbeatStatusLiteral), but the guard's own priorStatus check must
    // not depend on the payload shape.
    const input = { payloadStatus: 'busy' as const, priorStatus: 'retired' }

    // Act
    const result = decideHeartbeatTransition(input)

    // Assert
    expect(result.kind).toBe('noop')
    expect(result.effectiveStatus).toBe('retired')
  })
})

describe('scrubAgentErrorContext', () => {
  it('redacts secret-shaped keys at the top level', () => {
    // Arrange — operator-readable rows must not carry credentials.
    const input = {
      stack: 'Error at line 42',
      api_key: 'sk-prod-xxx',
      authorization: 'Bearer abc123',
      gpuId: 0,
    }

    // Act
    const out = scrubAgentErrorContext(input) as Record<string, unknown>

    // Assert
    expect(out['stack']).toBe('Error at line 42')
    expect(out['gpuId']).toBe(0)
    expect(out['api_key']).toBe('[REDACTED]')
    expect(out['authorization']).toBe('[REDACTED]')
  })

  it('redacts secret-shaped keys nested deeper in the payload', () => {
    // Arrange — error.context.cause.headers shape is common when an
    // agent serializes a fetch failure with a stack trace.
    const input = {
      cause: {
        headers: {
          'x-auth-token': 'secret-token',
          'content-type': 'application/json',
        },
        statusCode: 500,
      },
    }

    // Act
    const out = scrubAgentErrorContext(input) as Record<string, unknown>
    const cause = out['cause'] as Record<string, unknown>
    const headers = cause['headers'] as Record<string, unknown>

    // Assert
    expect(headers['x-auth-token']).toBe('[REDACTED]')
    expect(headers['content-type']).toBe('application/json')
    expect(cause['statusCode']).toBe(500)
  })

  it('redacts case-insensitively across naming conventions', () => {
    // Arrange — apiKey, API_KEY, Authorization, COOKIE all match.
    const input = {
      apiKey: 'a',
      API_KEY: 'b',
      Authorization: 'c',
      COOKIE: 'd',
      Bearer: 'e',
      customer_secret: 'f',
    }

    // Act
    const out = scrubAgentErrorContext(input) as Record<string, unknown>

    // Assert
    for (const value of Object.values(out)) {
      expect(value).toBe('[REDACTED]')
    }
  })

  it('walks arrays without dropping non-object entries', () => {
    // Arrange
    const input = {
      events: [{ password: 'p', code: 1 }, 'plain string', 42, null],
    }

    // Act
    const out = scrubAgentErrorContext(input) as Record<string, unknown>
    const events = out['events'] as unknown[]

    // Assert
    expect((events[0] as Record<string, unknown>)['password']).toBe('[REDACTED]')
    expect((events[0] as Record<string, unknown>)['code']).toBe(1)
    expect(events[1]).toBe('plain string')
    expect(events[2]).toBe(42)
    expect(events[3]).toBeNull()
  })

  it('caps recursion depth so cyclic-shaped payloads cannot exhaust the stack', () => {
    // Arrange — build a payload deeper than SCRUB_MAX_DEPTH (6).
    type Nested = { next: Nested | Record<string, never> }
    const deep: Nested = { next: {} }
    let cursor: Nested = deep
    for (let i = 0; i < 20; i++) {
      cursor.next = { next: {} }
      cursor = cursor.next as Nested
    }

    // Act + Assert — must not throw, and the scrubber substitutes the
    // sentinel beyond the depth cap.
    expect(() => scrubAgentErrorContext(deep)).not.toThrow()
  })

  it('preserves descriptive keys that only contain a secret-name as a prefix', () => {
    // Arrange — these names reference a secret (or count them) but do
    // not carry the secret value itself. The earlier substring-based
    // pattern over-redacted them, hiding useful debugging info from
    // operators.
    const input = {
      tokenCount: 42,
      cookieDomain: 'example.com',
      bearerHostname: 'api.example.com',
      apiKeyName: 'production',
      secretsManagerEnabled: true,
      passwordAge: 60,
    }

    // Act
    const out = scrubAgentErrorContext(input) as Record<string, unknown>

    // Assert — values pass through unchanged.
    expect(out['tokenCount']).toBe(42)
    expect(out['cookieDomain']).toBe('example.com')
    expect(out['bearerHostname']).toBe('api.example.com')
    expect(out['apiKeyName']).toBe('production')
    expect(out['secretsManagerEnabled']).toBe(true)
    expect(out['passwordAge']).toBe(60)
  })

  it('redacts trailing-secret compound keys (e.g., customer_secret, db_password)', () => {
    // Arrange — common pattern where a prefix scopes a secret-bearing
    // field.
    const input = {
      customer_secret: 'cs_xxx',
      db_password: 'pw',
      access_token: 'at',
      refresh_token: 'rt',
      x_api_key: 'k',
      legitimate_count: 3,
    }

    // Act
    const out = scrubAgentErrorContext(input) as Record<string, unknown>

    // Assert
    expect(out['customer_secret']).toBe('[REDACTED]')
    expect(out['db_password']).toBe('[REDACTED]')
    expect(out['access_token']).toBe('[REDACTED]')
    expect(out['refresh_token']).toBe('[REDACTED]')
    expect(out['x_api_key']).toBe('[REDACTED]')
    expect(out['legitimate_count']).toBe(3)
  })

  it('returns primitives unchanged', () => {
    // Arrange + Act + Assert
    expect(scrubAgentErrorContext('hello')).toBe('hello')
    expect(scrubAgentErrorContext(42)).toBe(42)
    expect(scrubAgentErrorContext(null)).toBeNull()
    expect(scrubAgentErrorContext(undefined)).toBeUndefined()
  })
})
