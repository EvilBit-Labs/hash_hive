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

export function useCampaignLifecycle(campaignId: number) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (action: 'start' | 'pause' | 'stop' | 'cancel') =>
      api.post<{ campaign: Campaign }>(`/dashboard/campaigns/${campaignId}/lifecycle`, {
        action,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['campaigns'] });
      queryClient.invalidateQueries({ queryKey: ['campaign', campaignId] });
    },
  });
}

/**
 * Delete a draft campaign. The backend enforces draft-only deletion;
 * non-draft campaigns surface as 409 NOT_DRAFT, which is propagated to
 * the caller so the UI can render a banner without rolling back any
 * cached state. Successful deletion invalidates the campaigns list.
 */
export function useCampaignDelete(campaignId: number) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: () =>
      api.delete<{ deleted: boolean; id: number }>(`/dashboard/campaigns/${campaignId}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['campaigns'] });
      queryClient.removeQueries({ queryKey: ['campaign', campaignId] });
    },
  });
}
