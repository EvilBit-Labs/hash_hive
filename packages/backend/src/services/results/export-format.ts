/**
 * Pure transport/format helpers shared by the dashboard + Control export routes.
 *
 * Kept separate from `export.ts` (the DB-touching export service) so route
 * contract tests can mock `createExport` without also having to stub these
 * pure helpers — the routes import them from here and they run for real.
 */
import type { ExportFormat, ExportScope } from '@hashhive/shared'

import type { ExportScopeParams } from './export.js'

/**
 * Convert an AsyncGenerator<string> from the export service into a
 * ReadableStream<Uint8Array>. Uses the `pull` pattern so bytes flow lazily and
 * backpressure propagates to the DB cursor. Each line gets a trailing newline.
 */
export function generatorToReadableStream(
  rows: AsyncGenerator<string>
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { value, done } = await rows.next()
      if (done) {
        controller.close()
        return
      }
      controller.enqueue(encoder.encode(`${value}\n`))
    },
  })
}

export function getExportMimeType(format: ExportFormat): string {
  return format === 'csv' ? 'text/csv; charset=utf-8' : 'text/plain; charset=utf-8'
}

export function getExportFileExtension(format: ExportFormat): string {
  return format === 'csv' ? 'csv' : 'potfile'
}

/** Filename-safe UTC timestamp, e.g. `2026-07-01T04-12-30`. */
export function buildExportTimestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
}

/**
 * Build the ExportScopeParams for a streamed export from the resolved scope,
 * projectId, and optional scope IDs. Returns null when a required scope ID is
 * missing; callers translate that into their surface's 400 error.
 */
export function buildExportScopeParams(
  scope: ExportScope,
  projectId: number,
  hashListId: number | undefined,
  campaignId: number | undefined
): ExportScopeParams | null {
  if (scope === 'hash-list') {
    if (hashListId == null) return null
    return { scope: 'hash-list', projectId, hashListId }
  }
  if (scope === 'campaign') {
    if (campaignId == null) return null
    return { scope: 'campaign', projectId, campaignId }
  }
  return { scope: 'project', projectId }
}
