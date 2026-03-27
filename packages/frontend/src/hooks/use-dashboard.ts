import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { useUiStore } from '../stores/ui';

interface DashboardStats {
  agents: { total: number; online: number; offline: number; error: number };
  campaigns: {
    total: number;
    draft: number;
    running: number;
    paused: number;
    completed: number;
  };
  tasks: { total: number; pending: number; running: number; completed: number; failed: number };
  cracked: { total: number };
}

interface Agent {
  id: number;
  name: string;
  status: string;
  lastSeenAt: string | null;
  projectId: number;
  capabilities: Record<string, unknown> | null;
  hardwareProfile: Record<string, unknown> | null;
  createdAt: string;
}

interface Campaign {
  id: number;
  name: string;
  status: string;
  projectId: number;
  priority: number;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

interface AgentError {
  id: number;
  agentId: number;
  severity: string;
  message: string;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

export function useDashboardStats() {
  const { selectedProjectId } = useUiStore();

  return useQuery<DashboardStats>({
    queryKey: ['dashboard-stats', selectedProjectId],
    queryFn: () => api.get<DashboardStats>('/dashboard/stats'),
    enabled: !!selectedProjectId,
    refetchInterval: 30_000,
  });
}

export function useAgents(options?: { status?: string; limit?: number; offset?: number }) {
  const { selectedProjectId } = useUiStore();

  return useQuery({
    queryKey: ['agents', selectedProjectId, options],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (options?.status) params.set('status', options.status);
      if (options?.limit !== undefined) params.set('limit', String(options.limit));
      if (options?.offset !== undefined) params.set('offset', String(options.offset));

      const query = params.toString();
      return api.get<{ agents: Agent[]; total: number }>(
        `/dashboard/agents${query ? `?${query}` : ''}`
      );
    },
    enabled: !!selectedProjectId,
  });
}

export function useAgent(agentId: number) {
  const { selectedProjectId } = useUiStore();

  return useQuery({
    queryKey: ['agent', agentId, selectedProjectId],
    queryFn: () => api.get<{ agent: Agent }>(`/dashboard/agents/${agentId}`),
    enabled: agentId > 0 && !!selectedProjectId,
  });
}

export function useAgentErrors(agentId: number) {
  const { selectedProjectId } = useUiStore();

  return useQuery({
    queryKey: ['agent-errors', agentId, selectedProjectId],
    queryFn: () =>
      api.get<{ errors: AgentError[] }>(`/dashboard/agents/${agentId}/errors?limit=50`),
    enabled: agentId > 0 && !!selectedProjectId,
  });
}

interface AgentBenchmark {
  id: number;
  agentId: number;
  hashcatMode: number;
  hashType: string;
  speedHs: number;
  deviceName: string;
  benchmarkedAt: string;
}

export function useAgentBenchmarks(agentId: number) {
  const { selectedProjectId } = useUiStore();

  return useQuery({
    queryKey: ['agent-benchmarks', agentId, selectedProjectId],
    queryFn: () =>
      api.get<{ benchmarks: AgentBenchmark[] }>(`/dashboard/agents/${agentId}/benchmarks`),
    enabled: agentId > 0 && !!selectedProjectId,
  });
}

export function useCampaigns(options?: { status?: string; limit?: number; offset?: number }) {
  const { selectedProjectId } = useUiStore();

  return useQuery({
    queryKey: ['campaigns', selectedProjectId, options],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (options?.status) params.set('status', options.status);
      if (options?.limit !== undefined) params.set('limit', String(options.limit));
      if (options?.offset !== undefined) params.set('offset', String(options.offset));

      const query = params.toString();
      return api.get<{ campaigns: Campaign[]; total: number }>(
        `/dashboard/campaigns${query ? `?${query}` : ''}`
      );
    },
    enabled: !!selectedProjectId,
  });
}
