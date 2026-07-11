/**
 * Worker for the resource-compression queue (issue #108 U4).
 *
 * See `services/resources/resource-compression.ts` for the streaming
 * compression + checksum-capture logic; this is a thin BullMQ adapter,
 * mirroring `queue/workers/line-count.ts` and
 * `queue/workers/blob-reclamation.ts`. A thrown error here is caught by
 * BullMQ and retried per the job's `attempts`/backoff configuration
 * (`QueueManager.enqueue`'s default) -- the service function itself already
 * guarantees a failure leaves the resource's row untouched (raw, retriable).
 */
import type Redis from 'ioredis'

import { type ConnectionOptions, Worker } from 'bullmq'

import type { ResourceCompressionJob } from '../types.js'

import { QUEUE_NAMES } from '../../config/queue.js'
import { compressChunkedResourceObject } from '../../services/resources/resource-compression.js'
import { attachWorkerMetrics } from './metrics.js'

export function createResourceCompressionWorker(connection: Redis): Worker<ResourceCompressionJob> {
  const worker = new Worker<ResourceCompressionJob>(
    QUEUE_NAMES.RESOURCE_COMPRESSION,
    async (job) => {
      const { resourceType, resourceId } = job.data
      return compressChunkedResourceObject(resourceType, resourceId)
    },
    // Cast needed: our ioredis version may differ from BullMQ's bundled types.
    { connection: connection as unknown as ConnectionOptions }
  )

  attachWorkerMetrics(worker, {
    queueName: QUEUE_NAMES.RESOURCE_COMPRESSION,
    failureMessage: 'resource-compression job failed',
    extractContext: (job) => ({
      resourceId: job?.data?.resourceId,
      resourceType: job?.data?.resourceType,
      projectId: job?.data?.projectId,
    }),
  })

  return worker
}
