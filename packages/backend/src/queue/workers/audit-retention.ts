/**
 * Scheduled audit-retention worker (U9).
 *
 * Runs once per day and purges `audit_logs` rows older than
 * `AUDIT_LOG_RETENTION` in bounded batches. Bounded deletes avoid holding a
 * single long-running table lock on large purges; the loop continues until a
 * pass removes zero rows.
 *
 * Orphaned rows (project_id IS NULL, produced when a project is deleted) are
 * covered by the plain `created_at < cutoff` predicate — no project_id filter
 * excludes them.
 *
 * `AUDIT_LOG_RETENTION` is validated against INTERVAL_LITERAL at startup
 * (env.ts), so interpolating it as a bound parameter is injection-safe.
 */

import type Redis from 'ioredis'

import { auditLogs } from '@hashhive/shared'
import { type ConnectionOptions, Worker } from 'bullmq'
import { inArray, sql } from 'drizzle-orm'

import type { AuditRetentionJob } from '../types.js'

import { env } from '../../config/env.js'
import { logger } from '../../config/logger.js'
import { QUEUE_NAMES } from '../../config/queue.js'
import { db } from '../../db/index.js'
import { attachWorkerMetrics } from './metrics.js'

/** Rows removed per DELETE pass. Keeps individual statements short. */
const AUDIT_RETENTION_BATCH_SIZE = 500

/** Cadence for the daily scheduler (24 h in milliseconds). */
export const AUDIT_RETENTION_SCHEDULER_INTERVAL_MS = 24 * 60 * 60 * 1_000

export interface PurgeResult {
  /** Total rows deleted across all passes. */
  deleted: number
  /** Number of DELETE passes executed. */
  passes: number
}

/**
 * Delete audit_logs rows older than `retention` in bounded batches.
 *
 * `retention` is validated against INTERVAL_LITERAL at startup (env.ts), so
 * interpolating it as a bound SQL parameter is injection-safe. Inlining the
 * interval expression directly into the WHERE clause avoids a separate
 * cutoff-compute query and keeps the logic minimal.
 *
 * Exported so tests can call it directly without wiring BullMQ.
 */
export async function purgeExpiredAuditLogs({
  batchSize = AUDIT_RETENTION_BATCH_SIZE,
  retention = env.AUDIT_LOG_RETENTION,
}: {
  batchSize?: number
  retention?: string
} = {}): Promise<PurgeResult> {
  let totalDeleted = 0
  let passes = 0

  // biome-ignore lint/correctness/noConstantCondition: deliberate loop
  while (true) {
    const deleted = await db
      .delete(auditLogs)
      .where(
        inArray(
          auditLogs.id,
          db
            .select({ id: auditLogs.id })
            .from(auditLogs)
            .where(sql`${auditLogs.createdAt} < now() - ${retention}::interval`)
            .limit(batchSize)
        )
      )
      .returning({ id: auditLogs.id })

    passes++
    totalDeleted += deleted.length

    if (deleted.length < batchSize) {
      break
    }
  }

  logger.info({ deleted: totalDeleted, passes, retention }, 'audit-retention: purge complete')

  return { deleted: totalDeleted, passes }
}

export function createAuditRetentionWorker(connection: Redis): Worker<AuditRetentionJob> {
  const worker = new Worker<AuditRetentionJob>(
    QUEUE_NAMES.AUDIT_RETENTION,
    async (job) => {
      logger.debug({ jobId: job.id, triggeredAt: job.data.triggeredAt }, 'audit-retention job')
      return purgeExpiredAuditLogs()
    },
    { connection: connection as unknown as ConnectionOptions }
  )

  attachWorkerMetrics(worker, {
    queueName: QUEUE_NAMES.AUDIT_RETENTION,
    failureMessage: 'audit-retention job failed',
  })

  return worker
}
