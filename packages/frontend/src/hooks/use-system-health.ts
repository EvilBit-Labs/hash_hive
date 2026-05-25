/**
 * System health query hook (issue #109).
 *
 * Polls the dashboard health endpoint every 30s. The query key is NOT
 * project-scoped (system_health is system-wide); the WebSocket
 * `system_health` event is wired to invalidate this key in `useEvents`.
 */
import { keepPreviousData, useQuery } from '@tanstack/react-query'

import { api } from '../lib/api'

export type ComponentStatus = 'healthy' | 'degraded' | 'unhealthy'

// `'object_store'` is the neutral wire identifier — vendor-agnostic across
// SeaweedFS today and any future hosted AWS S3 deploy. See
// `packages/backend/src/services/health.ts` (ComponentName) for the
// corresponding backend type.
export type ComponentName = 'database' | 'redis' | 'object_store' | 'queues'

export interface ComponentHealth {
  status: ComponentStatus
  message?: string
  detail?: Record<string, unknown>
  durationMs: number
}

export interface SystemHealth {
  status: ComponentStatus
  timestamp: string
  version: string
  components: Record<ComponentName, ComponentHealth>
}

export const SYSTEM_HEALTH_QUERY_KEY = ['system-health'] as const

export function useSystemHealth() {
  return useQuery<SystemHealth>({
    queryKey: SYSTEM_HEALTH_QUERY_KEY,
    queryFn: () => api.get<SystemHealth>('/dashboard/health'),
    refetchInterval: 30_000,
    // Tolerate occasional probe blips without flipping the UI to "error".
    retry: 1,
    // The card's job is to *report* outages — keep showing the last good
    // snapshot during a transient fetch failure rather than flipping the
    // UI to a loading or error state.
    placeholderData: keepPreviousData,
    staleTime: 15_000,
  })
}
