/**
 * U7 — Hash import propagation worker.
 *
 * Reads staged ParsedImportPair[] from the object store (KTD3: no cleartext
 * in Redis), upserts target-list rows with provenance and a setWhere guard
 * (KTD2), records one audit event at the target hash-list scope (KTD9), then
 * propagates each plaintext within the owning project via propagateCrack (U2).
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
 *   - `runHashImportJob` — extracted worker body (download → parse → process →
 *     success-delete); unit-testable with mocked storage.
 *   - `buildHashImportJobId` — deterministic jobId helper called by
 *     `stageAndEnqueueImport` (import-intake.ts) at enqueue time; QueueManager
 *     auto-pairs a non-empty jobId with removeOnComplete + removeOnFail eviction
 *     (repo memory: BullMQ dedup requires eviction).
 *   - `createHashImportWorker` — thin BullMQ factory that wraps the core.
 */

import type { ImportSummary } from '@hashhive/shared'
import type Redis from 'ioredis'

import { auditLogs, hashItems } from '@hashhive/shared'
import { type ConnectionOptions, UnrecoverableError, Worker } from 'bullmq'
import { and, eq, inArray, isNull, sql } from 'drizzle-orm'

import type { AuditActor } from '../../services/audit-log.js'
import type { ParsedImportPair } from '../../services/hash-items/import-parse.js'
import type { HashImportPropagationJob } from '../types.js'

import { logger } from '../../config/logger.js'
import { DEFAULT_JOB_ATTEMPTS, QUEUE_NAMES } from '../../config/queue.js'
import { deleteFile, downloadFile } from '../../config/storage.js'
import { db } from '../../db/index.js'
import { recordAuditEvent } from '../../services/audit-log.js'
import { upsertCrackedSet } from '../../services/hash-items/cracked-set.js'
import { propagateCrack } from '../../services/hash-items/propagation.js'
import { attachWorkerMetrics } from './metrics.js'

// ─── Constants ────────────────────────────────────────────────────────────────

/**
 * Maximum rows per upsert batch. Keeps individual INSERT...ON CONFLICT
 * statements below PostgreSQL's parameter limit (~65 535) and avoids
 * long-running row-level locks on large imports.
 */
const IMPORT_BATCH_SIZE = 500

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

// ─── Private helpers ──────────────────────────────────────────────────────────

/**
 * Phase 1: Upsert deduped pairs into the target hash list in batches.
 *
 * For each batch:
 *   a) Pre-count how many import hashes exist in the target list and how many
 *      are still uncracked. This gives `matchedInList` and `crackedInList`
 *      without depending on the conditional upsert's RETURNING behaviour.
 *   b) Upsert with `setWhere: crackedAt IS NULL` (KTD2): INSERT new rows with
 *      provenance; on conflict update only rows that were not yet cracked so
 *      existing attribution FKs (campaignId/taskId/agentId/attackId) and
 *      source/username are preserved for already-cracked rows.
 *
 * NOTE: Newly inserted rows (hashValue not already in the list) are NOT
 * counted in matchedInList — they were not pre-existing matches. They are
 * inserted as pre-cracked entries with source='import' and crackedAt set.
 *
 * RF1 (cracked-set population): each imported crack also records a
 * `(projectId, hashcatMode, hashValue)` row in `project_cracked_hashes` via
 * `upsertCrackedSet`, inside the SAME transaction as the per-list upsert —
 * mirroring `updateTaskProgress` (services/tasks.ts). Without this, an import
 * crack would fill `hash_items` but never enter the project cracked-set, so it
 * would not zap project-wide until a backfill ran. `upsertCrackedSet` no-ops
 * when `hashcatMode` is null (KTD3) and never moves the keyset `crackedAt` on
 * conflict (KTD2), so a re-import only refreshes plaintext.
 */
async function upsertTargetListBatches(
  dedupedPairs: ParsedImportPair[],
  hashListId: number,
  projectId: number,
  hashcatMode: number | null,
  crackedAt: Date
): Promise<{ totalMatched: number; totalCracked: number }> {
  let totalMatched = 0
  let totalCracked = 0

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

    // RF1 (feasibility F5, mirrors updateTaskProgress): the per-list hash_items
    // upsert and the project-wide cracked-set upsert must land atomically — a
    // crack must never be visible in one but not the other.
    await db.transaction(async (tx) => {
      await tx
        .insert(hashItems)
        .values(
          batch.map((p) => ({
            hashListId,
            hashValue: p.hashValue,
            plaintext: p.plaintext,
            crackedAt,
            // KTD3: stamp the target list's resolved mode so read/zap/propagate
            // all key off ONE authoritative mode column. Null when the list has
            // no hash type (leaves the row mode-less — it never cross-list dedups).
            detectedHashcatMode: hashcatMode,
            source: 'import',
            ...(p.username !== undefined ? { username: p.username } : {}),
          }))
        )
        .onConflictDoUpdate({
          target: [hashItems.hashListId, hashItems.hashValue],
          set: {
            plaintext: sql`EXCLUDED.plaintext`,
            crackedAt: sql`EXCLUDED.cracked_at`,
            // Preserve a previously-stamped mode when this import carries none,
            // but adopt the resolved mode when it does (KTD3).
            detectedHashcatMode: sql`COALESCE(EXCLUDED.detected_hashcat_mode, ${hashItems.detectedHashcatMode})`,
            // Preserve the row's existing source ('upload') on conflict — the
            // source column records how the ROW entered the list, not how it
            // was cracked. COALESCE keeps the existing origin when set; only
            // fills NULL origins (e.g. a bare INSERT without source) from import.
            source: sql`COALESCE(${hashItems.source}, EXCLUDED.source)`,
            // COALESCE so an import pair without a username (e.g. a plain
            // hash:plaintext potfile line) does NOT null out an existing username
            // on an uncracked row (a `user:hash:` upload leaves username set but
            // crackedAt NULL, so the setWhere guard would otherwise overwrite it).
            username: sql`COALESCE(EXCLUDED.username, ${hashItems.username})`,
          },
          setWhere: isNull(hashItems.crackedAt),
        })

      // RF1 / KTD3: record every imported crack in the project cracked-set so it
      // zaps project-wide immediately. upsertCrackedSet no-ops when hashcatMode
      // is null, so a mode-less import stays list-local (never cross-list dedups).
      if (hashcatMode != null) {
        for (const p of batch) {
          await upsertCrackedSet(tx, {
            projectId,
            hashcatMode,
            hashValue: p.hashValue,
            plaintext: p.plaintext,
            sourceHashListId: hashListId,
          })
        }
      }
    })
  }

  return { totalMatched, totalCracked }
}

/**
 * Phase 2: Record one audit event summarising the import outcome.
 *
 * Called after all upserts so the summary counts are final (KTD9). Entity scope
 * is hash_list / 'updated' — the import is a bulk mutation of the list's hash
 * items. The newRow carries `importKey` (the staging key) so the audit trail
 * can deduplicate on BullMQ retries: if a retry re-runs Phase 2, the
 * read-before-write check below finds the existing row and skips the insert.
 *
 * POSITION IS INTENTIONAL — must run after Phase 1 (counts are final) and
 * before Phase 3 (audit gap if propagation fails permanently).
 *
 * Race safety: BullMQ processes one attempt of a given jobId at a time — there
 * is no concurrent retry — so the SELECT + conditional INSERT is race-safe here.
 */
async function recordImportAudit(
  actor: AuditActor,
  projectId: number,
  hashListId: number,
  counts: { totalMatched: number; totalCracked: number },
  skippedFromParse: number,
  stagingKey: string
): Promise<void> {
  // Dedup check: skip if we already wrote an audit row for this staging key.
  // `changes->'importKey'->>'new'` navigates the computed diff JSON that
  // recordAuditEvent stores — importKey appears as `{ "new": "<stagingKey>" }`
  // because the allowlisted synthetic key has no oldRow counterpart.
  const existing = await db
    .select({ id: auditLogs.id })
    .from(auditLogs)
    .where(
      and(
        eq(auditLogs.entityType, 'hash_list'),
        eq(auditLogs.entityId, hashListId),
        eq(auditLogs.reason, 'import'),
        sql`${auditLogs.changes}->'importKey'->>'new' = ${stagingKey}`
      )
    )
    .limit(1)

  if (existing.length > 0) {
    logger.info(
      { hashListId, stagingKey },
      'hash-import-worker: skipping duplicate audit row (BullMQ retry)'
    )
    return
  }

  await recordAuditEvent({
    actor,
    projectId,
    entityType: 'hash_list',
    entityId: hashListId,
    action: 'updated',
    reason: 'import',
    newRow: {
      matchedInList: counts.totalMatched,
      crackedInList: counts.totalCracked,
      skipped: skippedFromParse,
      importKey: stagingKey,
    },
  })
}

/**
 * Phase 3: Propagate cracked plaintexts within the owning project via propagateCrack.
 *
 * Runs AFTER the target-list upsert. The target row's crackedAt is now set,
 * so propagateCrack's own `crackedAt IS NULL` guard will not overwrite it —
 * only uncracked rows in OTHER lists OF THE SAME PROJECT receive the plaintext
 * (project scope closes the pre-existing cross-tenant leak, security F2).
 *
 * Precheck first: after Phase 1 every imported hash's target-list row is
 * cracked, so any hashValue that still has an uncracked row must live in
 * another list — those are the only pairs worth propagating. Batched
 * selectDistinct over the hash_value index turns N per-pair no-op SELECTs
 * (the common case, where a hash exists only in the target list) into
 * ceil(N / IMPORT_BATCH_SIZE) queries. propagateCrack's own guard still
 * protects correctness if a concurrent crack lands between precheck and call.
 */
async function propagateImportedCracks(
  dedupedPairs: ParsedImportPair[],
  projectId: number,
  hashcatMode: number | null
): Promise<void> {
  // KTD3: a mode-less import has nothing to cross-list dedup against — every
  // fill would be against an unrelated row of unknown mode. Skip propagation.
  if (hashcatMode == null) return

  const hashesToPropagate = new Set<string>()
  for (let i = 0; i < dedupedPairs.length; i += IMPORT_BATCH_SIZE) {
    const chunk = dedupedPairs.slice(i, i + IMPORT_BATCH_SIZE).map((p) => p.hashValue)
    const uncrackedElsewhere = await db
      .selectDistinct({ hashValue: hashItems.hashValue })
      .from(hashItems)
      .where(and(inArray(hashItems.hashValue, chunk), isNull(hashItems.crackedAt)))
    for (const row of uncrackedElsewhere) hashesToPropagate.add(row.hashValue)
  }

  for (const pair of dedupedPairs) {
    if (!hashesToPropagate.has(pair.hashValue)) continue
    const { updated } = await propagateCrack(pair.hashValue, pair.plaintext, projectId, hashcatMode)
    if (updated > 0) {
      logger.debug({ updated }, 'hash-import-worker: propagated crack to other lists')
    }
  }
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
 * @param stagingKey        The S3 staging key for this import batch; used as an
 *                          idempotency token in the audit row so BullMQ retries
 *                          do not write a duplicate audit event (item I).
 * @param hashcatMode       The target list's resolved hashcat mode, or `null`
 *                          when it has no hash type set. Stamps
 *                          `detected_hashcat_mode`, drives cracked-set
 *                          population (RF1), and mode-scopes propagation (KTD3).
 */
export async function processImportPairs(
  pairs: readonly ParsedImportPair[],
  hashListId: number,
  projectId: number,
  actor: AuditActor,
  skippedFromParse: number,
  stagingKey: string,
  hashcatMode: number | null
): Promise<ImportSummary> {
  // Deduplicate by hashValue: last occurrence wins within a single import.
  // Prevents "cannot affect the same row twice in a single command" errors
  // on the ON CONFLICT upsert when the file contains duplicate hashes.
  const pairMap = new Map<string, ParsedImportPair>()
  for (const pair of pairs) {
    pairMap.set(pair.hashValue, pair)
  }
  const dedupedPairs = [...pairMap.values()]

  const crackedAt = new Date()

  // Phase 1: upsert target-list rows (+ cracked-set population, RF1)
  const { totalMatched, totalCracked } = await upsertTargetListBatches(
    dedupedPairs,
    hashListId,
    projectId,
    hashcatMode,
    crackedAt
  )

  // Phase 2: audit event (CRITICAL position — after counts are final, before propagation)
  await recordImportAudit(
    actor,
    projectId,
    hashListId,
    { totalMatched, totalCracked },
    skippedFromParse,
    stagingKey
  )

  // Phase 3: project-scoped, mode-scoped propagation (security F2 / KTD3)
  await propagateImportedCracks(dedupedPairs, projectId, hashcatMode)

  return {
    matchedInList: totalMatched,
    crackedInList: totalCracked,
    skipped: skippedFromParse,
  }
}

// ─── Worker job body ─────────────────────────────────────────────────────────

/**
 * Execute a single hash import propagation job.
 *
 * Extracted from the BullMQ worker closure so the download → parse → process →
 * success-delete path is unit-testable with mocked storage (inject a spy over
 * `downloadFile` / `deleteFile`). The `failed` event handler cleanup (final
 * retry exhausted) stays in the worker shell.
 *
 * Staging file lifecycle within this function:
 *   - Deleted on success.
 *   - Deleted immediately before throwing `UnrecoverableError` (corrupt JSON) —
 *     no retries will run so cleanup happens at throw time.
 *   - NOT deleted on retriable failures — the worker shell's `failed` handler
 *     cleans up only when `attemptsMade >= attempts`.
 */
export async function runHashImportJob(
  data: HashImportPropagationJob,
  jobId: string | undefined
): Promise<ImportSummary> {
  const { stagingKey, hashListId, projectId, actor, skippedFromParse, hashcatMode } = data

  logger.info({ jobId, hashListId, stagingKey }, 'hash-import-worker: starting')

  // Download staged pairs — cleartext lives only in the object store (KTD3).
  const download = await downloadFile(stagingKey)
  const body = await download.Body?.transformToString('utf-8')
  if (!body) {
    throw new Error(`hash-import-worker: staging file empty or missing — key=${stagingKey}`)
  }

  // Parse the staging file. A corrupt file is a permanent failure — burn no
  // retry attempts on it. Clean up the staging file before throwing so it
  // does not accumulate in the object store.
  let pairs: ParsedImportPair[]
  try {
    pairs = JSON.parse(body) as ParsedImportPair[]
  } catch (parseErr) {
    await deleteFile(stagingKey).catch((cleanupErr) =>
      logger.warn(
        { err: cleanupErr, stagingKey },
        'hash-import-worker: staging cleanup after parse error failed'
      )
    )
    const parseMessage = parseErr instanceof Error ? parseErr.message : String(parseErr)
    throw new UnrecoverableError(
      `hash-import-worker: staging file is not valid JSON — key=${stagingKey}, parseError=${parseMessage}`
    )
  }

  const result = await processImportPairs(
    pairs,
    hashListId,
    projectId,
    actor,
    skippedFromParse,
    stagingKey,
    hashcatMode
  )

  logger.info({ jobId, hashListId, ...result }, 'hash-import-worker: complete')

  // Delete the staging file on success — recovered-password files must not
  // accumulate in the object store indefinitely.
  await deleteFile(stagingKey).catch((err) =>
    logger.warn({ err, stagingKey }, 'hash-import-worker: staging cleanup failed')
  )

  return result
}

// ─── Worker factory ───────────────────────────────────────────────────────────

/**
 * Creates the BullMQ worker for the HASH_IMPORT_PROPAGATION queue.
 *
 * The worker is a thin shell: it delegates to `runHashImportJob` for all
 * download/parse/DB work. Metrics and failure logging are wired via
 * `attachWorkerMetrics`.
 *
 * Staging file lifecycle:
 *   - Deleted on success — recovered-password files must not accumulate.
 *   - Deleted on FINAL failure (retries exhausted) — file is unreadable or
 *     the error is permanent; keeping it serves no purpose.
 *   - NOT deleted on retriable failures — the retry needs to re-read the file.
 *   - Deleted immediately before throwing UnrecoverableError (corrupt JSON) —
 *     no retries will run, so cleanup happens at throw time.
 */
export function createHashImportWorker(connection: Redis): Worker<HashImportPropagationJob> {
  const worker = new Worker<HashImportPropagationJob>(
    QUEUE_NAMES.HASH_IMPORT_PROPAGATION,
    async (job) => runHashImportJob(job.data, job.id),
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

    // Delete the staging file only when retries are exhausted — retriable
    // attempts still need to re-read it. UnrecoverableError jobs are handled
    // at throw time (file already deleted before the error is raised).
    if (job && (job.attemptsMade ?? 0) >= (job.opts?.attempts ?? DEFAULT_JOB_ATTEMPTS)) {
      await deleteFile(job.data.stagingKey).catch((cleanupErr) =>
        logger.warn(
          { err: cleanupErr, stagingKey: job.data.stagingKey },
          'hash-import-worker: staging cleanup after failure failed'
        )
      )
    }
  })

  return worker
}
