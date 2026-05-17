/**
 * Integration tests for the agent heartbeat path (residual #2 from the
 * code review).
 *
 * These tests exercise `processHeartbeat` end-to-end through the route
 * handler against a mocked drizzle client. The mocking is heavier than
 * the typical unit test because the heartbeat path now spans a
 * transaction, fans out to `handleTaskFailure`, and emits SSE events
 * post-commit. We mock at the drizzle-chain level so the assertions
 * speak to the actual behavior the route exposes: which agent_errors
 * rows get persisted, when handleTaskFailure is invoked, and when the
 * status-transition audit log fires.
 *
 * Per AGENTS.md the gold standard would be a real-DB integration test,
 * but the project's existing tests/integration/ suite mocks the drizzle
 * client the same way; this file follows that convention. Scenarios
 * map 1:1 to the plan's U5 test scenarios so a reader can trace each
 * back to the original requirement.
 *
 * Runs in an isolated test phase via the
 * `AGENT_HEARTBEAT_TEST_ISOLATED` env gate because the `mock.module`
 * calls in this file replace `db`, `tasks`, and `events` namespaces
 * process-wide and would interfere with other test files in the same
 * bun:test invocation. Mirrors the pattern in
 * `tests/unit/control-routes-rbac.test.ts`.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

const IS_ISOLATED = process.env['AGENT_HEARTBEAT_TEST_ISOLATED'] === '1';

if (!IS_ISOLATED) {
  describe.skip('agent-heartbeat (skipped — runs in isolated phase)', () => {
    it('runs only with AGENT_HEARTBEAT_TEST_ISOLATED=1', () => {
      expect(true).toBe(true);
    });
  });
} else {
  // ─── Mock infrastructure ────────────────────────────────────────────

  const TEST_AGENT_TOKEN = 'test-agent-preshared-token';

  interface MockAgent {
    id: number;
    projectId: number;
    status: string;
    capabilities: Record<string, unknown>;
  }

  interface MockTask {
    id: number;
    agentId: number;
    status: string;
  }

  interface CapturedAgentError {
    agentId: number;
    severity: string;
    message: string;
    context: Record<string, unknown>;
    taskId: number | null;
  }

  interface CapturedAgentUpdate {
    status?: string;
    lastSeenAt?: Date;
  }

  // Shared mutable state the test cases set up before each call.
  const state = {
    agent: { id: 1, projectId: 7, status: 'online', capabilities: {} } as MockAgent | null,
    activeTasks: [] as MockTask[],
    ownedTaskIds: new Set<number>(),
    capturedErrors: [] as CapturedAgentError[],
    capturedAgentUpdates: [] as CapturedAgentUpdate[],
    highPriorityTask: null as { id: number } | null,
  };

  // Default handleTaskFailure implementation reused in beforeEach when
  // we mockReset the spy. Per GOTCHAS.md, mockClear only resets call
  // history — queued mockImplementationOnce values from a prior test
  // would leak across cases otherwise.
  const defaultHandleTaskFailureImpl = (
    taskId: number,
    agentId: number,
    reason: string
  ): Promise<unknown> => {
    state.activeTasks = state.activeTasks.filter((t) => t.id !== taskId);
    return Promise.resolve({ retried: false, taskId, agentId, reason });
  };

  const handleTaskFailureMock = mock(defaultHandleTaskFailureImpl);

  const loggerMock = {
    info: mock(),
    warn: mock(),
    error: mock(),
    debug: mock(),
  };

  const emitAgentErrorMock = mock();
  const emitAgentStatusMock = mock();

  // ─── Drizzle-client mock ────────────────────────────────────────────
  //
  // We intercept the three operations processHeartbeat performs through
  // either the global db or a tx:
  //   1. select agent row (with .for('update').limit(1) inside the tx)
  //   2. insert into agent_errors
  //   3. update agents
  //   4. select active tasks
  //   5. select high-priority pending tasks
  // Returning chainable proxies lets the same mock cover both the global
  // db and the tx argument of db.transaction(fn).

  type AnyTable = { _: { name: string } } | { dbName?: string } | unknown;

  function buildSelectChain(rows: unknown[]) {
    const chain: Record<string, unknown> = {
      from: () => chain,
      innerJoin: () => chain,
      where: () => chain,
      for: () => chain,
      limit: () => Promise.resolve(rows),
      orderBy: () => Promise.resolve(rows),
    };
    // Make the chain thenable so consumers that await it without .limit() resolve.
    (chain as { then: Promise<unknown[]>['then'] }).then = (resolve: (v: unknown) => void) =>
      Promise.resolve(rows).then(resolve);
    return chain;
  }

  function buildAgentErrorsInsertChain() {
    return {
      values: (vals: CapturedAgentError) => {
        const row = {
          ...vals,
          context: vals.context ?? {},
          taskId: vals.taskId ?? null,
        };
        state.capturedErrors.push(row);
        return { returning: () => Promise.resolve([{ id: state.capturedErrors.length, ...row }]) };
      },
    };
  }

  function buildAgentsUpdateChain() {
    return {
      set: (vals: CapturedAgentUpdate) => {
        state.capturedAgentUpdates.push(vals);
        if (state.agent && vals.status !== undefined) {
          state.agent = { ...state.agent, status: vals.status };
        }
        return {
          where: () => ({
            returning: () => Promise.resolve(state.agent ? [state.agent] : []),
          }),
        };
      },
    };
  }

  function buildClient() {
    return {
      select: (cols?: unknown) => {
        // The high-priority lookup selects `{ id: tasks.id }` and joins
        // campaigns; route to the highPriorityTask state.
        // The active-tasks lookup also selects `{ id: tasks.id }` from
        // tasks WHERE agent_id = ... AND status IN (...). To disambiguate
        // we use cols presence + a counter on tasks selects.
        if (cols && typeof cols === 'object') {
          const keys = Object.keys(cols as Record<string, unknown>);
          // Agent row select inside the tx (status + projectId)
          if (keys.includes('status') && keys.includes('projectId')) {
            return buildSelectChain(state.agent ? [state.agent] : []);
          }
          // Task ownership / active-task lookup selects only { id }.
          // The same projection serves three call sites:
          //   - verifyTaskOwnership: select.from.where.limit  -> ownedTaskIds
          //   - active-task fan-out: select.from.where        -> activeTasks
          //   - high-priority lookup: select.from.innerJoin.where.limit -> highPriorityTask
          // We disambiguate by call shape rather than parsing the where
          // clause (which is opaque drizzle SQL).
          if (keys.length === 1 && keys[0] === 'id') {
            const ownedRows = Array.from(state.ownedTaskIds).map((id) => ({ id }));
            const activeRows = state.activeTasks.map((t) => ({ id: t.id }));
            // verifyTaskOwnership now runs inside the tx with FOR UPDATE:
            //   select({id}).from(tasks).where(...).for('update').limit(1)
            // active-task fan-out is still:
            //   select({id}).from(tasks).where(...)  -- awaited directly
            // high-priority lookup is:
            //   select({id}).from(tasks).innerJoin(...).where(...).limit(1)
            const whereChain = {
              for: () => ({ limit: () => Promise.resolve(ownedRows) }),
              limit: () => Promise.resolve(ownedRows),
              then: (resolve: (v: unknown) => void) => Promise.resolve(activeRows).then(resolve),
            };
            return {
              from: () => ({
                where: () => whereChain,
                innerJoin: () => ({
                  where: () => ({
                    limit: () =>
                      Promise.resolve(state.highPriorityTask ? [state.highPriorityTask] : []),
                  }),
                }),
              }),
            };
          }
        }
        return buildSelectChain(state.agent ? [state.agent] : []);
      },
      insert: (_table: AnyTable) => buildAgentErrorsInsertChain(),
      update: (_table: AnyTable) => buildAgentsUpdateChain(),
      delete: (_table: AnyTable) => ({ where: () => Promise.resolve() }),
    };
  }

  mock.module('../../src/db/index.js', () => {
    const client = buildClient();
    return {
      db: {
        ...client,
        transaction: async (fn: (tx: ReturnType<typeof buildClient>) => Promise<unknown>) =>
          fn(buildClient()),
      },
      client: {},
    };
  });

  mock.module('../../src/config/logger.js', () => ({
    logger: loggerMock,
  }));

  mock.module('../../src/services/events.js', () => ({
    emitAgentError: emitAgentErrorMock,
    emitAgentStatus: emitAgentStatusMock,
    emitCrackResult: mock(),
    emitTaskUpdate: mock(),
    emitCampaignStatus: mock(),
    emit: mock(),
    registerClient: mock(),
    unregisterClient: mock(),
    getClientCount: mock(() => 0),
    __resetEventsForTesting: mock(),
    broadcastSystemEvent: mock(),
    broadcastSystemHealth: mock(),
    SYSTEM_EVENT_PROJECT_ID: 0 as const,
  }));

  mock.module('../../src/services/tasks.js', () => ({
    assignNextTask: mock(),
    updateTaskProgress: mock(),
    handleTaskFailure: handleTaskFailureMock,
    generateTasksForAttack: mock(),
    reassignStaleTasks: mock(() => Promise.resolve([])),
    getTaskById: mock(),
    listTasks: mock(),
    getZapsForTask: mock(),
    AGENT_TASK_ACTIVE_STATUSES: ['pending', 'assigned', 'running'] as const,
    projectAgentTaskRows: mock(),
    listTasksByAgent: mock(),
  }));

  mock.module('../../src/lib/auth.js', () => ({
    auth: { api: { getSession: async () => null }, handler: async () => new Response('ok') },
  }));

  const { app } = await import('../../src/index.js');
  const { agentToken } = await import('../fixtures.js');

  const AGENT_BASE = '/api/v1/agent';

  function resetState() {
    state.agent = { id: 1, projectId: 7, status: 'online', capabilities: {} };
    state.activeTasks = [];
    state.ownedTaskIds = new Set<number>();
    state.capturedErrors = [];
    state.capturedAgentUpdates = [];
    state.highPriorityTask = null;
  }

  beforeEach(() => {
    resetState();
    // mockReset (not mockClear) clears queued mockImplementationOnce
    // values too — required per GOTCHAS.md "Use mockReset() not
    // mockClear() in beforeEach". Reinstall the default impls so the
    // tests that rely on them keep working.
    handleTaskFailureMock.mockReset();
    handleTaskFailureMock.mockImplementation(defaultHandleTaskFailureImpl);
    loggerMock.info.mockReset();
    loggerMock.warn.mockReset();
    loggerMock.error.mockReset();
    emitAgentErrorMock.mockReset();
    emitAgentStatusMock.mockReset();
  });

  afterEach(() => {
    // Defense in depth — guarantee no state leaks across files.
    resetState();
  });

  // ─── Plan U5 scenarios ──────────────────────────────────────────────

  describe('Integration: agent heartbeat error handling (plan U5)', () => {
    it('persists a warning error row without moving the agent off its payload status', async () => {
      // Arrange — covers R3 / R4: warning persists, task continues, status unchanged.
      const token = agentToken(TEST_AGENT_TOKEN);

      // Act
      const res = await app.request(`${AGENT_BASE}/heartbeat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({
          status: 'online',
          error: { severity: 'warning', message: 'temperature spike', context: { gpuId: 0 } },
        }),
      });

      // Assert
      expect(res.status).toBe(200);
      expect(state.capturedErrors).toHaveLength(1);
      const persisted = state.capturedErrors[0];
      expect(persisted).toBeDefined();
      if (!persisted) throw new Error('expected one persisted error');
      expect(persisted.severity).toBe('warning');
      expect(persisted.message).toBe('temperature spike');
      // The agent's status set on UPDATE matches the payload, not 'error'.
      expect(state.capturedAgentUpdates.some((u) => u.status === 'online')).toBe(true);
      expect(state.capturedAgentUpdates.some((u) => u.status === 'error')).toBe(false);
      // handleTaskFailure is never invoked on a warning.
      expect(handleTaskFailureMock).not.toHaveBeenCalled();
    });

    it('on a fatal heartbeat: persists fatal row, sets status=error, and fails active tasks', async () => {
      // Arrange — covers R3 / R4 / R5: fatal persists, status forced to
      // 'error', handleTaskFailure called once per active task.
      const token = agentToken(TEST_AGENT_TOKEN);
      state.activeTasks = [
        { id: 100, agentId: 1, status: 'running' },
        { id: 101, agentId: 1, status: 'assigned' },
      ];

      // Act
      const res = await app.request(`${AGENT_BASE}/heartbeat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({
          status: 'error',
          error: { severity: 'fatal', message: 'hashcat crashed' },
        }),
      });

      // Assert
      expect(res.status).toBe(200);
      expect(state.capturedErrors).toHaveLength(1);
      const persisted = state.capturedErrors[0];
      expect(persisted).toBeDefined();
      if (!persisted) throw new Error('expected one persisted error');
      expect(persisted.severity).toBe('fatal');
      expect(state.capturedAgentUpdates.some((u) => u.status === 'error')).toBe(true);
      expect(handleTaskFailureMock).toHaveBeenCalledTimes(2);
    });

    it('persists the fatal row and forces status=error even when no active tasks exist', async () => {
      // Arrange — covers R5 edge case: fatal with no active tasks must
      // still record the error and force status, just without invoking
      // handleTaskFailure at all.
      const token = agentToken(TEST_AGENT_TOKEN);
      state.activeTasks = [];

      // Act
      const res = await app.request(`${AGENT_BASE}/heartbeat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({
          status: 'error',
          error: { severity: 'fatal', message: 'gpu hung' },
        }),
      });

      // Assert
      expect(res.status).toBe(200);
      expect(state.capturedErrors).toHaveLength(1);
      expect(state.capturedAgentUpdates.some((u) => u.status === 'error')).toBe(true);
      expect(handleTaskFailureMock).not.toHaveBeenCalled();
    });

    it('emits a status-transition audit log line exactly once on a real transition', async () => {
      // Arrange — agent currently 'offline'; heartbeat says 'online'.
      const token = agentToken(TEST_AGENT_TOKEN);
      state.agent = { id: 1, projectId: 7, status: 'offline', capabilities: {} };

      // Act
      const res = await app.request(`${AGENT_BASE}/heartbeat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ status: 'online' }),
      });

      // Assert
      expect(res.status).toBe(200);
      const transitionCalls = loggerMock.info.mock.calls.filter((args) => {
        const [payload, message] = args;
        return typeof message === 'string' && message === 'Agent status transition' && payload;
      });
      expect(transitionCalls).toHaveLength(1);
      const [payload] = transitionCalls[0] ?? [];
      expect((payload as Record<string, unknown>)['fromStatus']).toBe('offline');
      expect((payload as Record<string, unknown>)['toStatus']).toBe('online');
      expect((payload as Record<string, unknown>)['reason']).toBe('heartbeat_status');
    });

    it('does not emit a status-transition log on a no-op heartbeat (status unchanged)', async () => {
      // Arrange — every-30s heartbeat reporting the same status.
      const token = agentToken(TEST_AGENT_TOKEN);
      state.agent = { id: 1, projectId: 7, status: 'online', capabilities: {} };

      // Act
      const res = await app.request(`${AGENT_BASE}/heartbeat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ status: 'online' }),
      });

      // Assert
      expect(res.status).toBe(200);
      const transitionCalls = loggerMock.info.mock.calls.filter(
        (args) => typeof args[1] === 'string' && args[1] === 'Agent status transition'
      );
      expect(transitionCalls).toHaveLength(0);
    });

    it('carries currentTask.taskId onto agent_errors when the agent owns the task', async () => {
      // Arrange — task 42 belongs to this agent (ownership check passes).
      const token = agentToken(TEST_AGENT_TOKEN);
      state.ownedTaskIds = new Set([42]);

      // Act
      const res = await app.request(`${AGENT_BASE}/heartbeat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({
          status: 'online',
          currentTask: { taskId: 42, progress: 0.5, speed: 1000 },
          error: { severity: 'warning', message: 'temp spike' },
        }),
      });

      // Assert
      expect(res.status).toBe(200);
      expect(state.capturedErrors).toHaveLength(1);
      expect(state.capturedErrors[0]?.taskId).toBe(42);
    });

    it('drops currentTask.taskId on agent_errors when the agent does not own the task', async () => {
      // Arrange — agent claims task 999 but ownedTaskIds is empty, so
      // the ownership query returns no row.
      const token = agentToken(TEST_AGENT_TOKEN);
      state.ownedTaskIds = new Set();

      // Act
      const res = await app.request(`${AGENT_BASE}/heartbeat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({
          status: 'online',
          currentTask: { taskId: 999, progress: 0, speed: 0 },
          error: { severity: 'warning', message: 'spoofed' },
        }),
      });

      // Assert — the error is still persisted (the agent is allowed to
      // report errors), but the task linkage is severed.
      expect(res.status).toBe(200);
      expect(state.capturedErrors).toHaveLength(1);
      expect(state.capturedErrors[0]?.taskId).toBeNull();
      // The drop is logged so operators can detect compromised tokens.
      const warnCalls = loggerMock.warn.mock.calls.filter(
        (args) => typeof args[1] === 'string' && args[1].includes('not owned')
      );
      expect(warnCalls.length).toBeGreaterThanOrEqual(1);
    });

    it('continues failing sibling tasks when one handleTaskFailure throws', async () => {
      // Arrange — three active tasks, the middle one throws.
      const token = agentToken(TEST_AGENT_TOKEN);
      state.activeTasks = [
        { id: 200, agentId: 1, status: 'running' },
        { id: 201, agentId: 1, status: 'running' },
        { id: 202, agentId: 1, status: 'running' },
      ];
      handleTaskFailureMock.mockImplementationOnce(() => Promise.resolve({ retried: false }));
      handleTaskFailureMock.mockImplementationOnce(() => Promise.reject(new Error('boom')));
      handleTaskFailureMock.mockImplementationOnce(() => Promise.resolve({ retried: false }));

      // Act
      const res = await app.request(`${AGENT_BASE}/heartbeat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({
          status: 'error',
          error: { severity: 'fatal', message: 'fan-out test' },
        }),
      });

      // Assert — all three tasks were attempted, the failure was logged,
      // and the response still ack'd (the partial failure does not
      // bubble out to the agent because the heartbeat itself succeeded).
      expect(res.status).toBe(200);
      expect(handleTaskFailureMock).toHaveBeenCalledTimes(3);
      const errorCalls = loggerMock.error.mock.calls.filter(
        (args) => typeof args[1] === 'string' && args[1].includes('handleTaskFailure threw')
      );
      expect(errorCalls).toHaveLength(1);
    });

    it('scrubs secret-shaped keys from error.context before persisting', async () => {
      // Arrange — agent accidentally serializes credentials.
      const token = agentToken(TEST_AGENT_TOKEN);

      // Act
      const res = await app.request(`${AGENT_BASE}/heartbeat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({
          status: 'online',
          error: {
            severity: 'warning',
            message: 'leak attempt',
            context: { api_key: 'sk-real', stack: 'Error...', authorization: 'Bearer xxx' },
          },
        }),
      });

      // Assert
      expect(res.status).toBe(200);
      expect(state.capturedErrors).toHaveLength(1);
      const ctx = state.capturedErrors[0]?.context as Record<string, unknown>;
      expect(ctx['api_key']).toBe('[REDACTED]');
      expect(ctx['authorization']).toBe('[REDACTED]');
      expect(ctx['stack']).toBe('Error...');
    });
  });
}
