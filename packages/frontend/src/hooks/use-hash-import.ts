import type { ImportFormat, ImportSummary } from '@hashhive/shared'

import { useMutation } from '@tanstack/react-query'

import { api } from '../lib/api'

interface ImportPrecrackedArgs {
  hashListId: number
  content: string
  format: ImportFormat
}

/**
 * Mutation hook for submitting pre-cracked hash/plaintext pairs to a target
 * hash list via `POST /dashboard/hashes/hash-lists/{id}/import-precracked`.
 *
 * The endpoint accepts a JSON body (`{ content, format }`) and returns 202
 * with a compartmentalised summary that reflects enqueue-time counts for the
 * target list only. Actual propagation to results is async — query
 * invalidation belongs in the caller (e.g. when the operator closes the
 * import modal's summary phase) rather than in onSuccess here.
 */
export function useImportPrecracked() {
  return useMutation<ImportSummary, Error, ImportPrecrackedArgs>({
    mutationFn: ({ hashListId, content, format }) =>
      api.post<ImportSummary>(`/dashboard/hashes/hash-lists/${hashListId}/import-precracked`, {
        content,
        format,
      }),
  })
}
