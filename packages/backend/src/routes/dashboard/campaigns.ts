import type { Context } from 'hono'

import { inlineAttackRequestSchema } from '@hashhive/shared'
import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi'

import type { AppEnv } from '../../types.js'

import { logger } from '../../config/logger.js'
import { dashboardError } from '../../lib/dashboard-errors.js'
import { requireSession } from '../../middleware/auth.js'
import { requireProjectAccess, requireMembershipRole } from '../../middleware/rbac.js'
import {
  DASHBOARD_RESPONSE_REFS,
  dashboardOpenApiHonoOptions,
  sharedResponse,
} from '../../openapi/components.js'
import {
  createAttack,
  createCampaign,
  createCampaignWithAttacks,
  deleteAttack,
  deleteCampaign,
  getAttackById,
  getCampaignById,
  getCampaignTaskStats,
  listActiveAgentsByCampaign,
  listAttacks,
  listCampaigns,
  transitionCampaign,
  updateAttack,
  updateCampaign,
  validateCampaignDAG,
  validateCampaignResources,
  validateProposedDAG,
} from '../../services/campaigns.js'

// Use the shared dashboardOpenApiHonoOptions so every dashboard router
// emits the same `{ error: { code: 'VALIDATION_ERROR', message } }`
// envelope on createRoute Zod validation failures. The legacy
// `zValidator('query', ..., hook)` and in-handler `safeParse` blocks
// produced this envelope; the shared hook in
// `packages/backend/src/openapi/components.ts` centralises it now that
// route registration is the single source of truth across the dashboard.
const campaignRoutes = new OpenAPIHono<AppEnv>(dashboardOpenApiHonoOptions)

campaignRoutes.use('*', requireSession)

// ─── Campaign CRUD ──────────────────────────────────────────────────

const CAMPAIGN_LIST_MAX_LIMIT = 200
const CAMPAIGN_LIST_DEFAULT_LIMIT = 50

const listCampaignsQuerySchema = z.object({
  status: z.string().optional(),
  priority: z.coerce
    .number()
    .int()
    .refine((v) => v === 1 || v === 5 || v === 10, {
      message: 'priority must be one of 1, 5, 10',
    })
    .optional(),
  sort: z.enum(['name', 'createdAt', 'priority']).optional(),
  order: z.enum(['asc', 'desc']).optional(),
  // Coerce-and-clamp pagination at the schema boundary so malformed
  // URL params fall back to safe defaults instead of 400-ing the
  // request. Mirrors the agents-list pattern at routes/dashboard/agents.ts.
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(CAMPAIGN_LIST_MAX_LIMIT)
    .catch(CAMPAIGN_LIST_DEFAULT_LIMIT)
    .default(CAMPAIGN_LIST_DEFAULT_LIMIT),
  offset: z.coerce.number().int().min(0).catch(0).default(0),
})

// Path-param schema: `id` is the campaign id everywhere on this
// router. `z.coerce.number().int().positive()` replaces the inline
// `Number.isInteger(id) || id <= 0` check that was repeated in every
// handler; an invalid id surfaces as the defaultHook's 400
// VALIDATION_ERROR envelope before the handler runs.
const campaignIdParamSchema = z.object({
  id: z.coerce.number().int().positive(),
})

// Passthrough schemas for response shapes that don't (yet) have a
// canonical Zod schema in @hashhive/shared. The runtime spec gains a
// route entry but the schema body stays open — the U4 diff will surface
// any gaps once the dashboard YAML is compared field-by-field.
const campaignRowSchema = z.object({}).passthrough().openapi('Campaign')
const attackRowSchema = z.object({}).passthrough().openapi('Attack')

const listCampaignsResponseSchema = z
  .object({
    campaigns: z.array(campaignRowSchema),
    total: z.number().int().nonnegative(),
    limit: z.number().int().positive(),
    offset: z.number().int().nonnegative(),
  })
  .passthrough()

const createCampaignResponseSchema = z.object({
  campaign: campaignRowSchema,
  attacks: z.array(attackRowSchema),
})

const campaignDetailResponseSchema = z.object({
  campaign: campaignRowSchema,
  attacks: z.array(attackRowSchema),
  taskStats: z
    .object({
      total: z.number().int().nonnegative(),
      pending: z.number().int().nonnegative(),
      running: z.number().int().nonnegative(),
      completed: z.number().int().nonnegative(),
      failed: z.number().int().nonnegative(),
    })
    .passthrough(),
  activeAgents: z.array(z.unknown()),
})

const deleteCampaignResponseSchema = z.object({
  deleted: z.literal(true),
  id: z.number().int().positive(),
})

const updateCampaignResponseSchema = z.object({
  campaign: campaignRowSchema,
})

const lifecycleResponseSchema = z.object({
  campaign: campaignRowSchema.nullable(),
})

const validateCampaignResponseSchema = z.object({}).passthrough()

const listAttacksResponseSchema = z.object({
  attacks: z.array(attackRowSchema),
})

const attackResponseSchema = z.object({
  attack: attackRowSchema,
})

const deleteAttackResponseSchema = z.object({
  deleted: z.literal(true),
})

const listCampaignsRoute = createRoute({
  method: 'get',
  path: '/',
  tags: ['campaigns'],
  summary: 'List campaigns in the current project scope',
  security: [{ SessionCookie: [] }],
  middleware: [requireProjectAccess()] as const,
  request: {
    query: listCampaignsQuerySchema,
  },
  responses: {
    200: {
      description: 'List of campaigns matching the supplied filters.',
      content: { 'application/json': { schema: listCampaignsResponseSchema } },
    },
    401: sharedResponse(DASHBOARD_RESPONSE_REFS.AuthRequired),
    403: sharedResponse(DASHBOARD_RESPONSE_REFS.Forbidden),
    400: sharedResponse(DASHBOARD_RESPONSE_REFS.ValidationFailed),
  },
})

campaignRoutes.openapi(listCampaignsRoute, async (c) => {
  const { projectId } = c.get('scopedUser')!
  const { status, priority, sort, order, limit, offset } = c.req.valid('query')

  const result = await listCampaigns({
    projectId,
    status,
    priority,
    sort,
    order,
    limit,
    offset,
  })
  return c.json(result, 200)
})

// Inline-attack payload schema is canonical in @hashhive/shared so the
// frontend and backend stay in lockstep. The shared schema names the
// dependency field `dependencyIndices` to make the index-vs-id
// semantic explicit at the wire level (the standalone POST
// /:id/attacks path uses `dependencies` for real attack IDs).
const createCampaignSchema = z.object({
  name: z.string().min(1).max(255),
  description: z.string().max(2000).optional(),
  hashListId: z.number().int().positive(),
  priority: z.number().int().min(1).max(10).optional(),
  attacks: z.array(inlineAttackRequestSchema).optional(),
})

const createCampaignRoute = createRoute({
  method: 'post',
  path: '/',
  tags: ['campaigns'],
  summary: 'Create a campaign, optionally with inline attacks',
  security: [{ SessionCookie: [] }],
  middleware: [requireMembershipRole('admin', 'contributor')] as const,
  request: {
    body: {
      content: {
        'application/json': { schema: createCampaignSchema },
      },
    },
  },
  responses: {
    201: {
      description: 'Campaign (and any inline attacks) created.',
      content: { 'application/json': { schema: createCampaignResponseSchema } },
    },
    401: sharedResponse(DASHBOARD_RESPONSE_REFS.AuthRequired),
    403: sharedResponse(DASHBOARD_RESPONSE_REFS.Forbidden),
    400: sharedResponse(DASHBOARD_RESPONSE_REFS.ValidationFailed),
    409: {
      description: 'Inline attacks referenced a missing resource.',
      content: { 'application/json': { schema: z.object({}).passthrough() } },
    },
    503: {
      description: 'Transactional create could not run (e.g. DB unavailable).',
      content: { 'application/json': { schema: z.object({}).passthrough() } },
    },
  },
})

campaignRoutes.openapi(createCampaignRoute, async (c) => {
  const data = c.req.valid('json')
  const { userId, projectId } = c.get('scopedUser')!

  // No attacks supplied → legacy single-row insert (backward compatible).
  if (!data.attacks || data.attacks.length === 0) {
    const campaign = await createCampaign({
      name: data.name,
      description: data.description,
      hashListId: data.hashListId,
      priority: data.priority,
      projectId,
      createdBy: userId,
    })
    return c.json({ campaign, attacks: [] }, 201)
  }

  // Attacks supplied → single-transaction create + resource +
  // DAG pre-check. Wrap in try/catch so a DB blip during the
  // pre-check or the transaction surfaces as a typed 503 instead
  // of bubbling to onError as a generic 500. The discriminated
  // result handles the *expected* failure modes (dag_invalid,
  // resource_missing); this catches the *unexpected* throws.
  let result: Awaited<ReturnType<typeof createCampaignWithAttacks>>
  try {
    result = await createCampaignWithAttacks({
      name: data.name,
      description: data.description,
      hashListId: data.hashListId,
      priority: data.priority,
      projectId,
      createdBy: userId,
      attacks: data.attacks,
    })
  } catch (err) {
    logger.error(
      { err, route: 'POST /campaigns (with attacks)', projectId, userId },
      'createCampaignWithAttacks threw — surfacing as service unavailable'
    )
    return c.json(
      {
        error: {
          code: 'SERVICE_UNAVAILABLE',
          message: 'Unable to create campaign right now',
        },
      },
      503
    )
  }

  if (result.kind === 'dag_invalid') {
    return dashboardError(c, 400, 'DAG_INVALID', result.error)
  }

  if (result.kind === 'resource_missing') {
    return c.json(
      {
        error: {
          code: 'RESOURCE_MISSING',
          message: `Referenced resources missing: ${result.missing.join(', ')}`,
        },
      },
      409
    )
  }

  return c.json({ campaign: result.campaign, attacks: result.attacks }, 201)
})

const getCampaignRoute = createRoute({
  method: 'get',
  path: '/{id}',
  tags: ['campaigns'],
  summary: 'Get a campaign with its attacks, task stats, and active agents',
  security: [{ SessionCookie: [] }],
  middleware: [requireProjectAccess()] as const,
  request: {
    params: campaignIdParamSchema,
  },
  responses: {
    200: {
      description: 'Campaign detail with enriched payload.',
      content: { 'application/json': { schema: campaignDetailResponseSchema } },
    },
    401: sharedResponse(DASHBOARD_RESPONSE_REFS.AuthRequired),
    403: sharedResponse(DASHBOARD_RESPONSE_REFS.Forbidden),
    400: sharedResponse(DASHBOARD_RESPONSE_REFS.ValidationFailed),
    404: sharedResponse(DASHBOARD_RESPONSE_REFS.ResourceNotFound),
  },
})

campaignRoutes.openapi(getCampaignRoute, async (c) => {
  const { id } = c.req.valid('param')

  const { projectId } = c.get('scopedUser')!
  const campaign = await getCampaignById(id)

  if (!campaign || campaign.projectId !== projectId) {
    return dashboardError(c, 404, 'RESOURCE_NOT_FOUND', 'Campaign not found')
  }

  const [campaignAttacks, taskStats, activeAgents] = await Promise.all([
    listAttacks(id),
    getCampaignTaskStats(id),
    listActiveAgentsByCampaign(id),
  ])

  return c.json(
    {
      campaign,
      attacks: campaignAttacks,
      taskStats,
      activeAgents,
    },
    200
  )
})

const deleteCampaignRoute = createRoute({
  method: 'delete',
  path: '/{id}',
  tags: ['campaigns'],
  summary: 'Delete a draft campaign',
  security: [{ SessionCookie: [] }],
  middleware: [requireMembershipRole('admin', 'contributor')] as const,
  request: {
    params: campaignIdParamSchema,
  },
  responses: {
    200: {
      description: 'Campaign deleted.',
      content: { 'application/json': { schema: deleteCampaignResponseSchema } },
    },
    401: sharedResponse(DASHBOARD_RESPONSE_REFS.AuthRequired),
    403: sharedResponse(DASHBOARD_RESPONSE_REFS.Forbidden),
    400: sharedResponse(DASHBOARD_RESPONSE_REFS.ValidationFailed),
    404: sharedResponse(DASHBOARD_RESPONSE_REFS.ResourceNotFound),
    409: {
      description: 'Campaign is not in draft status and cannot be deleted.',
      content: { 'application/json': { schema: z.object({}).passthrough() } },
    },
    500: {
      description: 'Delete transaction failed unexpectedly.',
      content: { 'application/json': { schema: z.object({}).passthrough() } },
    },
  },
})

campaignRoutes.openapi(deleteCampaignRoute, async (c) => {
  const { id } = c.req.valid('param')

  const { userId, projectId } = c.get('scopedUser')!
  const existing = await getCampaignById(id)

  if (!existing || existing.projectId !== projectId) {
    return dashboardError(c, 404, 'RESOURCE_NOT_FOUND', 'Campaign not found')
  }

  let result: Awaited<ReturnType<typeof deleteCampaign>>
  try {
    result = await deleteCampaign(id)
  } catch (err) {
    // deleteCampaign runs a multi-statement transaction. Unexpected
    // failures (FK from a future child table, DB connectivity drop,
    // deadlock) bubble here as a thrown error rather than the
    // discriminated `kind` union. Surface them with context so the
    // destructive-operation audit trail is never empty.
    logger.error({ err, campaignId: id, projectId, userId }, 'deleteCampaign transaction failed')
    return c.json(
      {
        error: {
          code: 'DELETE_FAILED',
          message: 'Campaign deletion failed unexpectedly. Check server logs for details.',
        },
      },
      500
    )
  }

  switch (result.kind) {
    case 'not_found':
      return dashboardError(c, 404, 'RESOURCE_NOT_FOUND', 'Campaign not found')
    case 'not_draft':
      return c.json(
        {
          error: {
            code: 'NOT_DRAFT',
            message: `Campaign cannot be deleted in status "${result.status}". Only draft campaigns are deletable.`,
          },
        },
        409
      )
    case 'deleted':
      return c.json({ deleted: true as const, id: result.id }, 200)
  }
})

// PATCH is the partial-update form: every field is optional, only
// supplied fields are written. PUT is the full-replace form per REST
// semantics: name + priority are required, description is treated as
// "explicit value or null" so a PUT can deliberately clear a previous
// description rather than leaving it untouched. Both share the
// draft-only gate at the service layer.
const patchCampaignSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  description: z.string().max(2000).optional(),
  priority: z.number().int().min(1).max(10).optional(),
})

const putCampaignSchema = z.object({
  name: z.string().min(1).max(255),
  description: z.string().max(2000).nullable().default(null),
  priority: z.number().int().min(1).max(10),
})

// Per-method update handler factory. PATCH and PUT share post-validation
// logic but use different body schemas; createRoute is per-method so we
// build two routes from one handler. The factory still takes a method
// label so the runtime branch on result-kind responses stays identical
// to the legacy implementation.
const updateCampaignHandler = async (
  c: Context<AppEnv>,
  id: number,
  data: {
    name?: string | undefined
    description?: string | null | undefined
    priority?: number | undefined
  }
) => {
  const { projectId } = c.get('scopedUser')!
  const existing = await getCampaignById(id)
  if (!existing || existing.projectId !== projectId) {
    return dashboardError(c, 404, 'RESOURCE_NOT_FOUND', 'Campaign not found')
  }

  // PUT's `description` can be the literal `null` ("explicit clear");
  // updateCampaign accepts `undefined` to mean "leave alone", so we
  // pass null through unchanged and let the service write it.
  const result = await updateCampaign(id, data)

  switch (result.kind) {
    case 'not_found':
      return dashboardError(c, 404, 'RESOURCE_NOT_FOUND', 'Campaign not found')
    case 'not_draft':
      return c.json(
        {
          error: {
            code: 'NOT_DRAFT',
            message: `Campaign cannot be updated in status "${result.status}". Only draft campaigns are editable.`,
          },
        },
        409
      )
    case 'updated':
      return c.json({ campaign: result.campaign }, 200)
  }
}

// PATCH and PUT share the same update flow but expose different
// schemas. createRoute's body schema validation goes through the
// router's `defaultHook` for the dashboard envelope on failure.
const patchCampaignRoute = createRoute({
  method: 'patch',
  path: '/{id}',
  tags: ['campaigns'],
  summary: 'Partially update a draft campaign',
  security: [{ SessionCookie: [] }],
  middleware: [requireMembershipRole('admin', 'contributor')] as const,
  request: {
    params: campaignIdParamSchema,
    body: {
      content: {
        'application/json': { schema: patchCampaignSchema },
      },
    },
  },
  responses: {
    200: {
      description: 'Campaign updated.',
      content: { 'application/json': { schema: updateCampaignResponseSchema } },
    },
    401: sharedResponse(DASHBOARD_RESPONSE_REFS.AuthRequired),
    403: sharedResponse(DASHBOARD_RESPONSE_REFS.Forbidden),
    400: sharedResponse(DASHBOARD_RESPONSE_REFS.ValidationFailed),
    404: sharedResponse(DASHBOARD_RESPONSE_REFS.ResourceNotFound),
    409: {
      description: 'Campaign is not in draft status and cannot be edited.',
      content: { 'application/json': { schema: z.object({}).passthrough() } },
    },
  },
})

campaignRoutes.openapi(patchCampaignRoute, async (c) => {
  const { id } = c.req.valid('param')
  const data = c.req.valid('json')
  return updateCampaignHandler(c, id, data)
})

const putCampaignRoute = createRoute({
  method: 'put',
  path: '/{id}',
  tags: ['campaigns'],
  summary: 'Replace a draft campaign in full',
  security: [{ SessionCookie: [] }],
  middleware: [requireMembershipRole('admin', 'contributor')] as const,
  request: {
    params: campaignIdParamSchema,
    body: {
      content: {
        'application/json': { schema: putCampaignSchema },
      },
    },
  },
  responses: {
    200: {
      description: 'Campaign replaced.',
      content: { 'application/json': { schema: updateCampaignResponseSchema } },
    },
    401: sharedResponse(DASHBOARD_RESPONSE_REFS.AuthRequired),
    403: sharedResponse(DASHBOARD_RESPONSE_REFS.Forbidden),
    400: sharedResponse(DASHBOARD_RESPONSE_REFS.ValidationFailed),
    404: sharedResponse(DASHBOARD_RESPONSE_REFS.ResourceNotFound),
    409: {
      description: 'Campaign is not in draft status and cannot be edited.',
      content: { 'application/json': { schema: z.object({}).passthrough() } },
    },
  },
})

campaignRoutes.openapi(putCampaignRoute, async (c) => {
  const { id } = c.req.valid('param')
  const data = c.req.valid('json')
  return updateCampaignHandler(c, id, data)
})

// ─── Campaign Lifecycle ─────────────────────────────────────────────

// Action enum matches the spec-named alias routes — `resume` is
// included alongside `start` even though both map to `running`,
// because the alias path exposes `/resume` and the parity is
// documented in the OpenAPI spec.
const lifecycleSchema = z.object({
  action: z.enum(['start', 'pause', 'resume', 'stop', 'cancel']),
})

const lifecycleActionRoute = createRoute({
  method: 'post',
  path: '/{id}/lifecycle',
  tags: ['campaigns'],
  summary: 'Transition a campaign by action enum (start|pause|resume|stop|cancel)',
  security: [{ SessionCookie: [] }],
  middleware: [requireMembershipRole('admin', 'contributor')] as const,
  request: {
    params: campaignIdParamSchema,
    body: {
      content: {
        'application/json': { schema: lifecycleSchema },
      },
    },
  },
  responses: {
    200: {
      description: 'Campaign transitioned.',
      content: { 'application/json': { schema: lifecycleResponseSchema } },
    },
    401: sharedResponse(DASHBOARD_RESPONSE_REFS.AuthRequired),
    403: sharedResponse(DASHBOARD_RESPONSE_REFS.Forbidden),
    400: sharedResponse(DASHBOARD_RESPONSE_REFS.ValidationFailed),
    404: sharedResponse(DASHBOARD_RESPONSE_REFS.ResourceNotFound),
    409: {
      description: 'Stale state or referenced resources missing.',
      content: { 'application/json': { schema: z.object({}).passthrough() } },
    },
    500: {
      description: 'Task generation failed during transition.',
      content: { 'application/json': { schema: z.object({}).passthrough() } },
    },
    503: {
      description: 'Queue or resource lookup unavailable.',
      content: { 'application/json': { schema: z.object({}).passthrough() } },
    },
  },
})

campaignRoutes.openapi(lifecycleActionRoute, async (c) => {
  const { id } = c.req.valid('param')

  // transitionCampaign fetches by id alone; without this guard a
  // contributor in project A could transition a campaign in project
  // B by guessing the id. Mirrors the per-alias handler check.
  const { projectId } = c.get('scopedUser')!
  const existing = await getCampaignById(id)
  if (!existing || existing.projectId !== projectId) {
    return dashboardError(c, 404, 'RESOURCE_NOT_FOUND', 'Campaign not found')
  }

  const { action } = c.req.valid('json')

  const statusMap = {
    start: 'running',
    pause: 'paused',
    resume: 'running',
    stop: 'draft',
    cancel: 'cancelled',
  } as const

  const targetStatus = statusMap[action]
  const result = await transitionCampaign(id, targetStatus)
  return respondToTransition(c, result)
})

// Shared error mapping for transitionCampaign results. Keeps the
// /lifecycle action-enum route and the spec-named alias routes in
// lockstep — every recognized service-layer error code maps to the
// same HTTP status and envelope across both surfaces.
type TransitionResult = Awaited<ReturnType<typeof transitionCampaign>>
function respondToTransition(c: Context<AppEnv>, result: TransitionResult) {
  if ('error' in result) {
    const code = 'code' in result ? result.code : undefined
    if (code === 'QUEUE_UNAVAILABLE') {
      return dashboardError(c, 503, 'SERVICE_UNAVAILABLE', result.error)
    }
    if (code === 'RESOURCE_VALIDATION_FAILED') {
      // Resource lookup itself failed (DB blip). Surface as 503 so
      // clients can retry rather than treating it as a permanent error.
      return dashboardError(c, 503, 'SERVICE_UNAVAILABLE', result.error)
    }
    if (code === 'RESOURCE_MISSING') {
      // Precondition failed (referenced resource doesn't exist or
      // crosses project boundary). 409 Conflict captures this better
      // than 400 — the request was well-formed, the state isn't.
      return dashboardError(c, 409, 'RESOURCE_MISSING', result.error)
    }
    if (code === 'STALE_STATE') {
      // Optimistic-concurrency loss: another writer transitioned this
      // campaign between our read and write. 409 signals the client
      // should re-fetch and retry against the current state.
      return dashboardError(c, 409, 'STALE_STATE', result.error)
    }
    if (code === 'TASK_GENERATION_FAILED') {
      return dashboardError(c, 500, 'TASK_GENERATION_FAILED', result.error)
    }
    return dashboardError(c, 400, 'INVALID_TRANSITION', result.error)
  }
  return c.json({ campaign: result.campaign })
}

/**
 * Route-layer wrapper around `validateCampaignResources` that turns
 * service throws into the dashboard's `{ error: { code, message } }`
 * envelope. Returns:
 *   - `null` when validation succeeded (caller proceeds)
 *   - a 409 `RESOURCE_MISSING` Response when refs are missing
 *   - a 503 `SERVICE_UNAVAILABLE` Response when the lookup itself
 *     threw (DB blip, query error) — mirrors `transitionCampaign`'s
 *     `RESOURCE_VALIDATION_FAILED` mapping so attack-write paths
 *     have the same retryability semantics as the lifecycle path.
 */
async function checkResourcesOrErrorResponse(
  c: Context<AppEnv>,
  campaign: { projectId: number; hashListId: number | null },
  attacks: Parameters<typeof validateCampaignResources>[1],
  logContext: { route: string; campaignId: number; projectId: number }
): Promise<Response | null> {
  try {
    const result = await validateCampaignResources(campaign, attacks)
    if (result.valid) return null
    return c.json(
      {
        error: {
          code: 'RESOURCE_MISSING',
          message: `Referenced resources missing: ${result.missing.join(', ')}`,
        },
      },
      409
    )
  } catch (err) {
    logger.error(
      { err, ...logContext },
      'validateCampaignResources threw — surfacing as service unavailable'
    )
    return c.json(
      {
        error: {
          code: 'SERVICE_UNAVAILABLE',
          message: 'Unable to validate campaign resources right now',
        },
      },
      503
    )
  }
}

// Spec-named lifecycle aliases. These delegate to the same
// transitionCampaign service the action-enum /lifecycle route uses, so
// behavior (queue check, task generation, event emission, valid-
// transition allow-list) stays in lockstep. The pre-existing
// /lifecycle route is kept for the frontend which still calls it.
const lifecycleAliasStatus = {
  start: 'running',
  pause: 'paused',
  resume: 'running',
  stop: 'draft',
  cancel: 'cancelled',
} as const

type LifecycleAliasAction = keyof typeof lifecycleAliasStatus

async function lifecycleAliasHandler(c: Context<AppEnv>, id: number, action: LifecycleAliasAction) {
  const { projectId } = c.get('scopedUser')!
  const existing = await getCampaignById(id)
  if (!existing || existing.projectId !== projectId) {
    return dashboardError(c, 404, 'RESOURCE_NOT_FOUND', 'Campaign not found')
  }

  const result = await transitionCampaign(id, lifecycleAliasStatus[action])
  return respondToTransition(c, result)
}

function buildLifecycleAliasRoute(action: LifecycleAliasAction) {
  return createRoute({
    method: 'post',
    path: `/{id}/${action}`,
    tags: ['campaigns'],
    summary: `Transition a campaign via the /${action} alias`,
    security: [{ SessionCookie: [] }],
    middleware: [requireMembershipRole('admin', 'contributor')] as const,
    request: {
      params: campaignIdParamSchema,
    },
    responses: {
      200: {
        description: 'Campaign transitioned.',
        content: { 'application/json': { schema: lifecycleResponseSchema } },
      },
      401: sharedResponse(DASHBOARD_RESPONSE_REFS.AuthRequired),
      403: sharedResponse(DASHBOARD_RESPONSE_REFS.Forbidden),
      400: sharedResponse(DASHBOARD_RESPONSE_REFS.ValidationFailed),
      404: sharedResponse(DASHBOARD_RESPONSE_REFS.ResourceNotFound),
      409: {
        description: 'Stale state or referenced resources missing.',
        content: { 'application/json': { schema: z.object({}).passthrough() } },
      },
      500: {
        description: 'Task generation failed during transition.',
        content: { 'application/json': { schema: z.object({}).passthrough() } },
      },
      503: {
        description: 'Queue or resource lookup unavailable.',
        content: { 'application/json': { schema: z.object({}).passthrough() } },
      },
    },
  })
}

campaignRoutes.openapi(buildLifecycleAliasRoute('start'), async (c) => {
  const { id } = c.req.valid('param')
  return lifecycleAliasHandler(c, id, 'start')
})
campaignRoutes.openapi(buildLifecycleAliasRoute('pause'), async (c) => {
  const { id } = c.req.valid('param')
  return lifecycleAliasHandler(c, id, 'pause')
})
campaignRoutes.openapi(buildLifecycleAliasRoute('resume'), async (c) => {
  const { id } = c.req.valid('param')
  return lifecycleAliasHandler(c, id, 'resume')
})
campaignRoutes.openapi(buildLifecycleAliasRoute('stop'), async (c) => {
  const { id } = c.req.valid('param')
  return lifecycleAliasHandler(c, id, 'stop')
})
campaignRoutes.openapi(buildLifecycleAliasRoute('cancel'), async (c) => {
  const { id } = c.req.valid('param')
  return lifecycleAliasHandler(c, id, 'cancel')
})

// ─── DAG Validation ─────────────────────────────────────────────────

const validateCampaignRoute = createRoute({
  method: 'get',
  path: '/{id}/validate',
  tags: ['campaigns'],
  summary: 'Validate the campaign DAG without mutating state',
  security: [{ SessionCookie: [] }],
  middleware: [requireProjectAccess()] as const,
  request: {
    params: campaignIdParamSchema,
  },
  responses: {
    200: {
      description: 'DAG validation result.',
      content: { 'application/json': { schema: validateCampaignResponseSchema } },
    },
    401: sharedResponse(DASHBOARD_RESPONSE_REFS.AuthRequired),
    403: sharedResponse(DASHBOARD_RESPONSE_REFS.Forbidden),
    400: sharedResponse(DASHBOARD_RESPONSE_REFS.ValidationFailed),
    404: sharedResponse(DASHBOARD_RESPONSE_REFS.ResourceNotFound),
  },
})

campaignRoutes.openapi(validateCampaignRoute, async (c) => {
  const { id } = c.req.valid('param')
  const campaign = await getCampaignById(id)

  // Cross-project enforcement: requireProjectAccess only proves the
  // caller belongs to *their* active project, not that this campaign
  // belongs to it. Without the projectId compare a member of project A
  // could probe DAG validity (and infer existence/state) of a
  // campaign in project B. 404 on cross-project to avoid leaking
  // existence.
  const { projectId } = c.get('scopedUser')!
  if (!campaign || campaign.projectId !== projectId) {
    return dashboardError(c, 404, 'RESOURCE_NOT_FOUND', 'Campaign not found')
  }

  const result = await validateCampaignDAG(id)
  return c.json(result, 200)
})

// ─── Attack Management ──────────────────────────────────────────────

const createAttackSchema = z.object({
  mode: z.number().int().nonnegative(),
  hashTypeId: z.number().int().positive().optional(),
  wordlistId: z.number().int().positive().optional(),
  rulelistId: z.number().int().positive().optional(),
  masklistId: z.number().int().positive().optional(),
  advancedConfiguration: z.record(z.string(), z.unknown()).optional(),
  dependencies: z.array(z.number().int().positive()).optional(),
})

// Synthetic id used for pre-insert DAG validation. Attack IDs are
// positive serials, so any negative value is guaranteed not to collide
// with existing rows.
const SYNTHETIC_NEW_ATTACK_ID = -1

const createAttackRoute = createRoute({
  method: 'post',
  path: '/{id}/attacks',
  tags: ['campaigns', 'attacks'],
  summary: 'Create an attack on a draft campaign',
  security: [{ SessionCookie: [] }],
  middleware: [requireMembershipRole('admin', 'contributor')] as const,
  request: {
    params: campaignIdParamSchema,
    body: {
      content: {
        'application/json': { schema: createAttackSchema },
      },
    },
  },
  responses: {
    201: {
      description: 'Attack created.',
      content: { 'application/json': { schema: attackResponseSchema } },
    },
    401: sharedResponse(DASHBOARD_RESPONSE_REFS.AuthRequired),
    403: sharedResponse(DASHBOARD_RESPONSE_REFS.Forbidden),
    400: sharedResponse(DASHBOARD_RESPONSE_REFS.ValidationFailed),
    404: sharedResponse(DASHBOARD_RESPONSE_REFS.ResourceNotFound),
    409: {
      description: 'Referenced resources missing or cross-project.',
      content: { 'application/json': { schema: z.object({}).passthrough() } },
    },
    503: {
      description: 'Resource validation lookup unavailable.',
      content: { 'application/json': { schema: z.object({}).passthrough() } },
    },
  },
})

campaignRoutes.openapi(createAttackRoute, async (c) => {
  const { id: campaignId } = c.req.valid('param')

  // Project-scope guard: requireMembershipRole only validates that the caller
  // is a contributor *somewhere*; without this check a contributor
  // in project A could create attacks against a campaign in project
  // B by guessing the campaign id. 404 on cross-project to avoid
  // leaking existence.
  const { projectId } = c.get('scopedUser')!
  const campaign = await getCampaignById(campaignId)
  if (!campaign || campaign.projectId !== projectId) {
    return dashboardError(c, 404, 'RESOURCE_NOT_FOUND', 'Campaign not found')
  }

  const data = c.req.valid('json')

  // Cross-project resource pre-check at draft write time. FK
  // constraints only enforce existence; this gate enforces project
  // ownership so a contributor can't persist attack rows that
  // reference resources from another project. Skipped when no
  // nullable resource refs are supplied.
  const hasResourceRefs =
    data.hashTypeId != null ||
    data.wordlistId != null ||
    data.rulelistId != null ||
    data.masklistId != null
  if (hasResourceRefs) {
    const errResp = await checkResourcesOrErrorResponse(
      c,
      { projectId: campaign.projectId, hashListId: null },
      [
        {
          hashTypeId: data.hashTypeId,
          wordlistId: data.wordlistId,
          rulelistId: data.rulelistId,
          masklistId: data.masklistId,
        },
      ],
      { route: 'POST /:id/attacks', campaignId, projectId: campaign.projectId }
    )
    if (errResp) return errResp
  }

  // Pre-insert DAG validation: build the proposed graph (current
  // attacks + this new attack with a synthetic id) and reject the
  // request if it would introduce a cycle or reference a missing
  // attack id. Skipped when no dependencies are supplied — a
  // dependency-less attack cannot introduce a cycle, and skipping
  // the listAttacks read keeps the hot path cheap. Mirrors the same
  // optimization on the PATCH /:id/attacks/:attackId route.
  if (data.dependencies && data.dependencies.length > 0) {
    const currentAttacks = await listAttacks(campaignId)
    const proposed = [
      ...currentAttacks.map((a) => ({
        id: a.id,
        dependencies: a.dependencies as number[] | null,
      })),
      {
        id: SYNTHETIC_NEW_ATTACK_ID,
        dependencies: data.dependencies,
      },
    ]
    const dagResult = validateProposedDAG(proposed)
    if (!dagResult.valid) {
      return dashboardError(c, 400, 'DAG_INVALID', dagResult.error ?? 'Invalid DAG')
    }
  }

  const attack = await createAttack({
    ...data,
    campaignId,
    projectId: campaign.projectId,
  })

  return c.json({ attack }, 201)
})

const listAttacksRoute = createRoute({
  method: 'get',
  path: '/{id}/attacks',
  tags: ['campaigns', 'attacks'],
  summary: 'List attacks for a campaign',
  security: [{ SessionCookie: [] }],
  middleware: [requireProjectAccess()] as const,
  request: {
    params: campaignIdParamSchema,
  },
  responses: {
    200: {
      description: 'Attacks belonging to the campaign.',
      content: { 'application/json': { schema: listAttacksResponseSchema } },
    },
    401: sharedResponse(DASHBOARD_RESPONSE_REFS.AuthRequired),
    403: sharedResponse(DASHBOARD_RESPONSE_REFS.Forbidden),
    400: sharedResponse(DASHBOARD_RESPONSE_REFS.ValidationFailed),
    404: sharedResponse(DASHBOARD_RESPONSE_REFS.ResourceNotFound),
  },
})

campaignRoutes.openapi(listAttacksRoute, async (c) => {
  const { id: campaignId } = c.req.valid('param')
  const campaign = await getCampaignById(campaignId)

  // Cross-project enforcement: same reasoning as the /:id/validate
  // route above -- without the projectId compare, any project member
  // could enumerate attacks for a campaign in a different project by
  // guessing the id. 404 to avoid leaking existence.
  const { projectId } = c.get('scopedUser')!
  if (!campaign || campaign.projectId !== projectId) {
    return dashboardError(c, 404, 'RESOURCE_NOT_FOUND', 'Campaign not found')
  }

  const campaignAttacks = await listAttacks(campaignId)
  return c.json({ attacks: campaignAttacks }, 200)
})

const updateAttackSchema = z.object({
  mode: z.number().int().nonnegative().optional(),
  hashTypeId: z.number().int().positive().optional(),
  wordlistId: z.number().int().positive().optional(),
  rulelistId: z.number().int().positive().optional(),
  masklistId: z.number().int().positive().optional(),
  advancedConfiguration: z.record(z.string(), z.unknown()).optional(),
  dependencies: z.array(z.number().int().positive()).optional(),
})

const attackPathParamSchema = z.object({
  id: z.coerce.number().int().positive(),
  attackId: z.coerce.number().int().positive(),
})

const updateAttackRoute = createRoute({
  method: 'patch',
  path: '/{id}/attacks/{attackId}',
  tags: ['campaigns', 'attacks'],
  summary: 'Update an attack on a draft campaign',
  security: [{ SessionCookie: [] }],
  middleware: [requireMembershipRole('admin', 'contributor')] as const,
  request: {
    params: attackPathParamSchema,
    body: {
      content: {
        'application/json': { schema: updateAttackSchema },
      },
    },
  },
  responses: {
    200: {
      description: 'Attack updated.',
      content: { 'application/json': { schema: attackResponseSchema } },
    },
    401: sharedResponse(DASHBOARD_RESPONSE_REFS.AuthRequired),
    403: sharedResponse(DASHBOARD_RESPONSE_REFS.Forbidden),
    400: sharedResponse(DASHBOARD_RESPONSE_REFS.ValidationFailed),
    404: sharedResponse(DASHBOARD_RESPONSE_REFS.ResourceNotFound),
    409: {
      description: 'Referenced resources missing or cross-project.',
      content: { 'application/json': { schema: z.object({}).passthrough() } },
    },
    503: {
      description: 'Resource validation lookup unavailable.',
      content: { 'application/json': { schema: z.object({}).passthrough() } },
    },
  },
})

campaignRoutes.openapi(updateAttackRoute, async (c) => {
  const { id: campaignId, attackId } = c.req.valid('param')

  // Project-scope guard: load the parent campaign unconditionally
  // (not just when resource refs change) and reject when it doesn't
  // belong to the caller's active project. Without this gate a
  // contributor in project A could mutate attacks in project B by
  // guessing {campaignId, attackId} pairs. The attack-belongs-to-
  // campaign check below is necessary but not sufficient.
  const { projectId } = c.get('scopedUser')!
  const parentCampaign = await getCampaignById(campaignId)
  if (!parentCampaign || parentCampaign.projectId !== projectId) {
    return dashboardError(c, 404, 'RESOURCE_NOT_FOUND', 'Campaign not found')
  }

  // Verify attack belongs to the specified campaign
  const existing = await getAttackById(attackId)
  if (!existing || existing.campaignId !== campaignId) {
    return dashboardError(c, 404, 'RESOURCE_NOT_FOUND', 'Attack not found')
  }

  const data = c.req.valid('json')

  // Cross-project resource pre-check at draft write time. Only fires
  // when a resource ref is actually being changed; the existing row
  // already passed this gate when it was created. Uses the
  // parentCampaign already loaded above for its projectId.
  const hasResourceRefChange =
    data.hashTypeId !== undefined ||
    data.wordlistId !== undefined ||
    data.rulelistId !== undefined ||
    data.masklistId !== undefined
  if (hasResourceRefChange) {
    const errResp = await checkResourcesOrErrorResponse(
      c,
      { projectId: parentCampaign.projectId, hashListId: null },
      [
        {
          hashTypeId: data.hashTypeId,
          wordlistId: data.wordlistId,
          rulelistId: data.rulelistId,
          masklistId: data.masklistId,
        },
      ],
      { route: 'PATCH /:id/attacks/:attackId', campaignId, projectId: parentCampaign.projectId }
    )
    if (errResp) return errResp
  }

  // Pre-update DAG validation: only when dependencies are being
  // changed. Other field changes (mode, wordlist, etc.) do not affect
  // the dependency graph, so skipping the load avoids the extra query.
  if (data.dependencies !== undefined) {
    const currentAttacks = await listAttacks(campaignId)
    const proposed = currentAttacks.map((a) => ({
      id: a.id,
      dependencies:
        a.id === attackId ? (data.dependencies ?? null) : (a.dependencies as number[] | null),
    }))
    const dagResult = validateProposedDAG(proposed)
    if (!dagResult.valid) {
      return dashboardError(c, 400, 'DAG_INVALID', dagResult.error ?? 'Invalid DAG')
    }
  }

  const attack = await updateAttack(attackId, data)

  if (!attack) {
    return dashboardError(c, 404, 'RESOURCE_NOT_FOUND', 'Attack not found')
  }

  return c.json({ attack }, 200)
})

const deleteAttackRoute = createRoute({
  method: 'delete',
  path: '/{id}/attacks/{attackId}',
  tags: ['campaigns', 'attacks'],
  summary: 'Delete an attack from a draft campaign',
  security: [{ SessionCookie: [] }],
  middleware: [requireMembershipRole('admin', 'contributor')] as const,
  request: {
    params: attackPathParamSchema,
  },
  responses: {
    200: {
      description: 'Attack deleted.',
      content: { 'application/json': { schema: deleteAttackResponseSchema } },
    },
    401: sharedResponse(DASHBOARD_RESPONSE_REFS.AuthRequired),
    403: sharedResponse(DASHBOARD_RESPONSE_REFS.Forbidden),
    400: sharedResponse(DASHBOARD_RESPONSE_REFS.ValidationFailed),
    404: sharedResponse(DASHBOARD_RESPONSE_REFS.ResourceNotFound),
  },
})

campaignRoutes.openapi(deleteAttackRoute, async (c) => {
  const { id: campaignId, attackId } = c.req.valid('param')
  const { projectId } = c.get('scopedUser')!

  // Verify the campaign exists AND belongs to the caller's current
  // project scope. requireMembershipRole only proves the caller is a
  // member of the active project; without this check, a user in
  // project A who knew a valid {campaignId, attackId} pair from
  // project B could delete project B's attack.
  const parent = await getCampaignById(campaignId)
  if (!parent || (projectId !== null && parent.projectId !== projectId)) {
    return dashboardError(c, 404, 'RESOURCE_NOT_FOUND', 'Campaign not found')
  }

  // Verify attack belongs to the specified campaign
  const existing = await getAttackById(attackId)
  if (!existing || existing.campaignId !== campaignId) {
    return dashboardError(c, 404, 'RESOURCE_NOT_FOUND', 'Attack not found')
  }

  const attack = await deleteAttack(attackId)

  if (!attack) {
    return dashboardError(c, 404, 'RESOURCE_NOT_FOUND', 'Attack not found')
  }

  return c.json({ deleted: true as const }, 200)
})

export { campaignRoutes }
