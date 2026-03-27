import { agentHeartbeatSchema } from '@hashhive/shared';
import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import { z } from 'zod';
import { requireAgentToken } from '../../middleware/auth.js';
import { logAgentError, processHeartbeat } from '../../services/agents.js';
import { getAgentDownloadUrl } from '../../services/resources.js';
import {
  assignNextTask,
  getZapsForTask,
  handleTaskFailure,
  updateTaskProgress,
} from '../../services/tasks.js';
import type { AppEnv } from '../../types.js';

const agentRoutes = new Hono<AppEnv>();

// ─── Authenticated agent endpoints ──────────────────────────────────

agentRoutes.use('/heartbeat', requireAgentToken);
agentRoutes.use('/tasks/*', requireAgentToken);
agentRoutes.use('/errors', requireAgentToken);
agentRoutes.use('/resources/*', requireAgentToken);

// ─── POST /heartbeat — agent heartbeat ──────────────────────────────

agentRoutes.post('/heartbeat', zValidator('json', agentHeartbeatSchema), async (c) => {
  const { agentId } = c.get('agent');
  const data = c.req.valid('json');
  const result = await processHeartbeat(agentId, data);
  return c.json({
    acknowledged: true,
    ...(result.hasHighPriorityTasks ? { hasHighPriorityTasks: true } : {}),
  });
});

// ─── POST /tasks/next — request next task ───────────────────────────

agentRoutes.post('/tasks/next', async (c) => {
  const { agentId } = c.get('agent');
  const task = await assignNextTask(agentId);
  return c.json({ task });
});

// ─── POST /tasks/:id/report — report task progress ─────────────────

const taskReportSchema = z.object({
  status: z.enum(['running', 'completed', 'failed', 'exhausted']),
  progress: z
    .object({
      keyspaceProgress: z.number().optional(),
      speed: z.number().optional(),
      temperature: z.number().optional(),
    })
    .optional(),
  results: z
    .array(
      z.object({
        hashValue: z.string(),
        plaintext: z.string(),
      })
    )
    .optional(),
  errors: z.array(z.string()).optional(),
});

agentRoutes.post('/tasks/:id/report', zValidator('json', taskReportSchema), async (c) => {
  const { agentId } = c.get('agent');
  const taskId = Number(c.req.param('id'));

  if (Number.isNaN(taskId) || taskId <= 0) {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid task ID' } }, 400);
  }

  const data = c.req.valid('json');

  // Log any errors reported by the agent
  if (data.errors && data.errors.length > 0) {
    for (const errorMessage of data.errors) {
      await logAgentError({
        agentId,
        severity: 'error',
        message: errorMessage,
        taskId,
      });
    }
  }

  // Handle failure with retry logic
  if (data.status === 'failed') {
    const failResult = await handleTaskFailure(
      taskId,
      agentId,
      data.errors?.[0] ?? 'Unknown failure'
    );
    if ('error' in failResult) {
      return c.json({ error: { code: 'TASK_ERROR', message: failResult.error } }, 400);
    }
    return c.json({ acknowledged: true, retried: failResult.retried ?? false });
  }

  // Update task progress and insert cracked results
  const result = await updateTaskProgress(taskId, agentId, data);

  if ('error' in result) {
    return c.json({ error: { code: 'TASK_ERROR', message: result.error } }, 400);
  }

  return c.json({ acknowledged: true });
});

// ─── GET /tasks/:id/zaps — cracked hashes for a task ────────────────

const zapQuerySchema = z.object({
  since: z.iso
    .datetime()
    .optional()
    .transform((v) => (v ? new Date(v) : undefined)),
  limit: z.coerce.number().int().min(1).max(10_000).default(10_000),
});

agentRoutes.get('/tasks/:id/zaps', zValidator('query', zapQuerySchema), async (c) => {
  const { agentId, projectId } = c.get('agent');
  const taskId = Number(c.req.param('id'));

  if (Number.isNaN(taskId) || taskId <= 0) {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid task ID' } }, 400);
  }

  const { since, limit } = c.req.valid('query');
  const result = await getZapsForTask(taskId, agentId, projectId, { since, limit });

  if ('error' in result) {
    return c.json({ error: { code: 'TASK_NOT_FOUND', message: result.error } }, 404);
  }

  return c.json(result);
});

// ─── POST /errors — log an agent error ──────────────────────────────

const agentErrorSchema = z.object({
  severity: z.enum(['warning', 'error', 'fatal']),
  message: z.string().min(1),
  context: z.record(z.string(), z.unknown()).optional(),
  taskId: z.number().int().positive().optional(),
});

agentRoutes.post('/errors', zValidator('json', agentErrorSchema), async (c) => {
  const { agentId } = c.get('agent');
  const data = c.req.valid('json');
  await logAgentError({ ...data, agentId });
  return c.json({ acknowledged: true });
});

// ─── GET /resources/:type/:id/download-url — presigned download ─────

agentRoutes.get('/resources/:type/:id/download-url', async (c) => {
  const { projectId } = c.get('agent');
  const resourceType = c.req.param('type');
  const resourceId = Number(c.req.param('id'));

  if (!resourceType || !resourceId || Number.isNaN(resourceId)) {
    return c.json(
      { error: { code: 'VALIDATION_ERROR', message: 'Resource type and ID are required' } },
      400
    );
  }

  const result = await getAgentDownloadUrl(resourceType, resourceId, projectId);

  if (!result) {
    return c.json(
      { error: { code: 'RESOURCE_NOT_FOUND', message: 'Resource not found or has no file' } },
      404
    );
  }

  return c.json(result);
});

export { agentRoutes };
