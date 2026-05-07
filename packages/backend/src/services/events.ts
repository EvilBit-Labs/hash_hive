import { logger } from '../config/logger.js';

/**
 * FUTURE: Redis Pub/Sub Extension for Multi-Instance Deployments
 *
 * Current implementation uses in-memory Map for WebSocket connections.
 * For horizontal scaling, extend with Redis pub/sub:
 *
 * 1. Publish events to Redis channel:
 *    await redis.publish('hashhive:events', JSON.stringify(event));
 *
 * 2. Subscribe all instances to the channel:
 *    redis.subscribe('hashhive:events', (message) => {
 *      const event = JSON.parse(message);
 *      broadcastToLocalClients(event);
 *    });
 *
 * 3. Keep local client registry (Map) for WebSocket connections
 * 4. Each instance broadcasts only to its own connected clients
 */

// ─── Event Types ────────────────────────────────────────────────────

/**
 * Project-scoped event types — `emit()` filters delivery by the client's
 * subscribed project IDs.
 */
export type ProjectEventType =
  | 'agent_status'
  | 'campaign_status'
  | 'task_update'
  | 'crack_result'
  | 'resource_update';

/**
 * System-wide event types — `broadcastSystemEvent()` bypasses project
 * scoping and delivers to every subscribed client. Reserved for events
 * that affect every operator regardless of which project they have
 * selected (system health, future global maintenance notices, etc.).
 */
export type SystemEventType = 'system_health';

export type EventType = ProjectEventType | SystemEventType;

/**
 * Sentinel projectId carried on AppEvent payloads for system-wide events.
 * Chosen as `0` because Postgres project ids are positive integers, so a
 * project-scoped consumer filtering on `event.projectId === current`
 * will never falsely match a system event.
 *
 * Typed as the literal `0` so AppEvent's discriminated union can refuse
 * mismatched (type, projectId) pairs at compile time — see AppEvent
 * below.
 */
export const SYSTEM_EVENT_PROJECT_ID = 0 as const;
export type SystemEventProjectId = typeof SYSTEM_EVENT_PROJECT_ID;

/**
 * Discriminated union over event scope. Project events carry a real
 * project id; system events carry the sentinel literal. The union shape
 * means TypeScript refuses `{ type: 'agent_status', projectId: 0 }`
 * (project event with system sentinel) and `{ type: 'system_health',
 * projectId: 42 }` (system event leaking into project channel) at
 * compile time. `emit()` accepts the project arm; `broadcastSystemEvent()`
 * accepts the system arm.
 */
export type AppEvent =
  | {
      type: ProjectEventType;
      projectId: number;
      data: Record<string, unknown>;
      timestamp: string;
    }
  | {
      type: SystemEventType;
      projectId: SystemEventProjectId;
      data: Record<string, unknown>;
      timestamp: string;
    };

export type ProjectAppEvent = Extract<AppEvent, { type: ProjectEventType }>;

// ─── Connection Registry ────────────────────────────────────────────

interface WebSocketClient {
  ws: { send: (data: string) => void; readyState: number };
  projectIds: Set<number>;
  subscribedTypes: Set<EventType>;
}

// MUST stay in sync with the EventType union above. There's no way to
// derive a runtime array from a TypeScript union, so adding a new member
// requires touching both. Any new entry here means new clients connecting
// without `?types=` will receive the new event by default — verify that
// is the intended behavior before adding.
const ALL_EVENT_TYPES: EventType[] = [
  'agent_status',
  'campaign_status',
  'task_update',
  'crack_result',
  'resource_update',
  'system_health',
];

let clientIdCounter = 0;
const clients = new Map<number, WebSocketClient>();

export function registerClient(
  ws: WebSocketClient['ws'],
  projectIds: number[],
  eventTypes?: EventType[]
): number {
  const id = ++clientIdCounter;
  clients.set(id, {
    ws,
    projectIds: new Set(projectIds),
    subscribedTypes: new Set(eventTypes ?? ALL_EVENT_TYPES),
  });
  logger.debug({ clientId: id, projectIds, eventTypes }, 'WebSocket client registered');
  return id;
}

export function unregisterClient(clientId: number) {
  clients.delete(clientId);
  logger.debug({ clientId }, 'WebSocket client unregistered');
}

export function getClientCount(): number {
  return clients.size;
}

// ─── Event Broadcasting ─────────────────────────────────────────────

// Throttle: track last emit time per event type + project
const lastEmitTimes = new Map<string, number>();
const THROTTLE_MS = 250; // Max 4 events/sec per type+project

// Throttle map maintenance: how often to prune entries that no longer
// matter (background pulse) and what age qualifies an entry for pruning.
// Both are 60s so the worst-case dwell of an inactive throttle key is
// ~120s — short enough for a few hundred KB cap, long enough to absorb
// bursts without thrashing.
const THROTTLE_PRUNE_INTERVAL_MS = 60_000;
const THROTTLE_ENTRY_MAX_AGE_MS = 60_000;

// Periodically prune stale entries to prevent unbounded growth
setInterval(() => {
  const cutoff = Date.now() - THROTTLE_ENTRY_MAX_AGE_MS;
  for (const [key, time] of lastEmitTimes) {
    if (time < cutoff) {
      lastEmitTimes.delete(key);
    }
  }
}, THROTTLE_PRUNE_INTERVAL_MS);

/**
 * Test-only: clears the module-level client registry and throttle map
 * so each test starts from a clean slate. Production callers must not
 * use this — clearing the client map mid-broadcast would drop active
 * WS subscribers.
 */
export function __resetEventsForTesting(): void {
  clients.clear();
  lastEmitTimes.clear();
  clientIdCounter = 0;
}

/**
 * Emits a project-scoped event to all connected clients that are
 * subscribed to the event's project and type. Applies per-type
 * throttling. System events must use `broadcastSystemEvent` instead;
 * routing one through here would silently drop because no client has
 * SYSTEM_EVENT_PROJECT_ID in its projectIds set.
 */
export function emit(event: ProjectAppEvent) {
  const throttleKey = `${event.type}:${event.projectId}`;
  const now = Date.now();
  const lastEmit = lastEmitTimes.get(throttleKey) ?? 0;

  if (now - lastEmit < THROTTLE_MS) {
    return; // Throttled
  }
  lastEmitTimes.set(throttleKey, now);

  const payload = JSON.stringify(event);
  let delivered = 0;

  for (const [clientId, client] of clients) {
    // Check project scope
    if (!client.projectIds.has(event.projectId)) {
      continue;
    }

    // Check event type subscription
    if (!client.subscribedTypes.has(event.type)) {
      continue;
    }

    // Check connection is open (WebSocket OPEN = 1)
    if (client.ws.readyState !== 1) {
      clients.delete(clientId);
      continue;
    }

    try {
      client.ws.send(payload);
      delivered++;
    } catch (err) {
      logger.warn(
        { err, clientId, type: event.type, projectId: event.projectId },
        'WebSocket send failed; dropping client'
      );
      clients.delete(clientId);
    }
  }

  if (delivered > 0) {
    logger.debug({ type: event.type, projectId: event.projectId, delivered }, 'event broadcasted');
  }
}

// ─── Convenience Emitters ───────────────────────────────────────────

export function emitAgentStatus(projectId: number, agentId: number, status: string) {
  emit({
    type: 'agent_status',
    projectId,
    data: { agentId, status },
    timestamp: new Date().toISOString(),
  });
}

export function emitCampaignStatus(projectId: number, campaignId: number, status: string) {
  emit({
    type: 'campaign_status',
    projectId,
    data: { campaignId, status },
    timestamp: new Date().toISOString(),
  });
}

export function emitTaskUpdate(
  projectId: number,
  taskId: number,
  status: string,
  progress?: Record<string, unknown>
) {
  emit({
    type: 'task_update',
    projectId,
    data: { taskId, status, ...(progress ? { progress } : {}) },
    timestamp: new Date().toISOString(),
  });
}

export function emitCrackResult(projectId: number, hashListId: number, count: number) {
  emit({
    type: 'crack_result',
    projectId,
    data: { hashListId, crackedCount: count },
    timestamp: new Date().toISOString(),
  });
}

// ─── System-wide Broadcast (issue #109) ─────────────────────────────

/**
 * Broadcasts a system-wide event to every subscribed client, bypassing
 * the project-scope filter that `emit()` applies. Still respects
 * `subscribedTypes` so a client that opts out of `system_health` won't
 * receive it.
 *
 * No throttle: system events are infrequent by design (cadence is
 * controlled by the producer — e.g. health monitor's 30s interval —
 * and only fires on transitions, not every tick). Throttling here
 * would silently swallow simultaneous transitions (multiple components
 * flipping on the same tick).
 */
export function broadcastSystemEvent(type: SystemEventType, data: Record<string, unknown>): void {
  const event: AppEvent = {
    type,
    // SYSTEM_EVENT_PROJECT_ID sentinel: 0 is not a valid Postgres
    // project id, so consumers that filter `event.projectId === current`
    // (the natural pattern for project-scoped events) won't accidentally
    // match system events. Consumers that explicitly want system events
    // can match on `event.type` from the SystemEventType union, which is
    // the documented contract — projectId is implementation detail.
    projectId: SYSTEM_EVENT_PROJECT_ID,
    data,
    timestamp: new Date().toISOString(),
  };
  const payload = JSON.stringify(event);
  let delivered = 0;

  for (const [clientId, client] of clients) {
    if (!client.subscribedTypes.has(type)) {
      continue;
    }
    if (client.ws.readyState !== 1) {
      clients.delete(clientId);
      continue;
    }
    try {
      client.ws.send(payload);
      delivered++;
    } catch (err) {
      logger.warn({ err, clientId, type }, 'WebSocket send failed; dropping client');
      clients.delete(clientId);
    }
  }

  if (delivered > 0) {
    logger.debug({ type, delivered }, 'system event broadcasted');
  }
}

/**
 * Convenience wrapper for issuing a `system_health` event for a single
 * component status transition. The worker calls this once per component
 * that flipped on a given monitor tick.
 */
export function broadcastSystemHealth(
  component: string,
  status: 'healthy' | 'degraded' | 'unhealthy',
  message?: string
): void {
  broadcastSystemEvent('system_health', {
    component,
    status,
    ...(message ? { message } : {}),
  });
}
