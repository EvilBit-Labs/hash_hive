/**
 * Campaign attack management routes — extracted from `campaigns.ts`
 * to keep the main file under the 800-line cap. Registered against
 * the same `campaignRoutes` router via
 * `registerCampaignAttackRoutes(router)` so URL paths and middleware
 * composition stay identical.
 *
 * Covers:
 *  - POST   /{id}/attacks
 *  - GET    /{id}/attacks
 *  - PATCH  /{id}/attacks/{attackId}
 *  - DELETE /{id}/attacks/{attackId}
 *
 * Cross-project scope guards and pre-insert DAG validation are
 * preserved from the legacy handlers; only the route-registration
 * syntax changed.
 */

import { createRoute, type OpenAPIHono, z } from '@hono/zod-openapi'

import type { AppEnv } from '../../types.js'

import { dashboardError } from '../../lib/dashboard-errors.js'
import { requireMembershipRole, requireProjectAccess } from '../../middleware/rbac.js'
import { DASHBOARD_RESPONSE_REFS, sharedDashboardResponse } from '../../openapi/components.js'
import {
  checkSingleHashModePerCampaign,
  createAttack,
  deleteAttack,
  getAttackById,
  getCampaignById,
  listAttacks,
  updateAttack,
  validateProposedDAG,
} from '../../services/campaigns.js'
import {
  attackRowSchema,
  campaignIdParamSchema,
  checkResourcesOrErrorResponse,
} from './campaigns-shared.js'

// ─── Schemas ────────────────────────────────────────────────────────

const createAttackSchema = z.object({
  mode: z.number().int().nonnegative(),
  hashTypeId: z.number().int().positive().optional(),
  wordlistId: z.number().int().positive().optional(),
  rulelistId: z.number().int().positive().optional(),
  masklistId: z.number().int().positive().optional(),
  advancedConfiguration: z.record(z.string(), z.unknown()).optional(),
  dependencies: z.array(z.number().int().positive()).optional(),
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

const listAttacksResponseSchema = z.object({
  attacks: z.array(attackRowSchema),
})

// Archived attacks are excluded by default (ADR-0019 / issue #106 R6, R10);
// `?showArchived=true` includes them. Permissive coercion mirrors
// `campaigns.ts`'s `listCampaignsQuerySchema.showArchived`.
const listAttacksQuerySchema = z.object({
  showArchived: z
    .string()
    .optional()
    .transform((v) => v === 'true'),
})

const attackResponseSchema = z.object({
  attack: attackRowSchema,
})

const deleteAttackResponseSchema = z.object({
  deleted: z.literal(true),
})

// Synthetic id used for pre-insert DAG validation. Attack IDs are
// positive serials, so any negative value is guaranteed not to collide
// with existing rows.
const SYNTHETIC_NEW_ATTACK_ID = -1

// ─── Route definitions ─────────────────────────────────────────────

const createAttackRoute = createRoute({
  method: 'post',
  path: '/{id}/attacks',
  tags: ['Campaigns'],
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
    401: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.AuthRequired),
    403: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.Forbidden),
    400: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.ValidationFailed),
    404: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.ResourceNotFound),
    409: {
      description: 'Referenced resources missing or cross-project.',
      content: { 'application/json': { schema: z.object({}).passthrough() } },
    },
    422: {
      description: 'Attack mode conflicts with an existing non-terminal attack in this campaign.',
      content: { 'application/json': { schema: z.object({}).passthrough() } },
    },
    503: {
      description: 'Resource validation lookup unavailable.',
      content: { 'application/json': { schema: z.object({}).passthrough() } },
    },
  },
})

const listAttacksRoute = createRoute({
  method: 'get',
  path: '/{id}/attacks',
  tags: ['Campaigns'],
  summary: 'List attacks for a campaign',
  security: [{ SessionCookie: [] }],
  middleware: [requireProjectAccess()] as const,
  request: {
    params: campaignIdParamSchema,
    query: listAttacksQuerySchema,
  },
  responses: {
    200: {
      description: 'Attacks belonging to the campaign.',
      content: { 'application/json': { schema: listAttacksResponseSchema } },
    },
    401: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.AuthRequired),
    403: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.Forbidden),
    400: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.ValidationFailed),
    404: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.ResourceNotFound),
  },
})

const updateAttackRoute = createRoute({
  method: 'patch',
  path: '/{id}/attacks/{attackId}',
  tags: ['Campaigns'],
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
    401: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.AuthRequired),
    403: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.Forbidden),
    400: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.ValidationFailed),
    404: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.ResourceNotFound),
    409: {
      description: 'Referenced resources missing or cross-project.',
      content: { 'application/json': { schema: z.object({}).passthrough() } },
    },
    422: {
      description: 'Attack mode conflicts with an existing non-terminal attack in this campaign.',
      content: { 'application/json': { schema: z.object({}).passthrough() } },
    },
    503: {
      description: 'Resource validation lookup unavailable.',
      content: { 'application/json': { schema: z.object({}).passthrough() } },
    },
  },
})

const deleteAttackRoute = createRoute({
  method: 'delete',
  path: '/{id}/attacks/{attackId}',
  tags: ['Campaigns'],
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
    401: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.AuthRequired),
    403: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.Forbidden),
    400: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.ValidationFailed),
    404: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.ResourceNotFound),
    409: {
      description: 'Attack has run and is now permanent; only archiving is allowed.',
      content: { 'application/json': { schema: z.object({}).passthrough() } },
    },
  },
})

export function registerCampaignAttackRoutes(router: OpenAPIHono<AppEnv>): void {
  router.openapi(createAttackRoute, async (c) => {
    const { id: campaignId } = c.req.valid('param')

    // Project-scope guard: requireMembershipRole only validates that
    // the caller is a contributor *somewhere*; without this check, a
    // contributor in project A could create attacks against a campaign
    // in project B by guessing the campaign id. 404 to avoid leaking
    // existence.
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

    // Single-hash-mode-per-campaign guard (issue #100 R15 / AS1): the
    // campaign ETA rollup sums per-attack estimates across every
    // non-terminal attack, which is only exact when they share one
    // hashcat mode. Reject before the DAG check so a mode conflict is
    // reported without also validating a dependency graph that would be
    // discarded anyway.
    const modeCheck = await checkSingleHashModePerCampaign(campaignId, data.mode)
    if (!modeCheck.valid) {
      return dashboardError(
        c,
        422,
        'ATTACK_MODE_CONFLICT',
        `Attack mode ${data.mode} conflicts with mode ${modeCheck.conflictingMode} used by another non-terminal attack (id ${modeCheck.conflictingAttackId}) in this campaign; a campaign may only run one hashcat mode at a time`
      )
    }

    // Pre-insert DAG validation: build the proposed graph (current
    // attacks + this new attack with a synthetic id) and reject the
    // request if it would introduce a cycle or reference a missing
    // attack id. Skipped when no dependencies are supplied — a
    // dependency-less attack cannot introduce a cycle, and skipping
    // the listAttacks read keeps the hot path cheap. Mirrors the same
    // optimization on the PATCH /:id/attacks/:attackId route.
    if (data.dependencies && data.dependencies.length > 0) {
      // Include archived attacks (issue #106 U6): an archived attack is
      // hidden from the editor listing but remains a structurally valid
      // dependency target — excluding it here would make the DAG
      // validator misreport a real dependency as "non-existent".
      const currentAttacks = await listAttacks(campaignId, { showArchived: true })
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

    const { userId } = c.get('scopedUser')!
    const attack = await createAttack(
      {
        ...data,
        campaignId,
        projectId: campaign.projectId,
      },
      { actorType: 'user', actorId: userId }
    )

    return c.json({ attack }, 201)
  })

  router.openapi(listAttacksRoute, async (c) => {
    const { id: campaignId } = c.req.valid('param')
    const campaign = await getCampaignById(campaignId)

    // Cross-project enforcement: without the projectId compare, any
    // project member could enumerate attacks for a campaign in a
    // different project by guessing the id. 404 to avoid leaking
    // existence.
    const { projectId } = c.get('scopedUser')!
    if (!campaign || campaign.projectId !== projectId) {
      return dashboardError(c, 404, 'RESOURCE_NOT_FOUND', 'Campaign not found')
    }

    const { showArchived } = c.req.valid('query')
    const campaignAttacks = await listAttacks(campaignId, { showArchived })
    return c.json({ attacks: campaignAttacks }, 200)
  })

  router.openapi(updateAttackRoute, async (c) => {
    const { id: campaignId, attackId } = c.req.valid('param')

    // Project-scope guard: load the parent campaign unconditionally
    // (not just when resource refs change) and reject when it doesn't
    // belong to the caller's active project. The attack-belongs-to-
    // campaign check below is necessary but not sufficient.
    const { projectId } = c.get('scopedUser')!
    const parentCampaign = await getCampaignById(campaignId)
    if (!parentCampaign || parentCampaign.projectId !== projectId) {
      return dashboardError(c, 404, 'RESOURCE_NOT_FOUND', 'Campaign not found')
    }

    const existing = await getAttackById(attackId)
    if (!existing || existing.campaignId !== campaignId) {
      return dashboardError(c, 404, 'RESOURCE_NOT_FOUND', 'Attack not found')
    }

    const data = c.req.valid('json')

    // Cross-project resource pre-check at draft write time. Only fires
    // when a resource ref is actually being changed; the existing row
    // already passed this gate when it was created.
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

    // Single-hash-mode-per-campaign guard (issue #100 R15 / AS1): only
    // fires when `mode` is actually part of the patch — an update that
    // doesn't touch mode cannot introduce a conflict.
    if (data.mode !== undefined) {
      const modeCheck = await checkSingleHashModePerCampaign(campaignId, data.mode, attackId)
      if (!modeCheck.valid) {
        return dashboardError(
          c,
          422,
          'ATTACK_MODE_CONFLICT',
          `Attack mode ${data.mode} conflicts with mode ${modeCheck.conflictingMode} used by another non-terminal attack (id ${modeCheck.conflictingAttackId}) in this campaign; a campaign may only run one hashcat mode at a time`
        )
      }
    }

    // Pre-update DAG validation: only when dependencies are being
    // changed. Other field changes (mode, wordlist, etc.) do not affect
    // the dependency graph, so skipping the load avoids the extra query.
    if (data.dependencies !== undefined) {
      // Include archived attacks — see the create-route comment above.
      const currentAttacks = await listAttacks(campaignId, { showArchived: true })
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

    const { userId } = c.get('scopedUser')!
    const attack = await updateAttack(attackId, data, { actorType: 'user', actorId: userId })

    if (!attack) {
      return dashboardError(c, 404, 'RESOURCE_NOT_FOUND', 'Attack not found')
    }

    return c.json({ attack }, 200)
  })

  router.openapi(deleteAttackRoute, async (c) => {
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

    const existing = await getAttackById(attackId)
    if (!existing || existing.campaignId !== campaignId) {
      return dashboardError(c, 404, 'RESOURCE_NOT_FOUND', 'Attack not found')
    }

    const { userId } = c.get('scopedUser')!
    const result = await deleteAttack(attackId, { actorType: 'user', actorId: userId })

    switch (result.kind) {
      case 'not_found':
        return dashboardError(c, 404, 'RESOURCE_NOT_FOUND', 'Attack not found')
      case 'not_deletable':
        // ADR-0019 / issue #106 U6: an attack that has generated at least
        // one task is permanent — archive-only.
        return dashboardError(
          c,
          409,
          'NOT_DELETABLE',
          'Attack has run and is now permanent; it cannot be deleted, only archived.'
        )
      case 'deleted':
        return c.json({ deleted: true as const }, 200)
    }
  })
}
