import type { CreateAttackRequest, CreateCampaignRequest } from '@hashhive/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';

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

export type CampaignLifecycleAction = 'start' | 'pause' | 'stop' | 'cancel';

interface LifecycleVariables {
  campaignId: number;
  action: CampaignLifecycleAction;
}

/**
 * Lifecycle mutation for campaigns. Takes the campaign id at mutate-time
 * rather than hook-bind-time so the caller can fire actions against any
 * row without a rerender. The list page in particular needs this: Pause
 * fires immediately on click without an interstitial confirm modal, so
 * the previous render-bound hook would have sent the request to
 * `/campaigns/0/lifecycle` when no campaign was yet "selected".
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
 * can target any row.
 */
export function useCampaignDelete() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ campaignId }: { campaignId: number }) =>
      api.delete<{ deleted: boolean; id: number }>(`/dashboard/campaigns/${campaignId}`),
    onSuccess: (_data, { campaignId }) => {
      queryClient.invalidateQueries({ queryKey: ['campaigns'] });
      queryClient.removeQueries({ queryKey: ['campaign', campaignId] });
    },
  });
}
