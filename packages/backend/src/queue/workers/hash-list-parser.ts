import type { HashListTypeAnalysis } from '@hashhive/shared'
import type Redis from 'ioredis'

import { hashItems, hashLists, hashTypes } from '@hashhive/shared'
import { type ConnectionOptions, Worker } from 'bullmq'
import { and, count, eq, sql } from 'drizzle-orm'

import type { HashListParseJob } from '../types.js'

import { logger } from '../../config/logger.js'
import { DEFAULT_JOB_ATTEMPTS, QUEUE_NAMES } from '../../config/queue.js'
import { db } from '../../db/index.js'
import { emitResourceUpdate } from '../../services/events.js'
import { guessTopHashType } from '../../services/hash-analysis.js'
import {
  buildTypeAnalysis,
  TYPE_DETECTION_SCAN_CAP,
} from '../../services/hash-items/type-analysis.js'
import { MAX_LINE_LENGTH, streamLines } from '../../services/resources/line-count.js'
import { attachWorkerMetrics } from './metrics.js'

const BATCH_SIZE = 5_000

/**
 * Map a parse failure to an operator-facing string safe to broadcast over
 * the resource_update WebSocket. Raw `err.message` from Drizzle / Postgres
 * embeds SQL text and column names; this strips the wire payload down to
 * a stable enum of operator-meaningful reasons.
 */
function sanitizeParseError(err: unknown): string {
  if (!(err instanceof Error)) return 'Hash list parse failed'
  const msg = err.message.toLowerCase()
  if (msg.includes('no file reference') || msg.includes('missing file')) {
    return 'Hash list has no uploaded file'
  }
  if (msg.includes('empty file body') || msg.includes('empty body')) {
    return 'Uploaded file is empty'
  }
  // Anchored "hash list" prefix avoids collapsing Postgres "relation ...
  // not found" / Redis "key not found" / generic "not found" errors into
  // a misleading "Hash list not found" wire message.
  if (/\bhash list .* not found\b/i.test(err.message)) {
    return 'Hash list not found'
  }
  if (msg.includes('timeout') || msg.includes('econnrefused') || msg.includes('etimedout')) {
    return 'Storage backend unavailable'
  }
  // Default — never leak the raw SQL/internal message to the wire.
  return 'Hash list parse failed'
}

/**
 * Parse a single hash line into an insert value. Supports:
 *
 *   - `hash`                          1 token  -> { hashValue, source }
 *   - `hash:plaintext`                2 tokens -> { hashValue, plaintext, crackedAt, source }
 *   - `username:hash:plaintext`       3 tokens -> { ..., username, source }
 *   - 4+ tokens (plaintext with `:`)  fallback -> first-colon-as-separator, same as
 *                                                 2-token semantics, preserves prior
 *                                                 behavior for plaintexts containing
 *                                                 colons (the common case is a
 *                                                 password with literal colons).
 *
 * An ambiguous 2-token line (e.g. `admin:hash`) is always treated as
 * `hash:plaintext` — to submit a username-tagged hash without a plaintext, send
 * `username:hash:` (3 tokens, empty plaintext) or `username:hash:<plaintext>`.
 *
 * `source` is always `'upload'` for parser-originated rows. Rows written by
 * propagateCrack (U2) carry a NULL source; the import worker (U7) upserts
 * target-list rows with source='import'. Neither is written by this parser.
 *
 * Exported for testing.
 */
export function parseHashLine(line: string, hashListId: number) {
  const tokens = line.split(':')
  if (tokens.length === 1) {
    return { hashListId, hashValue: line, source: 'upload' as const }
  }
  if (tokens.length === 2) {
    const [hashValue, plaintext] = tokens
    if (!hashValue) return null // ':plain' - no hash to insert
    return {
      hashListId,
      hashValue,
      plaintext: plaintext ?? '',
      crackedAt: new Date(),
      source: 'upload' as const,
    }
  }
  if (tokens.length === 3) {
    const [username, hashValue, plaintext] = tokens
    if (!hashValue) return null // 'user::plain' - no hash to insert
    // `username:hash:` (empty plaintext) is the no-plaintext form per
    // the docstring — don't stamp crackedAt for it, which would inflate
    // the cracked count and progress %.
    const hasPlaintext = !!plaintext && plaintext.length > 0
    // Empty username (`:hash:plain`) falls back to 2-token semantics so
    // the username column isn't polluted with empty-string usernames.
    if (!username) {
      return {
        hashListId,
        hashValue,
        ...(hasPlaintext ? { plaintext: plaintext as string, crackedAt: new Date() } : {}),
        source: 'upload' as const,
      }
    }
    return {
      hashListId,
      hashValue,
      ...(hasPlaintext ? { plaintext: plaintext as string, crackedAt: new Date() } : {}),
      username,
      source: 'upload' as const,
    }
  }
  // 4+ tokens: legacy first-colon-as-separator. Preserves prior behavior for
  // hash:plaintext lines where the plaintext itself contains colons.
  const firstColon = line.indexOf(':')
  const hashValue = line.substring(0, firstColon)
  if (!hashValue) return null // ':plain:with:colons'
  return {
    hashListId,
    hashValue,
    plaintext: line.substring(firstColon + 1),
    crackedAt: new Date(),
    source: 'upload' as const,
  }
}

/**
 * Flush a batch of parsed hash items to the database.
 * Uses onConflictDoNothing for idempotency on (hashListId, hashValue).
 *
 * Returns the rows Postgres actually inserted (`RETURNING` on an
 * `ON CONFLICT DO NOTHING` insert only reports rows that didn't collide) so
 * the caller can run type detection against the DEDUPLICATED composition of
 * `hash_items` rather than every raw parsed line (issue #202 code review
 * fix — see `accumulateTypeDetection` below).
 */
type HashItemInsert = NonNullable<ReturnType<typeof parseHashLine>>

async function flushBatch(
  batch: ReadonlyArray<HashItemInsert>
): Promise<Array<{ hashValue: string }>> {
  if (batch.length === 0) return []
  return db
    .insert(hashItems)
    .values([...batch])
    .onConflictDoNothing()
    .returning({ hashValue: hashItems.hashValue })
}

/** Accumulated type-detection state threaded through `accumulateTypeDetection`. */
interface TypeDetectionState {
  unidentifiedCount: number
  scannedCount: number
  sampled: boolean
}

/**
 * Runs `guessTopHashType` against a batch of ACTUALLY-INSERTED (post-dedup)
 * hash values and folds the results into `typeHistogram` (mutated in place,
 * matching the existing `Map.set` accumulation style elsewhere in this
 * file) plus the returned `unidentifiedCount` / `scannedCount` / `sampled`
 * state.
 *
 * Detection must run on deduplicated rows, not raw parsed lines: a
 * duplicate-heavy file would otherwise let a handful of repeated hash
 * values dominate the histogram before `flushBatch`'s
 * `onConflictDoNothing()` collapses them down to one `hash_items` row,
 * producing a `type_analysis.verdict` that disagrees with what's actually
 * in the table (e.g. a genuinely mixed list reading `homogeneous`, which
 * then wrongly skips the split flow at campaign create).
 *
 * `TYPE_DETECTION_SCAN_CAP` still bounds the total number of hash values
 * scanned — now counted against inserted rows instead of raw lines — and
 * `sampled` still latches true once the cap is reached. No-ops (returns
 * the input state unchanged) once already sampled, so callers can skip
 * invoking this for later batches without extra bookkeeping.
 */
function accumulateTypeDetection(
  insertedRows: ReadonlyArray<{ hashValue: string }>,
  typeHistogram: Map<number, number>,
  state: TypeDetectionState
): TypeDetectionState {
  if (state.sampled) return state

  let { unidentifiedCount, scannedCount } = state
  for (const row of insertedRows) {
    if (scannedCount >= TYPE_DETECTION_SCAN_CAP) break
    const guess = guessTopHashType(row.hashValue)
    if (guess === null) {
      unidentifiedCount++
    } else {
      typeHistogram.set(guess.hashcatMode, (typeHistogram.get(guess.hashcatMode) ?? 0) + 1)
    }
    scannedCount++
  }

  return {
    unidentifiedCount,
    scannedCount,
    sampled: scannedCount >= TYPE_DETECTION_SCAN_CAP,
  }
}

/** Result of `ingestHashListContent` — the testable ingest+persist core. */
export interface IngestHashListContentResult {
  linesProcessed: number
  skippedLines: number
  statistics: { totalCount: number; crackedCount: number; crackRate: number; lastUpdated: string }
  typeAnalysis: HashListTypeAnalysis
  flipped: boolean
}

/**
 * Parses `lines`, batches inserts into `hash_items`, runs type detection
 * against the actually-inserted (post-dedup) rows, recomputes statistics,
 * and performs the guarded `processing -> ready` flip carrying the computed
 * `type_analysis`.
 *
 * Extracted from the worker processor closure — mirrors
 * `hash-import-worker.ts`'s `processImportPairs` — so the db test lane
 * (Postgres only, no live Redis/S3) can drive the REAL persistence path
 * directly: seed a `processing` hash list, call this with an in-memory line
 * source, and assert the persisted `type_analysis` + `hash_items` rows
 * instead of a test-local reimplementation. `createHashListParserWorker`'s
 * processor below resolves the file reference and declared mode, delegates
 * here, then logs/emits off the returned result.
 *
 * `onBatchFlush` is an optional progress hook — the live worker wires
 * `job.updateProgress`; direct (test) callers typically omit it.
 */
export async function ingestHashListContent(
  hashListId: number,
  lines: AsyncIterable<string> | Iterable<string>,
  declaredMode: number | null,
  onBatchFlush?: (linesProcessed: number) => Promise<void> | void
): Promise<IngestHashListContentResult> {
  let batch: HashItemInsert[] = []
  let linesProcessed = 0
  let skippedLines = 0

  // Type-detection accumulators (issue #202, FU3). Detection runs against
  // the extracted hash token (parsed.hashValue) of ACTUALLY-INSERTED
  // (post-dedup) rows, not every raw parsed line — see
  // `accumulateTypeDetection`'s doc comment. Detection stops once
  // TYPE_DETECTION_SCAN_CAP inserted rows have been scanned (sampled=true),
  // but row insertion is never gated by this cap.
  const typeHistogram = new Map<number, number>()
  let detectionState: TypeDetectionState = {
    unidentifiedCount: 0,
    scannedCount: 0,
    sampled: false,
  }

  for await (const raw of lines) {
    const line = raw.trim()
    if (line.length === 0) continue
    if (line.length > MAX_LINE_LENGTH) {
      skippedLines++
      continue
    }

    const parsed = parseHashLine(line, hashListId)
    if (parsed === null) {
      // Empty hashValue after split (e.g. ':plain', '::', '::plain') —
      // skip rather than insert a blank-hash row.
      skippedLines++
      continue
    }
    batch.push(parsed)

    if (batch.length >= BATCH_SIZE) {
      const insertedRows = await flushBatch(batch)
      linesProcessed += batch.length
      batch = []
      detectionState = accumulateTypeDetection(insertedRows, typeHistogram, detectionState)
      if (onBatchFlush) await onBatchFlush(linesProcessed)
    }
  }

  // Flush remaining batch
  if (batch.length > 0) {
    const insertedRows = await flushBatch(batch)
    linesProcessed += batch.length
    detectionState = accumulateTypeDetection(insertedRows, typeHistogram, detectionState)
  }

  const { unidentifiedCount, scannedCount, sampled } = detectionState

  // Recompute statistics from actual data (crash-safe, not accumulated).
  // Single roundtrip: COUNT(*) + COUNT(*) FILTER (WHERE cracked_at IS NOT NULL).
  const [statsResult] = await db
    .select({
      total: count(),
      cracked: sql<number>`count(*) FILTER (WHERE ${hashItems.crackedAt} IS NOT NULL)`,
    })
    .from(hashItems)
    .where(eq(hashItems.hashListId, hashListId))

  const total = Number(statsResult?.total ?? 0)
  const cracked = Number(statsResult?.cracked ?? 0)

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
  const typeAnalysis = buildTypeAnalysis(
    typeHistogram,
    unidentifiedCount,
    scannedCount,
    sampled,
    declaredMode
  )
  // Atomic guard: only flip processing -> ready. If another processor
  // already transitioned the row (concurrent re-run, manual intervention),
  // the WHERE matches zero rows and the caller skips the event emit —
  // preventing a duplicate hash_list_ready event from leaking out.
  // typeAnalysis rides in the same guarded update so a duplicate parse
  // event can't double-write it either.
  const flipped = await db
    .update(hashLists)
    .set({ status: 'ready', statistics, typeAnalysis, updatedAt: lastUpdated })
    .where(and(eq(hashLists.id, hashListId), eq(hashLists.status, 'processing')))
    .returning({ id: hashLists.id })

  return {
    linesProcessed,
    skippedLines,
    statistics,
    typeAnalysis,
    flipped: flipped.length > 0,
  }
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

      // Resolve the list's declared hashcat mode (if any) once, up front —
      // used only for the declared-vs-detected mismatch check in
      // buildTypeAnalysis, never per-line. Queried directly off hashTypes
      // (rather than via services/resources) so the parser worker's module
      // graph stays light and doesn't drag the whole resources module — and
      // its @hashhive/shared imports — into isolated-phase test mocks.
      const declaredMode =
        hl.hashTypeId !== null
          ? ((
              await db
                .select({ hashcatMode: hashTypes.hashcatMode })
                .from(hashTypes)
                .where(eq(hashTypes.id, hl.hashTypeId))
                .limit(1)
            )[0]?.hashcatMode ?? null)
          : null

      // Stream the file line by line via the shared storage walker — never
      // buffer the whole file in memory — and delegate parse/batch/insert/
      // detect/persist to the testable core (see `ingestHashListContent`'s
      // doc comment for why this split exists).
      const result = await ingestHashListContent(
        hashListId,
        streamLines(fileRef.key, fileRef.bucket),
        declaredMode,
        (linesProcessed) => job.updateProgress(linesProcessed)
      )

      logger.info(
        {
          hashListId,
          linesProcessed: result.linesProcessed,
          skippedLines: result.skippedLines,
          totalCount: result.statistics.totalCount,
          crackedCount: result.statistics.crackedCount,
          typeVerdict: result.typeAnalysis.verdict,
          typeSampled: result.typeAnalysis.sampled,
          flipped: result.flipped,
        },
        'Hash list parsing complete (streamed)'
      )

      if (result.flipped) {
        // Guard the emit: an EventService crash here happens AFTER the DB
        // commit and AFTER the row is at status=ready. Letting the throw
        // propagate would mark the BullMQ job failed and trigger a retry
        // against an already-ready row — which the atomic-flip guard would
        // then skip, permanently dropping the hash_list_ready event for
        // every subscriber. The parse itself succeeded; log the emit
        // failure and complete the job cleanly.
        try {
          emitResourceUpdate(projectId, {
            action: 'hash_list_ready',
            hashListId,
            statistics: result.statistics,
          })
        } catch (emitErr) {
          logger.error(
            { hashListId, err: emitErr },
            'Failed to emit hash_list_ready event after DB commit; subscribers will need to refresh manually'
          )
        }
      }

      return { inserted: result.linesProcessed, skippedLines: result.skippedLines }
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
    // Sanitize the wire error: raw Drizzle/Postgres messages include SQL
    // text, table names, and column names — broadcasting them to every
    // project subscriber would leak schema internals. The raw message
    // still lands in the structured log below for operator forensics.
    const errorMessage = sanitizeParseError(err)
    logger.warn({ hashListId, err }, 'Hash list parse failed; emitting sanitized event')
    try {
      // Atomic guard: only flip processing -> error. If a concurrent
      // processor / retry already moved the row to `ready`, do NOT
      // clobber it back to error or emit a misleading hash_list_failed.
      // Same pattern as the success-path flip in the processor body.
      const markedError = await db
        .update(hashLists)
        .set({ status: 'error', updatedAt: new Date() })
        .where(and(eq(hashLists.id, hashListId), eq(hashLists.status, 'processing')))
        .returning({ id: hashLists.id })
      if (markedError.length > 0 && typeof projectId === 'number') {
        // Same guard as the success path — emit failure mustn't make the
        // BullMQ failed-listener throw.
        try {
          emitResourceUpdate(projectId, {
            action: 'hash_list_failed',
            hashListId,
            error: errorMessage,
          })
        } catch (emitErr) {
          logger.error({ hashListId, err: emitErr }, 'Failed to emit hash_list_failed event')
        }
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
