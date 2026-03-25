import { type ConnectionOptions, Worker } from 'bullmq';
import type Redis from 'ioredis';
import { logger } from '../../config/logger.js';
import { generateTasksForAttack } from '../../services/tasks.js';
import type { TaskGenerationJob } from '../types.js';

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
      for (const attackId of attackIds) {
        const result = await generateTasksForAttack(attackId);
        if ('error' in result) {
          logger.warn(
            { attackId, error: result.error },
            'Skipping attack — task generation failed'
          );
          continue;
        }
        totalTasks += result.count;
      }

      logger.info({ campaignId, totalTasks }, 'Task generation complete');
      return { campaignId, totalTasks };
    },
    // Cast needed: our ioredis version may differ from BullMQ's bundled ioredis types
    { connection: connection as unknown as ConnectionOptions }
  );

  worker.on('failed', (job, err) => {
    logger.error(
      { jobId: job?.id, campaignId: job?.data?.campaignId, err },
      'Task generation job failed'
    );
  });

  return worker;
}
