/**
 * Control API task endpoints. Listing and inspection only — task lifecycle
 * (assign / report) belongs to the agent API.
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { paginate, paginationQuerySchema } from '../../lib/pagination.js';
import { problemResponse } from '../../lib/problem-details.js';
import { getCampaignById } from '../../services/campaigns.js';
import { getTaskById, listTasks } from '../../services/tasks.js';
import type { AppEnv } from '../../types.js';
import { controlErrorResponse, parseIdParam, requireProjectMembership } from './helpers.js';

export const controlTaskRoutes = new Hono<AppEnv>();

// `campaignId` is REQUIRED — the dashboard tasks service does not
// enforce project scoping by itself, so the caller must name a campaign
// we can verify belongs to the active project. Marking it required at
// the Zod layer means the validation message and the RFC 9457
// problem-details envelope are single-sourced through controlErrorResponse.
const taskFilterSchema = z.object({
  status: z.enum(['pending', 'running', 'completed', 'failed', 'exhausted']).optional(),
  agentId: z.coerce.number().int().positive().optional(),
  campaignId: z.coerce.number().int().positive(),
  attackId: z.coerce.number().int().positive().optional(),
});

controlTaskRoutes.get('/', async (c) => {
  try {
    const { projectId } = await requireProjectMembership(c);
    const params = Object.fromEntries(new URL(c.req.url).searchParams);
    const query = paginationQuerySchema.parse(params);
    const filters = taskFilterSchema.parse(params);

    const campaign = await getCampaignById(filters.campaignId);
    if (!campaign || campaign.projectId !== projectId) {
      return problemResponse(c, 404, 'not_found', 'campaign not found');
    }

    const { tasks, total } = await listTasks({
      ...filters,
      limit: query.limit,
      offset: query.offset,
    });
    return c.json(paginate(tasks, total, query));
  } catch (err) {
    return controlErrorResponse(c, err);
  }
});

controlTaskRoutes.get('/:id', async (c) => {
  try {
    const { projectId } = await requireProjectMembership(c);
    const id = parseIdParam(c.req.param('id'));
    const task = await getTaskById(id);
    if (!task) return problemResponse(c, 404, 'not_found', 'task not found');
    const campaign = await getCampaignById(task.campaignId);
    if (!campaign || campaign.projectId !== projectId) {
      return problemResponse(c, 404, 'not_found', 'task not found');
    }
    return c.json(task);
  } catch (err) {
    return controlErrorResponse(c, err);
  }
});
