/**
 * Control API attack endpoints. Attacks are owned by a campaign so all
 * routes are scoped via the parent campaign's project.
 */

import { zValidator } from '@hono/zod-validator'
import { Hono } from 'hono'
import { z } from 'zod'

import type { AppEnv } from '../../types.js'

import { paginate, paginationQuerySchema } from '../../lib/pagination.js'
import { problemResponse } from '../../lib/problem-details.js'
import {
  createAttack,
  deleteAttack,
  getAttackById,
  getCampaignById,
  listAttacksPaginated,
  updateAttack,
} from '../../services/campaigns.js'
import {
  controlErrorResponse,
  controlValidationHook,
  parseIdParam,
  requireProjectMembership,
  requireProjectRole,
} from './helpers.js'

export const controlAttackRoutes = new Hono<AppEnv>()

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

async function loadAttackInProject(id: number, projectId: number) {
  const attack = await getAttackById(id)
  if (!attack) return null
  const campaign = await getCampaignById(attack.campaignId)
  if (!campaign || campaign.projectId !== projectId) return null
  return attack
}

// `campaignId` is REQUIRED for the same project-scoping reason as
// /tasks. Validating at the Zod layer single-sources the validation
// envelope through controlErrorResponse.
const attackListQuerySchema = z.object({
  campaignId: z.coerce.number().int().positive(),
})

controlAttackRoutes.get('/', async (c) => {
  try {
    const { projectId } = await requireProjectMembership(c)
    const params = Object.fromEntries(new URL(c.req.url).searchParams)
    const query = paginationQuerySchema.parse(params)
    const { campaignId } = attackListQuerySchema.parse(params)

    const campaign = await getCampaignById(campaignId)
    if (!campaign || campaign.projectId !== projectId) {
      return problemResponse(c, 404, 'not_found', 'campaign not found')
    }
    const { items, total } = await listAttacksPaginated(campaignId, {
      limit: query.limit,
      offset: query.offset,
    })
    return c.json(paginate(items, total, query))
  } catch (err) {
    return controlErrorResponse(c, err)
  }
})

controlAttackRoutes.get('/:id', async (c) => {
  try {
    const { projectId } = await requireProjectMembership(c)
    const id = parseIdParam(c.req.param('id'))
    const attack = await loadAttackInProject(id, projectId)
    if (!attack) return problemResponse(c, 404, 'not_found', 'attack not found')
    return c.json(attack)
  } catch (err) {
    return controlErrorResponse(c, err)
  }
})

controlAttackRoutes.post(
  '/',
  zValidator('json', createAttackSchema, controlValidationHook),
  async (c) => {
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
  }
)

controlAttackRoutes.patch(
  '/:id',
  zValidator('json', updateAttackSchema, controlValidationHook),
  async (c) => {
    try {
      const { projectId } = await requireProjectRole(c, 'contributor', 'admin')
      const id = parseIdParam(c.req.param('id'))
      const existing = await loadAttackInProject(id, projectId)
      if (!existing) return problemResponse(c, 404, 'not_found', 'attack not found')
      const updated = await updateAttack(id, c.req.valid('json'))
      if (!updated) return problemResponse(c, 404, 'not_found', 'attack not found')
      return c.json(updated)
    } catch (err) {
      return controlErrorResponse(c, err)
    }
  }
)

controlAttackRoutes.delete('/:id', async (c) => {
  try {
    const { projectId } = await requireProjectRole(c, 'contributor', 'admin')
    const id = parseIdParam(c.req.param('id'))
    const existing = await loadAttackInProject(id, projectId)
    if (!existing) return problemResponse(c, 404, 'not_found', 'attack not found')
    await deleteAttack(id)
    return new Response(null, { status: 204 })
  } catch (err) {
    return controlErrorResponse(c, err)
  }
})
