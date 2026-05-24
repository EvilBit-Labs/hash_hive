import type Redis from 'ioredis'

import { hashItems, hashLists } from '@hashhive/shared'
import { type ConnectionOptions, Worker } from 'bullmq'
import { and, count, eq, isNotNull } from 'drizzle-orm'

import type { HashListParseJob } from '../types.js'

import { logger } from '../../config/logger.js'
import { DEFAULT_JOB_ATTEMPTS, QUEUE_NAMES } from '../../config/queue.js'
import { downloadFile } from '../../config/storage.js'
import { db } from '../../db/index.js'
import { emitResourceUpdate } from '../../services/events.js'
import { attachWorkerMetrics } from './metrics.js'

const BATCH_SIZE = 5_000
const MAX_LINE_LENGTH = 10_000 // 10 KB — skip malformed/binary lines

/**
 * Parse a single hash line into an insert value. Supports:
 *
 *   - `hash`                          1 token  -> { hashValue }
 *   - `hash:plaintext`                2 tokens -> { hashValue, plaintext, crackedAt }
 *   - `username:hash:plaintext`       3 tokens -> { ..., metadata: { username } }
 *   - 4+ tokens (plaintext with `:`)  fallback -> first-colon-as-separator, same as
 *                                                 2-token semantics, preserves prior
 *                                                 behavior for plaintexts containing
 *                                                 colons (the common case is a
 *                                                 password with literal colons).
 *
 * An ambiguous 2-token line (e.g. `admin:hash`) is always treated as
 * `hash:plaintext` — to submit a username-tagged hash without a plaintext, send
 * `username:hash:` (3 tokens, empty plaintext) or `username:hash:<plaintext>`.
 */
function parseHashLine(line: string, hashListId: number) {
  const tokens = line.split(':')
  if (tokens.length === 1) {
    return { hashListId, hashValue: line }
  }
  if (tokens.length === 2) {
    return {
      hashListId,
      hashValue: tokens[0] ?? '',
      plaintext: tokens[1] ?? '',
      crackedAt: new Date(),
    }
  }
  if (tokens.length === 3) {
    return {
      hashListId,
      hashValue: tokens[1] ?? '',
      plaintext: tokens[2] ?? '',
      crackedAt: new Date(),
      metadata: { username: tokens[0] ?? '' },
    }
  }
  // 4+ tokens: legacy first-colon-as-separator. Preserves prior behavior for
  // hash:plaintext lines where the plaintext itself contains colons.
  const firstColon = line.indexOf(':')
  return {
    hashListId,
    hashValue: line.substring(0, firstColon),
    plaintext: line.substring(firstColon + 1),
    crackedAt: new Date(),
  }
}

/**
 * Flush a batch of parsed hash items to the database.
 * Uses onConflictDoNothing for idempotency on (hashListId, hashValue).
 */
async function flushBatch(batch: ReadonlyArray<ReturnType<typeof parseHashLine>>): Promise<void> {
  if (batch.length === 0) return
  await db
    .insert(hashItems)
    .values([...batch])
    .onConflictDoNothing()
}

export function createHashListParserWorker(connection: Redis): Worker<HashListParseJob> {
  const worker = new Worker<HashListParseJob>(
    QUEUE_NAMES.HASH_LIST_PARSING,
    async (job) => {
      const { hashListId, projectId } = job.data
      logger.info({ jobId: job.id, hashListId }, 'Parsing hash list (streaming)')

      const [hl] = await db.select().from(hashLists).where(eq(hashLists.id, hashListId)).limit(1)

      if (!hl) {
        throw new Error(`Hash list ${hashListId} not found`)
      }

      const fileRef = hl.fileRef as { bucket?: string; key: string } | null
      if (!fileRef) {
        throw new Error(`Hash list ${hashListId} has no file reference`)
      }

      // Stream file from S3 — never buffer the entire file in memory
      const response = await downloadFile(fileRef.key, fileRef.bucket)
      const body = response.Body
      if (!body) {
        throw new Error(`Empty file body for hash list ${hashListId}`)
      }

      // Use the AWS SDK's built-in transformToWebStream for ReadableStream access
      const stream = body.transformToWebStream()
      const reader = stream.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      let batch: ReturnType<typeof parseHashLine>[] = []
      let linesProcessed = 0
      let skippedLines = 0

      while (true) {
        const { done, value } = await reader.read()
        if (done) {
          buffer += decoder.decode() // flush buffered multi-byte bytes
          break
        }

        buffer += decoder.decode(value, { stream: true })

        for (
          let newlineIdx = buffer.indexOf('\n');
          newlineIdx !== -1;
          newlineIdx = buffer.indexOf('\n')
        ) {
          const line = buffer.slice(0, newlineIdx).trim()
          buffer = buffer.slice(newlineIdx + 1)

          if (line.length === 0) continue
          if (line.length > MAX_LINE_LENGTH) {
            skippedLines++
            continue
          }

          batch.push(parseHashLine(line, hashListId))

          if (batch.length >= BATCH_SIZE) {
            await flushBatch(batch)
            linesProcessed += batch.length
            batch = []
            await job.updateProgress(linesProcessed)
          }
        }
      }

      // Flush final partial line left in buffer (file may not end with newline)
      const finalLine = buffer.trim()
      if (finalLine.length > 0) {
        if (finalLine.length > MAX_LINE_LENGTH) {
          skippedLines++
        } else {
          batch.push(parseHashLine(finalLine, hashListId))
        }
      }

      // Flush remaining batch
      if (batch.length > 0) {
        await flushBatch(batch)
        linesProcessed += batch.length
      }

      // Recompute statistics from actual data (crash-safe, not accumulated)
      const [totalResult] = await db
        .select({ value: count() })
        .from(hashItems)
        .where(eq(hashItems.hashListId, hashListId))

      const [crackedResult] = await db
        .select({ value: count() })
        .from(hashItems)
        .where(and(eq(hashItems.hashListId, hashListId), isNotNull(hashItems.crackedAt)))

      const total = totalResult?.value ?? 0
      const cracked = crackedResult?.value ?? 0

      // Mark hash list as ready with computed statistics.
      // skippedLines is logged but not persisted in the wire JSONB.
      const crackRate = total > 0 ? cracked / total : 0
      const lastUpdated = new Date()
      const statistics = {
        totalCount: total,
        crackedCount: cracked,
        crackRate,
        lastUpdated: lastUpdated.toISOString(),
      }
      // Atomic guard: only flip processing -> ready. If another processor
      // already transitioned the row (concurrent re-run, manual intervention),
      // the WHERE matches zero rows and we skip the event emit — preventing a
      // duplicate hash_list_ready event from leaking out.
      const flipped = await db
        .update(hashLists)
        .set({ status: 'ready', statistics, updatedAt: lastUpdated })
        .where(and(eq(hashLists.id, hashListId), eq(hashLists.status, 'processing')))
        .returning({ id: hashLists.id })

      logger.info(
        {
          hashListId,
          linesProcessed,
          skippedLines,
          totalCount: total,
          crackedCount: cracked,
          flipped: flipped.length > 0,
        },
        'Hash list parsing complete (streamed)'
      )

      if (flipped.length > 0) {
        emitResourceUpdate(projectId, {
          action: 'hash_list_ready',
          hashListId,
          statistics,
        })
      }

      return { inserted: linesProcessed, skippedLines }
    },
    // Cast needed: our ioredis version may differ from BullMQ's bundled ioredis types
    { connection: connection as unknown as ConnectionOptions }
  )

  attachWorkerMetrics(worker, {
    queueName: QUEUE_NAMES.HASH_LIST_PARSING,
    failureMessage: 'Hash list parse failed',
    extractContext: (job) => ({ hashListId: job?.data?.hashListId }),
  })

  // Separate listener: a DB outage here must not suppress the metrics log,
  // and BullMQ surfaces listener rejections as uncaughtException.
  worker.on('failed', async (job, err) => {
    if (!job || job.attemptsMade < (job.opts.attempts ?? DEFAULT_JOB_ATTEMPTS)) return
    const hashListId = job.data?.hashListId
    const projectId = job.data?.projectId
    if (typeof hashListId !== 'number') return
    const errorMessage = err instanceof Error ? err.message : 'Hash list parse failed'
    try {
      await db
        .update(hashLists)
        .set({ status: 'error', updatedAt: new Date() })
        .where(eq(hashLists.id, hashListId))
      if (typeof projectId === 'number') {
        emitResourceUpdate(projectId, {
          action: 'hash_list_failed',
          hashListId,
          error: errorMessage,
        })
      }
    } catch (cleanupErr) {
      // Hash list row likely stuck in non-error status; operator must reset manually.
      logger.error(
        { jobId: job.id, hashListId, err: cleanupErr },
        'Hash list parse failed AND cleanup db.update failed — manual intervention required'
      )
    }
  })

  return worker
}
