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
import { attachWorkerMetrics } from './metrics.js';

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

        // Per-agent try/catch: the DB transition already committed, so a
        // mid-loop broadcast failure must not skip subsequent broadcasts or
        // the downstream reassignStaleTasks call.
        for (const staleAgent of staleAgents) {
          try {
            emitAgentStatus(staleAgent.projectId, staleAgent.id, 'offline');
          } catch (err) {
            logger.error(
              { err, projectId: staleAgent.projectId, agentId: staleAgent.id },
              'emitAgentStatus threw — agent marked offline in DB but WS broadcast skipped'
            );
          }
        }

        logger.info({ count: staleAgents.length }, 'Marked stale agents as offline');
      }

      // Reassign tasks from offline agents
      const result = await reassignStaleTasks();

      // Surface every non-zero counter so terminal failures and per-task
      // errors are observable in operator logs, not buried in task rows.
      const anyMovement =
        result.reassigned > 0 ||
        result.rebalanced > 0 ||
        result.failedOverrun > 0 ||
        result.failedMaxRetries > 0 ||
        result.errored > 0;
      if (anyMovement) {
        const isWarn =
          result.failedOverrun > 0 || result.failedMaxRetries > 0 || result.errored > 0;
        const summary = {
          reassigned: result.reassigned,
          rebalanced: result.rebalanced,
          failedOverrun: result.failedOverrun,
          failedMaxRetries: result.failedMaxRetries,
          errored: result.errored,
        };
        if (isWarn) {
          logger.warn(summary, 'Stale task sweep summary');
        } else {
          logger.info(summary, 'Stale task sweep summary');
        }
      }

      return { ...result, offlineAgents: staleAgents.length };
    },
    // Cast needed: our ioredis version may differ from BullMQ's bundled ioredis types
    { connection: connection as unknown as ConnectionOptions }
  );

  attachWorkerMetrics(worker, {
    queueName: QUEUE_NAMES.HEARTBEAT_MONITOR,
    failureMessage: 'Heartbeat monitor job failed',
  });

  return worker;
}
