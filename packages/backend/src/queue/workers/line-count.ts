import type Redis from 'ioredis'

import { maskLists, ruleLists, wordLists } from '@hashhive/shared'
import { type ConnectionOptions, Worker } from 'bullmq'
import { eq } from 'drizzle-orm'

import type { LineCountJob } from '../types.js'

import { logger } from '../../config/logger.js'
import { QUEUE_NAMES } from '../../config/queue.js'
import { db } from '../../db/index.js'
import { recomputeKeyspaceForResource } from '../../services/attacks/complexity.js'
import { sumMasklistKeyspace } from '../../services/keyspace.js'
import {
  MAX_LINE_LENGTH,
  countLines,
  countsAsRuleLine,
  countsAsWordlistLine,
  streamLines,
} from '../../services/resources/line-count.js'
import { attachWorkerMetrics } from './metrics.js'

const RESOURCE_TABLES = { wordlist: wordLists, rulelist: ruleLists, masklist: maskLists } as const

/**
 * Worker for the resource line-count queue (issue #99, masklist keyspace #231).
 * Sizes a resource once from object storage, persists its keyspace input, then
 * recomputes keyspace for every attack referencing it (the resource-keyed
 * fan-out). Wordlists/rulelists are sized by `lineCount`; a masklist by its
 * summed mask keyspace (Σ per-line `calculateMaskKeyspace`, persisted to
 * `mask_lists.keyspace`). Jobs are enqueued event-driven and deduped per
 * resource via a deterministic jobId.
 *
 * The streaming read is the only retryable risk: it runs BEFORE the write, so a
 * storage-read failure fails the job (and is retried) without leaving a partial
 * value behind.
 */
export function createLineCountWorker(connection: Redis): Worker<LineCountJob> {
  const worker = new Worker<LineCountJob>(
    QUEUE_NAMES.LINE_COUNT,
    async (job) => {
      const { resourceType, resourceId } = job.data
      const table = RESOURCE_TABLES[resourceType]

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

      if (resourceType === 'masklist') {
        // Stream the masklist and sum its per-line mask keyspace. The file is
        // one mask per line; collect into an array (small) for the pure sum.
        const lines: string[] = []
        for await (const line of streamLines(fileRef.key, fileRef.bucket)) lines.push(line)
        const keyspace = sumMasklistKeyspace(lines, MAX_LINE_LENGTH)
        await db
          .update(maskLists)
          .set({ keyspace, updatedAt: new Date() })
          .where(eq(maskLists.id, resourceId))
        await recomputeKeyspaceForResource('masklist', resourceId)
        logger.info({ resourceType, resourceId, keyspace }, 'Masklist keyspace complete')
        return { keyspace }
      }

      const predicate = resourceType === 'wordlist' ? countsAsWordlistLine : countsAsRuleLine
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
