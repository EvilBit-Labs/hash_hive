import type { CrackedResultRow, ListResultsResponse } from '@hashhive/shared'

import { useQuery } from '@tanstack/react-query'

import { api } from '../lib/api'
import { useUiStore } from '../stores/ui'

// Wire shapes live in `@hashhive/shared` as `z.infer` from the canonical
// Zod schemas (`crackedResultRowSchema` / `listResultsResponseSchema`)
// per AGENTS.md. Re-export local aliases so existing in-package callers
// keep their imports stable while we point at the shared source of truth.
export type CrackedResult = CrackedResultRow
export type ResultsResponse = ListResultsResponse

interface UseResultsOptions {
  campaignId?: number
  hashListId?: number
  search?: string
  /** ISO 8601 timestamp (e.g. `2026-06-01T00:00:00.000Z`). */
  startDate?: string
  /** ISO 8601 timestamp (e.g. `2026-06-08T23:59:59.000Z`). */
  endDate?: string
  limit?: number
  offset?: number
}

export function useResults(options?: UseResultsOptions) {
  const selectedProjectId = useUiStore((s) => s.selectedProjectId)

  return useQuery<ResultsResponse>({
    queryKey: ['results', selectedProjectId, options],
    queryFn: () => {
      const params = new URLSearchParams()
      if (options?.campaignId) params.set('campaignId', String(options.campaignId))
      if (options?.hashListId) params.set('hashListId', String(options.hashListId))
      if (options?.search) params.set('q', options.search)
      if (options?.startDate) params.set('startDate', options.startDate)
      if (options?.endDate) params.set('endDate', options.endDate)
      if (options?.limit !== undefined) params.set('limit', String(options.limit))
      if (options?.offset !== undefined) params.set('offset', String(options.offset))

      const query = params.toString()
      return api.get<ResultsResponse>(`/dashboard/results${query ? `?${query}` : ''}`)
    },
    enabled: !!selectedProjectId,
  })
}
