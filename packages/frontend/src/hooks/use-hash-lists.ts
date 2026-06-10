import type { HashListListResponse } from '@hashhive/shared'

import { type UseQueryResult, useQuery } from '@tanstack/react-query'

import { api } from '../lib/api'
import { useUiStore } from '../stores/ui'

interface UseHashListsOptions {
  /**
   * Optional gate that defers fetching even when a project is selected.
   * The global Results page's hash-list filter dropdown uses this to
   * lazy-load options only after the operator opens the menu.
   */
  enabled?: boolean
}

/**
 * Project-scoped hash list summary hook.
 *
 * Thin TanStack Query wrapper over `GET /api/v1/dashboard/hash-lists`.
 * Returns the strict summary shape (`id`, `name`, `hashTypeId`,
 * `hashCount`, `crackedCount`). Distinct from `use-resources.ts`
 * `useHashLists`, which calls `GET /dashboard/resources/hash-lists`
 * and returns the full row including status, fileRef, createdAt.
 *
 * Cache key is intentionally `hash-list-summaries` (NOT `hash-lists`)
 * to avoid colliding with the resources hook above; both hooks share
 * the project-id segment but their payloads are different shapes and
 * must not bleed into each other's caches.
 */
export function useHashListSummaries(
  options?: UseHashListsOptions
): UseQueryResult<HashListListResponse, Error> {
  const selectedProjectId = useUiStore((s) => s.selectedProjectId)
  const callerEnabled = options?.enabled ?? true

  return useQuery<HashListListResponse>({
    queryKey: ['hash-list-summaries', selectedProjectId],
    queryFn: () => api.get<HashListListResponse>('/dashboard/hash-lists'),
    enabled: !!selectedProjectId && callerEnabled,
  })
}
