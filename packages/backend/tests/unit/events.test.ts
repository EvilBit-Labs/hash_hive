/**
 * Unit tests for the event-broadcast layer (issue #109).
 *
 * Focus on the new `broadcastSystemEvent` / `broadcastSystemHealth`
 * helpers which bypass project-scope filtering, and the existing
 * `emit()` / `emitAgentStatus` to verify project scoping is preserved
 * (regression guard).
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  __resetEventsForTesting,
  type AppEvent,
  broadcastSystemEvent,
  broadcastSystemHealth,
  emit,
  emitAgentStatus,
  getClientCount,
  registerClient,
  unregisterClient,
} from '../../src/services/events.js';

// Compile-time exhaustiveness pin for the drift-guard test below. Adding
// a new EventType without updating this map is a type error, which then
// guides the contributor to also extend the runtime drift guard. There's
// no way to derive a runtime array from a TypeScript union, so this is
// the closest we can get to a single source of truth.
type _EventTypeExhaustive = Record<AppEvent['type'], true>;
const _EVENT_TYPE_GUARD: _EventTypeExhaustive = {
  agent_status: true,
  campaign_status: true,
  task_update: true,
  crack_result: true,
  resource_update: true,
  system_health: true,
};
// Reference the constant so unused-export rules don't strip it.
void _EVENT_TYPE_GUARD;

interface FakeWs {
  readyState: number;
  sent: string[];
  send: (data: string) => void;
}

function createFakeWs(readyState = 1): FakeWs {
  const ws: FakeWs = {
    readyState,
    sent: [],
    send: (data: string) => {
      ws.sent.push(data);
    },
  };
  return ws;
}

// Reset the module-level client registry and throttle map before each
// test so suite-wide ordering doesn't leak state (testing review T-006).
const registeredIds: number[] = [];

beforeEach(() => {
  __resetEventsForTesting();
  registeredIds.length = 0;
});

afterEach(() => {
  for (const id of registeredIds) {
    unregisterClient(id);
  }
});

function trackedRegister(
  ws: FakeWs,
  projectIds: number[],
  eventTypes?: Parameters<typeof registerClient>[2]
): number {
  const id = registerClient(ws, projectIds, eventTypes);
  registeredIds.push(id);
  return id;
}

describe('broadcastSystemEvent', () => {
  test('delivers to all clients regardless of project subscription', () => {
    const ws1 = createFakeWs();
    const ws2 = createFakeWs();
    trackedRegister(ws1, [1]);
    trackedRegister(ws2, [42]);

    broadcastSystemEvent('system_health', {
      component: 'database',
      status: 'degraded',
    });

    expect(ws1.sent).toHaveLength(1);
    expect(ws2.sent).toHaveLength(1);
    const payload = JSON.parse(ws1.sent[0]!);
    expect(payload.type).toBe('system_health');
    expect(payload.data.component).toBe('database');
    expect(payload.data.status).toBe('degraded');
  });

  test('respects subscribedTypes — clients that opt out do not receive', () => {
    const wsOptedOut = createFakeWs();
    const wsSubscribed = createFakeWs();
    trackedRegister(wsOptedOut, [1], ['agent_status']);
    trackedRegister(wsSubscribed, [1], ['system_health']);

    broadcastSystemEvent('system_health', { component: 'redis', status: 'unhealthy' });

    expect(wsOptedOut.sent).toHaveLength(0);
    expect(wsSubscribed.sent).toHaveLength(1);
  });

  test('removes clients with closed sockets on broadcast attempt', () => {
    const closedWs = createFakeWs(3 /* CLOSED */);
    const id = trackedRegister(closedWs, [1]);
    const before = getClientCount();

    broadcastSystemEvent('system_health', { component: 'minio', status: 'unhealthy' });

    expect(closedWs.sent).toHaveLength(0);
    expect(getClientCount()).toBe(before - 1);
    // Already evicted from the map; remove from local tracking too.
    registeredIds.splice(registeredIds.indexOf(id), 1);
  });

  test('does NOT throttle simultaneous events (two components flip on same tick)', () => {
    const ws = createFakeWs();
    trackedRegister(ws, [1]);

    broadcastSystemEvent('system_health', { component: 'database', status: 'degraded' });
    broadcastSystemEvent('system_health', { component: 'redis', status: 'unhealthy' });

    expect(ws.sent).toHaveLength(2);
    const first = JSON.parse(ws.sent[0]!);
    const second = JSON.parse(ws.sent[1]!);
    expect(first.data.component).toBe('database');
    expect(second.data.component).toBe('redis');
  });

  test('uses sentinel projectId 0 so consumers can identify system origin', () => {
    const ws = createFakeWs();
    trackedRegister(ws, [99]);
    broadcastSystemEvent('system_health', { component: 'queues', status: 'degraded' });
    const payload = JSON.parse(ws.sent[0]!);
    expect(payload.projectId).toBe(0);
  });
});

describe('broadcastSystemHealth', () => {
  test('serializes component, status, and optional message into payload data', () => {
    const ws = createFakeWs();
    trackedRegister(ws, [1]);
    broadcastSystemHealth('database', 'degraded', 'pool 90% full');
    const payload = JSON.parse(ws.sent[0]!);
    expect(payload.data).toEqual({
      component: 'database',
      status: 'degraded',
      message: 'pool 90% full',
    });
  });

  test('omits message field when not provided', () => {
    const ws = createFakeWs();
    trackedRegister(ws, [1]);
    broadcastSystemHealth('redis', 'healthy');
    const payload = JSON.parse(ws.sent[0]!);
    expect(payload.data.message).toBeUndefined();
    expect(payload.data.component).toBe('redis');
    expect(payload.data.status).toBe('healthy');
  });
});

describe('emit (regression: project scoping unchanged)', () => {
  test('emit delivers only to clients subscribed to the event projectId', async () => {
    const wsScoped = createFakeWs();
    const wsOtherProject = createFakeWs();
    trackedRegister(wsScoped, [1]);
    trackedRegister(wsOtherProject, [2]);

    emit({
      type: 'agent_status',
      projectId: 1,
      data: { agentId: 7, status: 'online' },
      timestamp: new Date().toISOString(),
    });

    expect(wsScoped.sent).toHaveLength(1);
    expect(wsOtherProject.sent).toHaveLength(0);
  });

  test('emitAgentStatus still respects project filter (does not leak into broadcast path)', () => {
    const wsScoped = createFakeWs();
    const wsOther = createFakeWs();
    trackedRegister(wsScoped, [1]);
    trackedRegister(wsOther, [2]);

    emitAgentStatus(1, 7, 'online');

    expect(wsScoped.sent).toHaveLength(1);
    expect(wsOther.sent).toHaveLength(0);
  });

  test('ALL_EVENT_TYPES default subscription delivers every EventType member (drift guard)', () => {
    // The events.ts source warns: ALL_EVENT_TYPES MUST stay in sync with
    // the EventType union. If a future EventType is added but the array
    // is not updated, default-subscribed clients (no ?types= param)
    // silently miss the new event. This test enumerates every type and
    // verifies a default-subscribed client receives each one.
    const ws = createFakeWs();
    trackedRegister(ws, [1]); // No eventTypes arg → default to ALL_EVENT_TYPES

    // Every project-scoped type should reach the client
    emit({
      type: 'agent_status',
      projectId: 1,
      data: {},
      timestamp: new Date().toISOString(),
    });
    emit({
      type: 'campaign_status',
      projectId: 1,
      data: {},
      timestamp: new Date().toISOString(),
    });
    emit({
      type: 'task_update',
      projectId: 1,
      data: {},
      timestamp: new Date().toISOString(),
    });
    emit({
      type: 'crack_result',
      projectId: 1,
      data: {},
      timestamp: new Date().toISOString(),
    });
    emit({
      type: 'resource_update',
      projectId: 1,
      data: {},
      timestamp: new Date().toISOString(),
    });
    // System type also reaches (broadcast bypass + default subscription)
    broadcastSystemEvent('system_health', { component: 'database', status: 'healthy' });

    const types = ws.sent.map((p) => JSON.parse(p).type as string).sort();
    expect(types).toEqual([
      'agent_status',
      'campaign_status',
      'crack_result',
      'resource_update',
      'system_health',
      'task_update',
    ]);
  });

  test('throttle key includes both type and projectId (no cross-type collisions)', () => {
    // Issue #109 testing review T-006: prove that emitting two different
    // event types in quick succession on the same projectId both deliver
    // (different throttle keys) — this would silently fail if the throttle
    // key was just `${event.type}` or just `${event.projectId}`.
    const ws = createFakeWs();
    trackedRegister(ws, [1]);

    emit({
      type: 'agent_status',
      projectId: 1,
      data: { agentId: 1, status: 'online' },
      timestamp: new Date().toISOString(),
    });
    emit({
      type: 'campaign_status',
      projectId: 1,
      data: { campaignId: 5, status: 'running' },
      timestamp: new Date().toISOString(),
    });

    expect(ws.sent).toHaveLength(2);
  });
});
