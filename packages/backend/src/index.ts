import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { createBunWebSocket } from 'hono/bun';
import { cors } from 'hono/cors';
import { HTTPException } from 'hono/http-exception';
import { env } from './config/env.js';
import { logger } from './config/logger.js';
import { checkMinioHealth } from './config/storage.js';
import { db } from './db/index.js';
import { auth } from './lib/auth.js';
import { requestId } from './middleware/request-id.js';
import { requestLogger } from './middleware/request-logger.js';
import { securityHeaders } from './middleware/security-headers.js';
import { getQueueManager, setQueueManager } from './queue/context.js';
import { QueueManager } from './queue/manager.js';
import { agentRoutes } from './routes/agent/index.js';
import { controlRoutes } from './routes/control/index.js';
import { dashboardAgentRoutes } from './routes/dashboard/agents.js';
import { attackTemplateRoutes } from './routes/dashboard/attack-templates.js';
import { authRoutes } from './routes/dashboard/auth.js';
import { campaignRoutes } from './routes/dashboard/campaigns.js';
import { crackerRoutes } from './routes/dashboard/crackers.js';
import { createEventRoutes } from './routes/dashboard/events.js';
import { hashRoutes } from './routes/dashboard/hashes.js';
import { projectRoutes } from './routes/dashboard/projects.js';
import { resourceRoutes } from './routes/dashboard/resources.js';
import { resultsRoutes } from './routes/dashboard/results.js';
import { statsRoutes } from './routes/dashboard/stats.js';
import { taskRoutes } from './routes/dashboard/tasks.js';
import type { AppEnv } from './types.js';

const { upgradeWebSocket, websocket } = createBunWebSocket();

const app = new Hono<AppEnv>();
const eventRoutes = createEventRoutes(upgradeWebSocket);

// ─── Global Middleware ──────────────────────────────────────────────

app.use('*', requestId);
app.use('*', securityHeaders);
app.use('*', requestLogger);
app.use(
  '*',
  cors({
    origin: env.NODE_ENV === 'production' ? [] : ['http://localhost:3000'],
    credentials: true,
  })
);

// ─── Health Check ───────────────────────────────────────────────────

app.get('/health', async (c) => {
  const qm = getQueueManager();
  let dbCheck: Promise<{ status: 'connected' | 'disconnected' }>;
  try {
    dbCheck = db
      .execute(sql`SELECT 1`)
      .then(() => ({ status: 'connected' as const }))
      .catch(() => ({ status: 'disconnected' as const }));
  } catch {
    dbCheck = Promise.resolve({ status: 'disconnected' as const });
  }

  const [databaseHealth, redisHealth, minioHealth] = await Promise.all([
    dbCheck,
    qm ? qm.getHealth() : Promise.resolve({ status: 'disconnected' as const, queues: {} }),
    checkMinioHealth(),
  ]);

  const allConnected =
    databaseHealth.status === 'connected' &&
    redisHealth.status === 'connected' &&
    minioHealth.status === 'connected';

  return c.json({
    status: allConnected ? 'ok' : 'degraded',
    timestamp: new Date().toISOString(),
    version: '1.0.0',
    services: {
      database: databaseHealth,
      redis: redisHealth,
      minio: minioHealth,
    },
  });
});

// ─── BetterAuth Handler ──────────────────────────────────────────────

app.on(['POST', 'GET'], '/api/auth/*', async (c) => {
  try {
    return await auth.handler(c.req.raw);
  } catch (err) {
    logger.error({ err, path: c.req.path }, 'BetterAuth handler error');
    return c.json(
      { error: { code: 'AUTH_SERVICE_ERROR', message: 'Authentication service error' } },
      500
    );
  }
});

// ─── Route Mounts ────────────────────────────────────────────────────

app.route('/api/v1/dashboard/auth', authRoutes);
app.route('/api/v1/dashboard/projects', projectRoutes);
app.route('/api/v1/dashboard/agents', dashboardAgentRoutes);
app.route('/api/v1/dashboard/resources', resourceRoutes);
app.route('/api/v1/dashboard/hashes', hashRoutes);
app.route('/api/v1/dashboard/attack-templates', attackTemplateRoutes);
app.route('/api/v1/dashboard/campaigns', campaignRoutes);
app.route('/api/v1/dashboard/tasks', taskRoutes);
app.route('/api/v1/dashboard/stats', statsRoutes);
app.route('/api/v1/dashboard/results', resultsRoutes);
app.route('/api/v1/dashboard/events', eventRoutes);
app.route('/api/v1/dashboard/crackers', crackerRoutes);

app.route('/api/v1/agent', agentRoutes);
app.route('/api/v1/control', controlRoutes);

// ─── Error Handler ──────────────────────────────────────────────────

const CONTROL_PATH_PREFIX = '/api/v1/control/';
const CONTROL_PROBLEM_CONTENT_TYPE = 'application/problem+json';

function isControlPath(path: string): boolean {
  return path.startsWith(CONTROL_PATH_PREFIX) || path === '/api/v1/control';
}

function controlProblemBody(
  status: number,
  code: string,
  detail: string,
  instance: string
): string {
  return JSON.stringify({
    type: `https://hashhive.dev/errors/${code.replace(/_/g, '-')}`,
    title: status === 404 ? 'Not found' : 'Internal error',
    status,
    detail,
    instance,
  });
}

app.onError((err, c) => {
  if (err instanceof HTTPException) {
    return err.getResponse();
  }

  const reqId = c.get('requestId');
  logger.error({ err, requestId: reqId, path: c.req.path }, 'unhandled error');

  // Never leak internal details (SQL queries, stack traces) to clients — even in dev.
  // The full error is already logged above; the client gets a safe generic message.
  if (isControlPath(c.req.path)) {
    // Control API consumers expect RFC 9457 problem-details on every
    // error path; the dashboard envelope would break their parsers.
    return new Response(
      controlProblemBody(500, 'internal', 'An unexpected error occurred', c.req.path),
      { status: 500, headers: { 'content-type': CONTROL_PROBLEM_CONTENT_TYPE } }
    );
  }
  return c.json(
    {
      error: {
        code: 'INTERNAL_SERVER_ERROR',
        message: 'An unexpected error occurred',
        timestamp: new Date().toISOString(),
        requestId: reqId,
      },
    },
    500
  );
});

// ─── Not Found Handler ──────────────────────────────────────────────

app.notFound((c) => {
  if (isControlPath(c.req.path)) {
    return new Response(
      controlProblemBody(
        404,
        'not_found',
        `Route ${c.req.method} ${c.req.path} not found`,
        c.req.path
      ),
      { status: 404, headers: { 'content-type': CONTROL_PROBLEM_CONTENT_TYPE } }
    );
  }
  return c.json(
    {
      error: {
        code: 'NOT_FOUND',
        message: `Route ${c.req.method} ${c.req.path} not found`,
        timestamp: new Date().toISOString(),
      },
    },
    404
  );
});

// ─── Start Server ───────────────────────────────────────────────────

logger.info({ port: env.PORT, env: env.NODE_ENV }, 'starting server');

// ─── Queue Manager Init (non-blocking) ─────────────────────────────

const queueManager = new QueueManager();
setQueueManager(queueManager);
queueManager.init().catch((err) => {
  logger.error({ err }, 'Queue manager init failed — queues unavailable');
});

// ─── Graceful Shutdown ──────────────────────────────────────────────

async function handleShutdown(signal: string) {
  logger.info({ signal }, 'received shutdown signal, closing gracefully');
  const qm = getQueueManager();
  if (qm) {
    await qm.shutdown();
  }
  process.exit(0);
}

process.on('SIGTERM', () => handleShutdown('SIGTERM'));
process.on('SIGINT', () => handleShutdown('SIGINT'));

export default {
  port: env.PORT,
  fetch: app.fetch,
  websocket,
};

export { app, websocket };
