import type { Context } from 'hono'

import {
  type CampaignStatus,
  campaignEtaSchema,
  changeCampaignPriorityRequestSchema,
  confirmSplitCampaignRequestSchema,
  confirmSplitCampaignResponseSchema,
  inlineAttackRequestSchema,
  splitPendingResponseSchema,
  splitReviewGroupsSchema,
  splitStatusResponseSchema,
} from '@hashhive/shared'
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
import { getSplitStatus } from '../../services/campaign-split-status.js'
import { confirmSplitCampaign, createCampaignOrSplit } from '../../services/campaign-split.js'
import {
  deleteCampaign,
  changeRunningCampaignPriority,
  computeCampaignEtaState,
  getArchivedAttackIds,
  getCampaignAttacksWithRuntime,
  getCampaignById,
  getCampaignEtasBatch,
  getCampaignTaskStats,
  listActiveAgentsByCampaign,
  listCampaigns,
  updateCampaign,
  validateCampaignDAG,
} from '../../services/campaigns.js'
import { registerCampaignArchiveRoutes } from './campaigns-archive.js'
import { registerCampaignAttackArchiveRoutes } from './campaigns-attacks-archive.js'
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
  // Archived campaigns are excluded by default (ADR-0019); `?showArchived=true`
  // includes them. Permissive coercion: only the literal "true" enables it,
  // anything else (or absent) is false — never 400s the list request.
  showArchived: z
    .string()
    .optional()
    .transform((v) => v === 'true'),
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
  eta: campaignEtaSchema,
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
  const { status, priority, sort, order, limit, offset, showArchived } = c.req.valid('query')

  const result = await listCampaigns({
    projectId,
    status,
    priority,
    showArchived,
    sort,
    order,
    limit,
    offset,
  })

  // Issue #100 U2: one batched ETA rollup call for the whole page, never
  // one call per row. `getCampaignEtasBatch` already does a single
  // `inArray` attacks fetch + a single `deriveAttackRuntimes` call
  // internally (see campaign-eta-rollup.ts), so this stays within the
  // route's existing query budget regardless of page size.
  const etaByCampaignId = await getCampaignEtasBatch(result.campaigns.map((row) => row.id))
  const campaignsWithEta = result.campaigns.map((row) => ({
    ...row,
    // Unreachable today — the batch rollup returns an entry per requested
    // id. Falls back to the neutral "no data yet" state (not `complete`)
    // so a future lookup miss can never misrender a still-running campaign
    // as finished (code review fix).
    eta: etaByCampaignId.get(row.id) ?? ({ state: 'estimating' } as const),
  }))

  return c.json({ ...result, campaigns: campaignsWithEta }, 200)
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
  // Issue #202 SU7: force the plain single-mode create path even when the
  // target hash list is mixed/needs-review. Used by the wizard's
  // `single_group` fallback after the async split job found nothing to
  // split (see `createCampaignOrSplit` in services/campaign-split.ts).
  skipSplit: z.boolean().optional(),
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
    // Issue #202 SU3: a PRIOR call already split this parent — no new
    // campaign is created. The caller must resolve the `ambiguous` groups'
    // candidate modes and confirm via `POST /campaigns/split/confirm`.
    200: {
      description:
        'The target hash list was already split by a prior call — no campaign was created. Resolve the returned review groups and call POST /campaigns/split/confirm.',
      content: { 'application/json': { schema: splitReviewGroupsSchema } },
    },
    // Issue #202 SU7: the target hash list is mixed and has not been split
    // yet — the async split job was enqueued instead of running inline.
    // Poll GET /campaigns/split/status/{hashListId} for the outcome.
    202: {
      description:
        'The target hash list is mixed and split analysis was enqueued. Poll GET /campaigns/split/status/{hashListId} for the outcome.',
      content: { 'application/json': { schema: splitPendingResponseSchema } },
    },
    401: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.AuthRequired),
    403: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.Forbidden),
    400: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.ValidationFailed),
    409: {
      description: 'Inline attacks referenced a missing resource.',
      content: { 'application/json': { schema: z.object({}).passthrough() } },
    },
    422: {
      description: 'Inline attacks mix more than one hashcat mode.',
      content: { 'application/json': { schema: z.object({}).passthrough() } },
    },
    503: {
      description:
        'Transactional create could not run (e.g. DB unavailable), or the target hash list is mixed and the async split-analysis job could not be enqueued (SPLIT_ENQUEUE_FAILED).',
      content: { 'application/json': { schema: z.object({}).passthrough() } },
    },
  },
})

campaignRoutes.openapi(createCampaignRoute, async (c) => {
  const data = c.req.valid('json')
  const { userId, projectId } = c.get('scopedUser')!

  const actor = { actorType: 'user' as const, actorId: userId }

  // Single entry point regardless of whether inline attacks were supplied
  // (issue #202 SU3) — `createCampaignOrSplit` reads the target hash
  // list's `type_analysis.verdict` first and either passes through to the
  // normal single-transaction create (unanalyzed/homogeneous list, or a
  // mixed-verdict list whose split classifier degenerates to one group)
  // or short-circuits into the split/review flow. Wrap in try/catch so a
  // DB blip during the pre-check or the transaction surfaces as a typed
  // 503 instead of bubbling to onError as a generic 500.
  let result: Awaited<ReturnType<typeof createCampaignOrSplit>>
  try {
    result = await createCampaignOrSplit({
      name: data.name,
      description: data.description,
      hashListId: data.hashListId,
      priority: data.priority,
      projectId,
      createdBy: userId,
      attacks: data.attacks ?? [],
      actor,
      skipSplit: data.skipSplit,
    })
  } catch (err) {
    logger.error(
      { err, route: 'POST /campaigns', projectId, userId },
      'createCampaignOrSplit threw — surfacing as service unavailable'
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

  if (result.kind === 'resource_reclaimed') {
    return c.json(
      {
        error: {
          code: 'RESOURCE_RECLAIMED',
          message: `Referenced resources are reclaimed shells (re-upload required): ${result.reclaimed.join(', ')}`,
        },
      },
      409
    )
  }

  if (result.kind === 'resource_archived') {
    return c.json(
      {
        error: {
          code: 'RESOURCE_ARCHIVED',
          message: `Referenced resources are archived: ${result.archived.join(', ')}`,
        },
      },
      409
    )
  }

  if (result.kind === 'mode_conflict') {
    return dashboardError(
      c,
      422,
      'ATTACK_MODE_CONFLICT',
      `Campaign attacks must share one hashcat mode; received modes: ${result.modes.join(', ')}`
    )
  }

  if (result.kind === 'split_enqueue_failed') {
    logger.warn(
      { hashListId: result.hashListId, route: 'POST /campaigns', projectId, userId },
      'split analysis could not be enqueued — surfacing as service unavailable instead of split_pending'
    )
    return dashboardError(
      c,
      503,
      'SPLIT_ENQUEUE_FAILED',
      'Unable to schedule split analysis for this hash list right now. Try again in a moment.'
    )
  }

  if (result.kind === 'split_pending') {
    return c.json({ splitPending: true as const, hashListId: result.hashListId }, 202)
  }

  if (result.kind === 'split_review') {
    return c.json(
      {
        parentHashListId: result.parentHashListId,
        confident: result.confident,
        ambiguous: result.ambiguous,
        unidentified: result.unidentified,
      },
      200
    )
  }

  return c.json({ campaign: result.campaign, attacks: result.attacks }, 201)
})

// ─── Split confirm (issue #202 SU3) ────────────────────────────────
//
// A dedicated two-segment path (`/split/confirm`) so it can never collide
// with the `/{id}` detail route regardless of registration order — Hono
// matches on path shape, and `split` is never a valid campaign id.
const confirmSplitCampaignRoute = createRoute({
  method: 'post',
  path: '/split/confirm',
  tags: ['Campaigns'],
  summary:
    'Confirm a mixed hash-list split: resolve ambiguous groups, then create the parent + sub-campaigns',
  security: [{ SessionCookie: [] }],
  middleware: [requireMembershipRole('admin', 'contributor')] as const,
  request: {
    body: {
      content: {
        'application/json': { schema: confirmSplitCampaignRequestSchema },
      },
    },
  },
  responses: {
    201: {
      description: 'Parent campaign and its resolved sub-campaigns created.',
      content: { 'application/json': { schema: confirmSplitCampaignResponseSchema } },
    },
    401: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.AuthRequired),
    403: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.Forbidden),
    400: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.ValidationFailed),
    404: {
      description: "Parent hash list not found or outside the caller's project.",
      content: { 'application/json': { schema: z.object({}).passthrough() } },
    },
    409: {
      description:
        'Parent hash list has not been split yet, or an assignment is invalid (unknown sub-list, not ambiguous, or an out-of-candidate mode).',
      content: { 'application/json': { schema: z.object({}).passthrough() } },
    },
    503: {
      description: 'Transactional confirm could not run (e.g. DB unavailable).',
      content: { 'application/json': { schema: z.object({}).passthrough() } },
    },
  },
})

campaignRoutes.openapi(confirmSplitCampaignRoute, async (c) => {
  const data = c.req.valid('json')
  const { userId, projectId } = c.get('scopedUser')!
  const actor = { actorType: 'user' as const, actorId: userId }

  // Wrap in try/catch so a DB blip during the merge/create sequence
  // surfaces as a typed 503 instead of bubbling to onError as a generic
  // 500 (code review fix — mirrors the create route's handler above).
  let result: Awaited<ReturnType<typeof confirmSplitCampaign>>
  try {
    result = await confirmSplitCampaign({
      projectId,
      parentHashListId: data.parentHashListId,
      name: data.name,
      description: data.description,
      priority: data.priority,
      createdBy: userId,
      assignments: data.assignments,
      actor,
    })
  } catch (err) {
    logger.error(
      { err, route: 'POST /campaigns/split/confirm', projectId, userId },
      'confirmSplitCampaign threw — surfacing as service unavailable'
    )
    return c.json(
      {
        error: {
          code: 'SERVICE_UNAVAILABLE',
          message: 'Unable to confirm the split campaign right now',
        },
      },
      503
    )
  }

  switch (result.kind) {
    case 'not_found':
      return dashboardError(c, 404, 'RESOURCE_NOT_FOUND', 'Hash list not found')
    case 'not_split':
      return dashboardError(
        c,
        409,
        'HASH_LIST_NOT_SPLIT',
        'Hash list has not been split yet — POST /campaigns against it first'
      )
    case 'invalid_assignment':
      return dashboardError(c, 409, 'SPLIT_ASSIGNMENT_INVALID', result.reason)
    case 'confirmed':
      return c.json(
        {
          parentCampaignId: result.parentCampaign.id,
          parentHashListId: data.parentHashListId,
          subCampaigns: result.subCampaigns,
        },
        201
      )
  }
})

// ─── Split status polling (issue #202 SU7) ─────────────────────────
//
// Distinct three-segment path so it can never collide with `/{id}`
// (one segment) or `/split/confirm` (a different literal second
// segment) regardless of registration order — same reasoning as the
// confirm route's comment above.
const hashListIdParamSchema = z.object({
  hashListId: z.coerce.number().int().positive(),
})

const splitStatusRoute = createRoute({
  method: 'get',
  path: '/split/status/{hashListId}',
  tags: ['Campaigns'],
  summary: 'Poll the async mixed hash-list split analysis job',
  security: [{ SessionCookie: [] }],
  middleware: [requireProjectAccess()] as const,
  request: {
    params: hashListIdParamSchema,
  },
  responses: {
    200: {
      description: 'Current split status.',
      content: { 'application/json': { schema: splitStatusResponseSchema } },
    },
    401: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.AuthRequired),
    403: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.Forbidden),
    400: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.ValidationFailed),
    404: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.ResourceNotFound),
  },
})

campaignRoutes.openapi(splitStatusRoute, async (c) => {
  const { hashListId } = c.req.valid('param')
  const { projectId } = c.get('scopedUser')!

  const result = await getSplitStatus(hashListId, projectId)
  if (result.kind === 'not_found') {
    return dashboardError(c, 404, 'RESOURCE_NOT_FOUND', 'Hash list not found')
  }
  return c.json(result.response, 200)
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

  const [campaignAttacks, taskStats, activeAgents, archivedAttackIds] = await Promise.all([
    getCampaignAttacksWithRuntime(id),
    getCampaignTaskStats(id),
    listActiveAgentsByCampaign(id),
    getArchivedAttackIds(id),
  ])

  // Issue #100 U2: compute the campaign-level ETA from the attack runtimes
  // and active-agent list already fetched above rather than calling
  // `getCampaignEta`, which would re-fetch the campaign's attacks and
  // re-run `deriveAttackRuntimes` a second time for the same request.
  //
  // Code review fix (issue #100 R1): `getCampaignAttacksWithRuntime`
  // intentionally returns every attack regardless of archive state (the
  // detail payload's `attacks` array is a separate concern), so archived
  // rows are filtered out here before feeding the rollup — mirrors the
  // `isNull(archivedAt)` filter `getCampaignEtasBatch` applies for the
  // list view, keeping detail and list ETAs consistent.
  const eta = computeCampaignEtaState({
    // `campaigns.status` is a `varchar(20)` column — Drizzle infers `string`,
    // not the narrower `CampaignStatus` literal union (mirrors the same cast
    // in `campaign-eta-rollup.ts`'s batch path).
    campaignStatus: campaign.status as CampaignStatus,
    hasActiveAgents: activeAgents.length > 0,
    attacks: campaignAttacks.filter((attack) => !archivedAttackIds.has(attack.id)),
  })

  return c.json(
    {
      campaign,
      attacks: campaignAttacks,
      taskStats,
      activeAgents,
      eta,
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
    result = await deleteCampaign(id, projectId, { actorType: 'user', actorId: userId })
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
    case 'not_deletable':
      return c.json(
        {
          error: {
            code: 'NOT_DELETABLE',
            message:
              'Campaign has run and is now permanent; it cannot be deleted, only archived once completed or cancelled.',
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
  const { projectId, userId } = c.get('scopedUser')!
  const existing = await getCampaignById(id)
  if (!existing || existing.projectId !== projectId) {
    return dashboardError(c, 404, 'RESOURCE_NOT_FOUND', 'Campaign not found')
  }

  // PUT's `description` can be the literal `null` ("explicit clear");
  // updateCampaign accepts `undefined` to mean "leave alone", so we
  // pass null through unchanged and let the service write it.
  const result = await updateCampaign(id, projectId, data, { actorType: 'user', actorId: userId })

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
  const { projectId, userId } = c.get('scopedUser')!
  const result = await changeRunningCampaignPriority(id, projectId, priority, {
    actorType: 'user',
    actorId: userId,
  })
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
registerCampaignArchiveRoutes(campaignRoutes)
registerCampaignAttackArchiveRoutes(campaignRoutes)

export { campaignRoutes }
