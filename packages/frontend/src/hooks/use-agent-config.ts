import type {
  AgentConfig,
  AgentConfigResponse,
  FleetConfigResponse,
  FleetDefaultConfig,
} from '@hashhive/shared'

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { api } from '../lib/api'

// ─── Per-rig config ──────────────────────────────────────────────────────────

/**
 * Fetches per-rig configuration for a single agent.
 *
 * Query key: `['agent-config', agentId]`
 * The key does NOT include `selectedProjectId` — agent ids are globally unique
 * so there is no cross-project collision risk. Mirrors the shape difference
 * versus `useAgent`, which does include `selectedProjectId`.
 */
export function useAgentConfig(agentId: number) {
  return useQuery<AgentConfigResponse>({
    queryKey: ['agent-config', agentId],
    queryFn: () => api.get<AgentConfigResponse>(`/dashboard/agents/${agentId}/config`),
    enabled: agentId > 0,
  })
}

/**
 * PATCH per-rig configuration.
 *
 * On success invalidates:
 *  - `['agent-config', agentId]`   — this hook's own cache
 *  - `['agent', agentId]`          — agent detail (prefix-matches the scoped key)
 *  - `['agents']`                  — agent list (no scoping needed; RQ prefix-matches)
 */
export function useUpdateAgentConfig(agentId: number) {
  const qc = useQueryClient()
  return useMutation<AgentConfigResponse, unknown, AgentConfig>({
    mutationFn: (patch) =>
      api.patch<AgentConfigResponse>(`/dashboard/agents/${agentId}/config`, patch),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['agent-config', agentId] })
      void qc.invalidateQueries({ queryKey: ['agent', agentId] })
      void qc.invalidateQueries({ queryKey: ['agents'] })
    },
  })
}

// ─── Fleet-wide default config ───────────────────────────────────────────────

/**
 * Fetches the fleet-wide default configuration.
 *
 * Query key: `['fleet-agent-config']`
 * Always enabled — fleet config is a global resource, not project-scoped.
 */
export function useFleetDefaultConfig() {
  return useQuery<FleetConfigResponse>({
    queryKey: ['fleet-agent-config'],
    queryFn: () => api.get<FleetConfigResponse>('/dashboard/fleet-agent-config'),
  })
}

/**
 * PATCH fleet-wide default configuration.
 *
 * On success invalidates `['fleet-agent-config']` only. Individual agent
 * effective-config caches are intentionally not fanned out here; U8/U9
 * consumers re-fetch agent config independently when they mount.
 */
export function useUpdateFleetDefaultConfig() {
  const qc = useQueryClient()
  return useMutation<FleetConfigResponse, unknown, FleetDefaultConfig>({
    mutationFn: (patch) => api.patch<FleetConfigResponse>('/dashboard/fleet-agent-config', patch),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['fleet-agent-config'] })
    },
  })
}
