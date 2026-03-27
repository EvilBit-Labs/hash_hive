import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useAuthStore } from '../stores/auth';
import { useUiStore } from '../stores/ui';

export type EventType =
  | 'agent_status'
  | 'campaign_status'
  | 'task_update'
  | 'crack_result'
  | 'resource_update';

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
  const { user } = useAuthStore();
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
    if (!user || !selectedProjectId) {
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

      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data) as Record<string, unknown>;
          if (data['type'] === 'connected' || data['type'] === 'pong') return;

          const keys = invalidationKeys[data['type'] as string];
          if (keys) {
            for (const key of keys) {
              queryClient.invalidateQueries({ queryKey: [key, selectedProjectId] });
            }
          }

          onEventRef.current?.(data as unknown as AppEvent);
        } catch {
          // Ignore malformed messages
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
  }, [user, selectedProjectId, stableTypes, queryClient]);

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
