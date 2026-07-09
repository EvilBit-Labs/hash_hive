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
 * every future re-add). Best-effort: a missing queue manager or an enqueue
 * throw is swallowed, never rethrown, so it can never fail the originating
 * upload.
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
    if (!qm) return false
    return await qm.enqueue(
      QUEUE_NAMES.RESOURCE_COMPRESSION,
      { resourceType, resourceId, projectId },
      { jobId: `compress:${resourceType}:${resourceId}` }
    )
  } catch (err) {
    logger.warn({ err, resourceType, resourceId }, 'failed to enqueue resource-compression job')
    return false
  }
}
