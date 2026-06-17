/**
 * Backfill script: enqueue line-count jobs for wordlists/rulelists that were
 * uploaded before line-count tracking landed (issue #229, follow-up to #99 /
 * PR #226).
 *
 * The #99 triggers fire only on new upload and on attack create/update, so
 * resources predating #99 keep `line_count NULL` forever — and the attack
 * table's Keyspace column reads "Computing..." permanently because nothing is
 * computing it. This one-shot finds every `ready` wordlist/rulelist with a null
 * `line_count` and a usable file reference, and enqueues a `LINE_COUNT` job for
 * each, reusing the existing `enqueueLineCount` + queue + worker fan-out.
 *
 * Enqueues only — it does NOT count inline. The line-count worker
 * (`worker-jobs.ts`) does the counting and the dependent-attack recompute, so
 * **the worker process must be running** for the queued jobs to drain. In the
 * Docker Compose deployment the worker runs as a service, so this holds.
 *
 * Idempotent — the candidate query selects only `line_count IS NULL` rows, and
 * `enqueueLineCount` dedups per resource via a deterministic jobId that
 * `QueueManager.enqueue` pairs with terminal eviction. A re-run before workers
 * drain collapses to the same jobs; once a worker completes, the row gains a
 * non-null `line_count` and drops out of the next run.
 *
 * Masklists are intentionally excluded — they are sized by summed `keyspace`,
 * not `line_count`, and have their own backfill (`backfill-masklist-keyspace.ts`,
 * #231).
 *
 * Resilient — a single resource's enqueue failure is logged (with its id) and
 * the run continues. The process exits non-zero if any row failed, so a caller
 * (or CI) can tell a clean run from a partial one.
 *
 * Usage:
 *   bun packages/backend/src/scripts/backfill-line-count.ts
 */
import { ruleLists, wordLists } from '@hashhive/shared'
import { and, eq, isNotNull, isNull } from 'drizzle-orm'

import { logger } from '../config/logger.js'
import { client, db } from '../db/index.js'
import { setQueueManager } from '../queue/context.js'
import { QueueManager } from '../queue/manager.js'
import { enqueueLineCount } from '../services/resources/line-count-trigger.js'

export interface BackfillSummary {
  total: number
  enqueued: number
  skippedIds: number[]
  failedIds: number[]
}

// Seam so tests can inject a capturing or throwing enqueue. `enqueueLineCount`
// is best-effort and swallows its own errors, so a real call never throws — the
// per-row failure path can only be exercised through a stub.
export const _backfillDeps = {
  enqueue: enqueueLineCount,
}

const CANDIDATE_TABLES = [
  ['wordlist', wordLists],
  ['rulelist', ruleLists],
] as const

/**
 * Enqueue a line-count job for every `ready` wordlist/rulelist with a null
 * `line_count` and a usable file reference. Returns a summary of the run.
 */
export async function backfillLineCount(): Promise<BackfillSummary> {
  const skippedIds: number[] = []
  const failedIds: number[] = []
  let total = 0
  let enqueued = 0

  for (const [resourceType, table] of CANDIDATE_TABLES) {
    const rows = await db
      .select({ id: table.id, projectId: table.projectId, fileRef: table.fileRef })
      .from(table)
      .where(and(eq(table.status, 'ready'), isNull(table.lineCount), isNotNull(table.fileRef)))

    total += rows.length
    for (const row of rows) {
      const fileRef = row.fileRef as { key?: string } | null
      if (!fileRef?.key) {
        // A `ready` row with a fileRef but no usable key is a data-integrity
        // signal, not a count candidate — name it so an operator can investigate.
        skippedIds.push(row.id)
        continue
      }

      try {
        await _backfillDeps.enqueue(resourceType, row.id, row.projectId)
        enqueued++
      } catch (err) {
        // One row's failure must not abort the run — log its id and continue.
        failedIds.push(row.id)
        logger.error(
          { err, resourceType, resourceId: row.id },
          'line-count backfill: enqueue failed, continuing'
        )
      }
    }
  }

  logger.info(
    { total, enqueued, skipped: skippedIds.length, failed: failedIds.length },
    'line-count backfill complete'
  )
  if (skippedIds.length > 0) {
    logger.warn({ skippedIds }, 'line-count backfill: rows skipped (file reference has no key)')
  }
  if (failedIds.length > 0) {
    logger.warn({ failedIds }, 'line-count backfill: rows failed to enqueue')
  }

  return { total, enqueued, skippedIds, failedIds }
}

async function run(): Promise<number> {
  // The backfill enqueues; the worker computes. enqueueLineCount no-ops when no
  // QueueManager is registered (best-effort), so we must init one here or every
  // enqueue is a silent miss — the exact failure mode this fix exists to prevent.
  const queueManager = new QueueManager()
  setQueueManager(queueManager)
  await queueManager.init()
  try {
    const summary = await backfillLineCount()
    return summary.failedIds.length
  } finally {
    await queueManager.shutdown()
  }
}

if (import.meta.main) {
  run()
    .then(async (failed) => {
      await client.end()
      // Non-zero exit when any row failed so partial runs are detectable.
      if (failed > 0) process.exit(1)
    })
    .catch(async (err) => {
      logger.error({ err }, 'line-count backfill failed')
      await client.end()
      process.exit(1)
    })
}
