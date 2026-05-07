/**
 * Control API agent endpoints. Listing and admin-style updates; the
 * runtime-control surface (heartbeats, task assignment) stays on the
 * agent API and is not duplicated here.
 */

import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import { z } from 'zod';
import { paginate, paginationQuerySchema } from '../../lib/pagination.js';
import { problemResponse } from '../../lib/problem-details.js';
import { getAgentById, listAgents, updateAgent } from '../../services/agents.js';
import type { AppEnv } from '../../types.js';
import {
  controlErrorResponse,
  controlValidationHook,
  parseIdParam,
  requireProjectMembership,
  requireProjectRole,
} from './helpers.js';

export const controlAgentRoutes = new Hono<AppEnv>();

const agentStatusFilter = z.enum(['online', 'offline', 'busy', 'error', 'benchmarked']).optional();

const updateAgentSchema = z
  .object({
    name: z.string().min(1).max(255).optional(),
    status: z.enum(['online', 'offline', 'busy', 'error']).optional(),
  })
  .strict();

controlAgentRoutes.get('/', async (c) => {
  try {
    const { projectId } = await requireProjectMembership(c);
    const params = Object.fromEntries(new URL(c.req.url).searchParams);
    const query = paginationQuerySchema.parse(params);
    const status = agentStatusFilter.parse(params['status']);

    const { agents, total } = await listAgents({
      projectId,
      status,
      limit: query.limit,
      offset: query.offset,
    });
    return c.json(paginate(agents, total, query));
  } catch (err) {
    return controlErrorResponse(c, err);
  }
});

controlAgentRoutes.get('/:id', async (c) => {
  try {
    const { projectId } = await requireProjectMembership(c);
    const id = parseIdParam(c.req.param('id'));
    const agent = await getAgentById(id);
    if (!agent || agent.projectId !== projectId) {
      return problemResponse(c, 404, 'not_found', 'agent not found');
    }
    return c.json(agent);
  } catch (err) {
    return controlErrorResponse(c, err);
  }
});

controlAgentRoutes.patch(
  '/:id',
  zValidator('json', updateAgentSchema, controlValidationHook),
  async (c) => {
    try {
      const { projectId } = await requireProjectRole(c, 'admin');
      const id = parseIdParam(c.req.param('id'));

      const agent = await getAgentById(id);
      if (!agent || agent.projectId !== projectId) {
        return problemResponse(c, 404, 'not_found', 'agent not found');
      }

      const updated = await updateAgent(id, c.req.valid('json'));
      return c.json(updated);
    } catch (err) {
      return controlErrorResponse(c, err);
    }
  }
);
