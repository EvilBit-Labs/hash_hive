import { hashItems, hashLists } from '@hashhive/shared';
import { type ConnectionOptions, Worker } from 'bullmq';
import { and, count, eq, isNotNull } from 'drizzle-orm';
import type Redis from 'ioredis';
import { logger } from '../../config/logger.js';
import { QUEUE_NAMES } from '../../config/queue.js';
import { downloadFile } from '../../config/storage.js';
import { db } from '../../db/index.js';
import type { HashListParseJob } from '../types.js';

const BATCH_SIZE = 5_000;
const MAX_LINE_LENGTH = 10_000; // 10 KB — skip malformed/binary lines

/**
 * Parse a single hash line into an insert value.
 * Handles "hash:plaintext" (pre-cracked) and plain "hash" formats.
 */
function parseHashLine(line: string, hashListId: number) {
  const colonIdx = line.indexOf(':');
  if (colonIdx > 0) {
    return {
      hashListId,
      hashValue: line.substring(0, colonIdx),
      plaintext: line.substring(colonIdx + 1),
      crackedAt: new Date(),
    };
  }
  return { hashListId, hashValue: line };
}

/**
 * Flush a batch of parsed hash items to the database.
 * Uses onConflictDoNothing for idempotency on (hashListId, hashValue).
 */
async function flushBatch(batch: ReadonlyArray<ReturnType<typeof parseHashLine>>): Promise<void> {
  if (batch.length === 0) return;
  await db
    .insert(hashItems)
    .values([...batch])
    .onConflictDoNothing();
}

export function createHashListParserWorker(connection: Redis): Worker<HashListParseJob> {
  const worker = new Worker<HashListParseJob>(
    QUEUE_NAMES.HASH_LIST_PARSING,
    async (job) => {
      const { hashListId } = job.data;
      logger.info({ jobId: job.id, hashListId }, 'Parsing hash list (streaming)');

      const [hl] = await db.select().from(hashLists).where(eq(hashLists.id, hashListId)).limit(1);

      if (!hl) {
        throw new Error(`Hash list ${hashListId} not found`);
      }

      const fileRef = hl.fileRef as { bucket?: string; key: string } | null;
      if (!fileRef) {
        throw new Error(`Hash list ${hashListId} has no file reference`);
      }

      // Stream file from S3 — never buffer the entire file in memory
      const response = await downloadFile(fileRef.key, fileRef.bucket);
      const body = response.Body;
      if (!body) {
        throw new Error(`Empty file body for hash list ${hashListId}`);
      }

      // Use the AWS SDK's built-in transformToWebStream for ReadableStream access
      const stream = body.transformToWebStream();
      const reader = stream.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let batch: ReturnType<typeof parseHashLine>[] = [];
      let linesProcessed = 0;
      let skippedLines = 0;

      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          buffer += decoder.decode(); // flush buffered multi-byte bytes
          break;
        }

        buffer += decoder.decode(value, { stream: true });

        for (
          let newlineIdx = buffer.indexOf('\n');
          newlineIdx !== -1;
          newlineIdx = buffer.indexOf('\n')
        ) {
          const line = buffer.slice(0, newlineIdx).trim();
          buffer = buffer.slice(newlineIdx + 1);

          if (line.length === 0) continue;
          if (line.length > MAX_LINE_LENGTH) {
            skippedLines++;
            continue;
          }

          batch.push(parseHashLine(line, hashListId));

          if (batch.length >= BATCH_SIZE) {
            await flushBatch(batch);
            linesProcessed += batch.length;
            batch = [];
            await job.updateProgress(linesProcessed);
          }
        }
      }

      // Flush final partial line left in buffer (file may not end with newline)
      const finalLine = buffer.trim();
      if (finalLine.length > 0) {
        if (finalLine.length > MAX_LINE_LENGTH) {
          skippedLines++;
        } else {
          batch.push(parseHashLine(finalLine, hashListId));
        }
      }

      // Flush remaining batch
      if (batch.length > 0) {
        await flushBatch(batch);
        linesProcessed += batch.length;
      }

      // Recompute statistics from actual data (crash-safe, not accumulated)
      const [totalResult] = await db
        .select({ value: count() })
        .from(hashItems)
        .where(eq(hashItems.hashListId, hashListId));

      const [crackedResult] = await db
        .select({ value: count() })
        .from(hashItems)
        .where(and(eq(hashItems.hashListId, hashListId), isNotNull(hashItems.crackedAt)));

      const total = totalResult?.value ?? 0;
      const cracked = crackedResult?.value ?? 0;

      // Mark hash list as ready with computed statistics
      await db
        .update(hashLists)
        .set({
          status: 'ready',
          statistics: { total, cracked, remaining: total - cracked, skippedLines },
          updatedAt: new Date(),
        })
        .where(eq(hashLists.id, hashListId));

      logger.info(
        { hashListId, linesProcessed, skippedLines, total, cracked },
        'Hash list parsing complete (streamed)'
      );
      return { inserted: linesProcessed, skippedLines };
    },
    // Cast needed: our ioredis version may differ from BullMQ's bundled ioredis types
    { connection: connection as unknown as ConnectionOptions }
  );

  worker.on('failed', async (job, err) => {
    logger.error(
      { jobId: job?.id, hashListId: job?.data.hashListId, err },
      'Hash list parse failed'
    );

    // Mark hash list as error on final failure
    if (job && job.attemptsMade >= (job.opts.attempts ?? 3)) {
      await db
        .update(hashLists)
        .set({ status: 'error', updatedAt: new Date() })
        .where(eq(hashLists.id, job.data.hashListId));
    }
  });

  return worker;
}
