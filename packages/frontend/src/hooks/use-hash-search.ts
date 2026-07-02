import type { HashSearchResponse } from '@hashhive/shared'

import { SEARCH_DEFAULT_LIMIT } from '@hashhive/shared'
import { useQuery } from '@tanstack/react-query'

import { api } from '../lib/api'
import { useUiStore } from '../stores/ui'

/**
 * Fetches hash search results from the dashboard search endpoint.
 *
 * The query is disabled until both a project is selected and a non-empty
 * query string is provided. The caller is responsible for debouncing `q`
 * before passing it in.
 */
export function useHashSearch(q: string) {
  const selectedProjectId = useUiStore((s) => s.selectedProjectId)
  // Trim once so the query key, enabled gate, and fetch params all use the
  // same value. Without this, ' foo ' and 'foo' share a fetch but differ in
  // the cache key — triggering a redundant request on every leading-space keystroke.
  const trimmedQ = q.trim()

  return useQuery({
    queryKey: ['hash-search', selectedProjectId, trimmedQ],
    queryFn: async () => {
      const params = new URLSearchParams([
        ['q', trimmedQ],
        ['limit', String(SEARCH_DEFAULT_LIMIT)],
        ['offset', '0'],
      ])
      return api.get<HashSearchResponse>(`/dashboard/hashes/search?${params.toString()}`)
    },
    enabled: !!selectedProjectId && trimmedQ.length > 0,
  })
}
