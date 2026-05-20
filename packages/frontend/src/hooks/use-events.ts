import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
import { authClient } from '../lib/auth-client';
import { useUiStore } from '../stores/ui';

export type EventType =
  | 'agent_status'
  | 'agent_error'
  | 'campaign_status'
  | 'task_update'
  | 'crack_result'
  | 'resource_update'
  | 'system_health';

/**
 * Membership set for runtime validation of WS frame `type` fields.
 * Without this, an arbitrary string from a misbehaving backend would
 * be cast to `EventType` and forwarded to consumers as if it were a
 * recognized event.
 */
const KNOWN_EVENT_TYPES: ReadonlySet<EventType> = new Set([
  'agent_status',
  'agent_error',
  'campaign_status',
  'task_update',
  'crack_result',
  'resource_update',
  'system_health',
]);

function isKnownEventType(value: string): value is EventType {
  return KNOWN_EVENT_TYPES.has(value as EventType);
}

/**
 * Throttle the protocol-drift warnings emitted when a WS event arrives
 * without its expected scoping id (`agentId` or `campaignId`). A
 * misbehaving backend that emits a thousand malformed events in a row
 * would otherwise produce a thousand console warnings; the first warn
 * per `(scope, eventType)` key per cooldown is enough signal.
 */
const DRIFT_WARN_COOLDOWN_MS = 60_000;
const driftWarnTimestamps = new Map<string, number>();

function warnDriftOnce(scope: 'agent' | 'campaign', eventType: string): boolean {
  const safeType = eventType.replace(/[^a-zA-Z0-9_-]/g, '?').slice(0, 64);
  const key = `${scope}:${safeType}`;
  const last = driftWarnTimestamps.get(key) ?? 0;
  const now = Date.now();
  if (now - last < DRIFT_WARN_COOLDOWN_MS) return false;
  driftWarnTimestamps.set(key, now);
  return true;
}

export interface AppEvent {
  type: EventType;
  projectId: number;
  data: Record<string, unknown>;
  timestamp: string;
}

type EventHandler = (event: AppEvent) => void;

interface UseEventsOptions {
  /** Event types to subscribe to. Defaults to all. */
  types?: EventType[];
  /** Called when a matching event is received. */
  onEvent?: EventHandler;
}

/**
 * Connects to the backend WebSocket for real-time events.
 * Automatically reconnects on disconnect with exponential backoff.
 * Falls back to polling via TanStack Query invalidation when WS is unavailable.
 */
export function useEvents(options: UseEventsOptions = {}) {
  const { types, onEvent } = options;
  // Stabilize types array to prevent unnecessary WS reconnections
  const stableTypes = useMemo(() => types?.join(','), [types]);
  const { data: session } = authClient.useSession();
  const { selectedProjectId } = useUiStore();
  const queryClient = useQueryClient();
  const [connected, setConnected] = useState(false);
  const [polling, setPolling] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const reconnectAttemptsRef = useRef(0);
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;

  useEffect(() => {
    if (!session || !selectedProjectId) {
      return;
    }

    const projectIds = String(selectedProjectId);
    const typesParam = stableTypes ? `&types=${stableTypes}` : '';
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${protocol}//${window.location.host}/api/v1/dashboard/events/stream?projectIds=${projectIds}${typesParam}`;

    function connect() {
      const ws = new WebSocket(url);
      wsRef.current = ws;

      ws.onopen = () => {
        setConnected(true);
        setPolling(false);
        reconnectAttemptsRef.current = 0;
      };

      // Project-scoped query keys: invalidated with [key, selectedProjectId].
      const invalidationKeys: Record<string, string[]> = {
        agent_status: ['agents', 'dashboard-stats'],
        campaign_status: ['campaigns', 'dashboard-stats'],
        // task_update refreshes the campaigns list too because each task
        // affects its campaign's progress percentage and task counts —
        // both of which appear in the list table. Without this, the
        // list's progress column would only refresh on campaign
        // lifecycle transitions, missing per-task progress.
        task_update: ['tasks', 'campaigns', 'dashboard-stats'],
        crack_result: [
          'dashboard-stats',
          'results',
          'hash-list-detail',
          'hash-list-items',
          'hash-lists',
        ],
        resource_update: ['hash-lists', 'wordlists', 'rulelists', 'masklists'],
      };

      // Per-agent query key prefixes. We invalidate `[prefix, agentId]`
      // so only the affected agent's caches refresh — a fleet-wide event
      // stream doesn't fan out into every detail tab. The exact cache
      // shape lives in use-dashboard.ts (`useAgent`, `useAgentErrors`,
      // `useAgentTasks`).
      const agentScopedKeysByEvent: Record<string, string[]> = {
        agent_status: ['agent', 'agent-errors', 'agent-tasks'],
        agent_error: ['agent-errors', 'agent'],
        task_update: ['agent-tasks', 'agent'],
      };

      // Per-campaign query key prefixes. Invalidated as `[prefix, campaignId]`
      // so the detail page refreshes only when the event concerns *its*
      // campaign — fleet-wide task churn doesn't fan out into every cached
      // campaign detail. `task_update` carries `campaignId` so the detail
      // page's `useCampaignDetail` cache (key: `['campaign', id]`) refreshes
      // its taskStats / activeAgents block without a manual reload.
      const campaignScopedKeysByEvent: Record<string, string[]> = {
        campaign_status: ['campaign'],
        task_update: ['campaign'],
      };

      // System-scoped query keys: invalidated with just [key], no project.
      // Issue #109: system_health is system-wide; the query key has no
      // projectId component, so the project-scoped invalidation path
      // would never match it.
      const systemInvalidationKeys: Record<string, string[]> = {
        system_health: ['system-health'],
      };

      ws.onmessage = (event) => {
        try {
          // Validate envelope shape before any cast or invalidation.
          // Without this guard, a non-object payload or one missing a
          // string `type` would still flow through the casts below and
          // hit invalidateQueries / onEvent with malformed data.
          const parsed: unknown = JSON.parse(event.data);
          if (
            typeof parsed !== 'object' ||
            parsed === null ||
            typeof (parsed as Record<string, unknown>)['type'] !== 'string'
          ) {
            // biome-ignore lint/suspicious/noConsole: client-side observability has no structured logger
            console.warn('[useEvents] dropped malformed WS frame: invalid envelope');
            return;
          }
          const data = parsed as Record<string, unknown>;
          if (data['type'] === 'connected' || data['type'] === 'pong') return;

          // Validate the rest of the envelope before invalidation /
          // callback dispatch. The type guard above only pinned `type`;
          // a frame with `type: 'agent_status'` but missing
          // `projectId`/`timestamp`/`data` would still cast through to
          // AppEvent without these checks.
          if (
            typeof data['projectId'] !== 'number' ||
            typeof data['timestamp'] !== 'string' ||
            typeof data['data'] !== 'object' ||
            data['data'] === null
          ) {
            // biome-ignore lint/suspicious/noConsole: client-side observability has no structured logger
            console.warn('[useEvents] dropped malformed WS frame: invalid event payload');
            return;
          }

          const eventType = data['type'] as string;
          if (!isKnownEventType(eventType)) {
            // Unknown event type from the backend — drop loudly rather
            // than forwarding an unrecognized value to consumers.
            // biome-ignore lint/suspicious/noConsole: protocol drift signal
            console.warn('[useEvents] dropped WS frame with unknown event type', {
              eventType: eventType.replace(/[^a-zA-Z0-9_-]/g, '?').slice(0, 64),
            });
            return;
          }
          const projectKeys = invalidationKeys[eventType];
          if (projectKeys) {
            for (const key of projectKeys) {
              queryClient.invalidateQueries({ queryKey: [key, selectedProjectId] });
            }
          }
          const agentScopedKeys = agentScopedKeysByEvent[eventType];
          if (agentScopedKeys) {
            const payload = data['data'] as Record<string, unknown>;
            const rawAgentId = payload['agentId'];
            const agentId = typeof rawAgentId === 'number' ? rawAgentId : null;
            if (agentId !== null) {
              for (const key of agentScopedKeys) {
                queryClient.invalidateQueries({ queryKey: [key, agentId] });
              }
            } else {
              // No agentId on the payload — fall back to prefix invalidation
              // so we still refresh, but log so we know the producer should
              // be carrying agentId. Throttled to one warn per (scope,
              // event type) per cooldown so a misbehaving backend cannot
              // flood the console.
              if (warnDriftOnce('agent', eventType)) {
                const safeEventType =
                  typeof eventType === 'string'
                    ? eventType.replace(/[^a-zA-Z0-9_-]/g, '?').slice(0, 64)
                    : 'unknown';
                // biome-ignore lint/suspicious/noConsole: protocol drift signal
                console.warn(
                  '[useEvents] event missing agentId; falling back to broad invalidation',
                  { eventType: safeEventType }
                );
              }
              for (const key of agentScopedKeys) {
                queryClient.invalidateQueries({ queryKey: [key] });
              }
            }
          }
          const campaignScopedKeys = campaignScopedKeysByEvent[eventType];
          if (campaignScopedKeys) {
            const payload = data['data'] as Record<string, unknown>;
            const rawCampaignId = payload['campaignId'];
            const campaignId = typeof rawCampaignId === 'number' ? rawCampaignId : null;
            if (campaignId !== null) {
              for (const key of campaignScopedKeys) {
                queryClient.invalidateQueries({ queryKey: [key, campaignId] });
              }
            } else {
              // No campaignId on the payload — fall back to prefix invalidation
              // so the detail page still refreshes, but record the drift.
              // Throttled to one warn per (scope, event type) per cooldown.
              if (warnDriftOnce('campaign', eventType)) {
                const safeEventType =
                  typeof eventType === 'string'
                    ? eventType.replace(/[^a-zA-Z0-9_-]/g, '?').slice(0, 64)
                    : 'unknown';
                // biome-ignore lint/suspicious/noConsole: protocol drift signal
                console.warn(
                  '[useEvents] event missing campaignId; falling back to broad invalidation',
                  { eventType: safeEventType }
                );
              }
              for (const key of campaignScopedKeys) {
                queryClient.invalidateQueries({ queryKey: [key] });
              }
            }
          }

          const systemKeys = systemInvalidationKeys[eventType];
          if (systemKeys) {
            for (const key of systemKeys) {
              queryClient.invalidateQueries({ queryKey: [key] });
            }
          }

          onEventRef.current?.({
            type: data['type'] as EventType,
            projectId: data['projectId'] as number,
            data: data['data'] as Record<string, unknown>,
            timestamp: data['timestamp'] as string,
          });
        } catch (err) {
          // Surface schema drift between server and client to console.
          // Silently dropping the frame would mask backend events from
          // the dashboard with no diagnostic signal.
          // biome-ignore lint/suspicious/noConsole: client-side observability has no structured logger
          console.warn('[useEvents] dropped malformed WS frame', err);
        }
      };

      ws.onclose = () => {
        setConnected(false);
        setPolling(true);
        wsRef.current = null;
        // Exponential backoff: 1s, 2s, 4s, 8s, max 30s
        const delay = Math.min(1000 * 2 ** reconnectAttemptsRef.current, 30_000);
        reconnectAttemptsRef.current++;
        reconnectTimeoutRef.current = setTimeout(connect, delay);
      };

      ws.onerror = () => {
        ws.close();
      };
    }

    connect();

    return () => {
      clearTimeout(reconnectTimeoutRef.current);
      if (wsRef.current) {
        wsRef.current.onclose = null; // Prevent reconnect on intentional close
        wsRef.current.close();
        wsRef.current = null;
      }
      setConnected(false);
      setPolling(false);
    };
  }, [session, selectedProjectId, stableTypes, queryClient]);

  // Polling fallback: invalidate queries every 30s when disconnected
  // from the WebSocket. Includes the agent-detail keys (broadly, since
  // no event payload is available during polling) so a disconnected
  // detail page still refreshes its tasks/errors/agent caches instead
  // of going stale until the WS reconnects.
  useEffect(() => {
    if (!polling) return;

    const interval = setInterval(() => {
      queryClient.invalidateQueries({ queryKey: ['dashboard-stats', selectedProjectId] });
      queryClient.invalidateQueries({ queryKey: ['agents', selectedProjectId] });
      queryClient.invalidateQueries({ queryKey: ['campaigns', selectedProjectId] });
      queryClient.invalidateQueries({ queryKey: ['agent'] });
      queryClient.invalidateQueries({ queryKey: ['agent-errors'] });
      queryClient.invalidateQueries({ queryKey: ['agent-tasks'] });
      // Symmetric to the agent-detail keys above — without this a
      // disconnected user sitting on /campaigns/:id sees frozen
      // taskStats and activeAgents until the WS reconnects.
      queryClient.invalidateQueries({ queryKey: ['campaign'] });
    }, 30_000);

    return () => clearInterval(interval);
  }, [polling, queryClient, selectedProjectId]);

  return { connected, polling };
}
