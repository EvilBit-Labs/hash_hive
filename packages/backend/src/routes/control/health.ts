/**
 * Control API health endpoint.
 *
 * Mirrors the public `/health` endpoint but is API-key authenticated so
 * automation tooling can verify connectivity using its own credentials
 * (the public endpoint is unauthenticated for load-balancer probes).
 */

import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { checkMinioHealth } from '../../config/storage.js';
import { db } from '../../db/index.js';
import { getQueueManager } from '../../queue/context.js';
import type { AppEnv } from '../../types.js';

export const controlHealthRoutes = new Hono<AppEnv>();

controlHealthRoutes.get('/', async (c) => {
  const qm = getQueueManager();
  const dbCheck = db
    .execute(sql`SELECT 1`)
    .then(() => ({ status: 'connected' as const }))
    .catch(() => ({ status: 'disconnected' as const }));

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
    services: {
      database: databaseHealth,
      redis: redisHealth,
      minio: minioHealth,
    },
  });
});
