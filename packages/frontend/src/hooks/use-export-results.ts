import { useMutation } from '@tanstack/react-query'

import { useUiStore } from '../stores/ui'

export interface ExportResultsFilters {
  campaignId?: number
  hashListId?: number
  /** Free-text search across hashes / plaintexts. Maps to `q` query param. */
  search?: string
  /** ISO 8601 timestamp (e.g. `2026-06-01T00:00:00.000Z`). */
  startDate?: string
  /** ISO 8601 timestamp (e.g. `2026-06-08T23:59:59.000Z`). */
  endDate?: string
}

/**
 * RFC 6266 §4.1 — parse `filename="..."` from a `Content-Disposition`
 * header value. We intentionally accept only the double-quoted form
 * because the backend (PR #204) always emits double-quoted filenames.
 * Bare-token and `filename*` (RFC 5987 ext-value) forms are out of
 * scope for this consumer.
 */
const FILENAME_REGEX = /filename="([^"]+)"/

function parseFilename(headerValue: string | null): string | null {
  if (!headerValue) return null
  const match = headerValue.match(FILENAME_REGEX)
  return match?.[1] ?? null
}

/**
 * Slug-shaped fallback identifier baked into the client-composed
 * filename when `Content-Disposition` is absent. The UI store only
 * carries the numeric project id (see `stores/ui.ts`), so we slug
 * the id; if a project name becomes available later, this is the
 * single point to update.
 */
function buildFallbackFilename(projectId: number | null): string {
  const slug = projectId === null ? 'project' : String(projectId)
  const iso = new Date().toISOString()
  return `results-${slug}-${iso}.csv`
}

function serializeFilters(filters: ExportResultsFilters): string {
  const params = new URLSearchParams()
  if (filters.campaignId !== undefined) params.set('campaignId', String(filters.campaignId))
  if (filters.hashListId !== undefined) params.set('hashListId', String(filters.hashListId))
  if (filters.search) params.set('q', filters.search)
  if (filters.startDate) params.set('startDate', filters.startDate)
  if (filters.endDate) params.set('endDate', filters.endDate)
  return params.toString()
}

/**
 * Trigger a programmatic CSV download from `/dashboard/results/export`.
 *
 * Returns a TanStack Query mutation. While `isPending`, callers should
 * disable / spinner-ize their trigger button. The mutation reads the
 * filename from `Content-Disposition` (RFC 6266 double-quoted form);
 * if absent, falls back to `results-{projectId}-{ISO}.csv`.
 *
 * Cleanup: `URL.revokeObjectURL` runs in `finally` to release the blob
 * even if the `<a>` click handler throws. If `createObjectURL` was
 * never called (early `fetch`/`blob` error path), no revoke fires —
 * keeping the leak surface zero.
 */
export function useExportResults() {
  const selectedProjectId = useUiStore((s) => s.selectedProjectId)

  return useMutation({
    mutationFn: async (filters: ExportResultsFilters) => {
      const query = serializeFilters(filters)
      const url = `/api/v1/dashboard/results/export${query ? `?${query}` : ''}`

      const response = await fetch(url, { credentials: 'include' })
      if (!response.ok) {
        throw new Error(`Export failed: ${response.status} ${response.statusText}`)
      }

      const filename =
        parseFilename(response.headers.get('Content-Disposition')) ??
        buildFallbackFilename(selectedProjectId)

      // `response.blob()` may reject (network drop mid-stream). Let it
      // propagate before we allocate a blob URL — keeps the cleanup
      // contract tight.
      const blob = await response.blob()

      let objectUrl: string | null = null
      try {
        objectUrl = URL.createObjectURL(blob)
        const anchor = document.createElement('a')
        anchor.href = objectUrl
        anchor.download = filename
        document.body.appendChild(anchor)
        anchor.click()
        document.body.removeChild(anchor)
      } finally {
        if (objectUrl) URL.revokeObjectURL(objectUrl)
      }

      return { filename }
    },
  })
}
