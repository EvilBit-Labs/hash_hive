import type { HashListListResponse } from '@hashhive/shared'

import { useQuery } from '@tanstack/react-query'

import { api } from '../lib/api'
import { useUiStore } from '../stores/ui'

interface UseHashListsOptions {
  /**
   * Optional gate that defers fetching even when a project is selected.
   * The global Results page's hash-list filter dropdown (U7) uses this
   * to lazy-load options only after the operator opens the menu, so a
   * page mount with three filter dropdowns does not fan out three
   * parallel requests when only one will be touched.
   */
  enabled?: boolean
}

/**
 * Project-scoped hash-lists listing hook (U3, plan 2026-06-08-001).
 *
 * Thin TanStack Query wrapper over `GET /api/v1/dashboard/hash-lists`
 * (added in U2). Consumed by the global Results page's hash-list filter
 * dropdown (U7) and the hash list detail stats card (U10).
 *
 * Per AGENTS.md the wire shape lives in `@hashhive/shared` as `z.infer`
 * from `hashListListResponseSchema`. The cache key is scoped by
 * `selectedProjectId` so switching projects does not leak rows across
 * projects in the TanStack Query cache.
 */
export function useHashLists(options?: UseHashListsOptions) {
  const selectedProjectId = useUiStore((s) => s.selectedProjectId)
  const callerEnabled = options?.enabled ?? true

  return useQuery<HashListListResponse>({
    queryKey: ['hash-lists', selectedProjectId],
    queryFn: () => api.get<HashListListResponse>('/dashboard/hash-lists'),
    enabled: !!selectedProjectId && callerEnabled,
  })
}
