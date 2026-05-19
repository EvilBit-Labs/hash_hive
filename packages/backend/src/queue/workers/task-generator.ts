import { type ConnectionOptions, Worker } from 'bullmq';
import type Redis from 'ioredis';
import { logger } from '../../config/logger.js';
import { generateTasksForAttack } from '../../services/tasks.js';
import type { TaskGenerationJob } from '../types.js';
import { attachWorkerMetrics } from './metrics.js';

export function createTaskGeneratorWorker(
  connection: Redis,
  queueName: string
): Worker<TaskGenerationJob> {
  const worker = new Worker<TaskGenerationJob>(
    queueName,
    async (job) => {
      const { campaignId, attackIds } = job.data;
      logger.info(
        { jobId: job.id, campaignId, attackCount: attackIds.length, queue: queueName },
        'Generating tasks'
      );

      let totalTasks = 0;
      let skippedAttacks = 0;
      for (const attackId of attackIds) {
        const result = await generateTasksForAttack(attackId);
        if ('error' in result) {
          skippedAttacks++;
          logger.warn(
            { attackId, error: result.error },
            'Skipping attack — task generation failed'
          );
          continue;
        }
        totalTasks += result.count;
      }

      // Every attack failed — the campaign produced zero tasks; escalate so
      // alerting picks it up instead of leaving the signal at warn level.
      if (attackIds.length > 0 && skippedAttacks === attackIds.length) {
        logger.error(
          { campaignId, attackCount: attackIds.length, skippedAttacks },
          'Task generation produced no tasks — every attack failed'
        );
      }

      logger.info({ campaignId, totalTasks, skippedAttacks }, 'Task generation complete');
      return { campaignId, totalTasks, skippedAttacks };
    },
    // Cast needed: our ioredis version may differ from BullMQ's bundled ioredis types
    { connection: connection as unknown as ConnectionOptions }
  );

  attachWorkerMetrics(worker, {
    queueName,
    failureMessage: 'Task generation job failed',
    extractContext: (job) => ({ campaignId: job?.data?.campaignId }),
  });

  return worker;
}
