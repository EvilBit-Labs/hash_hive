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
import { describe, expect, it } from 'bun:test';
import {
  classifyRecentErrors,
  classifyWorstSeverity,
  decideHeartbeatTransition,
  pickCurrentTaskByAgent,
} from '../../src/services/agents.js';
import { AGENT_TASK_ACTIVE_STATUSES, projectAgentTaskRows } from '../../src/services/tasks.js';

describe('classifyRecentErrors', () => {
  it('returns count 0 and null worstSeverity when there are no rows', () => {
    expect(classifyRecentErrors([])).toEqual({ count: 0, worstSeverity: null });
  });

  it('classifies only-warning rows as worstSeverity=warning', () => {
    const result = classifyRecentErrors([{ severity: 'warning' }, { severity: 'WARNING' }]);
    expect(result.count).toBe(2);
    expect(result.worstSeverity).toBe('warning');
  });

  it('classifies a single fatal/critical/error row as worstSeverity=fatal', () => {
    expect(classifyRecentErrors([{ severity: 'fatal' }]).worstSeverity).toBe('fatal');
    expect(classifyRecentErrors([{ severity: 'critical' }]).worstSeverity).toBe('fatal');
    expect(classifyRecentErrors([{ severity: 'error' }]).worstSeverity).toBe('fatal');
  });

  it('treats fatal as dominant over warning when both are present', () => {
    const result = classifyRecentErrors([
      { severity: 'warning' },
      { severity: 'error' },
      { severity: 'warning' },
    ]);
    expect(result.count).toBe(3);
    expect(result.worstSeverity).toBe('fatal');
  });

  it('excludes unknown severities from count and worstSeverity', () => {
    const result = classifyRecentErrors([
      { severity: 'info' },
      { severity: 'debug' },
      { severity: 'notice' },
    ]);
    expect(result.count).toBe(0);
    expect(result.worstSeverity).toBe(null);
  });

  it('counts only allowlisted severities even when unknown rows are present', () => {
    const result = classifyRecentErrors([
      { severity: 'info' },
      { severity: 'warning' },
      { severity: 'debug' },
      { severity: 'critical' },
    ]);
    expect(result.count).toBe(2);
    expect(result.worstSeverity).toBe('fatal');
  });

  it('is case-insensitive for severity matching', () => {
    expect(classifyRecentErrors([{ severity: 'FATAL' }]).worstSeverity).toBe('fatal');
    expect(classifyRecentErrors([{ severity: 'Critical' }]).worstSeverity).toBe('fatal');
    expect(classifyRecentErrors([{ severity: 'WaRnInG' }]).worstSeverity).toBe('warning');
  });
});

describe('classifyWorstSeverity', () => {
  it('returns null when neither flag is set', () => {
    expect(classifyWorstSeverity({ hasFatal: false, hasWarning: false })).toBe(null);
  });

  it('returns warning when only warning is set', () => {
    expect(classifyWorstSeverity({ hasFatal: false, hasWarning: true })).toBe('warning');
  });

  it('returns fatal when fatal is set (regardless of warning)', () => {
    expect(classifyWorstSeverity({ hasFatal: true, hasWarning: false })).toBe('fatal');
    expect(classifyWorstSeverity({ hasFatal: true, hasWarning: true })).toBe('fatal');
  });
});

describe('pickCurrentTaskByAgent', () => {
  const baseTask = {
    campaignId: 7,
    campaignName: 'Audit',
    attackId: 9,
    attackMode: 0,
  } as const;

  it('returns an empty map for no rows', () => {
    expect(pickCurrentTaskByAgent([]).size).toBe(0);
  });

  it('skips rows whose agentId is null', () => {
    const result = pickCurrentTaskByAgent([
      { taskId: 1, agentId: null, status: 'running', ...baseTask },
    ]);
    expect(result.size).toBe(0);
  });

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
    ]);
    expect(result.get(42)?.id).toBe(2);
    expect(result.get(42)?.status).toBe('running');
  });

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
    ]);
    expect(result.get(42)?.id).toBe(2);
  });

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
    ]);
    expect(result.get(42)?.id).toBe(2);
  });

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
    ]);
    expect(result.size).toBe(2);
    expect(result.get(1)?.id).toBe(1);
    expect(result.get(2)?.id).toBe(2);
  });

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
    ]);
    expect(result.get(42)?.id).toBe(2);
  });
});

describe('projectAgentTaskRows', () => {
  it('converts Date startedAt/assignedAt to ISO strings', () => {
    const started = new Date('2026-03-01T10:00:00Z');
    const assigned = new Date('2026-03-01T09:00:00Z');
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
    ]);
    expect(result[0]?.startedAt).toBe(started.toISOString());
    expect(result[0]?.assignedAt).toBe(assigned.toISOString());
    expect(result[0]?.progress).toEqual({ percent: 50 });
  });

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
    ]);
    expect(result[0]?.startedAt).toBe(null);
    expect(result[0]?.assignedAt).toBe(null);
    // null progress should be normalized to an empty object so consumers
    // don't have to handle the null case.
    expect(result[0]?.progress).toEqual({});
  });
});

describe('AGENT_TASK_ACTIVE_STATUSES', () => {
  it('includes pending so the detail page shows queued work for one agent', () => {
    // This is the contract that distinguishes the detail-page tasks list
    // (which shows the agent's full active queue) from the list-page
    // currentTask column (running/assigned only).
    expect([...AGENT_TASK_ACTIVE_STATUSES]).toEqual(['pending', 'assigned', 'running']);
  });
});

describe('decideHeartbeatTransition', () => {
  it('forces effective status to "error" and flags fatal when severity is fatal', () => {
    // Arrange
    const input = {
      payloadStatus: 'online' as const,
      errorSeverity: 'fatal' as const,
      priorStatus: 'online',
    };

    // Act
    const result = decideHeartbeatTransition(input);

    // Assert
    expect(result.effectiveStatus).toBe('error');
    expect(result.isFatalError).toBe(true);
    expect(result.shouldLogTransition).toBe(true);
    expect(result.reason).toBe('fatal_error');
  });

  it('keeps the payload status and does not flag fatal on a warning-severity error', () => {
    // Arrange — online → online with a warning is the typical thermal-spike case.
    const input = {
      payloadStatus: 'online' as const,
      errorSeverity: 'warning' as const,
      priorStatus: 'online',
    };

    // Act
    const result = decideHeartbeatTransition(input);

    // Assert — warning is persisted by the caller via logAgentError but
    // does not move the agent, so no status-transition audit line.
    expect(result.effectiveStatus).toBe('online');
    expect(result.isFatalError).toBe(false);
    expect(result.shouldLogTransition).toBe(false);
    expect(result.reason).toBeNull();
  });

  it('suppresses the audit log on a no-op transition (status unchanged)', () => {
    // Arrange
    const input = { payloadStatus: 'online' as const, priorStatus: 'online' };

    // Act
    const result = decideHeartbeatTransition(input);

    // Assert
    expect(result.shouldLogTransition).toBe(false);
    expect(result.reason).toBeNull();
  });

  it('emits a heartbeat_status transition when the payload changes the status', () => {
    // Arrange — agent comes back online after the heartbeat-monitor marked it offline.
    const input = { payloadStatus: 'online' as const, priorStatus: 'offline' };

    // Act
    const result = decideHeartbeatTransition(input);

    // Assert
    expect(result.effectiveStatus).toBe('online');
    expect(result.shouldLogTransition).toBe(true);
    expect(result.reason).toBe('heartbeat_status');
  });

  it('emits a fatal_error transition when fatal flips an agent from online', () => {
    // Arrange
    const input = {
      payloadStatus: 'online' as const,
      errorSeverity: 'fatal' as const,
      priorStatus: 'online',
    };

    // Act
    const result = decideHeartbeatTransition(input);

    // Assert
    expect(result.shouldLogTransition).toBe(true);
    expect(result.reason).toBe('fatal_error');
  });

  it('suppresses the audit log when priorStatus is null (agent row missing)', () => {
    // Arrange — agent row vanished between auth and heartbeat handling.
    const input = { payloadStatus: 'online' as const, priorStatus: null };

    // Act
    const result = decideHeartbeatTransition(input);

    // Assert — processHeartbeat surfaces this case via logger.warn; the
    // pure decision stays silent.
    expect(result.shouldLogTransition).toBe(false);
    expect(result.reason).toBeNull();
  });
});
