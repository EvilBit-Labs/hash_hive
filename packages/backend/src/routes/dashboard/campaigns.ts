import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import { z } from 'zod';
import { logger } from '../../config/logger.js';
import { requireSession } from '../../middleware/auth.js';
import { requireProjectAccess, requireRole } from '../../middleware/rbac.js';
import {
  createAttack,
  createCampaign,
  deleteAttack,
  deleteCampaign,
  getAttackById,
  getCampaignById,
  getCampaignTaskStats,
  listActiveAgentsByCampaign,
  listAttacks,
  listCampaigns,
  transitionCampaign,
  updateAttack,
  updateCampaign,
  validateCampaignDAG,
} from '../../services/campaigns.js';
import type { AppEnv } from '../../types.js';

const campaignRoutes = new Hono<AppEnv>();

campaignRoutes.use('*', requireSession);

// ─── Campaign CRUD ──────────────────────────────────────────────────

const listCampaignsQuerySchema = z.object({
  status: z.string().optional(),
  priority: z.coerce
    .number()
    .int()
    .refine((v) => v === 1 || v === 5 || v === 10, {
      message: 'priority must be one of 1, 5, 10',
    })
    .optional(),
  sort: z.enum(['name', 'createdAt', 'priority']).optional(),
  order: z.enum(['asc', 'desc']).optional(),
  limit: z.coerce.number().int().positive().max(500).optional(),
  offset: z.coerce.number().int().nonnegative().optional(),
});

campaignRoutes.get(
  '/',
  requireProjectAccess(),
  zValidator('query', listCampaignsQuerySchema, (result, c) => {
    if (result.success) return;
    return c.json(
      {
        error: {
          code: 'VALIDATION_ERROR',
          message: result.error.issues.map((i) => i.message).join('; '),
        },
      },
      400
    );
  }),
  async (c) => {
    const { projectId } = c.get('currentUser');
    const { status, priority, sort, order, limit, offset } = c.req.valid('query');

    const result = await listCampaigns({
      projectId: projectId ?? undefined,
      status,
      priority,
      sort,
      order,
      limit,
      offset,
    });
    return c.json(result);
  }
);

const createCampaignSchema = z.object({
  name: z.string().min(1).max(255),
  description: z.string().max(2000).optional(),
  hashListId: z.number().int().positive(),
  priority: z.number().int().min(1).max(10).optional(),
});

campaignRoutes.post(
  '/',
  requireRole('admin', 'contributor'),
  zValidator('json', createCampaignSchema),
  async (c) => {
    const data = c.req.valid('json');
    const { userId, projectId } = c.get('currentUser');
    if (!projectId) {
      return c.json(
        { error: { code: 'PROJECT_NOT_SELECTED', message: 'No project selected' } },
        400
      );
    }
    const campaign = await createCampaign({ ...data, projectId, createdBy: userId });
    return c.json({ campaign }, 201);
  }
);

campaignRoutes.get('/:id', requireProjectAccess(), async (c) => {
  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id) || id <= 0) {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid campaign id' } }, 400);
  }

  const { projectId } = c.get('currentUser');
  const campaign = await getCampaignById(id);

  if (!campaign || (projectId !== undefined && campaign.projectId !== projectId)) {
    return c.json({ error: { code: 'RESOURCE_NOT_FOUND', message: 'Campaign not found' } }, 404);
  }

  const [campaignAttacks, taskStats, activeAgents] = await Promise.all([
    listAttacks(id),
    getCampaignTaskStats(id),
    listActiveAgentsByCampaign(id),
  ]);

  return c.json({
    campaign,
    attacks: campaignAttacks,
    taskStats,
    activeAgents,
  });
});

campaignRoutes.delete('/:id', requireRole('admin', 'contributor'), async (c) => {
  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id) || id <= 0) {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid campaign id' } }, 400);
  }

  const { userId, projectId } = c.get('currentUser');
  const existing = await getCampaignById(id);

  if (!existing || (projectId !== undefined && existing.projectId !== projectId)) {
    return c.json({ error: { code: 'RESOURCE_NOT_FOUND', message: 'Campaign not found' } }, 404);
  }

  let result: Awaited<ReturnType<typeof deleteCampaign>>;
  try {
    result = await deleteCampaign(id);
  } catch (err) {
    // deleteCampaign runs a multi-statement transaction. Unexpected
    // failures (FK from a future child table, DB connectivity drop,
    // deadlock) bubble here as a thrown error rather than the
    // discriminated `kind` union. Surface them with context so the
    // destructive-operation audit trail is never empty.
    logger.error({ err, campaignId: id, projectId, userId }, 'deleteCampaign transaction failed');
    return c.json(
      {
        error: {
          code: 'DELETE_FAILED',
          message: 'Campaign deletion failed unexpectedly. Check server logs for details.',
        },
      },
      500
    );
  }

  switch (result.kind) {
    case 'not_found':
      return c.json({ error: { code: 'RESOURCE_NOT_FOUND', message: 'Campaign not found' } }, 404);
    case 'not_draft':
      return c.json(
        {
          error: {
            code: 'NOT_DRAFT',
            message: `Campaign cannot be deleted in status "${result.status}". Only draft campaigns are deletable.`,
          },
        },
        409
      );
    case 'deleted':
      return c.json({ deleted: true, id: result.id });
  }
});

const updateCampaignSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  description: z.string().max(2000).optional(),
  priority: z.number().int().min(1).max(10).optional(),
});

campaignRoutes.patch(
  '/:id',
  requireRole('admin', 'contributor'),
  zValidator('json', updateCampaignSchema),
  async (c) => {
    const id = Number(c.req.param('id'));
    const data = c.req.valid('json');
    const campaign = await updateCampaign(id, data);

    if (!campaign) {
      return c.json({ error: { code: 'RESOURCE_NOT_FOUND', message: 'Campaign not found' } }, 404);
    }

    return c.json({ campaign });
  }
);

// ─── Campaign Lifecycle ─────────────────────────────────────────────

const lifecycleSchema = z.object({
  action: z.enum(['start', 'pause', 'stop', 'cancel']),
});

campaignRoutes.post(
  '/:id/lifecycle',
  requireRole('admin', 'contributor'),
  zValidator('json', lifecycleSchema),
  async (c) => {
    const id = Number(c.req.param('id'));
    const { action } = c.req.valid('json');

    const statusMap = {
      start: 'running',
      pause: 'paused',
      stop: 'draft',
      cancel: 'cancelled',
    } as const;

    const targetStatus = statusMap[action];
    const result = await transitionCampaign(id, targetStatus);

    if ('error' in result) {
      if ('code' in result && result.code === 'QUEUE_UNAVAILABLE') {
        return c.json({ error: { code: 'SERVICE_UNAVAILABLE', message: result.error } }, 503);
      }
      return c.json({ error: { code: 'INVALID_TRANSITION', message: result.error } }, 400);
    }

    return c.json({ campaign: result.campaign });
  }
);

// ─── DAG Validation ─────────────────────────────────────────────────

campaignRoutes.get('/:id/validate', requireProjectAccess(), async (c) => {
  const id = Number(c.req.param('id'));
  const campaign = await getCampaignById(id);

  if (!campaign) {
    return c.json({ error: { code: 'RESOURCE_NOT_FOUND', message: 'Campaign not found' } }, 404);
  }

  const result = await validateCampaignDAG(id);
  return c.json(result);
});

// ─── Attack Management ──────────────────────────────────────────────

const createAttackSchema = z.object({
  mode: z.number().int().nonnegative(),
  hashTypeId: z.number().int().positive().optional(),
  wordlistId: z.number().int().positive().optional(),
  rulelistId: z.number().int().positive().optional(),
  masklistId: z.number().int().positive().optional(),
  advancedConfiguration: z.record(z.string(), z.unknown()).optional(),
  dependencies: z.array(z.number().int().positive()).optional(),
});

campaignRoutes.post(
  '/:id/attacks',
  requireRole('admin', 'contributor'),
  zValidator('json', createAttackSchema),
  async (c) => {
    const campaignId = Number(c.req.param('id'));
    const campaign = await getCampaignById(campaignId);

    if (!campaign) {
      return c.json({ error: { code: 'RESOURCE_NOT_FOUND', message: 'Campaign not found' } }, 404);
    }

    const data = c.req.valid('json');
    const attack = await createAttack({
      ...data,
      campaignId,
      projectId: campaign.projectId,
    });

    return c.json({ attack }, 201);
  }
);

campaignRoutes.get('/:id/attacks', requireProjectAccess(), async (c) => {
  const campaignId = Number(c.req.param('id'));
  const campaign = await getCampaignById(campaignId);

  if (!campaign) {
    return c.json({ error: { code: 'RESOURCE_NOT_FOUND', message: 'Campaign not found' } }, 404);
  }

  const campaignAttacks = await listAttacks(campaignId);
  return c.json({ attacks: campaignAttacks });
});

const updateAttackSchema = z.object({
  mode: z.number().int().nonnegative().optional(),
  hashTypeId: z.number().int().positive().optional(),
  wordlistId: z.number().int().positive().optional(),
  rulelistId: z.number().int().positive().optional(),
  masklistId: z.number().int().positive().optional(),
  advancedConfiguration: z.record(z.string(), z.unknown()).optional(),
  dependencies: z.array(z.number().int().positive()).optional(),
});

campaignRoutes.patch(
  '/:id/attacks/:attackId',
  requireRole('admin', 'contributor'),
  zValidator('json', updateAttackSchema),
  async (c) => {
    const campaignId = Number(c.req.param('id'));
    const attackId = Number(c.req.param('attackId'));

    // Verify attack belongs to the specified campaign
    const existing = await getAttackById(attackId);
    if (!existing || existing.campaignId !== campaignId) {
      return c.json({ error: { code: 'RESOURCE_NOT_FOUND', message: 'Attack not found' } }, 404);
    }

    const data = c.req.valid('json');
    const attack = await updateAttack(attackId, data);

    if (!attack) {
      return c.json({ error: { code: 'RESOURCE_NOT_FOUND', message: 'Attack not found' } }, 404);
    }

    return c.json({ attack });
  }
);

campaignRoutes.delete('/:id/attacks/:attackId', requireRole('admin', 'contributor'), async (c) => {
  const campaignId = Number(c.req.param('id'));
  const attackId = Number(c.req.param('attackId'));

  // Verify attack belongs to the specified campaign
  const existing = await getAttackById(attackId);
  if (!existing || existing.campaignId !== campaignId) {
    return c.json({ error: { code: 'RESOURCE_NOT_FOUND', message: 'Attack not found' } }, 404);
  }

  const attack = await deleteAttack(attackId);

  if (!attack) {
    return c.json({ error: { code: 'RESOURCE_NOT_FOUND', message: 'Attack not found' } }, 404);
  }

  return c.json({ deleted: true });
});

export { campaignRoutes };
