/**
 * Control API resource-file endpoints (wordlists, rules, masks).
 *
 * Read-only listing and inspection. Uploads stay on the dashboard
 * surface — presigned URLs and chunked-upload coordination are
 * interactive workflows that don't compose well with one-shot
 * automation. Mutating endpoints (POST/PATCH/DELETE) are not
 * implemented in this Control surface.
 */

import {
  controlResourceArchiveResponseSchema,
  controlResourceRestoreResponseSchema,
  maskLists,
  ruleLists,
  selectMaskListSchema,
  selectRuleListSchema,
  selectWordListSchema,
  wordLists,
} from '@hashhive/shared'
import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi'

import type { AppEnv } from '../../types.js'

import { paginate, paginationQuerySchema } from '../../lib/pagination.js'
import { problemResponse } from '../../lib/problem-details.js'
import {
  CONTROL_RESPONSE_REFS,
  controlOpenApiHonoOptions,
  sharedControlResponse,
} from '../../openapi/components.js'
import { archiveResources, restoreResources } from '../../services/resources-archive.js'
import {
  getResourceById,
  listHashTypes,
  listResourcesPaginated,
  type ResourceTable,
} from '../../services/resources.js'
import { controlErrorResponse, requireProjectMembership, requireProjectRole } from './helpers.js'

export const controlResourceRoutes = new OpenAPIHono<AppEnv>(controlOpenApiHonoOptions)

const RESOURCE_KIND = z.enum(['wordlists', 'rulelists', 'masklists'])
type ResourceKind = z.infer<typeof RESOURCE_KIND>

const RESOURCE_TABLES: Record<ResourceKind, ResourceTable> = {
  wordlists: wordLists,
  rulelists: ruleLists,
  masklists: maskLists,
}

const kindParamSchema = z.object({ kind: RESOURCE_KIND })
const kindIdParamSchema = z.object({
  kind: RESOURCE_KIND,
  id: z.coerce.number().int().positive(),
})

// Resource row is one of wordlist/rulelist/masklist — the three share
// the same column set today (drizzle-zod schemas are structurally
// equivalent) but the discriminated union keeps the spec honest about
// the per-kind shape so future divergence (e.g., per-kind metadata
// columns) surfaces in the runtime spec automatically.
const resourceSchema = z
  .union([selectWordListSchema, selectRuleListSchema, selectMaskListSchema])
  .openapi('ControlResource')
const resourcePageSchema = z
  .object({
    items: z.array(resourceSchema),
    total: z.number().int().nonnegative(),
    limit: z.number().int().nonnegative(),
    offset: z.number().int().nonnegative(),
  })
  .openapi('ControlResourcePage')

const hashTypesResponseSchema = z
  .object({
    hashTypes: z.array(z.object({}).passthrough()),
  })
  .openapi('ControlHashTypes')

/**
 * Hash-type catalog. Defined before the `/:kind` route so the literal
 * path matches first (Hono routes are evaluated in registration order
 * within a sub-application). Hash types are global lookup data, not
 * project-scoped resources — automation clients need this endpoint to
 * resolve a hash-type name into the numeric ID accepted by the
 * createAttack endpoint without having to authenticate via the
 * dashboard cookie session.
 */
const listHashTypesRoute = createRoute({
  method: 'get',
  path: '/hash-types',
  tags: ['Resources'],
  summary: 'Global hash-type catalog (id, name, mode)',
  description:
    'Membership check ensures the caller has a valid API key and at least one project — the response itself is not project-scoped.',
  security: [{ ControlApiKey: [] }],
  responses: {
    200: {
      description: 'Hash types.',
      content: { 'application/json': { schema: hashTypesResponseSchema } },
    },
    400: sharedControlResponse(CONTROL_RESPONSE_REFS.ValidationError),
    401: sharedControlResponse(CONTROL_RESPONSE_REFS.AuthError),
    403: sharedControlResponse(CONTROL_RESPONSE_REFS.Forbidden),
    500: sharedControlResponse(CONTROL_RESPONSE_REFS.InternalError),
  },
})

controlResourceRoutes.openapi(listHashTypesRoute, async (c) => {
  try {
    await requireProjectMembership(c)
    const types = await listHashTypes()
    return c.json({ hashTypes: types }, 200)
  } catch (err) {
    return controlErrorResponse(c, err)
  }
})

// `showArchived` mirrors the dashboard's `?showArchived=true` query param
// naming and permissive coercion (ADR-0019 / issue #106 R10) — only the
// literal "true" enables it, anything else (or absent) is false and
// archived resources stay excluded from the default listing.
const listResourcesQuerySchema = paginationQuerySchema.merge(
  z.object({
    showArchived: z
      .string()
      .optional()
      .transform((v) => v === 'true'),
  })
)

const listResourcesRoute = createRoute({
  method: 'get',
  path: '/{kind}',
  tags: ['Resources'],
  summary: 'List resource files (wordlists, rulelists, masklists) in the active project',
  security: [{ ControlApiKey: [] }],
  request: { params: kindParamSchema, query: listResourcesQuerySchema },
  responses: {
    200: {
      description: 'Page of resources.',
      content: { 'application/json': { schema: resourcePageSchema } },
    },
    400: sharedControlResponse(CONTROL_RESPONSE_REFS.ValidationError),
    401: sharedControlResponse(CONTROL_RESPONSE_REFS.AuthError),
    403: sharedControlResponse(CONTROL_RESPONSE_REFS.Forbidden),
    500: sharedControlResponse(CONTROL_RESPONSE_REFS.InternalError),
  },
})

controlResourceRoutes.openapi(listResourcesRoute, async (c) => {
  try {
    const { projectId } = await requireProjectMembership(c)
    const { kind } = c.req.valid('param')
    const query = c.req.valid('query')
    const { items, total } = await listResourcesPaginated(RESOURCE_TABLES[kind], projectId, {
      limit: query.limit,
      offset: query.offset,
      showArchived: query.showArchived,
    })
    return c.json(paginate(items, total, query), 200)
  } catch (err) {
    return controlErrorResponse(c, err)
  }
})

const getResourceRoute = createRoute({
  method: 'get',
  path: '/{kind}/{id}',
  tags: ['Resources'],
  summary: 'Get a single resource by id',
  security: [{ ControlApiKey: [] }],
  request: { params: kindIdParamSchema },
  responses: {
    200: {
      description: 'Resource details.',
      content: { 'application/json': { schema: resourceSchema } },
    },
    400: sharedControlResponse(CONTROL_RESPONSE_REFS.ValidationError),
    401: sharedControlResponse(CONTROL_RESPONSE_REFS.AuthError),
    403: sharedControlResponse(CONTROL_RESPONSE_REFS.Forbidden),
    404: sharedControlResponse(CONTROL_RESPONSE_REFS.NotFound),
    500: sharedControlResponse(CONTROL_RESPONSE_REFS.InternalError),
  },
})

controlResourceRoutes.openapi(getResourceRoute, async (c) => {
  try {
    const { projectId } = await requireProjectMembership(c)
    const { kind, id } = c.req.valid('param')
    const resource = await getResourceById(RESOURCE_TABLES[kind], id, projectId)
    if (!resource) return problemResponse(c, 404, 'not_found', 'resource not found')
    return c.json(resource, 200)
  } catch (err) {
    return controlErrorResponse(c, err)
  }
})

// ─── POST /:kind/:id/archive, /:kind/:id/restore — resource lifecycle ──
// (issue #106 U10)
//
// Control API parity for the dashboard's bulk `POST /{prefix}/archive`
// and `/restore` (issue #106 U4), backed by the same `archiveResources`/
// `restoreResources` service (U3) shared across word/rule/mask lists.
// Single-resource per the Control surface's existing per-resource style
// — the service is bulk-`ids`-shaped, so these handlers call it with a
// one-element array and unwrap the sole result.
//
// Outcome → HTTP status: `archived`/`restored` → 200; `not_found` → 404
// `not_found`; `already_archived`/`not_archivable`/`in_use`/
// `not_archived` → 409 `conflict` (current-state conflict, distinct
// from a permanent 422 — see `control/attacks.ts`'s archive route doc
// for the full rationale); `error` → 500 `internal`.

const archiveResourceRoute = createRoute({
  method: 'post',
  path: '/{kind}/{id}/archive',
  tags: ['Resources'],
  summary: 'Archive a permanent, unreferenced resource file (contributor or admin only)',
  security: [{ ControlApiKey: [] }],
  request: { params: kindIdParamSchema },
  responses: {
    200: {
      description: 'Archive outcome.',
      content: { 'application/json': { schema: controlResourceArchiveResponseSchema } },
    },
    400: sharedControlResponse(CONTROL_RESPONSE_REFS.ValidationError),
    401: sharedControlResponse(CONTROL_RESPONSE_REFS.AuthError),
    403: sharedControlResponse(CONTROL_RESPONSE_REFS.Forbidden),
    404: sharedControlResponse(CONTROL_RESPONSE_REFS.NotFound),
    409: sharedControlResponse(CONTROL_RESPONSE_REFS.Conflict),
    500: sharedControlResponse(CONTROL_RESPONSE_REFS.InternalError),
  },
})

controlResourceRoutes.openapi(archiveResourceRoute, async (c) => {
  try {
    const { projectId } = await requireProjectRole(c, 'contributor', 'admin')
    const { kind, id } = c.req.valid('param')
    const user = c.get('currentUser')
    const [result] = await archiveResources(RESOURCE_TABLES[kind], projectId, [id], {
      actorType: 'user',
      actorId: user.userId,
    })
    if (!result) throw new Error('archiveResources returned no result for a single id')
    switch (result.outcome) {
      case 'not_found':
        return problemResponse(c, 404, 'not_found', 'resource not found')
      case 'already_archived':
        return problemResponse(c, 409, 'conflict', 'resource is already archived')
      case 'not_archivable':
        return problemResponse(
          c,
          409,
          'conflict',
          'resource is not permanent or not in a ready state'
        )
      case 'in_use':
        return problemResponse(
          c,
          409,
          'conflict',
          'resource is still referenced by a non-archived attack'
        )
      case 'error':
        return problemResponse(c, 500, 'internal', 'archive failed')
      case 'archived':
        return c.json({ id: result.id, outcome: result.outcome }, 200)
    }
  } catch (err) {
    return controlErrorResponse(c, err)
  }
})

const restoreResourceRoute = createRoute({
  method: 'post',
  path: '/{kind}/{id}/restore',
  tags: ['Resources'],
  summary: 'Restore an archived resource file (contributor or admin only)',
  security: [{ ControlApiKey: [] }],
  request: { params: kindIdParamSchema },
  responses: {
    200: {
      description: 'Restore outcome.',
      content: { 'application/json': { schema: controlResourceRestoreResponseSchema } },
    },
    400: sharedControlResponse(CONTROL_RESPONSE_REFS.ValidationError),
    401: sharedControlResponse(CONTROL_RESPONSE_REFS.AuthError),
    403: sharedControlResponse(CONTROL_RESPONSE_REFS.Forbidden),
    404: sharedControlResponse(CONTROL_RESPONSE_REFS.NotFound),
    409: sharedControlResponse(CONTROL_RESPONSE_REFS.Conflict),
    500: sharedControlResponse(CONTROL_RESPONSE_REFS.InternalError),
  },
})

controlResourceRoutes.openapi(restoreResourceRoute, async (c) => {
  try {
    const { projectId } = await requireProjectRole(c, 'contributor', 'admin')
    const { kind, id } = c.req.valid('param')
    const user = c.get('currentUser')
    const [result] = await restoreResources(RESOURCE_TABLES[kind], projectId, [id], {
      actorType: 'user',
      actorId: user.userId,
    })
    if (!result) throw new Error('restoreResources returned no result for a single id')
    switch (result.outcome) {
      case 'not_found':
        return problemResponse(c, 404, 'not_found', 'resource not found')
      case 'not_archived':
        return problemResponse(c, 409, 'conflict', 'resource is not archived')
      case 'error':
        return problemResponse(c, 500, 'internal', 'restore failed')
      case 'restored':
        return c.json({ id: result.id, outcome: result.outcome }, 200)
    }
  } catch (err) {
    return controlErrorResponse(c, err)
  }
})
