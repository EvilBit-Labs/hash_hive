/**
 * Scheduled blob-reclamation worker (issue #106 U11).
 *
 * Runs once per day and reclaims the object-store blob (never the row) of
 * word/rule/mask list resources that have been archived longer than
 * `BLOB_RECLAMATION_RETENTION`. Modeled directly on `audit-retention.ts`:
 * a pure sweep function bounded-batch loops per resource table, wrapped by
 * a thin BullMQ `createWorker` adapter.
 *
 * ── P0: the restore-vs-sweep TOCTOU race ──────────────────────────────
 *
 * A naive "SELECT candidates, then deleteFile for each" sweep has a data-loss
 * window: an operator can restore an archived resource (clearing
 * `archived_at`) after this worker's candidate SELECT but before it calls
 * `deleteFile`, and the still-live blob would be deleted out from under the
 * now-active resource.
 *
 * This is closed with an atomic intent-stamp: for every candidate, the
 * worker first runs
 *
 *   UPDATE <table>
 *   SET blob_reclaimed_at = now()
 *   WHERE id = $id
 *     AND archived_at IS NOT NULL
 *     AND blob_reclaimed_at IS NULL
 *     AND NOT EXISTS (SELECT 1 FROM attacks WHERE <fk> = <table>.id AND attacks.archived_at IS NULL)
 *   RETURNING id
 *
 * A single guarded UPDATE is atomic in Postgres — the WHERE is evaluated and
 * applied in one statement, so a concurrent restore (which clears
 * `archived_at`) or a concurrent attack reference (which fails the NOT
 * EXISTS) makes the predicate false and the UPDATE affects zero rows.
 * `deleteFile` is called ONLY when a row comes back from `RETURNING` — a
 * race loss skips the delete entirely and both the row and its blob are left
 * untouched. See `docs/adr/0019-campaign-archiving-immutable-lifecycle.md`
 * and the plan's Risks section ("Reclamation restore-race — was a data-loss
 * bug").
 *
 * `deleteFile` failure after a successful stamp is best-effort: the stamp
 * already committed, so a warning is logged and the sweep continues rather
 * than aborting the batch or attempting to un-stamp the row.
 */

import type Redis from 'ioredis'

import { type AuditEntityType, attacks, maskLists, ruleLists, wordLists } from '@hashhive/shared'
import { type ConnectionOptions, Worker } from 'bullmq'
import { and, eq, isNotNull, isNull, sql } from 'drizzle-orm'

import type { BlobReclamationJob } from '../types.js'

import { env } from '../../config/env.js'
import { logger } from '../../config/logger.js'
import { QUEUE_NAMES } from '../../config/queue.js'
import { deleteFile } from '../../config/storage.js'
import { db } from '../../db/index.js'
import { type AuditActor, recordAuditEvent } from '../../services/audit-log.js'
import { attackFkColumnForTable } from '../../services/resources-archive.js'
import { entityTypeForTable, type ResourceTable } from '../../services/resources.js'
import { attachWorkerMetrics } from './metrics.js'

const DEFAULT_SYSTEM_ACTOR: AuditActor = { actorType: 'system', actorId: null }

/** Candidate rows selected/stamped per pass, per table. Bounds lock duration. */
const BLOB_RECLAMATION_BATCH_SIZE = 200

/** Cadence for the daily scheduler (24 h in milliseconds) — mirrors audit-retention. */
export const BLOB_RECLAMATION_SCHEDULER_INTERVAL_MS = 24 * 60 * 60 * 1_000

/** Minimal shape reclamation needs off a candidate row, regardless of table. */
interface ReclaimCandidateRow {
  id: number
  projectId: number
  fileRef: unknown
  archivedAt: Date | null
  blobReclaimedAt: Date | null
  fileChecksum: string | null
  isPermanent: boolean
  status: string
  name: string
}

export interface ReclaimResult {
  /** Rows whose blob_reclaimed_at was stamped this run (deleteFile attempted). */
  reclaimed: number
  /** Candidate rows scanned, including race-losses that were skipped. */
  scanned: number
  /** Number of SELECT passes executed, summed across all three tables. */
  passes: number
}

type DeleteBlobFn = (key: string, bucket?: string) => Promise<unknown>

/**
 * Test-only hook invoked after a row is selected as a reclaim candidate but
 * before the atomic intent-stamp UPDATE runs for it. Lets DB-lane tests
 * deterministically prove the restore-vs-sweep TOCTOU race is closed: mutate
 * the row's `archived_at` (simulating a concurrent restore) inside the hook,
 * then assert the stamp UPDATE affects zero rows and `deleteBlob` is never
 * called. No-op by default — production callers never pass this.
 */
type OnBeforeStampHook = (row: { id: number }) => Promise<void>

/**
 * Reclaim object-store blobs for word/rule/mask list resources archived past
 * `retention`, in bounded per-table batches. Exported so tests can call it
 * directly (with an injected `deleteBlob` spy) without wiring BullMQ or
 * mocking the storage module — see GOTCHAS.md on `mock.module` pollution
 * across files sharing a `bun test` process.
 */
export async function reclaimExpiredResourceBlobs({
  batchSize = BLOB_RECLAMATION_BATCH_SIZE,
  retention = env.BLOB_RECLAMATION_RETENTION,
  deleteBlob = deleteFile,
  onBeforeStamp,
}: {
  batchSize?: number
  retention?: string
  deleteBlob?: DeleteBlobFn
  onBeforeStamp?: OnBeforeStampHook
} = {}): Promise<ReclaimResult> {
  const tables: readonly ResourceTable[] = [wordLists, ruleLists, maskLists]

  let reclaimed = 0
  let scanned = 0
  let passes = 0

  for (const table of tables) {
    // oxlint-disable-next-line no-await-in-loop -- tables are swept sequentially, one at a time
    const tableResult = await reclaimTableBlobs(table, {
      batchSize,
      retention,
      deleteBlob,
      ...(onBeforeStamp ? { onBeforeStamp } : {}),
    })
    reclaimed += tableResult.reclaimed
    scanned += tableResult.scanned
    passes += tableResult.passes
  }

  logger.info({ reclaimed, scanned, passes, retention }, 'blob-reclamation: sweep complete')

  return { reclaimed, scanned, passes }
}

async function reclaimTableBlobs(
  table: ResourceTable,
  opts: {
    batchSize: number
    retention: string
    deleteBlob: DeleteBlobFn
    onBeforeStamp?: OnBeforeStampHook
  }
): Promise<ReclaimResult> {
  const { batchSize, retention, deleteBlob, onBeforeStamp } = opts
  const entityType = entityTypeForTable(table)
  const attackFk = attackFkColumnForTable(table)

  let reclaimed = 0
  let scanned = 0
  let passes = 0

  for (;;) {
    // Candidate predicate (issue #106 U11 plan Approach):
    //   - archived beyond the retention window
    //   - a blob key present (nothing to reclaim otherwise)
    //   - file_checksum captured (U12 restore-after-reclaim needs it to
    //     verify a re-upload; reclaiming a blob with no checksum would make
    //     restore unverifiable)
    //   - not already reclaimed (idempotence)
    //   - no active (non-archived) attack still referencing this resource
    // oxlint-disable-next-line no-await-in-loop -- passes must run sequentially per table
    const candidates = (await db
      .select()
      .from(table)
      .where(
        and(
          isNotNull(table.archivedAt),
          sql`${table.archivedAt} < now() - ${retention}::interval`,
          sql`${table.fileRef} ->> 'key' IS NOT NULL`,
          isNotNull(table.fileChecksum),
          isNull(table.blobReclaimedAt),
          sql`NOT EXISTS (SELECT 1 FROM ${attacks} WHERE ${and(
            eq(attackFk, table.id),
            isNull(attacks.archivedAt)
          )})`
        )
      )
      .limit(batchSize)) as unknown as ReclaimCandidateRow[]

    passes++
    scanned += candidates.length

    if (candidates.length === 0) break

    for (const row of candidates) {
      // oxlint-disable-next-line no-await-in-loop -- per-row stamp+delete is sequential (network I/O to the object store)
      const didReclaim = await reclaimOne({
        table,
        row,
        attackFk,
        deleteBlob,
        entityType,
        ...(onBeforeStamp ? { onBeforeStamp } : {}),
      })
      if (didReclaim) reclaimed++
    }

    if (candidates.length < batchSize) break
  }

  return { reclaimed, scanned, passes }
}

/**
 * Stamp-then-delete for a single candidate row. Returns `true` only when the
 * intent-stamp UPDATE actually affected a row (i.e., the race was won and
 * `deleteBlob` was attempted) — a race loss (concurrent restore or new
 * attack reference) returns `false` and leaves the row/blob untouched.
 */
async function reclaimOne(args: {
  table: ResourceTable
  row: ReclaimCandidateRow
  attackFk: ReturnType<typeof attackFkColumnForTable>
  deleteBlob: DeleteBlobFn
  entityType: AuditEntityType
  onBeforeStamp?: OnBeforeStampHook
}): Promise<boolean> {
  const { table, row, attackFk, deleteBlob, entityType, onBeforeStamp } = args
  const stampedAt = new Date()

  if (onBeforeStamp) {
    await onBeforeStamp({ id: row.id })
  }

  // P0 atomic intent-stamp: see the module docblock for the full race
  // analysis. All three guards (id, archived_at IS NOT NULL, blob_reclaimed_at
  // IS NULL) plus the NOT EXISTS reference check are folded into ONE guarded
  // UPDATE's WHERE so the whole check-and-set is a single atomic statement.
  const [stamped] = await db
    .update(table)
    .set({ blobReclaimedAt: stampedAt })
    .where(
      and(
        eq(table.id, row.id),
        isNotNull(table.archivedAt),
        isNull(table.blobReclaimedAt),
        sql`NOT EXISTS (SELECT 1 FROM ${attacks} WHERE ${and(
          eq(attackFk, table.id),
          isNull(attacks.archivedAt)
        )})`
      )
    )
    .returning({ id: table.id })

  if (!stamped) {
    // Race lost between the batch SELECT and this UPDATE (restore, or a new
    // attack reference). Zero rows affected — deleteBlob is never called and
    // the blob is preserved. This is the intended, non-error outcome.
    return false
  }

  const fileRef = row.fileRef as { key?: string; bucket?: string } | null
  if (fileRef?.key) {
    try {
      await deleteBlob(fileRef.key, fileRef.bucket)
    } catch (err) {
      // Best-effort (issue #106 U11 plan Approach): the DB stamp already
      // committed above. Log and continue — do not abort the batch and do
      // not attempt to un-stamp the row. The row stays marked reclaimed
      // even if the underlying object-store delete needs a manual follow-up.
      logger.warn(
        { err, entityType, id: row.id, key: fileRef.key },
        'blob-reclamation: deleteFile failed after intent-stamp; continuing sweep'
      )
    }
  }

  await recordAuditEvent({
    actor: DEFAULT_SYSTEM_ACTOR,
    projectId: row.projectId,
    entityType,
    entityId: row.id,
    action: 'reclaimed',
    oldRow: row as unknown as Record<string, unknown>,
    newRow: { ...row, blobReclaimedAt: stampedAt } as unknown as Record<string, unknown>,
  })

  return true
}

export function createBlobReclamationWorker(connection: Redis): Worker<BlobReclamationJob> {
  const worker = new Worker<BlobReclamationJob>(
    QUEUE_NAMES.BLOB_RECLAMATION,
    async (job) => {
      logger.debug({ jobId: job.id, triggeredAt: job.data.triggeredAt }, 'blob-reclamation job')
      return reclaimExpiredResourceBlobs()
    },
    { connection: connection as unknown as ConnectionOptions }
  )

  attachWorkerMetrics(worker, {
    queueName: QUEUE_NAMES.BLOB_RECLAMATION,
    failureMessage: 'blob-reclamation job failed',
  })

  return worker
}
