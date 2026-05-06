/**
 * React Query bindings for the user-profile API-key endpoints.
 *
 * Issue / rotate / revoke flow:
 *   - `useApiKeyMetadata`  -> reads metadata only (never the raw token)
 *   - `useIssueApiKey`     -> POST returns the raw token exactly once
 *   - `useRevokeApiKey`    -> DELETE; nulls the stored hash
 *
 * The page owns presentation: hooks return mutation results and call
 * `onError` for user-facing failure messaging, but never render anything.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';

export interface ApiKeyMetadata {
  hasKey: boolean;
  prefix: string | null;
  lastUsedAt: string | null;
}

export interface IssueApiKeyResponse {
  token: string;
  metadata: ApiKeyMetadata;
}

interface MutationCallbacks {
  onError?: (message: string) => void;
}

const QUERY_KEY = ['account', 'api-key'] as const;

function errorMessage(err: unknown, fallback: string): string {
  if (err instanceof Error && err.message) return err.message;
  return fallback;
}

export function useApiKeyMetadata() {
  return useQuery<ApiKeyMetadata>({
    queryKey: QUERY_KEY,
    queryFn: () => api.get<ApiKeyMetadata>('/dashboard/auth/me/api-key'),
  });
}

export function useIssueApiKey({ onError }: MutationCallbacks = {}) {
  const qc = useQueryClient();
  return useMutation<IssueApiKeyResponse, unknown, void>({
    mutationFn: () => api.post<IssueApiKeyResponse>('/dashboard/auth/me/api-key'),
    onSuccess: (data) => {
      qc.setQueryData<ApiKeyMetadata>(QUERY_KEY, data.metadata);
    },
    onError: (err) => onError?.(errorMessage(err, 'Failed to issue API key')),
  });
}

export function useRevokeApiKey({ onError }: MutationCallbacks = {}) {
  const qc = useQueryClient();
  return useMutation<void, unknown, void>({
    mutationFn: async () => {
      await api.delete<unknown>('/dashboard/auth/me/api-key');
    },
    onSuccess: () => {
      qc.setQueryData<ApiKeyMetadata>(QUERY_KEY, {
        hasKey: false,
        prefix: null,
        lastUsedAt: null,
      });
    },
    onError: (err) => onError?.(errorMessage(err, 'Failed to revoke API key')),
  });
}
