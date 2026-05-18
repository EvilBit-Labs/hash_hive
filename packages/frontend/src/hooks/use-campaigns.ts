import type {
  CampaignLifecycleAction,
  CreateAttackRequest,
  CreateCampaignRequest,
} from '@hashhive/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';

// Re-export for callers that want the lifecycle action type alongside
// the mutation hooks.
export type { CampaignLifecycleAction } from '@hashhive/shared';

// API response types — represent JSON-serialized shapes (dates as strings)
interface Campaign {
  id: number;
  name: string;
  status: string;
  projectId: number;
}

interface Attack {
  id: number;
  campaignId: number;
  mode: number;
}

export function useCreateCampaign() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (data: CreateCampaignRequest) =>
      api.post<{ campaign: Campaign }>('/dashboard/campaigns', data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['campaigns'] });
    },
  });
}

export function useCreateAttack(campaignId: number) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (data: CreateAttackRequest) =>
      api.post<{ attack: Attack }>(`/dashboard/campaigns/${campaignId}/attacks`, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['campaign', campaignId] });
    },
  });
}

interface LifecycleVariables {
  campaignId: number;
  action: CampaignLifecycleAction;
}

/**
 * Lifecycle mutation for campaigns. Takes the campaign id at mutate-time
 * so a single hook instance can target any row without a render cycle.
 * Required by the list page's Pause action, which fires without a
 * confirmation modal and therefore has no setState-driven rerender to
 * rebind a render-time id.
 */
export function useCampaignLifecycle() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ campaignId, action }: LifecycleVariables) =>
      api.post<{ campaign: Campaign }>(`/dashboard/campaigns/${campaignId}/lifecycle`, {
        action,
      }),
    onSuccess: (_data, { campaignId }) => {
      queryClient.invalidateQueries({ queryKey: ['campaigns'] });
      queryClient.invalidateQueries({ queryKey: ['campaign', campaignId] });
    },
  });
}

/**
 * Delete a draft campaign. The backend enforces draft-only deletion;
 * non-draft campaigns surface as 409 NOT_DRAFT, which is propagated to
 * the caller so the UI can render a banner without rolling back any
 * cached state. Takes the campaign id at mutate-time so the list page
 * can target any row. Throws if the server returns `{ deleted: false }`
 * so a contract regression cannot quietly leave the row in the list.
 */
export function useCampaignDelete() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ campaignId }: { campaignId: number }) => {
      const response = await api.delete<{ deleted: boolean; id: number }>(
        `/dashboard/campaigns/${campaignId}`
      );
      if (response.deleted !== true) {
        throw new Error('Delete request returned without deleted: true');
      }
      return response;
    },
    onSuccess: (_data, { campaignId }) => {
      queryClient.invalidateQueries({ queryKey: ['campaigns'] });
      queryClient.invalidateQueries({ queryKey: ['dashboard-stats'] });
      queryClient.removeQueries({ queryKey: ['campaign', campaignId] });
    },
  });
}
