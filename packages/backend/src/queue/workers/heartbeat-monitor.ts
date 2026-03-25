import { agents } from '@hashhive/shared';
import { type ConnectionOptions, Worker } from 'bullmq';
import { and, eq, sql } from 'drizzle-orm';
import type Redis from 'ioredis';
import { logger } from '../../config/logger.js';
import { QUEUE_NAMES } from '../../config/queue.js';
import { db } from '../../db/index.js';
import { emitAgentStatus } from '../../services/events.js';
import { reassignStaleTasks } from '../../services/tasks.js';
import type { HeartbeatMonitorJob } from '../types.js';

const OFFLINE_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes

export function createHeartbeatMonitorWorker(connection: Redis): Worker<HeartbeatMonitorJob> {
  const worker = new Worker<HeartbeatMonitorJob>(
    QUEUE_NAMES.HEARTBEAT_MONITOR,
    async (job) => {
      logger.info(
        { jobId: job.id, triggeredAt: job.data.triggeredAt },
        'Running heartbeat monitor'
      );

      // Mark agents as offline if they haven't checked in
      const threshold = new Date(Date.now() - OFFLINE_THRESHOLD_MS);
      const staleAgents = await db
        .select({ id: agents.id, projectId: agents.projectId })
        .from(agents)
        .where(and(eq(agents.status, 'online'), sql`${agents.lastSeenAt} < ${threshold}`));

      if (staleAgents.length > 0) {
        await db
          .update(agents)
          .set({ status: 'offline', updatedAt: new Date() })
          .where(and(eq(agents.status, 'online'), sql`${agents.lastSeenAt} < ${threshold}`));

        for (const staleAgent of staleAgents) {
          emitAgentStatus(staleAgent.projectId, staleAgent.id, 'offline');
        }

        logger.info({ count: staleAgents.length }, 'Marked stale agents as offline');
      }

      // Reassign tasks from offline agents
      const result = await reassignStaleTasks();

      if (result.reassigned > 0) {
        logger.info({ reassigned: result.reassigned }, 'Reassigned stale tasks');
      }

      return { ...result, offlineAgents: staleAgents.length };
    },
    // Cast needed: our ioredis version may differ from BullMQ's bundled ioredis types
    { connection: connection as unknown as ConnectionOptions }
  );

  worker.on('failed', (job, err) => {
    logger.error({ jobId: job?.id, err }, 'Heartbeat monitor job failed');
  });

  return worker;
}
