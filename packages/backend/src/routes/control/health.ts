/**
 * Control API health endpoint.
 *
 * Mirrors the public `/health` endpoint but is API-key authenticated so
 * automation tooling can verify connectivity using its own credentials
 * (the public endpoint is unauthenticated for load-balancer probes).
 *
 * Probe failures are logged with the request id so a "degraded" status
 * can be tied back to a specific cause (the public endpoint silently
 * coerces every error to "disconnected" — useful for liveness checks
 * but unhelpful for ops triage).
 */

import { sql } from 'drizzle-orm';
import type { Context } from 'hono';
import { Hono } from 'hono';
import { logger } from '../../config/logger.js';
import { checkMinioHealth } from '../../config/storage.js';
import { db } from '../../db/index.js';
import { getQueueManager } from '../../queue/context.js';
import type { AppEnv } from '../../types.js';
import { controlErrorResponse } from './helpers.js';

export const controlHealthRoutes = new Hono<AppEnv>();

type ProbeStatus = { status: 'connected' | 'disconnected' };

function logProbeFailure(c: Context<AppEnv>, probe: string) {
  return (err: unknown) => {
    logger.warn({ err, probe, requestId: c.get('requestId') }, 'control health probe failed');
    return { status: 'disconnected' as const };
  };
}

controlHealthRoutes.get('/', async (c) => {
  try {
    const qm = getQueueManager();
    const dbCheck: Promise<ProbeStatus> = db
      .execute(sql`SELECT 1`)
      .then(() => ({ status: 'connected' as const }))
      .catch(logProbeFailure(c, 'database'));
    const redisCheck: Promise<{ status: 'connected' | 'disconnected'; queues?: unknown }> = qm
      ? qm.getHealth().catch(logProbeFailure(c, 'redis'))
      : Promise.resolve({ status: 'disconnected' as const, queues: {} });
    const minioCheck: Promise<ProbeStatus> = checkMinioHealth().catch(logProbeFailure(c, 'minio'));

    const [databaseHealth, redisHealth, minioHealth] = await Promise.all([
      dbCheck,
      redisCheck,
      minioCheck,
    ]);

    const allConnected =
      databaseHealth.status === 'connected' &&
      redisHealth.status === 'connected' &&
      minioHealth.status === 'connected';

    return c.json({
      status: allConnected ? 'ok' : 'degraded',
      timestamp: new Date().toISOString(),
      services: {
        database: databaseHealth,
        redis: redisHealth,
        minio: minioHealth,
      },
    });
  } catch (err) {
    return controlErrorResponse(c, err);
  }
});
