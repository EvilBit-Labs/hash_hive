import type {
  AddSuperMemberRequest,
  CreateSuperRequest,
  RenameSuperRequest,
  SuperCampaignFanoutResponse,
  SuperHashListDetailResponse,
  SuperHashListListResponse,
  SuperHashListResponse,
} from '@hashhive/shared'

import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { api } from '../lib/api'
import { useUiStore } from '../stores/ui'

/**
 * TanStack Query hooks for the SuperHashlist dashboard surface (issue #101
 * U8/U15). Thin wrappers over `/api/v1/dashboard/super-hash-lists` — mirrors
 * `use-resources.ts` conventions exactly:
 *
 * - Wire types come from `@hashhive/shared` (z.infer of the shared Zod
 *   schemas); no local cross-boundary interfaces (AGENTS.md).
 * - Read hooks are project-scoped and gate on `selectedProjectId`.
 * - Query keys `super-hash-lists` / `super-hash-list-detail` MATCH the literals
 *   already wired into `lib/event-routing.ts`, so a `crack_result` /
 *   `resource_update` WS frame invalidates these caches without a new event
 *   type. The list key carries `selectedProjectId` as segment 2 (the exact
 *   shape `routeEvent` invalidates with `[key, sessionProjectId]`).
 */

const BASE = '/dashboard/super-hash-lists'

interface SuperHashListsQueryOptions {
  /** Include archived supers (adds `?showArchived=true`). Defaults to false. */
  showArchived?: boolean
  /** Defer fetching even when a project is selected. */
  enabled?: boolean
}

/**
 * Project-scoped list of super hash lists, paginated with `useInfiniteQuery`
 * (issue #101 M2: the server's default page is 50 rows, so a super past that
 * point was previously unreachable as a campaign target). Callers get the
 * flattened `superHashLists` array across every page fetched so far, plus
 * `total` and the usual TanStack Query flags (`isLoading`, `isError`,
 * `hasNextPage`, `fetchNextPage`, `isFetchingNextPage`, ...) so a "Load more"
 * control can page through the rest.
 */
export function useSuperHashLists(options?: SuperHashListsQueryOptions) {
  const selectedProjectId = useUiStore((s) => s.selectedProjectId)
  const showArchived = options?.showArchived ?? false
  const enabledOverride = options?.enabled ?? true

  const query = useInfiniteQuery({
    queryKey: ['super-hash-lists', selectedProjectId, { showArchived }],
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams({ offset: String(pageParam) })
      if (showArchived) params.set('showArchived', 'true')
      return api.get<SuperHashListListResponse>(`${BASE}?${params.toString()}`)
    },
    initialPageParam: 0,
    // Defensive against a malformed/short-circuited page body (untrusted
    // external data per AGENTS.md) — an unexpected shape stops pagination
    // instead of throwing mid-render.
    getNextPageParam: (lastPage) => {
      const items = lastPage.superHashLists ?? []
      const offset = lastPage.offset ?? 0
      const total = lastPage.total ?? 0
      const loaded = offset + items.length
      return loaded < total ? loaded : undefined
    },
    enabled: !!selectedProjectId && enabledOverride,
  })

  const pages = query.data?.pages ?? []

  return {
    ...query,
    superHashLists: pages.flatMap((page) => page.superHashLists ?? []),
    total: pages.at(-1)?.total ?? 0,
  }
}

/** Single super hash list with its member hash-list ids. */
export function useSuperHashListDetail(id: number) {
  return useQuery<SuperHashListDetailResponse>({
    queryKey: ['super-hash-list-detail', id],
    queryFn: () => api.get<SuperHashListDetailResponse>(`${BASE}/${id}`),
    enabled: !!id,
  })
}

/**
 * Invalidate every super cache after a mutation. Uses the bare key prefix
 * (no project / id segment) so all project + detail variants refresh — the
 * same partial-match convention `use-resources.ts` relies on.
 */
function invalidateSupers(queryClient: ReturnType<typeof useQueryClient>) {
  void queryClient.invalidateQueries({ queryKey: ['super-hash-lists'] })
  void queryClient.invalidateQueries({ queryKey: ['super-hash-list-detail'] })
}

/** Create a super hash list, optionally with an initial member set. */
export function useCreateSuperHashList() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (data: CreateSuperRequest) => api.post<SuperHashListDetailResponse>(BASE, data),
    onSuccess: () => {
      invalidateSupers(queryClient)
    },
  })
}

/** Rename a super hash list. */
export function useRenameSuperHashList(id: number) {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (data: RenameSuperRequest) =>
      api.patch<SuperHashListResponse>(`${BASE}/${id}`, data),
    onSuccess: () => {
      invalidateSupers(queryClient)
    },
  })
}

/** Archive a super hash list (idempotent). */
export function useArchiveSuperHashList() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (id: number) => api.post<SuperHashListResponse>(`${BASE}/${id}/archive`),
    onSuccess: () => {
      invalidateSupers(queryClient)
    },
  })
}

/** Add a member hash list to a super. */
export function useAddSuperMember(id: number) {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (data: AddSuperMemberRequest) =>
      api.post<SuperHashListDetailResponse>(`${BASE}/${id}/members`, data),
    onSuccess: () => {
      invalidateSupers(queryClient)
    },
  })
}

/** Remove a member hash list from a super. */
export function useRemoveSuperMember(id: number) {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (listId: number) =>
      api.delete<SuperHashListDetailResponse>(`${BASE}/${id}/members/${listId}`),
    onSuccess: () => {
      invalidateSupers(queryClient)
    },
  })
}

/**
 * Create a super-targeting campaign (issue #101 U10/RF11). Posts to the shared
 * `POST /dashboard/campaigns` route with `superHashListId` set (exactly one of
 * hashListId / superHashListId — enforced by the shared request schema). The
 * route auto-confirms the fan-out and returns 201 with the parent campaign id
 * plus one typed single-mode sub-campaign per resolved leaf list.
 */
export function useCreateSuperCampaign() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (data: {
      name: string
      superHashListId: number
      description?: string
      priority?: number
    }) => api.post<SuperCampaignFanoutResponse>('/dashboard/campaigns', data),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['campaigns'] })
    },
  })
}
