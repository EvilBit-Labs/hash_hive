import type { HashSearchResponse } from '@hashhive/shared'

import { useQuery } from '@tanstack/react-query'

import { api } from '../lib/api'
import { useUiStore } from '../stores/ui'

const SEARCH_DEFAULT_LIMIT = 50

/**
 * Fetches hash search results from the dashboard search endpoint.
 *
 * The query is disabled until both a project is selected and a non-empty
 * query string is provided. The caller is responsible for debouncing `q`
 * before passing it in.
 */
export function useHashSearch(q: string) {
  const selectedProjectId = useUiStore((s) => s.selectedProjectId)

  return useQuery({
    queryKey: ['hash-search', selectedProjectId, q],
    queryFn: async () => {
      const params = new URLSearchParams([
        ['q', q.trim()],
        ['limit', String(SEARCH_DEFAULT_LIMIT)],
        ['offset', '0'],
      ])
      return api.get<HashSearchResponse>(`/dashboard/hashes/search?${params.toString()}`)
    },
    enabled: !!selectedProjectId && q.trim().length > 0,
  })
}
