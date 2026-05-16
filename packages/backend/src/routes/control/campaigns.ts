/**
 * Control API campaign endpoints. Full CRUD + state transitions —
 * automation's primary entry point for orchestrating cracking work.
 *
 * Role gates match the dashboard equivalents: write paths require
 * `contributor` or `admin`; read paths require any project member.
 */

import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import { z } from 'zod';
import { logger } from '../../config/logger.js';
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
import {
  controlErrorResponse,
  controlValidationHook,
  parseIdParam,
  requireProjectMembership,
  requireProjectRole,
} from './helpers.js';

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
const transitionRequestSchema = z.object({ targetStatus: transitionTargetSchema }).strict();

controlCampaignRoutes.get('/', async (c) => {
  try {
    const { projectId } = await requireProjectMembership(c);
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
    const { projectId } = await requireProjectMembership(c);
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

controlCampaignRoutes.post(
  '/',
  zValidator('json', createCampaignSchema, controlValidationHook),
  async (c) => {
    try {
      const { projectId } = await requireProjectRole(c, 'contributor', 'admin');
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
  }
);

controlCampaignRoutes.patch(
  '/:id',
  zValidator('json', updateCampaignSchema, controlValidationHook),
  async (c) => {
    try {
      const { projectId } = await requireProjectRole(c, 'contributor', 'admin');
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
  }
);

controlCampaignRoutes.post(
  '/:id/transition',
  zValidator('json', transitionRequestSchema, controlValidationHook),
  async (c) => {
    try {
      const { projectId } = await requireProjectRole(c, 'contributor', 'admin');
      const id = parseIdParam(c.req.param('id'));
      const existing = await getCampaignById(id);
      if (!existing || existing.projectId !== projectId) {
        return problemResponse(c, 404, 'not_found', 'campaign not found');
      }
      const { targetStatus } = c.req.valid('json');
      const result = await transitionCampaign(id, targetStatus);
      if ('error' in result) {
        // Three branches with distinct retry semantics:
        //   QUEUE_UNAVAILABLE -> 503 transient infra issue, retry later.
        //   TASK_GENERATION_FAILED -> 500 internal error; the state did
        //     not actually transition. Mislabeling this as a 409 conflict
        //     would tell automation "you tried an invalid transition"
        //     and skip retry — wrong, the transition was valid but
        //     something downstream blew up.
        //   Anything else -> 409 state-machine conflict, do not retry.
        if ('code' in result) {
          if (result.code === 'QUEUE_UNAVAILABLE') {
            // Transient infra error — surface a generic "service
            // unavailable" message so we don't leak internal queue text.
            logger.warn(
              { campaignId: id, requestId: c.get('requestId'), error: result.error },
              'campaign transition deferred — queue unavailable'
            );
            return problemResponse(
              c,
              503,
              'service_unavailable',
              'Service temporarily unavailable'
            );
          }
          if (result.code === 'TASK_GENERATION_FAILED') {
            // Internal error — log the full cause server-side, return a
            // generic message so SQL/stack details don't reach the
            // client.
            logger.error(
              { campaignId: id, requestId: c.get('requestId'), error: result.error },
              'task generation failed during campaign transition'
            );
            return problemResponse(c, 500, 'internal', 'An unexpected error occurred');
          }
        }
        return problemResponse(c, 409, 'conflict', result.error);
      }
      return c.json(result);
    } catch (err) {
      return controlErrorResponse(c, err);
    }
  }
);
