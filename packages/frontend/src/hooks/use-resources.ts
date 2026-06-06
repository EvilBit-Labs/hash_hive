import type {
  DetectHashTypeResponse,
  HashCandidate,
  HashItemsPageWire,
  HashListDetailWire,
  HashListWire,
  HashTypeWire,
  ResourceWire,
  SetHashListTypeRequest,
} from '@hashhive/shared'

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { api } from '../lib/api'
import { useUiStore } from '../stores/ui'

// Wire shapes flow through `@hashhive/shared` (z.infer from Zod
// schemas in `schemas/resources.ts`) per AGENTS.md — no local
// cross-boundary interfaces in hooks. Local aliases below keep call
// sites readable without shadowing the canonical names.
type HashList = HashListWire
type HashType = HashTypeWire
type Resource = ResourceWire
type HashListDetail = HashListDetailWire
type HashItemsResponse = HashItemsPageWire

export function useHashTypes() {
  return useQuery({
    queryKey: ['hash-types'],
    queryFn: () => api.get<{ hashTypes: HashType[] }>('/dashboard/resources/hash-types'),
  })
}

export function useHashLists() {
  const selectedProjectId = useUiStore((s) => s.selectedProjectId)

  return useQuery({
    queryKey: ['hash-lists', selectedProjectId],
    queryFn: () => api.get<{ hashLists: HashList[] }>('/dashboard/resources/hash-lists'),
    enabled: !!selectedProjectId,
  })
}

interface ResourceListOptions {
  enabled?: boolean
}

function useResourceList(
  type: 'wordlists' | 'rulelists' | 'masklists',
  options?: ResourceListOptions
) {
  const selectedProjectId = useUiStore((s) => s.selectedProjectId)
  const enabledOverride = options?.enabled ?? true

  return useQuery({
    queryKey: [type, selectedProjectId],
    queryFn: async () => {
      const data = await api.get<Record<string, Resource[]>>(`/dashboard/resources/${type}`)
      return { resources: data[type] ?? [] }
    },
    enabled: !!selectedProjectId && enabledOverride,
  })
}

export function useWordlists(options?: ResourceListOptions) {
  return useResourceList('wordlists', options)
}

export function useRulelists(options?: ResourceListOptions) {
  return useResourceList('rulelists', options)
}

export function useMasklists(options?: ResourceListOptions) {
  return useResourceList('masklists', options)
}

export function useGuessHashType() {
  return useMutation({
    mutationFn: (hashValue: string) =>
      api.post<{ hashValue: string; candidates: HashCandidate[]; identified: boolean }>(
        '/dashboard/hashes/guess-type',
        { hashValue }
      ),
  })
}

export function useCreateHashList() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (data: { name: string; hashTypeId?: number }) =>
      api.post<{ hashList: HashList }>('/dashboard/resources/hash-lists', data),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['hash-lists'] })
    },
  })
}

type ResourceType = 'hash-lists' | 'wordlists' | 'rulelists' | 'masklists'

export function useCreateResource(type: ResourceType) {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (data: { name: string }): Promise<{ item: Resource }> => {
      const raw = await api.post<Record<string, Resource>>(`/dashboard/resources/${type}`, data)
      // Hash lists return { hashList }, generic resources return { item }
      const item = raw['item'] ?? raw['hashList']
      if (!item) throw new Error('Unexpected response shape from create resource')
      return { item }
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: [type] })
    },
  })
}

// ─── Hash List Detail ────────────────────────────────────────────────
// HashListDetail and HashItemsResponse types come from @hashhive/shared
// (see top of file); no local interfaces needed.

export function useHashListDetail(id: number) {
  return useQuery({
    queryKey: ['hash-list-detail', id],
    queryFn: () => api.get<{ hashList: HashListDetail }>(`/dashboard/resources/hash-lists/${id}`),
    enabled: !!id,
  })
}

export function useHashListItems(
  id: number,
  opts: {
    status?: 'all' | 'cracked' | 'uncracked'
    search?: string
    limit?: number
    offset?: number
  }
) {
  const selectedProjectId = useUiStore((s) => s.selectedProjectId)

  return useQuery({
    queryKey: ['hash-list-items', id, opts],
    queryFn: () => {
      const params = new URLSearchParams()
      if (opts.status && opts.status !== 'all') params.set('status', opts.status)
      if (opts.search) params.set('q', opts.search)
      if (opts.limit) params.set('limit', String(opts.limit))
      if (opts.offset) params.set('offset', String(opts.offset))
      const qs = params.toString()
      return api.get<HashItemsResponse>(
        `/dashboard/resources/hash-lists/${id}/items${qs ? `?${qs}` : ''}`
      )
    },
    enabled: !!id && !!selectedProjectId,
  })
}

// Upload timeout for the direct (<100 MB) path. fetch has no built-in
// upload timeout and the modal's Cancel button is disabled while the
// request is pending, so a hung backend or proxy would wedge the UI
// indefinitely without this guard. 5 minutes is the soft cap - a
// 100 MB upload on a 1 Mbps link is ~13 minutes worst-case, so this
// is below that floor; chunked path covers anything that legitimately
// takes longer.
const DIRECT_UPLOAD_TIMEOUT_MS = 5 * 60 * 1000

export function useUploadResourceFile(type: ResourceType) {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async ({ id, file, signal }: { id: number; file: File; signal?: AbortSignal }) => {
      const formData = new FormData()
      formData.append('file', file)

      // Compose the caller's signal (from the modal's AbortController)
      // with a timeout signal. AbortSignal.any short-circuits on either
      // - operator-cancelled abort takes precedence over timeout, and
      // the timeout still fires when the caller didn't supply a signal.
      const timeoutSignal = AbortSignal.timeout(DIRECT_UPLOAD_TIMEOUT_MS)
      const combinedSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal

      let res: Response
      try {
        res = await fetch(`/api/v1/dashboard/resources/${type}/${id}/upload`, {
          method: 'POST',
          credentials: 'include',
          body: formData,
          signal: combinedSignal,
        })
      } catch (err) {
        // Distinguish timeout-driven abort from operator-driven abort
        // so the modal can surface the right hint. AbortSignal.timeout
        // throws DOMException with name 'TimeoutError'; manual abort
        // via the caller's signal throws name 'AbortError'.
        if (err instanceof DOMException && err.name === 'TimeoutError') {
          throw new Error(
            `Upload timed out after ${Math.round(DIRECT_UPLOAD_TIMEOUT_MS / 1000)}s. ` +
              'Try a smaller file or check your network.',
            { cause: err }
          )
        }
        throw err
      }
      if (!res.ok) {
        // Fall back to text() when the response body isn't JSON (proxy
        // 502 returning HTML, gateway timeout returning plaintext) so
        // the operator gets a real diagnostic instead of the bare
        // "Upload failed".
        let body: { error?: { message?: string } } = {}
        try {
          body = await res.json()
        } catch {
          const text = await res.text().catch(() => '')
          throw new Error(
            `Upload failed (HTTP ${res.status})${text ? `: ${text.slice(0, 200)}` : ''}`
          )
        }
        throw new Error(body.error?.message ?? `Upload failed (HTTP ${res.status})`)
      }
      return res.json()
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: [type] })
    },
  })
}

// ─── Delete / detect-batch / set-hash-type (issue #163) ─────────────

/**
 * Delete a resource by id. Hash lists and generic resources share the
 * same `DELETE /dashboard/resources/{type}/{id}` shape; the type
 * parameter routes to the right backend handler. Invalidates the
 * relevant list query on success - callers may layer optimistic
 * removal in the modal via `queryClient.setQueryData` and rollback in
 * `onError`.
 */
export function useDeleteResource(type: ResourceType) {
  const queryClient = useQueryClient()

  return useMutation({
    // Both DELETE routes return 204 No Content. `api.request` returns
    // `undefined` for 204 (api.ts:72), so the mutation result type is
    // `void` - claiming `{ success: true }` would be a runtime lie and
    // a future caller dereferencing `result.success` would get a
    // TypeError.
    mutationFn: (id: number) => api.delete<void>(`/dashboard/resources/${type}/${id}`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: [type] })
      // Also invalidate hash-list-detail in case the caller is mid-
      // navigation from a detail page when the delete fires. Cheap;
      // the hash-list-detail cache is per-id so only the deleted
      // row's detail entry is invalidated.
      if (type === 'hash-lists') {
        void queryClient.invalidateQueries({ queryKey: ['hash-list-detail'] })
      }
    },
  })
}

/**
 * Detect candidate hash types for a batch of sample hashes via the
 * shipped `POST /dashboard/resources/detect-hash-type` route. The
 * wire-shape field name is `hashes` (server contract, capped at 100
 * server-side); the UI enforces a tighter 5-10 cap before calling.
 * Returns one `{ hashValue, candidates }` entry per input.
 */
export function useDetectHashTypeBatch() {
  return useMutation({
    mutationFn: (hashes: string[]) =>
      api.post<DetectHashTypeResponse>('/dashboard/resources/detect-hash-type', { hashes }),
  })
}

/**
 * Set the hash type on an existing hash list. Used by the detect-
 * hash-type modal's "Use This Type" action. Project scope is
 * enforced server-side from the session; the request body carries
 * only `hashTypeId`. Invalidates `hash-list-detail` for the row and
 * the project-wide `hash-lists` list query so the table reflects the
 * new type without a refetch ping-pong.
 */
export function useSetHashListType(hashListId: number) {
  const queryClient = useQueryClient()
  const selectedProjectId = useUiStore((s) => s.selectedProjectId)

  return useMutation({
    mutationFn: (body: SetHashListTypeRequest) =>
      api.patch<{ hashList: HashList }>(`/dashboard/resources/hash-lists/${hashListId}`, body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['hash-list-detail', hashListId] })
      void queryClient.invalidateQueries({ queryKey: ['hash-lists', selectedProjectId] })
    },
  })
}
