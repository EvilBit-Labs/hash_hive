import { afterEach, beforeEach, describe, expect, it, jest, mock } from 'bun:test';

let mockSession: { user: { id: number } } | null = null;

mock.module('../../src/lib/auth-client', () => ({
  authClient: {
    useSession: () => ({ data: mockSession, isPending: false, error: null }),
    signIn: { email: mock(async () => ({ error: null })) },
    signOut: mock(async () => ({ data: null, error: null })),
  },
}));

import { type QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import { type EventType, useEvents } from '../../src/hooks/use-events';
import { useUiStore } from '../../src/stores/ui';
import { installMockWebSocket } from '../mocks/websocket';
import { act, cleanupAll, createTestQueryClient, screen, waitFor } from '../test-utils';

let wsMock: ReturnType<typeof installMockWebSocket>;

function setAuthenticatedWithProject(projectId = 1) {
  mockSession = { user: { id: 1 } };
  useUiStore.setState({ selectedProjectId: projectId });
}

interface EventsState {
  connected: boolean;
  polling: boolean;
}

/**
 * Test component that renders the useEvents hook state.
 */
function EventsTestComponent({
  types,
  onEvent,
}: {
  types?: EventType[];
  onEvent?: (e: unknown) => void;
}) {
  const { connected, polling } = useEvents({ types, onEvent });
  return (
    <div>
      <span data-testid="connected">{String(connected)}</span>
      <span data-testid="polling">{String(polling)}</span>
    </div>
  );
}

function renderEventsHook(
  qc?: QueryClient,
  hookProps?: { types?: EventType[]; onEvent?: (e: unknown) => void }
) {
  const queryClient = qc ?? createTestQueryClient();
  return render(
    <QueryClientProvider client={queryClient}>
      <EventsTestComponent types={hookProps?.types} onEvent={hookProps?.onEvent} />
    </QueryClientProvider>
  );
}

beforeEach(() => {
  wsMock = installMockWebSocket();
});

afterEach(() => {
  jest.useRealTimers();
  cleanupAll();
  wsMock.restore();
  mockSession = null;
});

describe('useEvents', () => {
  it('connects to WebSocket on mount', async () => {
    setAuthenticatedWithProject(1);
    renderEventsHook();

    // WebSocket constructor should have been called
    expect(wsMock.constructorMock).toHaveBeenCalled();
    const ws = wsMock.instances[0]!;
    expect(ws.url).toContain('/api/v1/dashboard/events/stream');
    expect(ws.url).toContain('projectIds=1');

    ws.simulateOpen();

    await waitFor(() => {
      expect(screen.getByTestId('connected').textContent).toBe('true');
    });
  });

  it('sets polling mode on WebSocket close', async () => {
    setAuthenticatedWithProject(1);
    renderEventsHook();

    const ws = wsMock.instances[0]!;
    ws.simulateOpen();

    await waitFor(() => {
      expect(screen.getByTestId('connected').textContent).toBe('true');
    });

    // Simulate close - should trigger polling mode
    ws.simulateClose();

    await waitFor(() => {
      expect(screen.getByTestId('connected').textContent).toBe('false');
      expect(screen.getByTestId('polling').textContent).toBe('true');
    });
  });

  // Verifies that polling invalidation fires at exactly 30s intervals using fake timers,
  // and does NOT fire before the interval elapses.
  it('invalidates queries at polling interval when WebSocket disconnects', async () => {
    jest.useFakeTimers();
    const projectId = 1;
    setAuthenticatedWithProject(projectId);
    const qc = createTestQueryClient();
    const invalidateSpy = mock(() => Promise.resolve());
    const originalInvalidate = qc.invalidateQueries.bind(qc);
    qc.invalidateQueries = ((...args: Parameters<typeof qc.invalidateQueries>) => {
      invalidateSpy(...args);
      return originalInvalidate(...args);
    }) as typeof qc.invalidateQueries;

    renderEventsHook(qc);

    const ws = wsMock.instances[0]!;
    await act(async () => {
      ws.simulateOpen();
    });
    expect(screen.getByTestId('connected').textContent).toBe('true');

    // Close WebSocket to enter polling mode
    await act(async () => {
      ws.simulateClose();
    });
    expect(screen.getByTestId('polling').textContent).toBe('true');

    // Clear any invalidation calls from WS close / reconnect setup
    invalidateSpy.mockClear();

    // No invalidation should occur immediately after entering polling mode
    expect(invalidateSpy.mock.calls.length).toBe(0);

    // Advance 29s - still before the 30s polling interval
    await act(async () => {
      jest.advanceTimersByTime(29_000);
    });
    expect(invalidateSpy.mock.calls.length).toBe(0);

    // Advance the remaining 1s to hit exactly 30s - invalidation should fire
    await act(async () => {
      jest.advanceTimersByTime(1_000);
    });

    const calls = invalidateSpy.mock.calls;
    const queryKeys = calls.map((c: unknown[]) => (c[0] as { queryKey: unknown[] }).queryKey);
    expect(queryKeys.some((k: unknown[]) => k[0] === 'dashboard-stats' && k[1] === projectId)).toBe(
      true
    );
    expect(queryKeys.some((k: unknown[]) => k[0] === 'agents' && k[1] === projectId)).toBe(true);
    expect(queryKeys.some((k: unknown[]) => k[0] === 'campaigns' && k[1] === projectId)).toBe(true);

    // Advance another 30s - second round of invalidation should fire
    invalidateSpy.mockClear();
    await act(async () => {
      jest.advanceTimersByTime(30_000);
    });

    const secondCalls = invalidateSpy.mock.calls;
    const secondKeys = secondCalls.map(
      (c: unknown[]) => (c[0] as { queryKey: unknown[] }).queryKey
    );
    expect(
      secondKeys.some((k: unknown[]) => k[0] === 'dashboard-stats' && k[1] === projectId)
    ).toBe(true);
    expect(secondKeys.some((k: unknown[]) => k[0] === 'agents' && k[1] === projectId)).toBe(true);
    expect(secondKeys.some((k: unknown[]) => k[0] === 'campaigns' && k[1] === projectId)).toBe(
      true
    );
  });

  it('invalidates dashboard-stats on crack_result event', async () => {
    setAuthenticatedWithProject(1);
    const qc = createTestQueryClient();
    const invalidateSpy = mock(() => Promise.resolve());
    const originalInvalidate = qc.invalidateQueries.bind(qc);
    qc.invalidateQueries = ((...args: Parameters<typeof qc.invalidateQueries>) => {
      invalidateSpy(...args);
      return originalInvalidate(...args);
    }) as typeof qc.invalidateQueries;

    renderEventsHook(qc);

    const ws = wsMock.instances[0]!;
    ws.simulateOpen();

    await waitFor(() => {
      expect(screen.getByTestId('connected').textContent).toBe('true');
    });

    ws.simulateMessage({
      type: 'crack_result',
      projectId: 1,
      data: {},
      timestamp: new Date().toISOString(),
    });

    await waitFor(() => {
      const calls = invalidateSpy.mock.calls;
      const queryKeys = calls.map((c: unknown[]) => (c[0] as { queryKey: unknown[] }).queryKey);
      expect(queryKeys.some((k: unknown[]) => k[0] === 'dashboard-stats' && k[1] === 1)).toBe(true);
      expect(queryKeys.some((k: unknown[]) => k[0] === 'results' && k[1] === 1)).toBe(true);
    });
  });

  it('invalidates agents on agent_status event', async () => {
    setAuthenticatedWithProject(1);
    const qc = createTestQueryClient();
    const invalidateSpy = mock(() => Promise.resolve());
    const originalInvalidate = qc.invalidateQueries.bind(qc);
    qc.invalidateQueries = ((...args: Parameters<typeof qc.invalidateQueries>) => {
      invalidateSpy(...args);
      return originalInvalidate(...args);
    }) as typeof qc.invalidateQueries;

    renderEventsHook(qc);

    const ws = wsMock.instances[0]!;
    ws.simulateOpen();

    await waitFor(() => {
      expect(screen.getByTestId('connected').textContent).toBe('true');
    });

    ws.simulateMessage({
      type: 'agent_status',
      projectId: 1,
      data: { agentId: 42, status: 'online' },
      timestamp: new Date().toISOString(),
    });

    await waitFor(() => {
      const calls = invalidateSpy.mock.calls;
      const queryKeys = calls.map((c: unknown[]) => (c[0] as { queryKey: unknown[] }).queryKey);
      expect(queryKeys.some((k: unknown[]) => k[0] === 'agents' && k[1] === 1)).toBe(true);
      expect(queryKeys.some((k: unknown[]) => k[0] === 'dashboard-stats' && k[1] === 1)).toBe(true);
      // Per-agent caches are invalidated with [prefix, agentId] so only the
      // affected agent's detail page refreshes, not every cached agent.
      expect(queryKeys.some((k: unknown[]) => k[0] === 'agent' && k[1] === 42)).toBe(true);
      expect(queryKeys.some((k: unknown[]) => k[0] === 'agent-errors' && k[1] === 42)).toBe(true);
      expect(queryKeys.some((k: unknown[]) => k[0] === 'agent-tasks' && k[1] === 42)).toBe(true);
    });
  });

  it('does not invalidate unrelated agent ids on agent_status events', async () => {
    setAuthenticatedWithProject(1);
    const qc = createTestQueryClient();
    const invalidateSpy = mock(() => Promise.resolve());
    const originalInvalidate = qc.invalidateQueries.bind(qc);
    qc.invalidateQueries = ((...args: Parameters<typeof qc.invalidateQueries>) => {
      invalidateSpy(...args);
      return originalInvalidate(...args);
    }) as typeof qc.invalidateQueries;

    renderEventsHook(qc);
    const ws = wsMock.instances[0]!;
    ws.simulateOpen();
    await waitFor(() => {
      expect(screen.getByTestId('connected').textContent).toBe('true');
    });

    ws.simulateMessage({
      type: 'agent_status',
      projectId: 1,
      data: { agentId: 7, status: 'online' },
      timestamp: new Date().toISOString(),
    });

    await waitFor(() => {
      const calls = invalidateSpy.mock.calls;
      const queryKeys = calls.map((c: unknown[]) => (c[0] as { queryKey: unknown[] }).queryKey);
      // Only agent 7's caches should be invalidated.
      expect(queryKeys.some((k: unknown[]) => k[0] === 'agent' && k[1] === 7)).toBe(true);
      expect(queryKeys.some((k: unknown[]) => k[0] === 'agent' && k[1] === 99)).toBe(false);
      expect(queryKeys.some((k: unknown[]) => k[0] === 'agent-tasks' && k[1] === 99)).toBe(false);
    });
  });

  it('invalidates tasks, campaigns, dashboard-stats, and agent-tasks on task_update event', async () => {
    setAuthenticatedWithProject(1);
    const qc = createTestQueryClient();
    const invalidateSpy = mock(() => Promise.resolve());
    const originalInvalidate = qc.invalidateQueries.bind(qc);
    qc.invalidateQueries = ((...args: Parameters<typeof qc.invalidateQueries>) => {
      invalidateSpy(...args);
      return originalInvalidate(...args);
    }) as typeof qc.invalidateQueries;

    renderEventsHook(qc);

    const ws = wsMock.instances[0]!;
    ws.simulateOpen();
    await waitFor(() => {
      expect(screen.getByTestId('connected').textContent).toBe('true');
    });

    ws.simulateMessage({
      type: 'task_update',
      projectId: 1,
      data: { taskId: 5, agentId: 42, status: 'running' },
      timestamp: new Date().toISOString(),
    });

    await waitFor(() => {
      const calls = invalidateSpy.mock.calls;
      const queryKeys = calls.map((c: unknown[]) => (c[0] as { queryKey: unknown[] }).queryKey);
      expect(queryKeys.some((k: unknown[]) => k[0] === 'tasks' && k[1] === 1)).toBe(true);
      expect(queryKeys.some((k: unknown[]) => k[0] === 'dashboard-stats' && k[1] === 1)).toBe(true);
      // Regression guard: the campaigns list shows per-task progress, so
      // task_update must invalidate ['campaigns'] not just ['tasks'].
      expect(queryKeys.some((k: unknown[]) => k[0] === 'campaigns' && k[1] === 1)).toBe(true);
      // Per-agent invalidation uses [prefix, agentId] now.
      expect(queryKeys.some((k: unknown[]) => k[0] === 'agent-tasks' && k[1] === 42)).toBe(true);
    });
  });

  it('drops WS frames with an unrecognized event type without invalidating any query or firing onEvent', async () => {
    setAuthenticatedWithProject(1);
    const qc = createTestQueryClient();
    const invalidateSpy = mock(() => Promise.resolve());
    const originalInvalidate = qc.invalidateQueries.bind(qc);
    qc.invalidateQueries = ((...args: Parameters<typeof qc.invalidateQueries>) => {
      invalidateSpy(...args);
      return originalInvalidate(...args);
    }) as typeof qc.invalidateQueries;

    const onEventSpy = mock(() => {});
    renderEventsHook(qc, { onEvent: onEventSpy });

    const ws = wsMock.instances[0]!;
    ws.simulateOpen();
    await waitFor(() => {
      expect(screen.getByTestId('connected').textContent).toBe('true');
    });

    // A type the backend never emits today — the guard must drop the
    // frame without invalidating any cache or forwarding it to onEvent
    // (which expects AppEvent.type to be a member of the EventType union).
    invalidateSpy.mockClear();
    onEventSpy.mockClear();

    // simulateMessage triggers ws.onmessage synchronously; invalidateQueries
    // calls inside fire synchronously too. Flush a single microtask so any
    // queued promise continuations (none expected, but defensive) settle
    // before the negative assertion — no real-time sleep needed.
    ws.simulateMessage({
      type: 'unrecognized_event_type',
      projectId: 1,
      data: { foo: 'bar' },
      timestamp: new Date().toISOString(),
    });
    await Promise.resolve();

    expect(invalidateSpy).not.toHaveBeenCalled();
    expect(onEventSpy).not.toHaveBeenCalled();
  });

  it('falls back to broad invalidation when task_update event lacks agentId', async () => {
    setAuthenticatedWithProject(1);
    const qc = createTestQueryClient();
    const invalidateSpy = mock(() => Promise.resolve());
    const originalInvalidate = qc.invalidateQueries.bind(qc);
    qc.invalidateQueries = ((...args: Parameters<typeof qc.invalidateQueries>) => {
      invalidateSpy(...args);
      return originalInvalidate(...args);
    }) as typeof qc.invalidateQueries;

    renderEventsHook(qc);
    const ws = wsMock.instances[0]!;
    ws.simulateOpen();
    await waitFor(() => {
      expect(screen.getByTestId('connected').textContent).toBe('true');
    });

    ws.simulateMessage({
      type: 'task_update',
      projectId: 1,
      data: { taskId: 5, status: 'pending' }, // no agentId
      timestamp: new Date().toISOString(),
    });

    await waitFor(() => {
      const calls = invalidateSpy.mock.calls;
      const queryKeys = calls.map((c: unknown[]) => (c[0] as { queryKey: unknown[] }).queryKey);
      // Without agentId we fall back to single-element prefix invalidation.
      expect(queryKeys.some((k: unknown[]) => k[0] === 'agent-tasks' && k.length === 1)).toBe(true);
    });
  });

  it('does NOT broadly invalidate agent keys on unrelated events', async () => {
    // Negative case: a regression that wildcard-added 'agent' to every event's
    // broad-invalidation list would silently pass the positive assertions
    // above. Lock the inverse contract: resource_update must not touch any
    // agent-detail query key.
    setAuthenticatedWithProject(1);
    const qc = createTestQueryClient();
    const invalidateSpy = mock(() => Promise.resolve());
    const originalInvalidate = qc.invalidateQueries.bind(qc);
    qc.invalidateQueries = ((...args: Parameters<typeof qc.invalidateQueries>) => {
      invalidateSpy(...args);
      return originalInvalidate(...args);
    }) as typeof qc.invalidateQueries;

    renderEventsHook(qc);

    const ws = wsMock.instances[0]!;
    ws.simulateOpen();
    await waitFor(() => {
      expect(screen.getByTestId('connected').textContent).toBe('true');
    });

    ws.simulateMessage({
      type: 'resource_update',
      projectId: 1,
      data: {},
      timestamp: new Date().toISOString(),
    });

    await waitFor(() => {
      // Project-scoped resource keys are invalidated (existing contract).
      const calls = invalidateSpy.mock.calls;
      const queryKeys = calls.map((c: unknown[]) => (c[0] as { queryKey: unknown[] }).queryKey);
      expect(queryKeys.some((k: unknown[]) => k[0] === 'hash-lists' && k[1] === 1)).toBe(true);
    });

    // After resource_update settles, none of the agent-scoped keys should
    // have been invalidated.
    const queryKeys = invalidateSpy.mock.calls.map(
      (c: unknown[]) => (c[0] as { queryKey: unknown[] }).queryKey
    );
    expect(queryKeys.some((k: unknown[]) => k[0] === 'agent')).toBe(false);
    expect(queryKeys.some((k: unknown[]) => k[0] === 'agent-errors')).toBe(false);
    expect(queryKeys.some((k: unknown[]) => k[0] === 'agent-tasks')).toBe(false);
  });

  // Verifies exponential backoff: 1s (2^0), 2s (2^1) delays between reconnect attempts.
  // All time advancement uses fake timers - no real setTimeout waits.
  it('reconnects with exponential backoff after disconnect', async () => {
    jest.useFakeTimers();
    setAuthenticatedWithProject(1);
    renderEventsHook();

    const ws1 = wsMock.instances[0]!;
    await act(async () => {
      ws1.simulateOpen();
    });
    expect(screen.getByTestId('connected').textContent).toBe('true');

    // Close triggers reconnect with 1s delay (2^0 * 1000)
    await act(async () => {
      ws1.simulateClose();
    });

    // No reconnect should happen immediately - still waiting for 1s backoff
    expect(wsMock.instances.length).toBe(1);

    // Advance past 1s reconnect delay
    await act(async () => {
      jest.advanceTimersByTime(1000);
    });

    // Second WebSocket instance created after 1s backoff
    expect(wsMock.instances.length).toBeGreaterThanOrEqual(2);

    const ws2 = wsMock.instances[1]!;
    await act(async () => {
      ws2.simulateOpen();
    });
    await act(async () => {
      ws2.simulateClose();
    });

    // No reconnect should happen immediately - still waiting for 2s backoff
    expect(wsMock.instances.length).toBe(2);

    // Advance past 2s reconnect delay (2^1 * 1000)
    await act(async () => {
      jest.advanceTimersByTime(2000);
    });

    // Third WebSocket instance created after 2s backoff
    expect(wsMock.instances.length).toBeGreaterThanOrEqual(3);
  });

  it('cleans up WebSocket on unmount', async () => {
    setAuthenticatedWithProject(1);
    const { unmount } = renderEventsHook();

    const ws = wsMock.instances[0]!;
    ws.simulateOpen();

    await waitFor(() => {
      expect(screen.getByTestId('connected').textContent).toBe('true');
    });

    unmount();

    // The hook nulls onclose before calling close() to prevent reconnect
    expect(ws.readyState).toBe(ws.CLOSED);
  });

  it('filters events by type when types option provided', () => {
    setAuthenticatedWithProject(1);
    renderEventsHook(undefined, { types: ['crack_result'] });

    const ws = wsMock.instances[0]!;
    expect(ws.url).toContain('types=crack_result');
  });

  // Issue #109 (testing review T-002): system_health events use a
  // different invalidation path because their query key has no project
  // component. Verify the new branch fires invalidation with just
  // ['system-health'] (no projectId), separately from project-scoped
  // events.
  it('invalidates [system-health] (un-scoped) on system_health event', async () => {
    setAuthenticatedWithProject(1);
    const qc = createTestQueryClient();
    const invalidateSpy = mock(() => Promise.resolve());
    const originalInvalidate = qc.invalidateQueries.bind(qc);
    qc.invalidateQueries = ((...args: Parameters<typeof qc.invalidateQueries>) => {
      invalidateSpy(...args);
      return originalInvalidate(...args);
    }) as typeof qc.invalidateQueries;

    renderEventsHook(qc);

    const ws = wsMock.instances[0]!;
    ws.simulateOpen();

    await waitFor(() => {
      expect(screen.getByTestId('connected').textContent).toBe('true');
    });

    ws.simulateMessage({
      type: 'system_health',
      projectId: 0,
      data: { component: 'database', status: 'degraded' },
      timestamp: new Date().toISOString(),
    });

    await waitFor(() => {
      const calls = invalidateSpy.mock.calls;
      const queryKeys = calls.map((c: unknown[]) => (c[0] as { queryKey: unknown[] }).queryKey);
      // The system invalidation must use a single-element key with NO
      // projectId — the dashboard health query is system-wide.
      const systemHealthCall = queryKeys.find(
        (k: unknown[]) => k.length === 1 && k[0] === 'system-health'
      );
      expect(systemHealthCall).toBeDefined();
    });
  });
});
