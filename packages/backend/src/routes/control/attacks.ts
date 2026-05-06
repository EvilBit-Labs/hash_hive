/**
 * Control API attack endpoints. Attacks are owned by a campaign so all
 * routes are scoped via the parent campaign's project.
 */

import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import { z } from 'zod';
import { problemResponse } from '../../lib/problem-details.js';
import {
  createAttack,
  deleteAttack,
  getAttackById,
  getCampaignById,
  listAttacks,
  updateAttack,
} from '../../services/campaigns.js';
import type { AppEnv } from '../../types.js';
import {
  controlErrorResponse,
  parseIdParam,
  requireProjectMembership,
  requireProjectRole,
} from './helpers.js';

export const controlAttackRoutes = new Hono<AppEnv>();

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
  .strict();

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
  .strict();

async function loadAttackInProject(id: number, projectId: number) {
  const attack = await getAttackById(id);
  if (!attack) return null;
  const campaign = await getCampaignById(attack.campaignId);
  if (!campaign || campaign.projectId !== projectId) return null;
  return attack;
}

controlAttackRoutes.get('/', async (c) => {
  try {
    const { projectId } = await requireProjectMembership(c);
    const campaignIdRaw = c.req.query('campaignId');
    if (!campaignIdRaw) {
      return problemResponse(c, 400, 'validation', 'campaignId query parameter is required');
    }
    const campaignId = Number(campaignIdRaw);
    if (!Number.isInteger(campaignId) || campaignId <= 0) {
      return problemResponse(c, 400, 'validation', 'campaignId must be a positive integer');
    }
    const campaign = await getCampaignById(campaignId);
    if (!campaign || campaign.projectId !== projectId) {
      return problemResponse(c, 404, 'not_found', 'campaign not found');
    }
    const items = await listAttacks(campaignId);
    return c.json({ items, total: items.length });
  } catch (err) {
    return controlErrorResponse(c, err);
  }
});

controlAttackRoutes.get('/:id', async (c) => {
  try {
    const { projectId } = await requireProjectMembership(c);
    const id = parseIdParam(c.req.param('id'));
    const attack = await loadAttackInProject(id, projectId);
    if (!attack) return problemResponse(c, 404, 'not_found', 'attack not found');
    return c.json(attack);
  } catch (err) {
    return controlErrorResponse(c, err);
  }
});

controlAttackRoutes.post('/', zValidator('json', createAttackSchema), async (c) => {
  try {
    const { projectId } = await requireProjectRole(c, 'contributor', 'admin');
    const data = c.req.valid('json');
    const campaign = await getCampaignById(data.campaignId);
    if (!campaign || campaign.projectId !== projectId) {
      return problemResponse(c, 404, 'not_found', 'campaign not found');
    }
    const attack = await createAttack({ ...data, projectId });
    return c.json(attack, 201);
  } catch (err) {
    return controlErrorResponse(c, err);
  }
});

controlAttackRoutes.patch('/:id', zValidator('json', updateAttackSchema), async (c) => {
  try {
    const { projectId } = await requireProjectRole(c, 'contributor', 'admin');
    const id = parseIdParam(c.req.param('id'));
    const existing = await loadAttackInProject(id, projectId);
    if (!existing) return problemResponse(c, 404, 'not_found', 'attack not found');
    const updated = await updateAttack(id, c.req.valid('json'));
    if (!updated) return problemResponse(c, 404, 'not_found', 'attack not found');
    return c.json(updated);
  } catch (err) {
    return controlErrorResponse(c, err);
  }
});

controlAttackRoutes.delete('/:id', async (c) => {
  try {
    const { projectId } = await requireProjectRole(c, 'contributor', 'admin');
    const id = parseIdParam(c.req.param('id'));
    const existing = await loadAttackInProject(id, projectId);
    if (!existing) return problemResponse(c, 404, 'not_found', 'attack not found');
    await deleteAttack(id);
    return new Response(null, { status: 204 });
  } catch (err) {
    return controlErrorResponse(c, err);
  }
});
