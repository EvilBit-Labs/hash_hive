import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import { z } from 'zod';
import { requireSession } from '../../middleware/auth.js';
import { requireProjectAccess, requireRole } from '../../middleware/rbac.js';
import {
  getAgentById,
  getAgentErrors,
  getBenchmarksForAgent,
  listAgents,
  updateAgent,
} from '../../services/agents.js';
import { listTasksByAgent } from '../../services/tasks.js';
import type { AppEnv } from '../../types.js';

const dashboardAgentRoutes = new Hono<AppEnv>();

dashboardAgentRoutes.use('*', requireSession);

const AGENT_LIST_MAX_LIMIT = 200;
const AGENT_LIST_DEFAULT_LIMIT = 50;

function parsePositiveIntParam(raw: string | undefined, max: number, fallback: number): number {
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(Math.floor(parsed), max);
}

function parseOffsetParam(raw: string | undefined): number {
  if (raw === undefined) return 0;
  const parsed = Number(raw);
  // Non-finite and negative values fall back to 0 rather than 400 — matches
  // the limit param's permissive contract and avoids leaking Infinity into
  // Drizzle's .offset() (which the driver may either reject or send as a
  // bogus query depending on version).
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return Math.floor(parsed);
}

// GET /agents — list agents with optional filtering
dashboardAgentRoutes.get('/', requireProjectAccess(), async (c) => {
  const { projectId } = c.get('currentUser');
  const status = c.req.query('status') ?? undefined;
  const limit = parsePositiveIntParam(
    c.req.query('limit'),
    AGENT_LIST_MAX_LIMIT,
    AGENT_LIST_DEFAULT_LIMIT
  );
  const offset = parseOffsetParam(c.req.query('offset'));

  const result = await listAgents({ projectId: projectId ?? undefined, status, limit, offset });
  return c.json(result);
});

// GET /agents/:id -- get agent details
dashboardAgentRoutes.get('/:id', requireProjectAccess(), async (c) => {
  const agentId = Number(c.req.param('id'));
  if (Number.isNaN(agentId) || agentId <= 0) {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid agent ID' } }, 400);
  }
  const { projectId } = c.get('currentUser');
  const agent = await getAgentById(agentId);

  if (!agent || agent.projectId !== projectId) {
    return c.json({ error: { code: 'RESOURCE_NOT_FOUND', message: 'Agent not found' } }, 404);
  }

  return c.json({ agent });
});

// PATCH /agents/:id — update agent
const updateAgentSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  status: z.enum(['online', 'offline', 'busy', 'error']).optional(),
});

dashboardAgentRoutes.patch(
  '/:id',
  requireRole('admin', 'contributor'),
  zValidator('json', updateAgentSchema),
  async (c) => {
    const agentId = Number(c.req.param('id'));
    const data = c.req.valid('json');
    const agent = await updateAgent(agentId, data);

    if (!agent) {
      return c.json({ error: { code: 'RESOURCE_NOT_FOUND', message: 'Agent not found' } }, 404);
    }

    return c.json({ agent });
  }
);

// GET /agents/:id/errors -- get agent errors
dashboardAgentRoutes.get('/:id/errors', requireProjectAccess(), async (c) => {
  const agentId = Number(c.req.param('id'));
  if (Number.isNaN(agentId) || agentId <= 0) {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid agent ID' } }, 400);
  }
  const { projectId } = c.get('currentUser');

  const agent = await getAgentById(agentId);
  if (!agent || agent.projectId !== projectId) {
    return c.json({ error: { code: 'RESOURCE_NOT_FOUND', message: 'Agent not found' } }, 404);
  }

  const limit = c.req.query('limit') ? Number(c.req.query('limit')) : undefined;
  const offset = c.req.query('offset') ? Number(c.req.query('offset')) : undefined;

  const errors = await getAgentErrors(agentId, { limit, offset });
  return c.json({ errors });
});

// GET /agents/:id/tasks -- list active tasks assigned to the agent
dashboardAgentRoutes.get('/:id/tasks', requireProjectAccess(), async (c) => {
  const agentId = Number(c.req.param('id'));
  if (Number.isNaN(agentId) || agentId <= 0) {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid agent ID' } }, 400);
  }
  const { projectId } = c.get('currentUser');

  const agent = await getAgentById(agentId);
  if (!agent || agent.projectId !== projectId) {
    return c.json({ error: { code: 'RESOURCE_NOT_FOUND', message: 'Agent not found' } }, 404);
  }

  const tasks = await listTasksByAgent(agentId);
  return c.json({ tasks });
});

// GET /agents/:id/benchmarks -- get agent benchmarks
dashboardAgentRoutes.get('/:id/benchmarks', requireProjectAccess(), async (c) => {
  const agentId = Number(c.req.param('id'));
  if (Number.isNaN(agentId) || agentId <= 0) {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid agent ID' } }, 400);
  }
  const { projectId } = c.get('currentUser');

  const agent = await getAgentById(agentId);
  if (!agent || agent.projectId !== projectId) {
    return c.json({ error: { code: 'RESOURCE_NOT_FOUND', message: 'Agent not found' } }, 404);
  }

  const benchmarks = await getBenchmarksForAgent(agentId);
  return c.json({ benchmarks });
});

export { dashboardAgentRoutes };
