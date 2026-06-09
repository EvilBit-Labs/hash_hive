import type { HashListListResponse } from '@hashhive/shared'

import { useQuery } from '@tanstack/react-query'

import { api } from '../lib/api'
import { useUiStore } from '../stores/ui'

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
export function useHashLists() {
  const selectedProjectId = useUiStore((s) => s.selectedProjectId)

  return useQuery<HashListListResponse>({
    queryKey: ['hash-lists', selectedProjectId],
    queryFn: () => api.get<HashListListResponse>('/dashboard/hash-lists'),
    enabled: !!selectedProjectId,
  })
}
