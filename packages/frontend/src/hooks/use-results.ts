import { useQuery } from '@tanstack/react-query'

import { api } from '../lib/api'
import { useUiStore } from '../stores/ui'

interface CrackedResult {
  id: number
  hashValue: string
  plaintext: string | null
  crackedAt: string | null
  hashListId: number
  hashListName: string
  campaignId: number | null
  campaignName: string
  attackId: number | null
  attackMode: number | null
  agentId: number | null
}

interface ResultsResponse {
  results: CrackedResult[]
  total: number
  limit: number
  offset: number
}

export function useResults(options?: {
  campaignId?: number
  hashListId?: number
  search?: string
  limit?: number
  offset?: number
}) {
  const { selectedProjectId } = useUiStore()

  return useQuery<ResultsResponse>({
    queryKey: ['results', selectedProjectId, options],
    queryFn: () => {
      const params = new URLSearchParams()
      if (options?.campaignId) params.set('campaignId', String(options.campaignId))
      if (options?.hashListId) params.set('hashListId', String(options.hashListId))
      if (options?.search) params.set('q', options.search)
      if (options?.limit !== undefined) params.set('limit', String(options.limit))
      if (options?.offset !== undefined) params.set('offset', String(options.offset))

      const query = params.toString()
      return api.get<ResultsResponse>(`/dashboard/results${query ? `?${query}` : ''}`)
    },
    enabled: !!selectedProjectId,
  })
}

export function useResultsExportUrl(options?: {
  campaignId?: number
  hashListId?: number
  search?: string
}) {
  const { selectedProjectId } = useUiStore()

  if (!selectedProjectId) return null

  const params = new URLSearchParams()
  if (options?.campaignId) params.set('campaignId', String(options.campaignId))
  if (options?.hashListId) params.set('hashListId', String(options.hashListId))
  if (options?.search) params.set('q', options.search)

  const query = params.toString()
  return `/api/v1/dashboard/results/export${query ? `?${query}` : ''}`
}
