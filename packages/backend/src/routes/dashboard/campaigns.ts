import { zValidator } from '@hono/zod-validator';
import { type Context, Hono } from 'hono';
import { z } from 'zod';
import { logger } from '../../config/logger.js';
import { requireSession } from '../../middleware/auth.js';
import { requireProjectAccess, requireRole } from '../../middleware/rbac.js';
import {
  createAttack,
  createCampaign,
  createCampaignWithAttacks,
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
  validateProposedDAG,
} from '../../services/campaigns.js';
import type { AppEnv } from '../../types.js';

const campaignRoutes = new Hono<AppEnv>();

campaignRoutes.use('*', requireSession);

// ─── Campaign CRUD ──────────────────────────────────────────────────

const CAMPAIGN_LIST_MAX_LIMIT = 200;
const CAMPAIGN_LIST_DEFAULT_LIMIT = 50;

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
  // Coerce-and-clamp pagination at the schema boundary so malformed
  // URL params fall back to safe defaults instead of 400-ing the
  // request. Mirrors the agents-list pattern at routes/dashboard/agents.ts.
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(CAMPAIGN_LIST_MAX_LIMIT)
    .catch(CAMPAIGN_LIST_DEFAULT_LIMIT)
    .default(CAMPAIGN_LIST_DEFAULT_LIMIT),
  offset: z.coerce.number().int().min(0).catch(0).default(0),
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

// Inline-attack payload schema for the optional transactional create
// path. `dependencies` here are 0-based indices into the same `attacks[]`
// array — the service layer translates them to real attack IDs after
// the INSERT returns. Indices are non-negative integers because zero is
// a valid index into the array.
const inlineAttackSchema = z.object({
  mode: z.number().int().nonnegative(),
  hashTypeId: z.number().int().positive().optional(),
  wordlistId: z.number().int().positive().optional(),
  rulelistId: z.number().int().positive().optional(),
  masklistId: z.number().int().positive().optional(),
  advancedConfiguration: z.record(z.string(), z.unknown()).optional(),
  dependencies: z.array(z.number().int().nonnegative()).optional(),
});

const createCampaignSchema = z.object({
  name: z.string().min(1).max(255),
  description: z.string().max(2000).optional(),
  hashListId: z.number().int().positive(),
  priority: z.number().int().min(1).max(10).optional(),
  attacks: z.array(inlineAttackSchema).optional(),
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

    // No attacks supplied → legacy single-row insert (backward compatible).
    if (!data.attacks || data.attacks.length === 0) {
      const campaign = await createCampaign({
        name: data.name,
        description: data.description,
        hashListId: data.hashListId,
        priority: data.priority,
        projectId,
        createdBy: userId,
      });
      return c.json({ campaign, attacks: [] }, 201);
    }

    // Attacks supplied → single-transaction create + DAG pre-check.
    const result = await createCampaignWithAttacks({
      name: data.name,
      description: data.description,
      hashListId: data.hashListId,
      priority: data.priority,
      projectId,
      createdBy: userId,
      attacks: data.attacks,
    });

    if (result.kind === 'dag_invalid') {
      return c.json({ error: { code: 'DAG_INVALID', message: result.error } }, 400);
    }

    return c.json({ campaign: result.campaign, attacks: result.attacks }, 201);
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

// Shared handler for PATCH and PUT — spec ticket calls for PUT, frontend
// already uses PATCH; both map to the same partial-update semantics, and
// both are gated to draft-status campaigns at the service layer.
const updateCampaignHandler = async (c: Context<AppEnv>) => {
  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id) || id <= 0) {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid campaign id' } }, 400);
  }

  const { projectId } = c.get('currentUser');
  const existing = await getCampaignById(id);
  if (!existing || (projectId !== undefined && existing.projectId !== projectId)) {
    return c.json({ error: { code: 'RESOURCE_NOT_FOUND', message: 'Campaign not found' } }, 404);
  }

  // Parse and validate the body inside the handler. Wrapping c.req.json()
  // in try/catch keeps a malformed body (invalid JSON, premature EOF) from
  // surfacing as an unhandled 500; the safeParse below handles schema
  // violations on syntactically valid JSON. Both failures share the
  // dashboard's `{ error: { code, message } }` envelope.
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json(
      { error: { code: 'VALIDATION_ERROR', message: 'Request body must be valid JSON' } },
      400
    );
  }
  const parsed = updateCampaignSchema.safeParse(body);
  if (!parsed.success) {
    return c.json(
      {
        error: {
          code: 'VALIDATION_ERROR',
          message: parsed.error.issues.map((i) => i.message).join('; '),
        },
      },
      400
    );
  }
  const result = await updateCampaign(id, parsed.data);

  switch (result.kind) {
    case 'not_found':
      return c.json({ error: { code: 'RESOURCE_NOT_FOUND', message: 'Campaign not found' } }, 404);
    case 'not_draft':
      return c.json(
        {
          error: {
            code: 'NOT_DRAFT',
            message: `Campaign cannot be updated in status "${result.status}". Only draft campaigns are editable.`,
          },
        },
        409
      );
    case 'updated':
      return c.json({ campaign: result.campaign });
  }
};

// Validation runs inside the shared handler via safeParse so PATCH and
// PUT share a single source of truth for the response envelope (the
// default zValidator shape uses `{ success, error }`, but the rest of
// the dashboard API uses `{ error: { code, message } }`).
campaignRoutes.patch('/:id', requireRole('admin', 'contributor'), updateCampaignHandler);
campaignRoutes.put('/:id', requireRole('admin', 'contributor'), updateCampaignHandler);

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
    return respondToTransition(c, result);
  }
);

// Shared error mapping for transitionCampaign results. Keeps the
// /lifecycle action-enum route and the spec-named alias routes in
// lockstep — every recognized service-layer error code maps to the
// same HTTP status and envelope across both surfaces.
type TransitionResult = Awaited<ReturnType<typeof transitionCampaign>>;
function respondToTransition(c: Context<AppEnv>, result: TransitionResult) {
  if ('error' in result) {
    const code = 'code' in result ? result.code : undefined;
    if (code === 'QUEUE_UNAVAILABLE') {
      return c.json({ error: { code: 'SERVICE_UNAVAILABLE', message: result.error } }, 503);
    }
    if (code === 'RESOURCE_MISSING') {
      return c.json({ error: { code: 'RESOURCE_MISSING', message: result.error } }, 400);
    }
    if (code === 'TASK_GENERATION_FAILED') {
      return c.json({ error: { code: 'TASK_GENERATION_FAILED', message: result.error } }, 500);
    }
    return c.json({ error: { code: 'INVALID_TRANSITION', message: result.error } }, 400);
  }
  return c.json({ campaign: result.campaign });
}

// Spec-named lifecycle aliases. These delegate to the same
// transitionCampaign service the action-enum /lifecycle route uses, so
// behavior (queue check, task generation, event emission, valid-
// transition allow-list) stays in lockstep. The pre-existing
// /lifecycle route is kept for the frontend which still calls it.
const lifecycleAliasStatus = {
  start: 'running',
  pause: 'paused',
  resume: 'running',
  stop: 'draft',
} as const;

const lifecycleAliasHandler =
  (action: keyof typeof lifecycleAliasStatus) => async (c: Context<AppEnv>) => {
    const id = Number(c.req.param('id'));
    if (!Number.isInteger(id) || id <= 0) {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid campaign id' } }, 400);
    }

    const { projectId } = c.get('currentUser');
    const existing = await getCampaignById(id);
    if (!existing || (projectId !== undefined && existing.projectId !== projectId)) {
      return c.json({ error: { code: 'RESOURCE_NOT_FOUND', message: 'Campaign not found' } }, 404);
    }

    const result = await transitionCampaign(id, lifecycleAliasStatus[action]);
    return respondToTransition(c, result);
  };

campaignRoutes.post(
  '/:id/start',
  requireRole('admin', 'contributor'),
  lifecycleAliasHandler('start')
);
campaignRoutes.post(
  '/:id/pause',
  requireRole('admin', 'contributor'),
  lifecycleAliasHandler('pause')
);
campaignRoutes.post(
  '/:id/resume',
  requireRole('admin', 'contributor'),
  lifecycleAliasHandler('resume')
);
campaignRoutes.post(
  '/:id/stop',
  requireRole('admin', 'contributor'),
  lifecycleAliasHandler('stop')
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

// Synthetic id used for pre-insert DAG validation. Attack IDs are
// positive serials, so any negative value is guaranteed not to collide
// with existing rows.
const SYNTHETIC_NEW_ATTACK_ID = -1;

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

    // Pre-insert DAG validation: build the proposed graph (current
    // attacks + this new attack with a synthetic id) and reject the
    // request if it would introduce a cycle or reference a missing
    // attack id. Skipped when no dependencies are supplied — a
    // dependency-less attack cannot introduce a cycle, and skipping
    // the listAttacks read keeps the hot path cheap. Mirrors the same
    // optimization on the PATCH /:id/attacks/:attackId route.
    if (data.dependencies && data.dependencies.length > 0) {
      const currentAttacks = await listAttacks(campaignId);
      const proposed = [
        ...currentAttacks.map((a) => ({
          id: a.id,
          dependencies: a.dependencies as number[] | null,
        })),
        {
          id: SYNTHETIC_NEW_ATTACK_ID,
          dependencies: data.dependencies,
        },
      ];
      const dagResult = validateProposedDAG(proposed);
      if (!dagResult.valid) {
        return c.json(
          { error: { code: 'DAG_INVALID', message: dagResult.error ?? 'Invalid DAG' } },
          400
        );
      }
    }

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

    // Pre-update DAG validation: only when dependencies are being
    // changed. Other field changes (mode, wordlist, etc.) do not affect
    // the dependency graph, so skipping the load avoids the extra query.
    if (data.dependencies !== undefined) {
      const currentAttacks = await listAttacks(campaignId);
      const proposed = currentAttacks.map((a) => ({
        id: a.id,
        dependencies:
          a.id === attackId ? (data.dependencies ?? null) : (a.dependencies as number[] | null),
      }));
      const dagResult = validateProposedDAG(proposed);
      if (!dagResult.valid) {
        return c.json(
          { error: { code: 'DAG_INVALID', message: dagResult.error ?? 'Invalid DAG' } },
          400
        );
      }
    }

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
