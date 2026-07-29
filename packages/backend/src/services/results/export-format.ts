/**
 * Pure transport/format helpers shared by the dashboard + Control export routes.
 *
 * Kept separate from `export.ts` (the DB-touching export service) so route
 * contract tests can mock `createExport` without also having to stub these
 * pure helpers — the routes import them from here and they run for real.
 */
import type { ExportFormat, ExportScope } from '@hashhive/shared'

import type { ExportScopeParams } from './export.js'

import { logger } from '../../config/logger.js'

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
      try {
        const { value, done } = await rows.next()
        if (done) {
          controller.close()
          return
        }
        controller.enqueue(encoder.encode(`${value}\n`))
      } catch (err) {
        // Headers + 200 are already sent by the time the stream pulls, so a
        // mid-stream DB cursor error truncates the client's download. Log it
        // (ops has no other signal) and error the stream rather than hang.
        logger.error({ err }, 'export stream: cursor error mid-stream — client download truncated')
        controller.error(err)
      }
    },
    async cancel() {
      // Client disconnect mid-download — release the DB cursor by signalling
      // the AsyncGenerator to run its finally block and close any open DB
      // resources. Without this the cursor stays open until the generator is
      // garbage-collected.
      await rows.return?.(undefined)
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
  campaignId: number | undefined,
  superHashListId?: number
): ExportScopeParams | null {
  if (scope === 'hash-list') {
    if (hashListId == null) return null
    return { scope: 'hash-list', projectId, hashListId }
  }
  if (scope === 'campaign') {
    if (campaignId == null) return null
    return { scope: 'campaign', projectId, campaignId }
  }
  if (scope === 'super') {
    if (superHashListId == null) return null
    return { scope: 'super', projectId, superHashListId }
  }
  return { scope: 'project', projectId }
}
