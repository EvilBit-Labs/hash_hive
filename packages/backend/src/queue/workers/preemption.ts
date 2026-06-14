import type Redis from 'ioredis'

import { type ConnectionOptions, Worker } from 'bullmq'

import type { PreemptionJob } from '../types.js'

import { logger } from '../../config/logger.js'
import { QUEUE_NAMES } from '../../config/queue.js'
import { evaluatePreemption } from '../../services/tasks/preemption.js'
import { attachWorkerMetrics } from './metrics.js'

/**
 * Worker for the preemption-evaluation queue (issue #97 U5). Each job runs
 * `evaluatePreemption(projectId)`, which acquires a per-project advisory
 * lock and applies the pause + resume passes. Jobs are enqueued
 * event-driven (campaign → running, priority change, terminal transitions)
 * and deduped per project via a deterministic jobId.
 */
export function createPreemptionWorker(connection: Redis): Worker<PreemptionJob> {
  const worker = new Worker<PreemptionJob>(
    QUEUE_NAMES.PREEMPTION,
    async (job) => {
      const { projectId } = job.data
      const result = await evaluatePreemption(projectId)
      logger.info(
        {
          jobId: job.id,
          projectId,
          paused: result.pausedTaskIds.length,
          resumed: result.resumedTaskIds.length,
        },
        'Preemption evaluation complete'
      )
      return result
    },
    // Cast needed: our ioredis version may differ from BullMQ's bundled types.
    { connection: connection as unknown as ConnectionOptions }
  )

  attachWorkerMetrics(worker, {
    queueName: QUEUE_NAMES.PREEMPTION,
    failureMessage: 'Preemption evaluation job failed',
  })

  return worker
}
