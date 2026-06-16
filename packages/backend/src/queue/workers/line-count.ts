import type Redis from 'ioredis'

import { ruleLists, wordLists } from '@hashhive/shared'
import { type ConnectionOptions, Worker } from 'bullmq'
import { eq } from 'drizzle-orm'

import type { LineCountJob } from '../types.js'

import { logger } from '../../config/logger.js'
import { QUEUE_NAMES } from '../../config/queue.js'
import { db } from '../../db/index.js'
import { recomputeKeyspaceForResource } from '../../services/attacks/complexity.js'
import {
  countLines,
  countsAsRuleLine,
  countsAsWordlistLine,
} from '../../services/resources/line-count.js'
import { attachWorkerMetrics } from './metrics.js'

/**
 * Worker for the resource line-count queue (issue #99). Counts a wordlist or
 * rule list once from object storage, persists its `lineCount`, then recomputes
 * keyspace for every attack referencing it (the resource-keyed fan-out). Jobs
 * are enqueued event-driven (resource → ready without an inline count, or an
 * attack referencing an uncounted resource) and deduped per resource via a
 * deterministic jobId.
 *
 * The count is the only retryable risk: it runs BEFORE the lineCount write, so
 * a storage-read failure fails the job (and is retried) without leaving a
 * partial count behind.
 */
export function createLineCountWorker(connection: Redis): Worker<LineCountJob> {
  const worker = new Worker<LineCountJob>(
    QUEUE_NAMES.LINE_COUNT,
    async (job) => {
      const { resourceType, resourceId } = job.data
      const table = resourceType === 'wordlist' ? wordLists : ruleLists
      const predicate = resourceType === 'wordlist' ? countsAsWordlistLine : countsAsRuleLine

      const [row] = await db
        .select({ fileRef: table.fileRef })
        .from(table)
        .where(eq(table.id, resourceId))
        .limit(1)
      if (!row) {
        throw new Error(`${resourceType} ${resourceId} not found`)
      }
      const fileRef = row.fileRef as { bucket?: string; key: string } | null
      if (!fileRef?.key) {
        throw new Error(`${resourceType} ${resourceId} has no file reference`)
      }

      const lineCount = await countLines(fileRef.key, predicate, fileRef.bucket)
      await db
        .update(table)
        .set({ lineCount, updatedAt: new Date() })
        .where(eq(table.id, resourceId))

      // Resource counted once; fan the pure keyspace recompute out to every
      // dependent attack.
      await recomputeKeyspaceForResource(resourceType, resourceId)

      logger.info({ resourceType, resourceId, lineCount }, 'Line count complete')
      return { lineCount }
    },
    // Cast needed: our ioredis version may differ from BullMQ's bundled types.
    { connection: connection as unknown as ConnectionOptions }
  )

  attachWorkerMetrics(worker, {
    queueName: QUEUE_NAMES.LINE_COUNT,
    failureMessage: 'Line count job failed',
    extractContext: (job) => ({ resourceId: job?.data?.resourceId }),
  })

  return worker
}
