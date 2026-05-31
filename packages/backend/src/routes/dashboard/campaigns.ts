import type { Context } from 'hono'

import { inlineAttackRequestSchema } from '@hashhive/shared'
import { OpenAPIHono } from '@hono/zod-openapi'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'

import type { AppEnv } from '../../types.js'

import { logger } from '../../config/logger.js'
import { dashboardError } from '../../lib/dashboard-errors.js'
import { requireSession } from '../../middleware/auth.js'
import { requireProjectAccess, requireMembershipRole } from '../../middleware/rbac.js'
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

const campaignRoutes = new OpenAPIHono<AppEnv>()

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

campaignRoutes.get(
  '/',
  requireProjectAccess(),
  zValidator('query', listCampaignsQuerySchema, (result, c) => {
    if (result.success) return
    return c.json(
      {
        error: {
          code: 'VALIDATION_ERROR',
          message: result.error.issues.map((i) => i.message).join('; '),
        },
      },
      400
    )
  }),
  async (c) => {
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
    return c.json(result)
  }
)

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

campaignRoutes.post(
  '/',
  requireMembershipRole('admin', 'contributor'),
  zValidator('json', createCampaignSchema),
  async (c) => {
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
  }
)

campaignRoutes.get('/:id', requireProjectAccess(), async (c) => {
  const id = Number(c.req.param('id'))
  if (!Number.isInteger(id) || id <= 0) {
    return dashboardError(c, 400, 'VALIDATION_ERROR', 'Invalid campaign id')
  }

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

  return c.json({
    campaign,
    attacks: campaignAttacks,
    taskStats,
    activeAgents,
  })
})

campaignRoutes.delete('/:id', requireMembershipRole('admin', 'contributor'), async (c) => {
  const id = Number(c.req.param('id'))
  if (!Number.isInteger(id) || id <= 0) {
    return dashboardError(c, 400, 'VALIDATION_ERROR', 'Invalid campaign id')
  }

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
      return c.json({ deleted: true, id: result.id })
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

const updateCampaignHandler = (method: 'PATCH' | 'PUT') => async (c: Context<AppEnv>) => {
  const id = Number(c.req.param('id'))
  if (!Number.isInteger(id) || id <= 0) {
    return dashboardError(c, 400, 'VALIDATION_ERROR', 'Invalid campaign id')
  }

  const { projectId } = c.get('scopedUser')!
  const existing = await getCampaignById(id)
  if (!existing || existing.projectId !== projectId) {
    return dashboardError(c, 404, 'RESOURCE_NOT_FOUND', 'Campaign not found')
  }

  // Parse and validate the body inside the handler. Wrapping c.req.json()
  // in try/catch keeps a malformed body (invalid JSON, premature EOF) from
  // surfacing as an unhandled 500; the safeParse below handles schema
  // violations on syntactically valid JSON. Both failures share the
  // dashboard's `{ error: { code, message } }` envelope.
  let body: unknown
  try {
    body = await c.req.json()
  } catch {
    return dashboardError(c, 400, 'VALIDATION_ERROR', 'Request body must be valid JSON')
  }
  const schema = method === 'PUT' ? putCampaignSchema : patchCampaignSchema
  const parsed = schema.safeParse(body)
  if (!parsed.success) {
    return c.json(
      {
        error: {
          code: 'VALIDATION_ERROR',
          message: parsed.error.issues.map((i) => i.message).join('; '),
        },
      },
      400
    )
  }
  // PUT's `description` can be the literal `null` ("explicit clear");
  // updateCampaign accepts `undefined` to mean "leave alone", so we
  // pass null through unchanged and let the service write it.
  const result = await updateCampaign(id, parsed.data)

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
      return c.json({ campaign: result.campaign })
  }
}

// PATCH and PUT share a handler factory but use different schemas:
// PATCH is partial, PUT is full-replace. The handler bypasses
// zValidator's default envelope so all error responses use the
// dashboard's `{ error: { code, message } }` shape.
campaignRoutes.patch(
  '/:id',
  requireMembershipRole('admin', 'contributor'),
  updateCampaignHandler('PATCH')
)
campaignRoutes.put(
  '/:id',
  requireMembershipRole('admin', 'contributor'),
  updateCampaignHandler('PUT')
)

// ─── Campaign Lifecycle ─────────────────────────────────────────────

// Action enum matches the spec-named alias routes — `resume` is
// included alongside `start` even though both map to `running`,
// because the alias path exposes `/resume` and the parity is
// documented in the OpenAPI spec.
const lifecycleSchema = z.object({
  action: z.enum(['start', 'pause', 'resume', 'stop', 'cancel']),
})

campaignRoutes.post(
  '/:id/lifecycle',
  requireMembershipRole('admin', 'contributor'),
  zValidator('json', lifecycleSchema),
  async (c) => {
    const id = Number(c.req.param('id'))
    if (!Number.isInteger(id) || id <= 0) {
      return dashboardError(c, 400, 'VALIDATION_ERROR', 'Invalid campaign id')
    }

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
  }
)

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

const lifecycleAliasHandler =
  (action: keyof typeof lifecycleAliasStatus) => async (c: Context<AppEnv>) => {
    const id = Number(c.req.param('id'))
    if (!Number.isInteger(id) || id <= 0) {
      return dashboardError(c, 400, 'VALIDATION_ERROR', 'Invalid campaign id')
    }

    const { projectId } = c.get('scopedUser')!
    const existing = await getCampaignById(id)
    if (!existing || existing.projectId !== projectId) {
      return dashboardError(c, 404, 'RESOURCE_NOT_FOUND', 'Campaign not found')
    }

    const result = await transitionCampaign(id, lifecycleAliasStatus[action])
    return respondToTransition(c, result)
  }

campaignRoutes.post(
  '/:id/start',
  requireMembershipRole('admin', 'contributor'),
  lifecycleAliasHandler('start')
)
campaignRoutes.post(
  '/:id/pause',
  requireMembershipRole('admin', 'contributor'),
  lifecycleAliasHandler('pause')
)
campaignRoutes.post(
  '/:id/resume',
  requireMembershipRole('admin', 'contributor'),
  lifecycleAliasHandler('resume')
)
campaignRoutes.post(
  '/:id/stop',
  requireMembershipRole('admin', 'contributor'),
  lifecycleAliasHandler('stop')
)
campaignRoutes.post(
  '/:id/cancel',
  requireMembershipRole('admin', 'contributor'),
  lifecycleAliasHandler('cancel')
)

// ─── DAG Validation ─────────────────────────────────────────────────

campaignRoutes.get('/:id/validate', requireProjectAccess(), async (c) => {
  const id = Number(c.req.param('id'))
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
  return c.json(result)
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

campaignRoutes.post(
  '/:id/attacks',
  requireMembershipRole('admin', 'contributor'),
  zValidator('json', createAttackSchema),
  async (c) => {
    const campaignId = Number(c.req.param('id'))
    if (!Number.isInteger(campaignId) || campaignId <= 0) {
      return dashboardError(c, 400, 'VALIDATION_ERROR', 'Invalid campaign id')
    }

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
  }
)

campaignRoutes.get('/:id/attacks', requireProjectAccess(), async (c) => {
  const campaignId = Number(c.req.param('id'))
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
  return c.json({ attacks: campaignAttacks })
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

campaignRoutes.patch(
  '/:id/attacks/:attackId',
  requireMembershipRole('admin', 'contributor'),
  zValidator('json', updateAttackSchema),
  async (c) => {
    const campaignId = Number(c.req.param('id'))
    const attackId = Number(c.req.param('attackId'))
    if (
      !Number.isInteger(campaignId) ||
      campaignId <= 0 ||
      !Number.isInteger(attackId) ||
      attackId <= 0
    ) {
      return dashboardError(c, 400, 'VALIDATION_ERROR', 'Invalid id')
    }

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

    return c.json({ attack })
  }
)

campaignRoutes.delete(
  '/:id/attacks/:attackId',
  requireMembershipRole('admin', 'contributor'),
  async (c) => {
    const campaignId = Number(c.req.param('id'))
    const attackId = Number(c.req.param('attackId'))
    // Validate both IDs at the route boundary so NaN / negatives /
    // floats produce the file's canonical 400 VALIDATION_ERROR
    // envelope instead of falling through as misleading 404s from
    // the service layer.
    if (
      !Number.isInteger(campaignId) ||
      campaignId <= 0 ||
      !Number.isInteger(attackId) ||
      attackId <= 0
    ) {
      return dashboardError(c, 400, 'VALIDATION_ERROR', 'Invalid campaign or attack id')
    }
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

    return c.json({ deleted: true })
  }
)

export { campaignRoutes }
