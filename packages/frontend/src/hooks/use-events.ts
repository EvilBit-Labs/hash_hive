import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
import { authClient } from '../lib/auth-client';
import { useUiStore } from '../stores/ui';

export type EventType =
  | 'agent_status'
  | 'campaign_status'
  | 'task_update'
  | 'crack_result'
  | 'resource_update'
  | 'system_health';

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
        task_update: ['tasks', 'dashboard-stats'],
        crack_result: [
          'dashboard-stats',
          'results',
          'hash-list-detail',
          'hash-list-items',
          'hash-lists',
        ],
        resource_update: ['hash-lists', 'wordlists', 'rulelists', 'masklists'],
      };

      // Broad query keys: invalidated with just [key], matching every query
      // whose key starts with that prefix. Used for entity-detail caches
      // (e.g., ['agent', agentId, projectId]) where agentId sits between
      // the prefix and projectId, so the project-scoped invalidation above
      // would never prefix-match them.
      const broadInvalidationKeys: Record<string, string[]> = {
        agent_status: ['agent', 'agent-errors', 'agent-tasks'],
        task_update: ['agent-tasks', 'agent'],
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
          const projectKeys = invalidationKeys[eventType];
          if (projectKeys) {
            for (const key of projectKeys) {
              queryClient.invalidateQueries({ queryKey: [key, selectedProjectId] });
            }
          }
          const broadKeys = broadInvalidationKeys[eventType];
          if (broadKeys) {
            for (const key of broadKeys) {
              queryClient.invalidateQueries({ queryKey: [key] });
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
  useEffect(() => {
    if (!polling) return;

    const interval = setInterval(() => {
      queryClient.invalidateQueries({ queryKey: ['dashboard-stats', selectedProjectId] });
      queryClient.invalidateQueries({ queryKey: ['agents', selectedProjectId] });
      queryClient.invalidateQueries({ queryKey: ['campaigns', selectedProjectId] });
    }, 30_000);

    return () => clearInterval(interval);
  }, [polling, queryClient, selectedProjectId]);

  return { connected, polling };
}
