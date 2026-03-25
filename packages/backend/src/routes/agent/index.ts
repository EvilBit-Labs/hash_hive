import { agentHeartbeatSchema } from '@hashhive/shared';
import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import { z } from 'zod';
import { requireAgentToken } from '../../middleware/auth.js';
import { logAgentError, processHeartbeat } from '../../services/agents.js';
import { assignNextTask, handleTaskFailure, updateTaskProgress } from '../../services/tasks.js';
import type { AppEnv } from '../../types.js';

const agentRoutes = new Hono<AppEnv>();

// ─── Authenticated agent endpoints ──────────────────────────────────

agentRoutes.use('/heartbeat', requireAgentToken);
agentRoutes.use('/tasks/*', requireAgentToken);
agentRoutes.use('/errors', requireAgentToken);

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
    const failResult = await handleTaskFailure(taskId, data.errors?.[0] ?? 'Unknown failure');
    return c.json({ acknowledged: true, retried: failResult.retried ?? false });
  }

  // Update task progress and insert cracked results
  const result = await updateTaskProgress(taskId, agentId, data);

  if ('error' in result) {
    return c.json({ error: { code: 'TASK_ERROR', message: result.error } }, 400);
  }

  return c.json({ acknowledged: true });
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

export { agentRoutes };
