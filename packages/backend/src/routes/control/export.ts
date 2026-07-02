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
  isPotfileVariantConflict,
} from '@hashhive/shared'
import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi'

import type { AppEnv } from '../../types.js'

import { db } from '../../db/index.js'
import {
  CONTROL_RESPONSE_REFS,
  controlOpenApiHonoOptions,
  sharedControlResponse,
} from '../../openapi/components.js'
import {
  buildExportScopeParams,
  buildExportTimestamp,
  generatorToReadableStream,
  getExportFileExtension,
  getExportMimeType,
} from '../../services/results/export-format.js'
import { createExport } from '../../services/results/export.js'
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
    if (isPotfileVariantConflict(data.format, data.variant)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `format '${data.format}' requires the cracked-pairs variant — potfiles need both the hash and its plaintext, which '${data.variant}' does not provide.`,
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

// ─── Handler ──────────────────────────────────────────────────────────────────

controlExportRoutes.openapi(controlExportRoute, async (c) => {
  try {
    const { projectId } = await requireProjectMembership(c)
    const { scope, variant, format, hashListId, campaignId } = c.req.valid('query')

    // superRefine on the query schema guarantees the required scope ID is
    // present, so buildExportScopeParams never returns null here.
    const scopeParams = buildExportScopeParams(scope, projectId, hashListId, campaignId)!
    const { skippedCount, rows } = await createExport(db, { ...scopeParams, variant, format })

    const timestamp = buildExportTimestamp()
    const ext = getExportFileExtension(format)
    const mime = getExportMimeType(format)
    const stream = generatorToReadableStream(rows)

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
