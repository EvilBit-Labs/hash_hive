import {
  agentHeartbeatSchema,
  benchmarkSubmissionSchema,
  crackerCheckUpdateRequestSchema,
  HEARTBEAT_ERROR_CONTEXT_MAX_CHARS,
  HEARTBEAT_ERROR_MESSAGE_MAX,
} from '@hashhive/shared';
import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import { z } from 'zod';
import { logger } from '../../config/logger.js';
import { requireAgentToken } from '../../middleware/auth.js';
import { logAgentError, processHeartbeat, submitBenchmarks } from '../../services/agents.js';
import {
  compareCrackerVersions,
  getCrackerDownloadUrl,
  getLatestCracker,
  isKnownEngine,
  normalizeEngineName,
} from '../../services/crackers.js';
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
agentRoutes.use('/benchmark', requireAgentToken);
agentRoutes.use('/resources/*', requireAgentToken);
agentRoutes.use('/cracker/*', requireAgentToken);

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
      // Absolute keyspace units cracked within the task's workRange.total.
      // Must be a non-negative whole number. Numbers go through .int() so
      // fractional reports (legacy fraction-mode agents) and negatives are
      // rejected. The number branch caps at Number.MAX_SAFE_INTEGER so
      // unsafe-size reports are forced through the decimal-string branch
      // instead of arriving here already-rounded. Decimal strings cover
      // the bigint-overflow path.
      keyspaceProgress: z
        .union([
          z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
          z
            .string()
            .regex(/^[0-9]+$/)
            .max(64),
        ])
        .optional(),
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

// Same size caps as agentHeartbeatErrorSchema (in @hashhive/shared) so the
// standalone error channel can't be used to bypass the bound. severity stays
// wider (warning|error|fatal) for back-compat with agents that have not
// adopted the heartbeat-borne error block yet.
const agentErrorSchema = z.object({
  severity: z.enum(['warning', 'error', 'fatal']),
  message: z.string().min(1).max(HEARTBEAT_ERROR_MESSAGE_MAX),
  context: z
    .record(z.string(), z.unknown())
    .optional()
    .refine(
      (value) =>
        value === undefined || JSON.stringify(value).length <= HEARTBEAT_ERROR_CONTEXT_MAX_CHARS,
      {
        message: `context exceeds ${HEARTBEAT_ERROR_CONTEXT_MAX_CHARS} characters when serialized`,
      }
    ),
  taskId: z.number().int().positive().optional(),
});

agentRoutes.post('/errors', zValidator('json', agentErrorSchema), async (c) => {
  const { agentId } = c.get('agent');
  const data = c.req.valid('json');
  await logAgentError({ ...data, agentId });
  return c.json({ acknowledged: true });
});

// ─── POST /benchmark — submit hashcat benchmark results ─────────────

agentRoutes.post('/benchmark', zValidator('json', benchmarkSubmissionSchema), async (c) => {
  const { agentId } = c.get('agent');
  const data = c.req.valid('json');
  try {
    await submitBenchmarks(agentId, data.entries, data.crackerVersion);
    return c.json({ acknowledged: true });
  } catch (err: unknown) {
    logger.error({ err, agentId, entryCount: data.entries.length }, 'Benchmark submission failed');
    return c.json(
      { error: { code: 'BENCHMARK_ERROR', message: 'Failed to store benchmark results' } },
      500
    );
  }
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

// ─── POST /cracker/check-update — agent cracker auto-update ─────────

/**
 * Returns the latest active cracker binary for the agent's engine + platform
 * and a presigned download URL when the agent is behind. Missing `engine`
 * defaults to `'hashcat'` for back-compat with agents that have not adopted
 * the engines[] capability advertisement.
 *
 * Engine normalization delegates to the service-layer helper so the route
 * and service can never disagree about what `'Hashcat'` means.
 */
agentRoutes.post(
  '/cracker/check-update',
  zValidator('json', crackerCheckUpdateRequestSchema),
  async (c) => {
    const data = c.req.valid('json');
    const engine = normalizeEngineName(data.engine);
    // Trim version + platform so an agent sending `'6.2.7 '` (trailing
    // whitespace) doesn't compare unequal against the registry's stored
    // value. The comparator treats whitespace as part of the version
    // string, so the trim has to happen here.
    const platform = data.platform.trim();
    const version = data.version.trim();

    // A misconfigured agent advertising `engine: "hashca"` would otherwise
    // poll forever and silently appear up-to-date. Log a warn so an
    // operator searching logs for "stale agent" can find it. We still
    // return `updateAvailable: false` (not 400) — the agent contract is
    // soft on engine names so unknown values don't break the update loop.
    if (!isKnownEngine(engine)) {
      logger.warn(
        { engine, rawEngine: data.engine, platform },
        'Cracker check-update from agent advertising unknown engine; treating as no update'
      );
      return c.json({ updateAvailable: false, engine });
    }

    const latest = await getLatestCracker({ engine, platform });

    if (!latest || compareCrackerVersions(latest.version, version) <= 0) {
      return c.json({ updateAvailable: false, engine });
    }

    const downloadInfo = await getCrackerDownloadUrl(latest.id);
    if (!downloadInfo) {
      // Latest record exists but lacks an uploaded file — treat as no update
      // available rather than failing the agent's poll. Logged at warn so
      // an admin can find rows that were created but never uploaded.
      logger.warn(
        { crackerBinaryId: latest.id, engine, platform: data.platform },
        'Latest cracker binary has no completed file; agent will not see this version'
      );
      return c.json({ updateAvailable: false, engine });
    }

    return c.json({
      updateAvailable: true,
      engine,
      latestVersion: latest.version,
      downloadUrl: downloadInfo.url,
      expiresIn: downloadInfo.expiresIn,
    });
  }
);

export { agentRoutes };
