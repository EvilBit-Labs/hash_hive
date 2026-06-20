import type {
  CreateEnrollmentTokenRequest,
  CreateEnrollmentTokenResponse,
  EnrollmentTokenMetadata,
  ListEnrollmentTokensResponse,
} from '@hashhive/shared'

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { api } from '../lib/api'
import { useUiStore } from '../stores/ui'

export type { CreateEnrollmentTokenRequest, EnrollmentTokenMetadata }

interface MutationCallbacks {
  onError: (message: string) => void
}

// Project-scoped: enrollment tokens belong to the active project, so the
// selected project id is part of the cache key (mirrors use-dashboard).
const queryKey = (projectId: number | null) => ['enrollment-tokens', projectId] as const

function errorMessage(err: unknown, fallback: string): string {
  if (err instanceof Error && err.message) return err.message
  return fallback
}

export function useEnrollmentTokens() {
  const selectedProjectId = useUiStore((s) => s.selectedProjectId)
  return useQuery<EnrollmentTokenMetadata[]>({
    queryKey: queryKey(selectedProjectId),
    queryFn: async () => {
      const res = await api.get<ListEnrollmentTokensResponse>('/dashboard/enrollment-tokens')
      return res.tokens
    },
    enabled: !!selectedProjectId,
  })
}

export function useCreateEnrollmentToken({ onError }: MutationCallbacks) {
  const qc = useQueryClient()
  return useMutation<CreateEnrollmentTokenResponse, unknown, CreateEnrollmentTokenRequest>({
    mutationFn: (input) =>
      api.post<CreateEnrollmentTokenResponse>('/dashboard/enrollment-tokens', input),
    // The raw token is handed to the caller (shown once); only the list
    // metadata is durable, so we refetch rather than cache the response.
    // Invalidate the project the token actually belongs to (from the
    // response), not the store's selected project, which can drift if the
    // operator switches projects while the mutation is in flight.
    onSuccess: (data) => {
      void qc.invalidateQueries({ queryKey: queryKey(data.metadata.projectId) })
    },
    onError: (err) => onError(errorMessage(err, 'Failed to mint enrollment token')),
  })
}

export function useRevokeEnrollmentToken({ onError }: MutationCallbacks) {
  const qc = useQueryClient()
  return useMutation<EnrollmentTokenMetadata, unknown, number>({
    mutationFn: (id) => api.delete<EnrollmentTokenMetadata>(`/dashboard/enrollment-tokens/${id}`),
    // Invalidate the token's own project (from the response) rather than the
    // store's selected project — see useCreateEnrollmentToken.
    onSuccess: (data) => {
      void qc.invalidateQueries({ queryKey: queryKey(data.projectId) })
    },
    onError: (err) => onError(errorMessage(err, 'Failed to revoke enrollment token')),
  })
}
