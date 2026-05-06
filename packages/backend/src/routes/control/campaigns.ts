/**
 * Control API campaign endpoints. Full CRUD + state transitions —
 * automation's primary entry point for orchestrating cracking work.
 */

import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import { z } from 'zod';
import { paginate, paginationQuerySchema } from '../../lib/pagination.js';
import { problemResponse } from '../../lib/problem-details.js';
import {
  createCampaign,
  getCampaignById,
  listCampaigns,
  transitionCampaign,
  updateCampaign,
} from '../../services/campaigns.js';
import type { AppEnv } from '../../types.js';
import { controlErrorResponse, parseIdParam, requireProjectId } from './_shared.js';

export const controlCampaignRoutes = new Hono<AppEnv>();

const campaignFilterSchema = z.object({
  status: z.enum(['draft', 'running', 'paused', 'completed', 'cancelled']).optional(),
});

const createCampaignSchema = z
  .object({
    name: z.string().min(1).max(255),
    description: z.string().max(2000).optional(),
    hashListId: z.number().int().positive(),
    priority: z.number().int().min(0).max(10).optional(),
  })
  .strict();

const updateCampaignSchema = z
  .object({
    name: z.string().min(1).max(255).optional(),
    description: z.string().max(2000).optional(),
    priority: z.number().int().min(0).max(10).optional(),
  })
  .strict();

const transitionTargetSchema = z.enum(['draft', 'running', 'paused', 'completed', 'cancelled']);

controlCampaignRoutes.get('/', async (c) => {
  try {
    const projectId = requireProjectId(c);
    const params = Object.fromEntries(new URL(c.req.url).searchParams);
    const query = paginationQuerySchema.parse(params);
    const filters = campaignFilterSchema.parse(params);

    const { campaigns, total } = await listCampaigns({
      projectId,
      status: filters.status,
      limit: query.limit,
      offset: query.offset,
    });
    return c.json(paginate(campaigns, total, query));
  } catch (err) {
    return controlErrorResponse(c, err);
  }
});

controlCampaignRoutes.get('/:id', async (c) => {
  try {
    const projectId = requireProjectId(c);
    const id = parseIdParam(c.req.param('id'));
    const campaign = await getCampaignById(id);
    if (!campaign || campaign.projectId !== projectId) {
      return problemResponse(c, 404, 'not_found', 'campaign not found');
    }
    return c.json(campaign);
  } catch (err) {
    return controlErrorResponse(c, err);
  }
});

controlCampaignRoutes.post('/', zValidator('json', createCampaignSchema), async (c) => {
  try {
    const projectId = requireProjectId(c);
    const user = c.get('currentUser');
    const data = c.req.valid('json');
    const campaign = await createCampaign({
      projectId,
      createdBy: user.userId,
      ...data,
    });
    return c.json(campaign, 201);
  } catch (err) {
    return controlErrorResponse(c, err);
  }
});

controlCampaignRoutes.patch('/:id', zValidator('json', updateCampaignSchema), async (c) => {
  try {
    const projectId = requireProjectId(c);
    const id = parseIdParam(c.req.param('id'));
    const existing = await getCampaignById(id);
    if (!existing || existing.projectId !== projectId) {
      return problemResponse(c, 404, 'not_found', 'campaign not found');
    }
    const updated = await updateCampaign(id, c.req.valid('json'));
    return c.json(updated);
  } catch (err) {
    return controlErrorResponse(c, err);
  }
});

controlCampaignRoutes.post('/:id/transition', async (c) => {
  try {
    const projectId = requireProjectId(c);
    const id = parseIdParam(c.req.param('id'));
    const existing = await getCampaignById(id);
    if (!existing || existing.projectId !== projectId) {
      return problemResponse(c, 404, 'not_found', 'campaign not found');
    }
    const body = await c.req.json().catch(() => ({}));
    const parsed = transitionTargetSchema.safeParse(body.targetStatus);
    if (!parsed.success) {
      return problemResponse(
        c,
        400,
        'validation',
        'targetStatus must be one of: draft, running, paused, completed, cancelled'
      );
    }
    const result = await transitionCampaign(id, parsed.data);
    if ('error' in result) {
      return problemResponse(c, 409, 'conflict', result.error);
    }
    return c.json(result);
  } catch (err) {
    return controlErrorResponse(c, err);
  }
});
