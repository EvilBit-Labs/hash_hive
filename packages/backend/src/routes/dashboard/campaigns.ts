import type { Context } from 'hono'

import { changeCampaignPriorityRequestSchema, inlineAttackRequestSchema } from '@hashhive/shared'
import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi'

import type { AppEnv } from '../../types.js'

import { logger } from '../../config/logger.js'
import { dashboardError } from '../../lib/dashboard-errors.js'
import { requireSession } from '../../middleware/auth.js'
import { requireProjectAccess, requireMembershipRole } from '../../middleware/rbac.js'
import { coercedIntegerQuery } from '../../openapi/coerced-query.js'
import {
  DASHBOARD_RESPONSE_REFS,
  dashboardOpenApiHonoOptions,
  sharedDashboardResponse,
} from '../../openapi/components.js'
import {
  createCampaign,
  createCampaignWithAttacks,
  deleteCampaign,
  changeRunningCampaignPriority,
  getCampaignById,
  getCampaignTaskStats,
  listActiveAgentsByCampaign,
  listAttacks,
  listCampaigns,
  updateCampaign,
  validateCampaignDAG,
} from '../../services/campaigns.js'
import { registerCampaignAttackRoutes } from './campaigns-attacks.js'
import { registerCampaignLifecycleRoutes } from './campaigns-lifecycle.js'
import { attackRowSchema, campaignIdParamSchema, campaignRowSchema } from './campaigns-shared.js'

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
  limit: coercedIntegerQuery({
    min: 1,
    max: CAMPAIGN_LIST_MAX_LIMIT,
    default: CAMPAIGN_LIST_DEFAULT_LIMIT,
  }),
  offset: coercedIntegerQuery({ min: 0, default: 0 }),
})

// `campaignIdParamSchema`, `campaignRowSchema`, `attackRowSchema`
// live in `./campaigns-shared.ts` so the lifecycle and attack route
// modules can reuse them without re-creating an import cycle.

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

const validateCampaignResponseSchema = z.object({}).passthrough()

const listCampaignsRoute = createRoute({
  method: 'get',
  path: '/',
  tags: ['Campaigns'],
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
    401: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.AuthRequired),
    403: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.Forbidden),
    400: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.ValidationFailed),
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
  tags: ['Campaigns'],
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
    401: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.AuthRequired),
    403: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.Forbidden),
    400: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.ValidationFailed),
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
  tags: ['Campaigns'],
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
    401: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.AuthRequired),
    403: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.Forbidden),
    400: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.ValidationFailed),
    404: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.ResourceNotFound),
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
  tags: ['Campaigns'],
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
    401: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.AuthRequired),
    403: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.Forbidden),
    400: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.ValidationFailed),
    404: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.ResourceNotFound),
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

// Shared post-load update logic for PATCH and PUT — the two routes
// expose different body schemas (PATCH is partial, PUT is required)
// but the lookup, project-scope check, service call, and result-kind
// branch are identical. Each route's handler validates its body via
// its own createRoute schema and then forwards the parsed `data` here.
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
  const result = await updateCampaign(id, projectId, data)

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
  tags: ['Campaigns'],
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
    401: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.AuthRequired),
    403: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.Forbidden),
    400: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.ValidationFailed),
    404: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.ResourceNotFound),
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
  tags: ['Campaigns'],
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
    401: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.AuthRequired),
    403: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.Forbidden),
    400: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.ValidationFailed),
    404: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.ResourceNotFound),
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

// ─── Live Priority Change (issue #97 U7) ────────────────────────────
// Distinct from PATCH /{id} (draft-only): this re-prioritises a RUNNING or
// PAUSED campaign and re-evaluates preemption. Same contributor/admin gate.
// Wire shape shared with the control surface (#97 U7) so the two cannot drift.
const changePriorityBodySchema = changeCampaignPriorityRequestSchema

const changePriorityRoute = createRoute({
  method: 'patch',
  path: '/{id}/priority',
  tags: ['Campaigns'],
  summary: "Change a running or paused campaign's priority (triggers preemption)",
  security: [{ SessionCookie: [] }],
  middleware: [requireMembershipRole('admin', 'contributor')] as const,
  request: {
    params: campaignIdParamSchema,
    body: { content: { 'application/json': { schema: changePriorityBodySchema } } },
  },
  responses: {
    200: {
      description: 'Priority changed.',
      content: { 'application/json': { schema: updateCampaignResponseSchema } },
    },
    401: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.AuthRequired),
    403: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.Forbidden),
    400: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.ValidationFailed),
    404: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.ResourceNotFound),
    409: {
      description: 'Campaign is not running or paused; priority cannot be changed.',
      content: { 'application/json': { schema: z.object({}).passthrough() } },
    },
  },
})

campaignRoutes.openapi(changePriorityRoute, async (c) => {
  const { id } = c.req.valid('param')
  const { priority } = c.req.valid('json')
  const { projectId } = c.get('scopedUser')!
  const result = await changeRunningCampaignPriority(id, projectId, priority)
  switch (result.kind) {
    case 'not_found':
      return dashboardError(c, 404, 'RESOURCE_NOT_FOUND', 'Campaign not found')
    case 'not_active':
      return c.json(
        {
          error: {
            code: 'NOT_ACTIVE',
            message: `Campaign priority cannot be changed in status "${result.status}". Only running or paused campaigns can be re-prioritised.`,
          },
        },
        409
      )
    case 'updated':
      return c.json({ campaign: result.campaign }, 200)
  }
})

// ─── DAG Validation ─────────────────────────────────────────────────

const validateCampaignRoute = createRoute({
  method: 'get',
  path: '/{id}/validate',
  tags: ['Campaigns'],
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
    401: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.AuthRequired),
    403: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.Forbidden),
    400: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.ValidationFailed),
    404: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.ResourceNotFound),
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

// ─── Sub-router registrations ──────────────────────────────────────
//
// Lifecycle and attack routes live in their own files to keep this
// module under the 800-line cap. They register against the same
// `campaignRoutes` router so URL paths and middleware composition
// stay identical to the single-file form.

registerCampaignLifecycleRoutes(campaignRoutes)
registerCampaignAttackRoutes(campaignRoutes)

export { campaignRoutes }
