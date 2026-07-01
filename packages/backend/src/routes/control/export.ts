/**
 * Control API export endpoint (issue #102, unit U4).
 *
 * Streams hash-item exports (cracked pairs, plaintexts, or uncracked hashes)
 * in CSV or potfile format via a single GET endpoint. Authenticated by per-user
 * API key (requireApiKey runs upstream at the surface aggregator). Project scope
 * is derived from the X-Project-Id header via requireProjectMembership.
 *
 * Errors follow RFC 9457 problem-details (application/problem+json).
 *
 * Response headers:
 *   Content-Type:         text/csv; charset=utf-8  — or —  text/plain; charset=utf-8
 *   Content-Disposition:  attachment; filename="results-<timestamp>.<ext>"
 *   x-export-skipped:     count of rows omitted because the hash type is missing
 *                         or the potfile mode is unsupported. Always "0" for CSV.
 */

import {
  exportFormatSchema,
  exportScopeSchema,
  exportVariantSchema,
  type ExportFormat,
  type ExportScope,
} from '@hashhive/shared'
import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi'

import type { AppEnv } from '../../types.js'

import { db } from '../../db/index.js'
import {
  CONTROL_RESPONSE_REFS,
  controlOpenApiHonoOptions,
  sharedControlResponse,
} from '../../openapi/components.js'
import { createExport, type ExportScopeParams } from '../../services/results/export.js'
import { controlErrorResponse, requireProjectMembership } from './helpers.js'

export const controlExportRoutes = new OpenAPIHono<AppEnv>(controlOpenApiHonoOptions)

// ─── Query schema ─────────────────────────────────────────────────────────────

/**
 * Control export query. All three axes are required (unlike the dashboard
 * surface which has optional defaults for backward compatibility). Scope IDs
 * are conditionally required via superRefine so the OpenAPI spec describes
 * them as optional while runtime validation enforces presence.
 */
const controlExportQuerySchema = z
  .object({
    scope: exportScopeSchema,
    variant: exportVariantSchema,
    format: exportFormatSchema,
    hashListId: z.coerce.number().int().positive().optional().openapi({
      description: "Required when scope is 'hash-list'.",
      example: 1,
    }),
    campaignId: z.coerce.number().int().positive().optional().openapi({
      description: "Required when scope is 'campaign'.",
      example: 1,
    }),
  })
  .superRefine((data, ctx) => {
    const isPotfile = data.format === 'hashcat-potfile' || data.format === 'john-potfile'
    const isCsvOnly = data.variant === 'plaintext-only' || data.variant === 'uncracked'
    if (isPotfile && isCsvOnly) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `format '${data.format}' requires variant 'cracked-pairs'; '${data.variant}' does not include hash values`,
        path: ['format'],
      })
    }
    if (data.scope === 'hash-list' && !data.hashListId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "'hashListId' is required when scope is 'hash-list'",
        path: ['hashListId'],
      })
    }
    if (data.scope === 'campaign' && !data.campaignId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "'campaignId' is required when scope is 'campaign'",
        path: ['campaignId'],
      })
    }
  })

// ─── Route definition ────────────────────────────────────────────────────────

const controlExportRoute = createRoute({
  method: 'get',
  path: '/',
  tags: ['Export'],
  summary: 'Stream a hash-item export in CSV or potfile format.',
  description:
    'Streams all matching rows with no row cap. Set the `x-export-skipped` response header to the number of rows omitted because the hash type is missing or the potfile mode is unsupported.',
  security: [{ ControlApiKey: [] }],
  request: { query: controlExportQuerySchema },
  responses: {
    200: {
      description:
        'Streamed export file. Content-Type is text/csv for CSV exports or text/plain for potfile exports.',
      content: {
        'text/csv': { schema: z.string() },
        'text/plain': { schema: z.string() },
      },
    },
    400: sharedControlResponse(CONTROL_RESPONSE_REFS.ValidationError),
    401: sharedControlResponse(CONTROL_RESPONSE_REFS.AuthError),
    403: sharedControlResponse(CONTROL_RESPONSE_REFS.Forbidden),
    500: sharedControlResponse(CONTROL_RESPONSE_REFS.InternalError),
  },
})

// ─── Helpers ──────────────────────────────────────────────────────────────────

function buildScopeParams(
  scope: ExportScope,
  projectId: number,
  hashListId: number | undefined,
  campaignId: number | undefined
): ExportScopeParams {
  if (scope === 'hash-list') {
    // superRefine guarantees hashListId is present; the cast is safe.
    return { scope: 'hash-list', projectId, hashListId: hashListId! }
  }
  if (scope === 'campaign') {
    // superRefine guarantees campaignId is present; the cast is safe.
    return { scope: 'campaign', projectId, campaignId: campaignId! }
  }
  return { scope: 'project', projectId }
}

function getMimeType(format: ExportFormat): string {
  return format === 'csv' ? 'text/csv; charset=utf-8' : 'text/plain; charset=utf-8'
}

function getFileExtension(format: ExportFormat): string {
  return format === 'csv' ? 'csv' : 'potfile'
}

/**
 * Convert the export service's AsyncGenerator<string> into a ReadableStream<Uint8Array>.
 * Uses the `pull` pattern so bytes flow lazily and backpressure propagates.
 * Each line from the generator is encoded with a trailing newline.
 */
function generatorToStream(rows: AsyncGenerator<string>): ReadableStream<Uint8Array> {
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

// ─── Handler ──────────────────────────────────────────────────────────────────

controlExportRoutes.openapi(controlExportRoute, async (c) => {
  try {
    const { projectId } = await requireProjectMembership(c)
    const { scope, variant, format, hashListId, campaignId } = c.req.valid('query')

    const scopeParams = buildScopeParams(scope, projectId, hashListId, campaignId)
    const { skippedCount, rows } = await createExport(db, { ...scopeParams, variant, format })

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    const ext = getFileExtension(format)
    const mime = getMimeType(format)
    const stream = generatorToStream(rows)

    return new Response(stream, {
      status: 200,
      headers: {
        'Content-Type': mime,
        'Content-Disposition': `attachment; filename="results-${timestamp}.${ext}"`,
        'x-export-skipped': String(skippedCount),
        'X-Accel-Buffering': 'no',
        'Cache-Control': 'no-store',
      },
    })
  } catch (err) {
    return controlErrorResponse(c, err)
  }
})
