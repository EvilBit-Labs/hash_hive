import type { ListResultsResponse } from '@hashhive/shared'

import { useQuery } from '@tanstack/react-query'

import { api } from '../lib/api'
import { useUiStore } from '../stores/ui'

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
  /**
   * Polling interval in milliseconds. The global Results page (U7)
   * passes 30_000 so the cracked-result list stays close to fresh
   * without relying solely on the WebSocket event stream.
   */
  refetchInterval?: number
  /**
   * Caller-side gate that ANDs with the implicit project gate. Lets
   * tab-style call sites (campaign detail Results tab) suspend the
   * query — and its 30s poll — while the operator is on an adjacent
   * tab. Defaults to true so existing call sites keep their behavior.
   */
  enabled?: boolean
}

export function useResults(options?: UseResultsOptions) {
  const selectedProjectId = useUiStore((s) => s.selectedProjectId)
  const callerEnabled = options?.enabled ?? true

  return useQuery<ListResultsResponse>({
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
      return api.get<ListResultsResponse>(`/dashboard/results${query ? `?${query}` : ''}`)
    },
    enabled: !!selectedProjectId && callerEnabled,
    ...(options?.refetchInterval !== undefined && { refetchInterval: options.refetchInterval }),
  })
}
