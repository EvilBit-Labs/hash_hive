import type { AuditLogListResponse } from '@hashhive/shared'

import { type UseQueryResult, useQuery } from '@tanstack/react-query'

import { api } from '../lib/api'
import { useUiStore } from '../stores/ui'

interface UseAuditLogsOptions {
  entityType?: string
  entityId?: number
  actorType?: string
  action?: string
  /** ISO 8601 datetime string (e.g. `2026-06-01T00:00:00.000Z`). */
  dateFrom?: string
  /** ISO 8601 datetime string (e.g. `2026-06-30T23:59:59.999Z`). */
  dateTo?: string
  limit?: number
  offset?: number
  /**
   * Caller-side gate that ANDs with the implicit project gate. Lets call
   * sites suspend the query while irrelevant. Defaults to true.
   */
  enabled?: boolean
}

export function useAuditLogs(
  options?: UseAuditLogsOptions
): UseQueryResult<AuditLogListResponse, Error> {
  const selectedProjectId = useUiStore((s) => s.selectedProjectId)
  const callerEnabled = options?.enabled ?? true

  // Normalize options into the EXACT URL-meaningful subset before composing
  // both the cache key and the request. Using Array<[string,string]> pairs
  // prevents cache sharding for logically identical queries (e.g. an
  // option of `undefined` vs. absent produces the same URL and the same key).
  const requestPairs: Array<[string, string]> = []
  if (options?.entityType) requestPairs.push(['entityType', options.entityType])
  if (options?.entityId !== undefined) requestPairs.push(['entityId', String(options.entityId)])
  if (options?.actorType) requestPairs.push(['actorType', options.actorType])
  if (options?.action) requestPairs.push(['action', options.action])
  if (options?.dateFrom) requestPairs.push(['dateFrom', options.dateFrom])
  if (options?.dateTo) requestPairs.push(['dateTo', options.dateTo])
  if (options?.limit !== undefined) requestPairs.push(['limit', String(options.limit)])
  if (options?.offset !== undefined) requestPairs.push(['offset', String(options.offset)])

  return useQuery({
    queryKey: ['audit-logs', selectedProjectId, requestPairs],
    queryFn: () => {
      const params = new URLSearchParams(requestPairs)
      const query = params.toString()
      return api.get<AuditLogListResponse>(`/dashboard/audit-logs${query ? `?${query}` : ''}`)
    },
    enabled: !!selectedProjectId && callerEnabled,
  })
}
