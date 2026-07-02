/**
 * Control API attack endpoints. Attacks are owned by a campaign so all
 * routes are scoped via the parent campaign's project.
 */

import {
  attackStatusSchema,
  controlAttackArchiveResponseSchema,
  controlAttackRestoreResponseSchema,
  keyspaceCoordSchema,
  selectAttackSchema,
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
import { deriveAttackRuntimes } from '../../services/attacks/runtime.js'
import {
  archiveAttacks,
  createAttack,
  deleteAttack,
  findReclaimedResourceRefs,
  getAttackById,
  getCampaignById,
  listAttacksPaginated,
  restoreAttacks,
  updateAttack,
} from '../../services/campaigns.js'
import { controlErrorResponse, requireProjectMembership, requireProjectRole } from './helpers.js'

/** The persisted attack fields `deriveAttackRuntimes` needs to derive runtime. */
type AttackWithRuntimeInput = {
  id: number
  campaignId: number
  projectId: number
  mode: number
  keyspace: string | null
}

/**
 * Attach the derived `status` and `estimatedSecondsRemaining` to an attack row.
 * Attack status is never persisted (issue #99); the Control surface derives it
 * through the same shared ladder the dashboard uses so the two cannot drift.
 */
async function withRuntime<T extends AttackWithRuntimeInput>(attack: T) {
  const runtime = await deriveAttackRuntimes([attack])
  const rt = runtime.get(attack.id)
  return {
    ...attack,
    status: rt?.status ?? 'pending',
    estimatedSecondsRemaining: rt?.estimatedSecondsRemaining ?? null,
  }
}

async function withRuntimeMany<T extends AttackWithRuntimeInput>(attackList: T[]) {
  const runtime = await deriveAttackRuntimes(attackList)
  return attackList.map((attack) => {
    const rt = runtime.get(attack.id)
    return {
      ...attack,
      status: rt?.status ?? 'pending',
      estimatedSecondsRemaining: rt?.estimatedSecondsRemaining ?? null,
    }
  })
}

export const controlAttackRoutes = new OpenAPIHono<AppEnv>(controlOpenApiHonoOptions)

const idParamSchema = z.object({
  id: z.coerce.number().int().positive(),
})

const createAttackSchema = z
  .object({
    campaignId: z.number().int().positive(),
    mode: z.number().int().min(0),
    hashTypeId: z.number().int().positive().optional(),
    wordlistId: z.number().int().positive().optional(),
    rulelistId: z.number().int().positive().optional(),
    masklistId: z.number().int().positive().optional(),
    advancedConfiguration: z.record(z.string(), z.unknown()).optional(),
    dependencies: z.array(z.number().int().positive()).optional(),
  })
  .strict()
  .openapi('ControlCreateAttackRequest')

const updateAttackSchema = z
  .object({
    mode: z.number().int().min(0).optional(),
    hashTypeId: z.number().int().positive().optional(),
    wordlistId: z.number().int().positive().optional(),
    rulelistId: z.number().int().positive().optional(),
    masklistId: z.number().int().positive().optional(),
    advancedConfiguration: z.record(z.string(), z.unknown()).optional(),
    dependencies: z.array(z.number().int().positive()).optional(),
  })
  .strict()
  .openapi('ControlUpdateAttackRequest')

// `campaignId` is REQUIRED for the same project-scoping reason as
// /tasks. Declaring it at the schema layer lets
// `controlOpenApiHonoOptions.defaultHook` (openapi/components.ts) emit
// the uniform RFC 9457 problem-details envelope on absence — handlers
// don't need a manual presence check.
// `showArchived` mirrors the dashboard's `?showArchived=true` query param
// naming and permissive coercion (ADR-0019 / issue #106 R10) — only the
// literal "true" enables it, anything else (or absent) is false and
// archived attacks stay excluded from the default listing.
const attackListQuerySchema = paginationQuerySchema.merge(
  z.object({
    campaignId: z.coerce.number().int().positive(),
    showArchived: z
      .string()
      .optional()
      .transform((v) => v === 'true'),
  })
)

// `selectAttackSchema` no longer carries `status` (the dead column was dropped
// in issue #99); re-add it plus the ETA as derived, read-time fields so the
// Control attack surface stays whole.
const attackSchema = selectAttackSchema
  .extend({
    status: attackStatusSchema,
    estimatedSecondsRemaining: keyspaceCoordSchema.nullable(),
  })
  .openapi('ControlAttack')
const attackPageSchema = z
  .object({
    items: z.array(attackSchema),
    total: z.number().int().nonnegative(),
    limit: z.number().int().nonnegative(),
    offset: z.number().int().nonnegative(),
  })
  .openapi('ControlAttackPage')

async function loadAttackInProject(id: number, projectId: number) {
  const attack = await getAttackById(id)
  if (!attack) return null
  const campaign = await getCampaignById(attack.campaignId)
  if (!campaign || campaign.projectId !== projectId) return null
  return attack
}

// ─── GET / — list attacks for a campaign ────────────────────────────

const listAttacksRoute = createRoute({
  method: 'get',
  path: '/',
  tags: ['Attacks'],
  summary: 'List attacks for a campaign (campaignId required)',
  security: [{ ControlApiKey: [] }],
  request: { query: attackListQuerySchema },
  responses: {
    200: {
      description: 'Page of attacks.',
      content: { 'application/json': { schema: attackPageSchema } },
    },
    400: sharedControlResponse(CONTROL_RESPONSE_REFS.ValidationError),
    401: sharedControlResponse(CONTROL_RESPONSE_REFS.AuthError),
    403: sharedControlResponse(CONTROL_RESPONSE_REFS.Forbidden),
    404: sharedControlResponse(CONTROL_RESPONSE_REFS.NotFound),
    500: sharedControlResponse(CONTROL_RESPONSE_REFS.InternalError),
  },
})

controlAttackRoutes.openapi(listAttacksRoute, async (c) => {
  try {
    const { projectId } = await requireProjectMembership(c)
    const query = c.req.valid('query')

    const campaign = await getCampaignById(query.campaignId)
    if (!campaign || campaign.projectId !== projectId) {
      return problemResponse(c, 404, 'not_found', 'campaign not found')
    }
    const { items, total } = await listAttacksPaginated(query.campaignId, {
      limit: query.limit,
      offset: query.offset,
      showArchived: query.showArchived,
    })
    return c.json(paginate(await withRuntimeMany(items), total, query), 200)
  } catch (err) {
    return controlErrorResponse(c, err)
  }
})

// ─── GET /:id — attack details ──────────────────────────────────────

const getAttackRoute = createRoute({
  method: 'get',
  path: '/{id}',
  tags: ['Attacks'],
  summary: 'Get an attack by id (scoped to the active project)',
  security: [{ ControlApiKey: [] }],
  request: { params: idParamSchema },
  responses: {
    200: {
      description: 'Attack details.',
      content: { 'application/json': { schema: attackSchema } },
    },
    400: sharedControlResponse(CONTROL_RESPONSE_REFS.ValidationError),
    401: sharedControlResponse(CONTROL_RESPONSE_REFS.AuthError),
    403: sharedControlResponse(CONTROL_RESPONSE_REFS.Forbidden),
    404: sharedControlResponse(CONTROL_RESPONSE_REFS.NotFound),
    500: sharedControlResponse(CONTROL_RESPONSE_REFS.InternalError),
  },
})

controlAttackRoutes.openapi(getAttackRoute, async (c) => {
  try {
    const { projectId } = await requireProjectMembership(c)
    const { id } = c.req.valid('param')
    const attack = await loadAttackInProject(id, projectId)
    if (!attack) return problemResponse(c, 404, 'not_found', 'attack not found')
    return c.json(await withRuntime(attack), 200)
  } catch (err) {
    return controlErrorResponse(c, err)
  }
})

// ─── POST / — create attack ─────────────────────────────────────────

const createAttackRoute = createRoute({
  method: 'post',
  path: '/',
  tags: ['Attacks'],
  summary: 'Create a new attack on a campaign (contributor or admin only)',
  security: [{ ControlApiKey: [] }],
  request: {
    body: { content: { 'application/json': { schema: createAttackSchema } } },
  },
  responses: {
    201: {
      description: 'Attack created.',
      content: { 'application/json': { schema: attackSchema } },
    },
    400: sharedControlResponse(CONTROL_RESPONSE_REFS.ValidationError),
    401: sharedControlResponse(CONTROL_RESPONSE_REFS.AuthError),
    403: sharedControlResponse(CONTROL_RESPONSE_REFS.Forbidden),
    404: sharedControlResponse(CONTROL_RESPONSE_REFS.NotFound),
    409: sharedControlResponse(CONTROL_RESPONSE_REFS.Conflict),
    500: sharedControlResponse(CONTROL_RESPONSE_REFS.InternalError),
  },
})

controlAttackRoutes.openapi(createAttackRoute, async (c) => {
  try {
    const { projectId } = await requireProjectRole(c, 'contributor', 'admin')
    const data = c.req.valid('json')
    const campaign = await getCampaignById(data.campaignId)
    if (!campaign || campaign.projectId !== projectId) {
      return problemResponse(c, 404, 'not_found', 'campaign not found')
    }
    // Reclaimed-shell / archived guard (issue #106 U12 / R12, F5 code
    // review): the Control surface has no existing pre-check chokepoint
    // (unlike the dashboard's checkResourcesOrErrorResponse), so this is
    // checked directly. A word/rule/mask list swept by the
    // blob-reclamation worker is present but unusable until re-uploaded
    // and checksum-verified; an archived one is hidden from listings and
    // must not silently power new work.
    const { reclaimed, archived } = await findReclaimedResourceRefs(projectId, data)
    if (reclaimed.length > 0) {
      return problemResponse(
        c,
        409,
        'conflict',
        `Referenced resources are reclaimed shells (re-upload required): ${reclaimed.join(', ')}`
      )
    }
    if (archived.length > 0) {
      return problemResponse(
        c,
        409,
        'conflict',
        `Referenced resources are archived: ${archived.join(', ')}`
      )
    }
    const user = c.get('currentUser')
    const attack = await createAttack(
      { ...data, projectId },
      { actorType: 'user', actorId: user.userId }
    )
    if (!attack) throw new Error('attack insert returned no row')
    return c.json(await withRuntime(attack), 201)
  } catch (err) {
    return controlErrorResponse(c, err)
  }
})

// ─── PATCH /:id — update attack ────────────────────────────────────

const updateAttackRoute = createRoute({
  method: 'patch',
  path: '/{id}',
  tags: ['Attacks'],
  summary: 'Update an attack (contributor or admin only)',
  security: [{ ControlApiKey: [] }],
  request: {
    params: idParamSchema,
    body: { content: { 'application/json': { schema: updateAttackSchema } } },
  },
  responses: {
    200: {
      description: 'Updated attack.',
      content: { 'application/json': { schema: attackSchema } },
    },
    400: sharedControlResponse(CONTROL_RESPONSE_REFS.ValidationError),
    401: sharedControlResponse(CONTROL_RESPONSE_REFS.AuthError),
    403: sharedControlResponse(CONTROL_RESPONSE_REFS.Forbidden),
    404: sharedControlResponse(CONTROL_RESPONSE_REFS.NotFound),
    409: sharedControlResponse(CONTROL_RESPONSE_REFS.Conflict),
    500: sharedControlResponse(CONTROL_RESPONSE_REFS.InternalError),
  },
})

controlAttackRoutes.openapi(updateAttackRoute, async (c) => {
  try {
    const { projectId } = await requireProjectRole(c, 'contributor', 'admin')
    const { id } = c.req.valid('param')
    const existing = await loadAttackInProject(id, projectId)
    if (!existing) return problemResponse(c, 404, 'not_found', 'attack not found')
    const body = c.req.valid('json')
    // Reclaimed-shell guard (issue #106 U12 / R12) — only fires when a
    // resource ref is actually being changed, mirroring the dashboard's
    // hasResourceRefChange gate.
    const hasResourceRefChange =
      body.wordlistId !== undefined ||
      body.rulelistId !== undefined ||
      body.masklistId !== undefined
    if (hasResourceRefChange) {
      const { reclaimed, archived } = await findReclaimedResourceRefs(projectId, body)
      if (reclaimed.length > 0) {
        return problemResponse(
          c,
          409,
          'conflict',
          `Referenced resources are reclaimed shells (re-upload required): ${reclaimed.join(', ')}`
        )
      }
      if (archived.length > 0) {
        return problemResponse(
          c,
          409,
          'conflict',
          `Referenced resources are archived: ${archived.join(', ')}`
        )
      }
    }
    const user = c.get('currentUser')
    const updated = await updateAttack(id, body, {
      actorType: 'user',
      actorId: user.userId,
    })
    if (!updated) return problemResponse(c, 404, 'not_found', 'attack not found')
    return c.json(await withRuntime(updated), 200)
  } catch (err) {
    return controlErrorResponse(c, err)
  }
})

// ─── DELETE /:id — delete attack ────────────────────────────────────

const deleteAttackRoute = createRoute({
  method: 'delete',
  path: '/{id}',
  tags: ['Attacks'],
  summary: 'Delete an attack (contributor or admin only)',
  security: [{ ControlApiKey: [] }],
  request: { params: idParamSchema },
  responses: {
    204: { description: 'Attack deleted.' },
    400: sharedControlResponse(CONTROL_RESPONSE_REFS.ValidationError),
    401: sharedControlResponse(CONTROL_RESPONSE_REFS.AuthError),
    403: sharedControlResponse(CONTROL_RESPONSE_REFS.Forbidden),
    404: sharedControlResponse(CONTROL_RESPONSE_REFS.NotFound),
    422: sharedControlResponse(CONTROL_RESPONSE_REFS.UnprocessableEntity),
    500: sharedControlResponse(CONTROL_RESPONSE_REFS.InternalError),
  },
})

controlAttackRoutes.openapi(deleteAttackRoute, async (c) => {
  try {
    const { projectId } = await requireProjectRole(c, 'contributor', 'admin')
    const { id } = c.req.valid('param')
    const existing = await loadAttackInProject(id, projectId)
    if (!existing) return problemResponse(c, 404, 'not_found', 'attack not found')
    const user = c.get('currentUser')
    // deleteAttack returns a typed result (issue #106 U6) — a permanent
    // (run) attack is archive-only. See the archive/restore routes below
    // (issue #106 U10) for the actual archive-only path.
    const result = await deleteAttack(id, { actorType: 'user', actorId: user.userId })
    switch (result.kind) {
      case 'not_found':
        return problemResponse(c, 404, 'not_found', 'attack not found')
      case 'not_deletable':
        return problemResponse(
          c,
          422,
          'not_deletable',
          'attack has run and is now permanent; it cannot be deleted, only archived'
        )
      case 'deleted':
        return c.body(null, 204)
    }
  } catch (err) {
    return controlErrorResponse(c, err)
  }
})

// ─── POST /:id/archive, /:id/restore — attack lifecycle (issue #106 U10) ─
//
// Control API parity for the dashboard's bulk `POST /attacks/archive`
// and `/restore` (issue #106 U7). Single-resource per the Control
// surface's existing per-resource style — the underlying service
// (`archiveAttacks`/`restoreAttacks`, U6) is bulk-`ids`-shaped, so these
// handlers call it with a one-element array and unwrap the sole result.
//
// Outcome → HTTP status (documented here once; hash-list/resource and
// agent-retire routes follow the same convention):
//   - archived / restored       → 200, body carries `{ id, outcome }`.
//   - not_found                 → 404 `not_found`.
//   - already_archived,
//     not_archivable,
//     in_use, not_archived,
//     resource_reclaimed        → 409 `conflict` — the record's CURRENT
//                                  state blocks the action but the
//                                  state can change (e.g. a task-less
//                                  attack becomes archivable once it
//                                  latches permanent). This is
//                                  deliberately distinct from the 422
//                                  `not_deletable` the DELETE route
//                                  above uses: 422 means the action can
//                                  NEVER succeed for this record (it's
//                                  permanent), 409 means it can't
//                                  succeed RIGHT NOW.
//   - error                     → 500 `internal` (a per-id service
//                                  failure, e.g. a DB error).

const archiveAttackRoute = createRoute({
  method: 'post',
  path: '/{id}/archive',
  tags: ['Attacks'],
  summary: 'Archive a permanent attack (contributor or admin only)',
  security: [{ ControlApiKey: [] }],
  request: { params: idParamSchema },
  responses: {
    200: {
      description: 'Archive outcome.',
      content: { 'application/json': { schema: controlAttackArchiveResponseSchema } },
    },
    400: sharedControlResponse(CONTROL_RESPONSE_REFS.ValidationError),
    401: sharedControlResponse(CONTROL_RESPONSE_REFS.AuthError),
    403: sharedControlResponse(CONTROL_RESPONSE_REFS.Forbidden),
    404: sharedControlResponse(CONTROL_RESPONSE_REFS.NotFound),
    409: sharedControlResponse(CONTROL_RESPONSE_REFS.Conflict),
    500: sharedControlResponse(CONTROL_RESPONSE_REFS.InternalError),
  },
})

controlAttackRoutes.openapi(archiveAttackRoute, async (c) => {
  try {
    const { projectId } = await requireProjectRole(c, 'contributor', 'admin')
    const { id } = c.req.valid('param')
    const user = c.get('currentUser')
    const [result] = await archiveAttacks(projectId, [id], {
      actorType: 'user',
      actorId: user.userId,
    })
    if (!result) throw new Error('archiveAttacks returned no result for a single id')
    switch (result.outcome) {
      case 'not_found':
        return problemResponse(c, 404, 'not_found', 'attack not found')
      case 'already_archived':
        return problemResponse(c, 409, 'conflict', 'attack is already archived')
      case 'not_archivable':
        return problemResponse(
          c,
          409,
          'conflict',
          'attack has never generated a task and is not yet permanent; delete it instead'
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

const restoreAttackRoute = createRoute({
  method: 'post',
  path: '/{id}/restore',
  tags: ['Attacks'],
  summary: 'Restore an archived attack (contributor or admin only)',
  security: [{ ControlApiKey: [] }],
  request: { params: idParamSchema },
  responses: {
    200: {
      description: 'Restore outcome.',
      content: { 'application/json': { schema: controlAttackRestoreResponseSchema } },
    },
    400: sharedControlResponse(CONTROL_RESPONSE_REFS.ValidationError),
    401: sharedControlResponse(CONTROL_RESPONSE_REFS.AuthError),
    403: sharedControlResponse(CONTROL_RESPONSE_REFS.Forbidden),
    404: sharedControlResponse(CONTROL_RESPONSE_REFS.NotFound),
    409: sharedControlResponse(CONTROL_RESPONSE_REFS.Conflict),
    500: sharedControlResponse(CONTROL_RESPONSE_REFS.InternalError),
  },
})

controlAttackRoutes.openapi(restoreAttackRoute, async (c) => {
  try {
    const { projectId } = await requireProjectRole(c, 'contributor', 'admin')
    const { id } = c.req.valid('param')
    const user = c.get('currentUser')
    const [result] = await restoreAttacks(projectId, [id], {
      actorType: 'user',
      actorId: user.userId,
    })
    if (!result) throw new Error('restoreAttacks returned no result for a single id')
    switch (result.outcome) {
      case 'not_found':
        return problemResponse(c, 404, 'not_found', 'attack not found')
      case 'not_archived':
        return problemResponse(c, 409, 'conflict', 'attack is not archived')
      case 'resource_reclaimed':
        return problemResponse(
          c,
          409,
          'conflict',
          'attack references a reclaimed-shell resource; re-upload the resource before restoring'
        )
      case 'error':
        return problemResponse(c, 500, 'internal', 'restore failed')
      case 'restored':
        return c.json({ id: result.id, outcome: result.outcome }, 200)
    }
  } catch (err) {
    return controlErrorResponse(c, err)
  }
})
