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
 * Resilient — a single resource's enqueue failure (a throw, or an enqueue that
 * reports the queue was unavailable) is logged with its ref and the run
 * continues. The process exits non-zero if any row failed to enqueue, or if
 * Redis is not connected after queue init. Rows skipped for a missing file-ref
 * key are a separate, permanent data-integrity condition (re-running will not
 * fix them): they are logged at warn but do not affect the exit code, so a
 * clean exit means "every countable row was enqueued", not "zero rows skipped".
 *
 * Usage (from the repo root — the --filter form sets CWD to packages/backend so
 * env validation finds packages/backend/.env):
 *   just backfill-line-count
 *   # or: bun --filter @hashhive/backend backfill:line-count
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
  /**
   * Qualified `resourceType:id` refs (e.g. "wordlist:5"). Wordlists and rulelists
   * have independent id sequences and can collide on a bare number, so refs are
   * tagged with the resource type to keep operator logs unambiguous.
   */
  skipped: string[]
  failed: string[]
}

// Seam so tests can inject a capturing or throwing enqueue. `enqueueLineCount`
// wraps its whole body in try/catch and returns false on any error, so in the
// current implementation a real call does not throw — the per-row catch is
// exercised through a stub.
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
  const skipped: string[] = []
  const failed: string[] = []
  let total = 0
  let enqueued = 0

  for (const [resourceType, table] of CANDIDATE_TABLES) {
    const rows = await db
      .select({ id: table.id, projectId: table.projectId, fileRef: table.fileRef })
      .from(table)
      .where(and(eq(table.status, 'ready'), isNull(table.lineCount), isNotNull(table.fileRef)))

    total += rows.length
    for (const row of rows) {
      const ref = `${resourceType}:${row.id}`
      const fileRef = row.fileRef as { key?: string } | null
      if (!fileRef?.key) {
        // A `ready` row with a fileRef but no usable key is a data-integrity
        // signal, not a count candidate — name it so an operator can investigate.
        skipped.push(ref)
        continue
      }

      try {
        const ok = await _backfillDeps.enqueue(resourceType, row.id, row.projectId)
        if (ok) {
          enqueued++
        } else {
          // enqueueLineCount returns false (rather than throwing) when the queue
          // is unavailable — e.g. Redis down and the queue map is empty. Counting
          // it as enqueued would report a clean run while queuing nothing, so
          // record it as a failure.
          failed.push(ref)
          logger.warn(
            { resourceType, resourceId: row.id },
            'line-count backfill: enqueue reported not enqueued (queue unavailable?), continuing'
          )
        }
      } catch (err) {
        // One row's failure must not abort the run — log its ref and continue.
        failed.push(ref)
        logger.error(
          { err, resourceType, resourceId: row.id },
          'line-count backfill: enqueue failed, continuing'
        )
      }
    }
  }

  logger.info(
    { total, enqueued, skipped: skipped.length, failed: failed.length },
    'line-count backfill complete'
  )
  if (skipped.length > 0) {
    logger.warn({ skipped }, 'line-count backfill: rows skipped (file reference has no key)')
  }
  if (failed.length > 0) {
    logger.warn({ failed }, 'line-count backfill: rows failed to enqueue')
  }

  return { total, enqueued, skipped, failed }
}

async function run(): Promise<number> {
  // The backfill enqueues; the worker computes. enqueueLineCount no-ops when no
  // QueueManager is registered (best-effort), so we must init one here or every
  // enqueue is a silent miss — the exact failure mode this fix exists to prevent.
  const queueManager = new QueueManager()
  setQueueManager(queueManager)
  await queueManager.init()
  try {
    // QueueManager.init() swallows a Redis connect failure and returns with an
    // empty queue map, so a down Redis would otherwise let every enqueue no-op
    // while the run still reports success. Fail loudly instead.
    if (queueManager.getRedisStatus() !== 'connected') {
      throw new Error('Redis is not connected after queue init; cannot enqueue line-count jobs')
    }
    const summary = await backfillLineCount()
    return summary.failed.length
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
