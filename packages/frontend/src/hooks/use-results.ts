import type { ListResultsResponse } from '@hashhive/shared'

import { type UseQueryResult, useQuery } from '@tanstack/react-query'

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

export function useResults(
  options?: UseResultsOptions
): UseQueryResult<ListResultsResponse, Error> {
  const selectedProjectId = useUiStore((s) => s.selectedProjectId)
  const callerEnabled = options?.enabled ?? true

  // Normalize options into the EXACT URL-meaningful subset before
  // composing both the cache key and the request. Two cache shards
  // for the same URL is a real bug: `{ search: '', limit: 100 }` and
  // `{ limit: 100 }` produce the same `/dashboard/results?limit=100`
  // request but used to shard the TanStack cache because the
  // spread-style key carried `search: ''` in one branch and not the
  // other.
  const requestPairs: Array<[string, string]> = []
  if (options?.campaignId) requestPairs.push(['campaignId', String(options.campaignId)])
  if (options?.hashListId) requestPairs.push(['hashListId', String(options.hashListId)])
  if (options?.search) requestPairs.push(['q', options.search])
  if (options?.startDate) requestPairs.push(['startDate', options.startDate])
  if (options?.endDate) requestPairs.push(['endDate', options.endDate])
  if (options?.limit !== undefined) requestPairs.push(['limit', String(options.limit)])
  if (options?.offset !== undefined) requestPairs.push(['offset', String(options.offset)])

  return useQuery<ListResultsResponse>({
    queryKey: ['results', selectedProjectId, requestPairs],
    queryFn: () => {
      const params = new URLSearchParams(requestPairs)
      const query = params.toString()
      return api.get<ListResultsResponse>(`/dashboard/results${query ? `?${query}` : ''}`)
    },
    enabled: !!selectedProjectId && callerEnabled,
    ...(options?.refetchInterval !== undefined && { refetchInterval: options.refetchInterval }),
  })
}
