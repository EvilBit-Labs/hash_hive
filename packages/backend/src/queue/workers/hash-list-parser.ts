import { hashItems, hashLists } from '@hashhive/shared';
import { type ConnectionOptions, Worker } from 'bullmq';
import { eq } from 'drizzle-orm';
import type Redis from 'ioredis';
import { logger } from '../../config/logger.js';
import { QUEUE_NAMES } from '../../config/queue.js';
import { downloadFile } from '../../config/storage.js';
import { db } from '../../db/index.js';
import type { HashListParseJob } from '../types.js';

const BATCH_SIZE = 1_000;

export function createHashListParserWorker(connection: Redis): Worker<HashListParseJob> {
  const worker = new Worker<HashListParseJob>(
    QUEUE_NAMES.HASH_LIST_PARSING,
    async (job) => {
      const { hashListId } = job.data;
      logger.info({ jobId: job.id, hashListId }, 'Parsing hash list');

      const [hl] = await db.select().from(hashLists).where(eq(hashLists.id, hashListId)).limit(1);

      if (!hl) {
        throw new Error(`Hash list ${hashListId} not found`);
      }

      const fileRef = hl.fileRef as { bucket?: string; key: string } | null;
      if (!fileRef) {
        throw new Error(`Hash list ${hashListId} has no file reference`);
      }

      // Download file from S3
      const response = await downloadFile(fileRef.key, fileRef.bucket);
      const body = response.Body;
      if (!body) {
        throw new Error(`Empty file body for hash list ${hashListId}`);
      }

      const text = await body.transformToString('utf-8');
      const lines = text.split('\n').filter((line) => line.trim().length > 0);

      // Batch insert hash items
      let inserted = 0;
      for (let i = 0; i < lines.length; i += BATCH_SIZE) {
        const batch = lines.slice(i, i + BATCH_SIZE);
        const values = batch.map((line) => {
          const trimmed = line.trim();
          // Hash files may be in format "hash:plain" or just "hash"
          const colonIdx = trimmed.indexOf(':');
          if (colonIdx > 0) {
            return {
              hashListId,
              hashValue: trimmed.substring(0, colonIdx),
              plaintext: trimmed.substring(colonIdx + 1),
              crackedAt: new Date(),
            };
          }
          return {
            hashListId,
            hashValue: trimmed,
            isCracked: false,
          };
        });

        await db.insert(hashItems).values(values).onConflictDoNothing();
        inserted += values.length;

        await job.updateProgress(Math.round((inserted / lines.length) * 100));
      }

      // Mark hash list as ready
      await db
        .update(hashLists)
        .set({ status: 'ready', updatedAt: new Date() })
        .where(eq(hashLists.id, hashListId));

      logger.info({ hashListId, inserted }, 'Hash list parsing complete');
      return { inserted };
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
