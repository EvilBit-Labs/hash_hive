import type { CompressibleResourceType } from './resource-compression.js'

/**
 * Best-effort trigger that enqueues the resource-compression worker (issue
 * #108 U4). The single caller is `completeChunkedUpload`, for a normal
 * (non-restore) word/rule/mask list completion -- chunked uploads stream
 * parts straight to S3 without ever buffering the file server-side, so
 * compression and the authoritative raw-file checksum happen in a
 * background pass rather than inline. An enqueue failure must never fail
 * the originating upload, so it is swallowed here, mirroring
 * `line-count-trigger.ts`'s `enqueueLineCount`.
 */
import { logger } from '../../config/logger.js'

// Dynamic-import seam so tests can stub the queue access without a live
// Redis, mirroring `line-count-trigger.ts`'s `_lineCountDeps` pattern
// (bun:test's mock.module can't override already-cached dynamic imports
// across files).
export const _resourceCompressionDeps = {
  getQueueContext: () => import('../../queue/context.js'),
  getQueueConfig: () => import('../../config/queue.js'),
}

/**
 * Enqueue a single resource-compression job, deduped per resource via a
 * deterministic jobId (`QueueManager.enqueue` auto-pairs the jobId with
 * terminal eviction -- see the gotcha on retained-terminal-jobs blocking
 * every future re-add). Best-effort: a missing queue manager, a declined
 * enqueue, or an enqueue throw is swallowed, never rethrown, so it can
 * never fail the originating upload -- but every silent-`false` path is
 * logged (not just the thrown-error case) so a missed enqueue leaves a
 * grep-able trail rather than vanishing entirely (issue #108 gate-hole
 * review: a task-resources 409 self-heal depends on this being retried,
 * so a silently-lost enqueue would otherwise wedge a task behind a
 * permanent 409).
 */
export async function enqueueResourceCompression(
  resourceType: CompressibleResourceType,
  resourceId: number,
  projectId: number
): Promise<boolean> {
  try {
    const { getQueueManager } = await _resourceCompressionDeps.getQueueContext()
    const { QUEUE_NAMES } = await _resourceCompressionDeps.getQueueConfig()
    const qm = getQueueManager()
    if (!qm) {
      logger.warn(
        { resourceType, resourceId },
        'enqueueResourceCompression: no queue manager available, compression job not enqueued'
      )
      return false
    }
    const enqueued = await qm.enqueue(
      QUEUE_NAMES.RESOURCE_COMPRESSION,
      { resourceType, resourceId, projectId },
      { jobId: `compress:${resourceType}:${resourceId}` }
    )
    if (!enqueued) {
      logger.warn(
        { resourceType, resourceId },
        'enqueueResourceCompression: queue manager declined the job, compression job not enqueued'
      )
    }
    return enqueued
  } catch (err) {
    logger.warn({ err, resourceType, resourceId }, 'failed to enqueue resource-compression job')
    return false
  }
}
