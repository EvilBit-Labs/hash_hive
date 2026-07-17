import type {
  CampaignLifecycleAction,
  ConfirmSplitCampaignRequest,
  ConfirmSplitCampaignResponse,
  CreateAttackRequest,
  CreateCampaignRequest,
  SplitReviewGroups,
} from '@hashhive/shared'

import { useMutation, useQueryClient } from '@tanstack/react-query'

import { api } from '../lib/api'

// Re-export for callers that want the lifecycle action type alongside
// the mutation hooks.
export type { CampaignLifecycleAction } from '@hashhive/shared'

// API response types — represent JSON-serialized shapes (dates as strings)
interface Campaign {
  id: number
  name: string
  status: string
  projectId: number
}

interface Attack {
  id: number
  campaignId: number
  mode: number
}

// Discriminated result of `POST /dashboard/campaigns`. The route returns
// 201 with the created campaign for the normal (unanalyzed/homogeneous
// hash list) path, and 200 with `SplitReviewGroups` instead when the
// target hash list's persisted `type_analysis.verdict` is mixed/needs-review
// (issue #202 SU3/SU6) — no campaign was created, and the caller must
// resolve the ambiguous groups and confirm via `useConfirmSplitCampaign`.
// The mutation branches on the response's HTTP status, never on body
// shape, since guessing from shape alone is exactly the kind of
// contract drift this discriminated union exists to prevent.
export type CreateCampaignResult =
  | { kind: 'created'; campaign: Campaign }
  | { kind: 'split_review'; review: SplitReviewGroups }

export function useCreateCampaign() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (data: CreateCampaignRequest): Promise<CreateCampaignResult> => {
      const { status, data: body } = await api.postWithStatus<
        { campaign: Campaign } | SplitReviewGroups
      >('/dashboard/campaigns', data)

      if (status === 200) {
        return { kind: 'split_review', review: body as SplitReviewGroups }
      }
      return { kind: 'created', campaign: (body as { campaign: Campaign }).campaign }
    },
    onSuccess: (result) => {
      // Nothing was created on the split-review branch — no list to
      // invalidate yet. The confirm mutation invalidates once the parent
      // campaign actually exists.
      if (result.kind === 'created') {
        void queryClient.invalidateQueries({ queryKey: ['campaigns'] })
      }
    },
  })
}

/**
 * Confirms a mixed-hash-list split review (issue #202 SU6): resolves the
 * caller's per-ambiguous-group mode assignments and creates the parent
 * campaign plus one single-mode sub-campaign per resolved sub-list. Always
 * 201 — this endpoint has no split-review branch of its own.
 */
export function useConfirmSplitCampaign() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (data: ConfirmSplitCampaignRequest) =>
      api.post<ConfirmSplitCampaignResponse>('/dashboard/campaigns/split/confirm', data),
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: ['campaigns'] })
      void queryClient.invalidateQueries({
        queryKey: ['hash-list-detail', result.parentHashListId],
      })
      void queryClient.invalidateQueries({ queryKey: ['hash-lists'] })
    },
  })
}

export function useCreateAttack(campaignId: number) {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (data: CreateAttackRequest) =>
      api.post<{ attack: Attack }>(`/dashboard/campaigns/${campaignId}/attacks`, data),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['campaign', campaignId] })
    },
  })
}

interface LifecycleVariables {
  campaignId: number
  action: CampaignLifecycleAction
}

/**
 * Lifecycle mutation for campaigns. Takes the campaign id at mutate-time
 * so a single hook instance can target any row without a render cycle.
 * Required by the list page's Pause action, which fires without a
 * confirmation modal and therefore has no setState-driven rerender to
 * rebind a render-time id.
 */
export function useCampaignLifecycle() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: ({ campaignId, action }: LifecycleVariables) =>
      api.post<{ campaign: Campaign }>(`/dashboard/campaigns/${campaignId}/lifecycle`, {
        action,
      }),
    onSuccess: (_data, { campaignId }) => {
      void queryClient.invalidateQueries({ queryKey: ['campaigns'] })
      void queryClient.invalidateQueries({ queryKey: ['campaign', campaignId] })
    },
  })
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
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async ({ campaignId }: { campaignId: number }) => {
      const response = await api.delete<{ deleted: boolean; id: number }>(
        `/dashboard/campaigns/${campaignId}`
      )
      if (response.deleted !== true) {
        throw new Error('Delete request returned without deleted: true')
      }
      return response
    },
    onSuccess: (_data, { campaignId }) => {
      void queryClient.invalidateQueries({ queryKey: ['campaigns'] })
      void queryClient.invalidateQueries({ queryKey: ['dashboard-stats'] })
      queryClient.removeQueries({ queryKey: ['campaign', campaignId] })
    },
  })
}
