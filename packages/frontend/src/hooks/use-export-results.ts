import { useMutation } from '@tanstack/react-query'

import { api } from '../lib/api'
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
 * header value. We accept only the double-quoted form because the
 * backend currently emits exactly that (`results-{ISO}.csv`). If the
 * backend ever switches to a bare token or RFC 5987 `filename*`
 * ext-value, this regex returns null and the caller falls back to
 * the client-composed filename — no silent corruption. Escaped
 * inner quotes (`filename="weird\"name.csv"`) would truncate; the
 * backend doesn't emit those.
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
 * Routes through `api.getRaw` so the export inherits the same
 * 30s timeout, 401 session-expiry redirect, and `{ error: { code,
 * message } }` envelope parsing the rest of the dashboard relies on.
 * A hung export request can't spin in `isPending` forever; a 401
 * doesn't leave the operator with a misleading "Export failed: 401"
 * inline while their session is dead.
 *
 * Cleanup: `URL.revokeObjectURL` runs in `finally` to release the
 * blob even if `<a>.click()` throws. The anchor is appended to and
 * removed from the body inside a nested try/finally so a `click()`
 * exception (CSP `navigate-to` violation, browser-hardened download
 * blocker) doesn't leak a detached `<a>` into the document.
 */
export function useExportResults() {
  const selectedProjectId = useUiStore((s) => s.selectedProjectId)

  return useMutation({
    mutationFn: async (filters: ExportResultsFilters) => {
      const query = serializeFilters(filters)
      const url = `/dashboard/results/export${query ? `?${query}` : ''}`

      const response = await api.getRaw(url)

      const filename =
        parseFilename(response.headers.get('Content-Disposition')) ??
        buildFallbackFilename(selectedProjectId)

      // `response.blob()` may reject (network drop mid-stream). Let it
      // propagate before we allocate a blob URL — keeps the cleanup
      // contract tight.
      const blob = await response.blob()

      let objectUrl: string | null = null
      const anchor = document.createElement('a')
      try {
        objectUrl = URL.createObjectURL(blob)
        anchor.href = objectUrl
        anchor.download = filename
        document.body.appendChild(anchor)
        try {
          anchor.click()
        } finally {
          // Always remove the anchor — even if click() throws
          // (CSP / browser-hardened download blockers can throw
          // synchronously). Without this nested finally a thrown
          // click leaks a detached <a> into the document body.
          anchor.remove()
        }
      } finally {
        if (objectUrl) URL.revokeObjectURL(objectUrl)
      }

      return { filename }
    },
  })
}
