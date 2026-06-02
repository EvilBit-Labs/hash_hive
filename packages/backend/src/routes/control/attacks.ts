/**
 * Control API attack endpoints. Attacks are owned by a campaign so all
 * routes are scoped via the parent campaign's project.
 */

import { selectAttackSchema } from '@hashhive/shared'
import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi'

import type { AppEnv } from '../../types.js'

import { paginate, paginationQuerySchema } from '../../lib/pagination.js'
import { problemResponse } from '../../lib/problem-details.js'
import {
  CONTROL_RESPONSE_REFS,
  controlOpenApiHonoOptions,
  sharedControlResponse,
} from '../../openapi/components.js'
import {
  createAttack,
  deleteAttack,
  getAttackById,
  getCampaignById,
  listAttacksPaginated,
  updateAttack,
} from '../../services/campaigns.js'
import { controlErrorResponse, requireProjectMembership, requireProjectRole } from './helpers.js'

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
const attackListQuerySchema = paginationQuerySchema.merge(
  z.object({ campaignId: z.coerce.number().int().positive() })
)

const attackSchema = selectAttackSchema.openapi('ControlAttack')
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
    })
    return c.json(paginate(items, total, query), 200)
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
    return c.json(attack, 200)
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
    const attack = await createAttack({ ...data, projectId })
    return c.json(attack, 201)
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
    500: sharedControlResponse(CONTROL_RESPONSE_REFS.InternalError),
  },
})

controlAttackRoutes.openapi(updateAttackRoute, async (c) => {
  try {
    const { projectId } = await requireProjectRole(c, 'contributor', 'admin')
    const { id } = c.req.valid('param')
    const existing = await loadAttackInProject(id, projectId)
    if (!existing) return problemResponse(c, 404, 'not_found', 'attack not found')
    const updated = await updateAttack(id, c.req.valid('json'))
    if (!updated) return problemResponse(c, 404, 'not_found', 'attack not found')
    return c.json(updated, 200)
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
    500: sharedControlResponse(CONTROL_RESPONSE_REFS.InternalError),
  },
})

controlAttackRoutes.openapi(deleteAttackRoute, async (c) => {
  try {
    const { projectId } = await requireProjectRole(c, 'contributor', 'admin')
    const { id } = c.req.valid('param')
    const existing = await loadAttackInProject(id, projectId)
    if (!existing) return problemResponse(c, 404, 'not_found', 'attack not found')
    await deleteAttack(id)
    return c.body(null, 204)
  } catch (err) {
    return controlErrorResponse(c, err)
  }
})
