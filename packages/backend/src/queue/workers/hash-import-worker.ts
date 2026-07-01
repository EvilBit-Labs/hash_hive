/**
 * U7 — Hash import propagation worker.
 *
 * Reads staged ParsedImportPair[] from the object store (KTD3: no cleartext
 * in Redis), upserts target-list rows with provenance and a setWhere guard
 * (KTD2), records one audit event at the target hash-list scope (KTD9), then
 * propagates each plaintext system-wide via propagateCrack (U2).
 *
 * Operation order (CRITICAL — see NOTE in propagation.ts):
 *   1. Upsert all target-list rows — FIRST
 *      The `setWhere: crackedAt IS NULL` guard writes provenance only to rows
 *      that were not already cracked. Running propagateCrack first would crack
 *      the target row and the subsequent upsert's guard would skip it, losing
 *      the import provenance entirely.
 *   2. Record audit event once — SECOND (summary counts are final by then)
 *   3. propagateCrack — THIRD (target row already cracked before cross-list fill)
 *
 * Exported surface:
 *   - `processImportPairs` — the testable DB core; real-DB tests call it directly
 *     without needing Redis or a live S3 connection.
 *   - `buildHashImportJobId` — deterministic jobId helper used by U8 at enqueue
 *     time; QueueManager auto-pairs a non-empty jobId with removeOnComplete +
 *     removeOnFail eviction (repo memory: BullMQ dedup requires eviction).
 *   - `createHashImportWorker` — thin BullMQ factory that wraps the core.
 */

import type Redis from 'ioredis'

import { hashItems } from '@hashhive/shared'
import { type ConnectionOptions, Worker } from 'bullmq'
import { and, eq, inArray, isNull, sql } from 'drizzle-orm'

import type { AuditActor } from '../../services/audit-log.js'
import type { ParsedImportPair } from '../../services/hash-items/import-parse.js'
import type { HashImportPropagationJob } from '../types.js'

import { logger } from '../../config/logger.js'
import { QUEUE_NAMES } from '../../config/queue.js'
import { downloadFile } from '../../config/storage.js'
import { db } from '../../db/index.js'
import { recordAuditEvent } from '../../services/audit-log.js'
import { propagateCrack } from '../../services/hash-items/propagation.js'
import { attachWorkerMetrics } from './metrics.js'

// ─── Constants ────────────────────────────────────────────────────────────────

/**
 * Maximum rows per upsert batch. Keeps individual INSERT...ON CONFLICT
 * statements below PostgreSQL's parameter limit (~65 535) and avoids
 * long-running row-level locks on large imports.
 */
const IMPORT_BATCH_SIZE = 500

// ─── Types ────────────────────────────────────────────────────────────────────

/** Result returned by processImportPairs and surfaced as the BullMQ job result. */
export interface HashImportResult {
  /** Rows in the target list whose hashValue appeared in the import (pre-existing matches). */
  matchedInList: number
  /** Subset of matchedInList that were uncracked and newly cracked by this import. */
  crackedInList: number
  /** Parse-time skip count passed through from U6 for the complete response summary. */
  skipped: number
}

// ─── JobId helper ─────────────────────────────────────────────────────────────

/**
 * Builds the deterministic BullMQ jobId for a hash import job.
 *
 * Keyed on `hashListId` + `stagingKey`. The staging key is a per-upload UUID
 * (set by U8), so this is effectively per-import unique. Passing this jobId to
 * `QueueManager.enqueue` is all that is needed for eviction: the manager
 * unconditionally adds `removeOnComplete: true` and `removeOnFail: true`
 * whenever a jobId is present (see queue/manager.ts), preventing the deduped
 * key from blocking future re-adds after a terminal state.
 */
export function buildHashImportJobId(hashListId: number, stagingKey: string): string {
  return `hash-import:${hashListId}:${stagingKey}`
}

// ─── Core processor ───────────────────────────────────────────────────────────

/**
 * Process a set of parsed import pairs against a target hash list.
 *
 * Exported for real-DB testing — the DB test suite calls this directly with
 * seeded pairs, bypassing Redis and S3 entirely.
 *
 * @param pairs          Parsed pairs from U6 (or from a deserialized staging file).
 * @param hashListId     The target hash list to upsert into.
 * @param projectId      The project owning the hash list (for audit scope).
 * @param actor          Auth-context actor from the originating request.
 * @param skippedFromParse  Lines skipped during U6 parsing — passed through for summary.
 */
export async function processImportPairs(
  pairs: readonly ParsedImportPair[],
  hashListId: number,
  projectId: number,
  actor: AuditActor,
  skippedFromParse: number
): Promise<HashImportResult> {
  // Deduplicate by hashValue: last occurrence wins within a single import.
  // Prevents "cannot affect the same row twice in a single command" errors
  // on the ON CONFLICT upsert when the file contains duplicate hashes.
  const pairMap = new Map<string, ParsedImportPair>()
  for (const pair of pairs) {
    pairMap.set(pair.hashValue, pair)
  }
  const dedupedPairs = [...pairMap.values()]

  let totalMatched = 0
  let totalCracked = 0
  const crackedAt = new Date()

  // ── Phase 1: upsert target-list rows ───────────────────────────────────────
  //
  // For each batch:
  //   a) Pre-count how many import hashes exist in the target list and how many
  //      are still uncracked. This gives `matchedInList` and `crackedInList`
  //      without depending on the conditional upsert's RETURNING behaviour.
  //   b) Upsert with `setWhere: crackedAt IS NULL` (KTD2): INSERT new rows with
  //      provenance; on conflict update only rows that were not yet cracked so
  //      existing attribution FKs (campaignId/taskId/agentId/attackId) and
  //      source/username are preserved for already-cracked rows.
  //
  // NOTE: Newly inserted rows (hashValue not already in the list) are NOT
  // counted in matchedInList — they were not pre-existing matches. They are
  // inserted as pre-cracked entries with source='import' and crackedAt set.

  for (let i = 0; i < dedupedPairs.length; i += IMPORT_BATCH_SIZE) {
    const batch = dedupedPairs.slice(i, i + IMPORT_BATCH_SIZE)
    const hashValues = batch.map((p) => p.hashValue)

    const [preCount] = await db
      .select({
        matched: sql<number>`count(*)::int`,
        willCrack: sql<number>`count(*) FILTER (WHERE ${hashItems.crackedAt} IS NULL)`,
      })
      .from(hashItems)
      .where(and(eq(hashItems.hashListId, hashListId), inArray(hashItems.hashValue, hashValues)))

    totalMatched += Number(preCount?.matched ?? 0)
    totalCracked += Number(preCount?.willCrack ?? 0)

    await db
      .insert(hashItems)
      .values(
        batch.map((p) => ({
          hashListId,
          hashValue: p.hashValue,
          plaintext: p.plaintext,
          crackedAt,
          source: 'import',
          ...(p.username !== undefined ? { username: p.username } : {}),
        }))
      )
      .onConflictDoUpdate({
        target: [hashItems.hashListId, hashItems.hashValue],
        set: {
          plaintext: sql`EXCLUDED.plaintext`,
          crackedAt: sql`EXCLUDED.cracked_at`,
          source: sql`EXCLUDED.source`,
          username: sql`EXCLUDED.username`,
        },
        setWhere: isNull(hashItems.crackedAt),
      })
  }

  // ── Phase 2: audit event ────────────────────────────────────────────────────
  //
  // Recorded once after all upserts so the summary counts are final (KTD9).
  // Entity scope is hash_list / 'updated' — the import is a bulk mutation
  // of the list's hash items. The newRow carries the import summary so the
  // audit trail documents what the operator pushed in.
  await recordAuditEvent({
    actor,
    projectId,
    entityType: 'hash_list',
    entityId: hashListId,
    action: 'updated',
    reason: 'import',
    newRow: {
      matchedInList: totalMatched,
      crackedInList: totalCracked,
      skipped: skippedFromParse,
    },
  })

  // ── Phase 3: system-wide propagation ───────────────────────────────────────
  //
  // Runs AFTER the target-list upsert. The target row's crackedAt is now set,
  // so propagateCrack's own `crackedAt IS NULL` guard will not overwrite it —
  // only rows in OTHER lists (and other projects) will receive the plaintext.
  for (const pair of dedupedPairs) {
    const { updated } = await propagateCrack(pair.hashValue, pair.plaintext)
    if (updated > 0) {
      logger.debug(
        { hashValue: pair.hashValue, updated },
        'hash-import-worker: propagated crack to other lists'
      )
    }
  }

  return {
    matchedInList: totalMatched,
    crackedInList: totalCracked,
    skipped: skippedFromParse,
  }
}

// ─── Worker factory ───────────────────────────────────────────────────────────

/**
 * Creates the BullMQ worker for the HASH_IMPORT_PROPAGATION queue.
 *
 * The worker is a thin shell: it downloads the staged pairs JSON from S3
 * (KTD3 — cleartext never serialised into Redis) and delegates to
 * `processImportPairs` for all database work. Metrics and failure logging
 * are wired via `attachWorkerMetrics`.
 */
export function createHashImportWorker(connection: Redis): Worker<HashImportPropagationJob> {
  const worker = new Worker<HashImportPropagationJob>(
    QUEUE_NAMES.HASH_IMPORT_PROPAGATION,
    async (job) => {
      const { stagingKey, hashListId, projectId, actor, skippedFromParse } = job.data

      logger.info({ jobId: job.id, hashListId, stagingKey }, 'hash-import-worker: starting')

      // Download staged pairs — cleartext lives only in the object store (KTD3).
      const download = await downloadFile(stagingKey)
      const body = await download.Body?.transformToString('utf-8')
      if (!body) {
        throw new Error(`hash-import-worker: staging file empty or missing — key=${stagingKey}`)
      }

      const pairs = JSON.parse(body) as ParsedImportPair[]

      const result = await processImportPairs(pairs, hashListId, projectId, actor, skippedFromParse)

      logger.info({ jobId: job.id, hashListId, ...result }, 'hash-import-worker: complete')

      return result
    },
    { connection: connection as unknown as ConnectionOptions }
  )

  attachWorkerMetrics(worker, {
    queueName: QUEUE_NAMES.HASH_IMPORT_PROPAGATION,
    failureMessage: 'Hash import propagation failed',
    extractContext: (job) => ({
      hashListId: job?.data?.hashListId,
      stagingKey: job?.data?.stagingKey,
    }),
  })

  worker.on('failed', async (job, err) => {
    logger.error(
      {
        err,
        jobId: job?.id,
        hashListId: job?.data?.hashListId,
        stagingKey: job?.data?.stagingKey,
        attemptsMade: job?.attemptsMade,
      },
      'hash-import-worker: job failed'
    )
  })

  return worker
}
