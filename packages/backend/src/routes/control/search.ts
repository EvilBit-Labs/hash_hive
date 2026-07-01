/**
 * Control API global hash-search endpoint (issue #102, unit U11).
 *
 * GET /search?q=&limit=&offset=
 *   - API-key auth via requireProjectMembership (enforces X-Project-Id header)
 *   - Project-scoped: only rows from the active project are returned (R16)
 *   - Both cracked and uncracked rows (crackedAt ISO string or null) (R15)
 *   - Fetch-on-demand — no realtime-invalidation wired here (KTD8)
 *   - RFC 9457 problem+json errors; `limit` capped to SEARCH_MAX_LIMIT (100)
 *
 * Requirements: R14, R15, R16, R17
 */

import type { HashSearchResult } from '@hashhive/shared'

import { hashSearchResponseSchema } from '@hashhive/shared'
import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi'

import type { AppEnv } from '../../types.js'

import {
  CONTROL_RESPONSE_REFS,
  controlOpenApiHonoOptions,
  sharedControlResponse,
} from '../../openapi/components.js'
import {
  SEARCH_DEFAULT_LIMIT,
  SEARCH_MAX_LIMIT,
  SEARCH_MAX_Q_LENGTH,
  searchHashes,
} from '../../services/hash-items/search.js'
import { controlErrorResponse, requireProjectMembership } from './helpers.js'

export const controlSearchRoutes = new OpenAPIHono<AppEnv>(controlOpenApiHonoOptions)

const searchQuerySchema = z.object({
  q: z.string().min(1, 'q must not be empty').max(SEARCH_MAX_Q_LENGTH, 'q is too long'),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(SEARCH_MAX_LIMIT)
    .default(SEARCH_DEFAULT_LIMIT)
    .openapi({
      type: 'integer',
      minimum: 1,
      maximum: SEARCH_MAX_LIMIT,
      default: SEARCH_DEFAULT_LIMIT,
    }),
  offset: z.coerce
    .number()
    .int()
    .min(0)
    .default(0)
    .openapi({ type: 'integer', minimum: 0, default: 0 }),
})

const controlHashSearchResponseSchema = hashSearchResponseSchema.openapi(
  'ControlHashSearchResponse'
)

const searchRoute = createRoute({
  method: 'get',
  path: '/',
  tags: ['Search'],
  summary: 'Search for hashes across all hash lists in the active project',
  security: [{ ControlApiKey: [] }],
  request: { query: searchQuerySchema },
  responses: {
    200: {
      description:
        'Project-scoped hash search results. Both cracked (crackedAt is an ISO string) and uncracked (crackedAt is null) rows are returned. A single hash value may appear in multiple hash lists and produces one row per list.',
      content: { 'application/json': { schema: controlHashSearchResponseSchema } },
    },
    400: sharedControlResponse(CONTROL_RESPONSE_REFS.ValidationError),
    401: sharedControlResponse(CONTROL_RESPONSE_REFS.AuthError),
    403: sharedControlResponse(CONTROL_RESPONSE_REFS.Forbidden),
    500: sharedControlResponse(CONTROL_RESPONSE_REFS.InternalError),
  },
})

controlSearchRoutes.openapi(searchRoute, async (c) => {
  try {
    const { projectId } = await requireProjectMembership(c)
    const { q, limit, offset } = c.req.valid('query')

    const result = await searchHashes(projectId, q, { limit, offset })

    // Map Date → ISO string for the wire shape (crackedAt is Date in the service,
    // string | null in hashSearchResponseSchema). This mapping is load-bearing
    // for round-trip .parse() validation (KTD8).
    const results = result.results.map((r) => ({
      ...r,
      crackedAt: r.crackedAt !== null ? r.crackedAt.toISOString() : null,
    })) satisfies HashSearchResult[]

    return c.json({ results, total: result.total, limit: result.limit, offset: result.offset }, 200)
  } catch (err) {
    return controlErrorResponse(c, err)
  }
})
