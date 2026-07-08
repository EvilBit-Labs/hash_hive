import type {
  AgentCurrentTask,
  AgentTaskSummary,
  AgentWorstSeverity,
  CampaignDetailPayload,
  CampaignEta,
  DashboardStats,
  SelectAgentError,
  UseCampaignsOptions,
} from '@hashhive/shared'

import { useQuery } from '@tanstack/react-query'

import { api } from '../lib/api'
import { useUiStore } from '../stores/ui'

// Re-export so existing component imports keep working without forcing every
// caller to switch to the shared package directly.
export type {
  AgentCurrentTask,
  AgentWorstSeverity,
  CampaignActiveAgent,
  CampaignAttackRow,
  CampaignDetailPayload,
  CampaignEta,
  CampaignLifecycleAction,
  CampaignSortField,
  CampaignSortOrder,
  CampaignTaskStats,
  UseCampaignsOptions,
} from '@hashhive/shared'

interface Agent {
  id: number
  name: string
  status: string
  lastSeenAt: string | null
  projectId: number
  capabilities: Record<string, unknown> | null
  hardwareProfile: Record<string, unknown> | null
  createdAt: string
  errorCount24h?: number
  worstSeverity24h?: AgentWorstSeverity
  currentTask?: AgentCurrentTask | null
}

// Frontend alias for the shared task-detail shape — keeps existing component
// imports stable while pointing at the shared source of truth.
export type AgentTask = AgentTaskSummary

interface CampaignProgressShape {
  totalTasks?: number
  completedTasks?: number
  overallProgress?: number
  percentage?: number
  hashProgress?: {
    total: number
    cracked: number
    remaining: number
    percentage: number
  }
}

interface Campaign {
  id: number
  name: string
  status: string
  projectId: number
  priority: number
  hashListId: number
  description: string | null
  progress?: CampaignProgressShape | null
  createdAt: string
  startedAt: string | null
  completedAt: string | null
  // Issue #100: read-time rollup from the batched `/dashboard/campaigns`
  // list route. Always present on the wire (the route defaults a
  // campaign with no eta entry to `{ state: 'estimating' }`), typed
  // optional here only because pre-#100 fixtures may omit it.
  eta?: CampaignEta
}

// SelectAgentError has `createdAt: Date` (Drizzle row shape) but the wire
// shape serializes it as an ISO string. Map at the boundary so consumers
// stay typed without re-declaring the row shape locally.
export type AgentError = Omit<SelectAgentError, 'createdAt'> & { createdAt: string }

export function useDashboardStats() {
  const selectedProjectId = useUiStore((s) => s.selectedProjectId)

  return useQuery<DashboardStats>({
    queryKey: ['dashboard-stats', selectedProjectId],
    // Freshness is primarily event-driven: `packages/frontend/src/lib/event-routing.ts`
    // maps `agent_status`, `campaign_status`, `task_update`, and `crack_result`
    // to invalidate `['dashboard-stats']`. The 60s interval is a safety-net
    // floor for periods when the WebSocket is unavailable; lengthened from
    // the previous 30s now that the brainstorm's freshness gap is closed
    // by the existing routing map (see plan #161 D5 / Reframed §).
    queryFn: () => api.get<DashboardStats>('/dashboard/stats'),
    enabled: !!selectedProjectId,
    refetchInterval: 60_000,
  })
}

export function useAgents(options?: { status?: string; limit?: number; offset?: number }) {
  const selectedProjectId = useUiStore((s) => s.selectedProjectId)

  return useQuery({
    queryKey: ['agents', selectedProjectId, options],
    queryFn: async () => {
      const params = new URLSearchParams()
      if (options?.status) params.set('status', options.status)
      if (options?.limit !== undefined) params.set('limit', String(options.limit))
      if (options?.offset !== undefined) params.set('offset', String(options.offset))

      const query = params.toString()
      return api.get<{ agents: Agent[]; total: number }>(
        `/dashboard/agents${query ? `?${query}` : ''}`
      )
    },
    enabled: !!selectedProjectId,
  })
}

export function useAgent(agentId: number) {
  const selectedProjectId = useUiStore((s) => s.selectedProjectId)

  return useQuery({
    queryKey: ['agent', agentId, selectedProjectId],
    queryFn: () => api.get<{ agent: Agent }>(`/dashboard/agents/${agentId}`),
    enabled: agentId > 0 && !!selectedProjectId,
  })
}

export function useAgentErrors(agentId: number) {
  const selectedProjectId = useUiStore((s) => s.selectedProjectId)

  return useQuery({
    queryKey: ['agent-errors', agentId, selectedProjectId],
    queryFn: () =>
      api.get<{ errors: AgentError[] }>(`/dashboard/agents/${agentId}/errors?limit=50`),
    enabled: agentId > 0 && !!selectedProjectId,
  })
}

// SelectAgentBenchmark from @hashhive/shared has Date fields; over JSON they arrive as strings.
// Keep a mapped type for the API response shape.
type AgentBenchmarkResponse = Omit<
  import('@hashhive/shared').SelectAgentBenchmark,
  'benchmarkedAt'
> & { benchmarkedAt: string }

export function useAgentBenchmarks(agentId: number) {
  const selectedProjectId = useUiStore((s) => s.selectedProjectId)

  return useQuery({
    queryKey: ['agent-benchmarks', agentId, selectedProjectId],
    queryFn: () =>
      api.get<{ benchmarks: AgentBenchmarkResponse[] }>(`/dashboard/agents/${agentId}/benchmarks`),
    enabled: agentId > 0 && !!selectedProjectId,
  })
}

export function useAgentTasks(agentId: number) {
  const selectedProjectId = useUiStore((s) => s.selectedProjectId)

  return useQuery({
    queryKey: ['agent-tasks', agentId, selectedProjectId],
    queryFn: () => api.get<{ tasks: AgentTask[] }>(`/dashboard/agents/${agentId}/tasks`),
    enabled: agentId > 0 && !!selectedProjectId,
  })
}

export function useCampaigns(options?: UseCampaignsOptions) {
  const selectedProjectId = useUiStore((s) => s.selectedProjectId)

  return useQuery({
    queryKey: ['campaigns', selectedProjectId, options],
    queryFn: async () => {
      const params = new URLSearchParams()
      if (options?.status) params.set('status', options.status)
      if (options?.priority !== undefined) params.set('priority', String(options.priority))
      if (options?.sort) params.set('sort', options.sort)
      if (options?.order) params.set('order', options.order)
      if (options?.limit !== undefined) params.set('limit', String(options.limit))
      if (options?.offset !== undefined) params.set('offset', String(options.offset))

      const query = params.toString()
      return api.get<{ campaigns: Campaign[]; total: number }>(
        `/dashboard/campaigns${query ? `?${query}` : ''}`
      )
    },
    enabled: !!selectedProjectId,
  })
}

/**
 * Loads the enriched campaign detail payload from
 * `GET /dashboard/campaigns/:id`. Cache key includes `selectedProjectId`
 * to prevent cross-project leakage when a user switches projects and
 * navigates to a campaign id that exists in both. Mirrors the
 * `useAgent` / `useAgentErrors` scoping pattern. The useEvents
 * invalidation map refreshes this key on `campaign_status` and
 * `task_update` events that carry the matching `campaignId`.
 */
export function useCampaignDetail(campaignId: number) {
  const selectedProjectId = useUiStore((s) => s.selectedProjectId)

  return useQuery({
    queryKey: ['campaign', campaignId, selectedProjectId],
    queryFn: () => api.get<CampaignDetailPayload>(`/dashboard/campaigns/${campaignId}`),
    enabled: Number.isInteger(campaignId) && campaignId > 0 && !!selectedProjectId,
  })
}
