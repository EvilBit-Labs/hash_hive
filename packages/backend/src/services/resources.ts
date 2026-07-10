import {
  type AuditEntityType,
  hashItems,
  hashLists,
  hashTypes,
  maskLists,
  type ResourceCompressionEncoding,
  ruleLists,
  wordLists,
} from '@hashhive/shared'
import { and, count, desc, eq, isNotNull, isNull, max, type SQL, sql } from 'drizzle-orm'
import { randomUUID } from 'node:crypto'
import { extname } from 'node:path'

import { env } from '../config/env.js'
import { logger } from '../config/logger.js'
import {
  abortMultipartUpload,
  completeMultipartUpload,
  createMultipartUpload,
  getPresignedUrl,
  headObject as headObjectDefault,
  listParts,
  uploadFile as uploadFileDefault,
  uploadPart,
} from '../config/storage.js'
import { db } from '../db/index.js'
import { recomputeKeyspaceForResource } from './attacks/complexity.js'
import { type AuditActor, recordAuditEvent } from './audit-log.js'
import { sumMasklistKeyspace } from './keyspace.js'
import { type BlobOwnerTable, deleteBlobIfUnreferenced } from './resources/blob-lifecycle.js'
import { sha256HexFromBuffer, sha256HexFromObject } from './resources/checksum.js'
import { compressBufferForStorage } from './resources/compression.js'
import { blobKeyForChecksum, findCompressionEncodingForKey } from './resources/content-address.js'
import { enqueueLineCount, type LineCountResourceType } from './resources/line-count-trigger.js'
import {
  MAX_LINE_LENGTH,
  countLinesInText,
  countsAsRuleLine,
  countsAsWordlistLine,
  splitTextLines,
} from './resources/line-count.js'
import { enqueueResourceCompression } from './resources/resource-compression-trigger.js'

// ─── Actor ────────────────────────────────────────────────────────────────────

const DEFAULT_SYSTEM_ACTOR: AuditActor = { actorType: 'system', actorId: null }

/** Actor resolved from request auth context — never from a request body (R5). */
export type Actor = AuditActor

// ─── Errors ────────────────────────────────────────────────────────────

/**
 * Thrown when a resource cannot be deleted because another row references
 * it (campaign, attack, etc.). Routes catch this and surface a 409.
 */
export class ResourceInUseError extends Error {
  readonly resourceType: string
  readonly resourceId: number
  readonly references: string
  constructor(resourceType: string, resourceId: number, references: string) {
    super(`${resourceType} ${resourceId} cannot be deleted while it is referenced by ${references}`)
    this.name = 'ResourceInUseError'
    this.resourceType = resourceType
    this.resourceId = resourceId
    this.references = references
  }
}

// ─── Upload size limits ─────────────────────────────────────────────

/**
 * Maximum file size accepted by the single-shot upload helpers
 * (`uploadHashListFile` / `uploadResourceFile`). These helpers buffer the
 * entire payload into memory before forwarding to S3, so we cap them at
 * a small ceiling and steer larger uploads through the chunked multipart
 * flow (`initiateChunkedUpload` + `uploadChunkPart` + `completeChunkedUpload`),
 * which streams parts straight to S3 without buffering the whole file.
 *
 * Anything above this threshold should use `POST /api/v1/dashboard/resources/upload/initiate`
 * (the chunked endpoint) instead of the legacy `/upload` form-data endpoint.
 */
export const MAX_DIRECT_UPLOAD_BYTES = 10 * 1024 * 1024 // 10 MB

/**
 * Thrown by the direct upload helpers when the incoming file exceeds
 * `MAX_DIRECT_UPLOAD_BYTES`. Routes catch this to surface a 413 with a
 * pointer at the chunked upload endpoint.
 */
export class UploadTooLargeError extends Error {
  readonly size: number
  readonly limit: number
  constructor(size: number, limit: number) {
    super(
      `File size ${size} bytes exceeds direct-upload limit of ${limit} bytes; use chunked upload.`
    )
    this.name = 'UploadTooLargeError'
    this.size = size
    this.limit = limit
  }
}

/**
 * Thrown when a re-upload targeting a reclaimed-shell resource
 * (`blob_reclaimed_at IS NOT NULL`) doesn't checksum-match the file that was
 * reclaimed (issue #106 U12 / R12). The row is left untouched — still a
 * shell — and no bytes are written to storage on the direct-upload path (the
 * checksum is computed from the in-memory buffer before `uploadFile` is
 * called). Routes catch this and surface a 409.
 */
export class ChecksumMismatchError extends Error {
  readonly resourceId: number
  readonly resourceType: string
  constructor(resourceId: number, resourceType: string) {
    super(
      `${resourceType} ${resourceId} is a reclaimed shell; the re-uploaded file does not match the original checksum`
    )
    this.name = 'ChecksumMismatchError'
    this.resourceId = resourceId
    this.resourceType = resourceType
  }
}

/**
 * Thrown by `uploadChunkPart` and `completeChunkedUpload` when the
 * underlying resource row is missing or out-of-project-scope. Routes
 * catch this and map to 404 `RESOURCE_NOT_FOUND` so the runtime
 * dashboard spec's 404 declaration is reachable. Without this typed
 * channel, the bare `throw new Error('Resource N not found')` fell
 * through to the generic 500 `UPLOAD_PART_FAILED` / `UPLOAD_COMPLETE_FAILED`
 * envelope and the documented 404 was unreachable from the wire - a
 * route-as-spec contract violation.
 */
export class UploadResourceNotFoundError extends Error {
  readonly resourceId: number
  readonly resourceType: string
  constructor(resourceId: number, resourceType: string) {
    super(`Resource ${resourceId} (${resourceType}) not found or not in project scope`)
    this.name = 'UploadResourceNotFoundError'
    this.resourceId = resourceId
    this.resourceType = resourceType
  }
}

/**
 * Thrown by `initiateChunkedUpload` when a caller supplies `restoreResourceId`
 * (issue #106 F3 code review — chunked-upload restore-after-reclaim) that
 * points at a resource which exists and is in project scope, but is NOT a
 * reclaimed shell (`blob_reclaimed_at IS NULL`). Restore-via-chunked-upload
 * is only for resurrecting a reclaimed shell; hijacking an active resource's
 * upload session through this path is refused. Routes catch this and
 * surface a 409.
 */
export class ResourceNotReclaimedShellError extends Error {
  readonly resourceId: number
  readonly resourceType: string
  constructor(resourceId: number, resourceType: string) {
    super(`${resourceType} ${resourceId} is not a reclaimed shell; nothing to restore`)
    this.name = 'ResourceNotReclaimedShellError'
    this.resourceId = resourceId
    this.resourceType = resourceType
  }
}

// ─── Hash Types ──────────────────────────────────────────────────────

export async function listHashTypes() {
  return db.select().from(hashTypes).orderBy(hashTypes.hashcatMode)
}

export async function getHashTypeById(id: number) {
  const [ht] = await db.select().from(hashTypes).where(eq(hashTypes.id, id)).limit(1)
  return ht ?? null
}

// ─── Hash Lists ─────────────────────────────────────────────────────

export async function listHashLists(
  projectId: number,
  opts: { showArchived?: boolean | undefined } = {}
) {
  // Archived hash lists are excluded from active list views by default
  // (ADR-0019 / R10); pass showArchived to include them.
  const conditions = [eq(hashLists.projectId, projectId)]
  if (!opts.showArchived) {
    conditions.push(isNull(hashLists.archivedAt))
  }
  return db
    .select()
    .from(hashLists)
    .where(and(...conditions))
    .orderBy(desc(hashLists.createdAt))
}

/**
 * Paginated variant of `listHashLists` for callers that need to bound
 * the result set (e.g., the Control API). Returns `{ items, total }`
 * with the count derived from a single matching `count(*)` query so
 * callers don't have to choose between fetching everything for a
 * length and paying a separate roundtrip.
 */
export async function listHashListsPaginated(
  projectId: number,
  opts: { limit: number; offset: number; showArchived?: boolean | undefined }
) {
  const conditions = [eq(hashLists.projectId, projectId)]
  if (!opts.showArchived) {
    conditions.push(isNull(hashLists.archivedAt))
  }
  const whereClause = and(...conditions)
  const [items, countResult] = await Promise.all([
    db
      .select()
      .from(hashLists)
      .where(whereClause)
      .orderBy(desc(hashLists.createdAt), desc(hashLists.id))
      .limit(opts.limit)
      .offset(opts.offset),
    db.select({ value: count() }).from(hashLists).where(whereClause),
  ])
  return { items, total: Number(countResult[0]?.value ?? 0) }
}

/**
 * Detect a Postgres foreign-key-violation. SQLSTATE 23503 is the
 * canonical, locale-stable signal; the message regex is a fallback for
 * older driver versions and test mocks that don't surface `err.code`.
 *
 * When `expectedConstraint` is supplied, the constraint name on the
 * error must match - this prevents misclassifying an unrelated FK
 * violation (e.g., a trigger that references another table) as the
 * specific FK the caller is mapping to a 400. Drizzle/postgres-js
 * surfaces the constraint name on `err.constraint` for SQLSTATE 23503
 * violations.
 */
export function isForeignKeyViolation(err: unknown, expectedConstraint?: string): boolean {
  if (!(err instanceof Error)) return false
  const code = 'code' in err ? (err as { code?: string }).code : undefined
  const constraint = 'constraint' in err ? (err as { constraint?: string }).constraint : undefined
  const isFkBySqlstate = code === '23503'
  const isFkByMessage = !isFkBySqlstate && /foreign key|violates|reference/i.test(err.message)
  if (!isFkBySqlstate && !isFkByMessage) return false
  // No expected constraint: any FK violation counts (backward-compatible).
  if (expectedConstraint === undefined) return true
  // Expected constraint: require an exact match. If the error didn't
  // surface a constraint name (older driver, mock), be conservative
  // and return false so the caller falls through to the generic 500
  // rather than silently misclassifying.
  return constraint === expectedConstraint
}

type DbTx = Parameters<Parameters<typeof db.transaction>[0]>[0]
type DbRunner = DbTx | typeof db

// ─── Permanence latch (ADR-0019 / issue #106 U3) ────────────────────
//
// Any table this latch can target — hash lists plus the three generic
// resource tables. All four share the same `id` / `isPermanent` /
// `updatedAt` column shapes, so one function covers every reference-write
// site instead of four near-duplicates.
type LatchableTable = typeof hashLists | ResourceTable

/**
 * Latch `is_permanent = true` the first time a hash list or word/rule/mask
 * list becomes referenced by a campaign or attack — the resource analog of
 * a campaign leaving `draft` (see `transitionCampaign`'s latch). One-way:
 * the guarded `WHERE isPermanent = false` makes a repeat call on an
 * already-permanent row a no-op, so callers can invoke this unconditionally
 * on every reference-creating write without checking current state first.
 *
 * Must run inside the same transaction as the reference-creating write
 * (campaign/attack insert or update) so a crash between the two can never
 * leave a referenced resource un-latched.
 */
export async function latchResourcePermanent(
  tx: DbTx,
  table: LatchableTable,
  id: number
): Promise<void> {
  await tx
    .update(table)
    .set({ isPermanent: true, updatedAt: new Date() })
    .where(and(eq(table.id, id), eq(table.isPermanent, false)))
}

// ─── Delete guard ─────────────────────────────────────────────────────

/**
 * Outcome of a hash-list / resource delete attempt. Mirrors
 * `DeleteCampaignResult` (`campaign-dashboard.ts`): a purely backend-internal
 * discriminated union — routes translate `kind` into the HTTP envelope, it is
 * never serialized verbatim, so it does not need a shared Zod schema.
 */
export type DeleteResourceResult =
  | { kind: 'not_found' }
  // Latched permanent (referenced at least once, ever) — archive-only,
  // never hard-deletable again even if every reference is later removed.
  | { kind: 'not_deletable' }
  | { kind: 'deleted' }

/**
 * Shared cascade-delete flow for resource tables. Steps:
 *   1. Ownership check (404 if not in project) - handled by the caller via
 *      `lookup`.
 *   2. Permanence pre-check (409-equivalent `not_deletable`) - skips the
 *      cascade entirely for an already-latched row so a hash list with
 *      millions of `hash_items` is never scanned for a delete that the
 *      guard will refuse anyway.
 *   3. DB delete FIRST (inside a tx when `cascade` is supplied so a late
 *      FK violation rolls back the children). The owner delete folds
 *      `is_permanent = false` into its own WHERE so a concurrent latch
 *      (a reference created between step 2 and here) is caught atomically
 *      instead of racing past the pre-check.
 *   4. Best-effort S3 object delete on the row's fileRef.
 *
 * Throws `ResourceInUseError` if a FK from another table still references
 * the row (the pristine-but-referenced case: never latched, still blocked
 * by RESTRICT/child rows).
 */
async function cascadeDeleteResource<
  TRow extends { fileRef?: unknown; isPermanent: boolean },
>(args: {
  id: number
  projectId: number
  resourceLabel: string
  referencedBy: string
  entityType: AuditEntityType
  actor: Actor
  // Which table the row being deleted belongs to (#108 safety foundation) —
  // threaded through to `deleteBlobIfUnreferenced` so it knows which other
  // tables to scan for a still-live reference to the same blob.
  table: BlobOwnerTable
  lookup: () => Promise<TRow | null>
  cascade?: (tx: DbTx) => Promise<void>
  // Performs the guarded DELETE (folding `isPermanent = false` into its
  // WHERE) and returns the number of rows actually removed, so the caller
  // can detect a race where permanence latched between the pre-check and
  // this statement.
  deleteOwner: (runner: DbRunner) => Promise<number>
}): Promise<DeleteResourceResult> {
  const row = await args.lookup()
  if (!row) return { kind: 'not_found' }
  if (row.isPermanent) return { kind: 'not_deletable' }

  class LatchedDuringDelete extends Error {}

  try {
    await db.transaction(async (tx) => {
      if (args.cascade) {
        await args.cascade(tx)
      }
      const deletedCount = await args.deleteOwner(tx)
      if (deletedCount === 0) {
        // Race: a reference-creating write latched is_permanent=true between
        // the pre-check above and this guarded DELETE. Throw to roll back
        // any cascade deletes already applied in this transaction.
        throw new LatchedDuringDelete()
      }
      await recordAuditEvent(
        {
          actor: args.actor,
          projectId: args.projectId,
          entityType: args.entityType,
          entityId: args.id,
          action: 'deleted',
          oldRow: row as Record<string, unknown>,
        },
        tx
      )
    })
  } catch (err) {
    if (err instanceof LatchedDuringDelete) {
      return { kind: 'not_deletable' }
    }
    if (isForeignKeyViolation(err)) {
      throw new ResourceInUseError(args.resourceLabel, args.id, args.referencedBy)
    }
    throw err
  }

  const fileRef = (row as Record<string, unknown>)['fileRef'] as {
    bucket?: string
    key?: string
  } | null
  if (fileRef?.key) {
    // #108 safety foundation: guarded delete, not a bare `deleteFile`. A
    // no-op today (unique-per-resource keys), but the row this delete
    // targets no longer exists (it was removed by `deleteOwner` above), so
    // `deleteBlobIfUnreferenced`'s own (table, id) self-exclusion is moot
    // here — it just needs `args.id` to be excluded from the scan, which it
    // is regardless. Delete failures are logged and swallowed inside the
    // guard itself.
    await deleteBlobIfUnreferenced({
      table: args.table,
      resourceId: args.id,
      key: fileRef.key,
      ...(fileRef.bucket ? { bucket: fileRef.bucket } : {}),
    })
  }
  return { kind: 'deleted' }
}

// Maximum hash_items rows to remove per DELETE chunk during cascade. Bounds
// the worst-case lock duration so a hash list with millions of items can
// be deleted without holding row-level locks for minutes.
const HASH_ITEMS_DELETE_CHUNK = 10_000
// Hard cap on cascade iterations (10k rows × this = 1B rows). A driver
// that returns rowCount=0 while rows remain (or any future bug that hides
// the chunk count) would otherwise loop forever inside the transaction.
const HASH_ITEMS_DELETE_MAX_ITERATIONS = 100_000

/**
 * Cascade-delete `hash_items` for `hashListId` in bounded batches. Each
 * iteration deletes up to `HASH_ITEMS_DELETE_CHUNK` rows using a
 * `ctid IN (SELECT ctid ... LIMIT N)` pattern (PG-specific; bounds the
 * statement-level lock duration). Hard-capped at
 * `HASH_ITEMS_DELETE_MAX_ITERATIONS` so a misreported row count can't
 * cause an unbounded transaction.
 */
async function deleteHashItemsBatched(tx: DbTx, hashListId: number): Promise<void> {
  for (let iter = 0; iter < HASH_ITEMS_DELETE_MAX_ITERATIONS; iter++) {
    // postgres-js v3.4.x exposes the DELETE affected-row count on
    // `result.count` (it returns its own `Result` array with a `.count`
    // property - NOT `rowCount`, which is the pg/node-pg convention).
    // `rowCount` retained as a fallback for any future driver that
    // diverges; the MAX_ITERATIONS cap below bails on either reporting
    // bug. https://github.com/porsager/postgres
    const result = (await tx.execute(
      sql`DELETE FROM ${hashItems}
          WHERE ctid IN (
            SELECT ctid FROM ${hashItems}
            WHERE ${eq(hashItems.hashListId, hashListId)}
            LIMIT ${HASH_ITEMS_DELETE_CHUNK}
          )`
    )) as { count?: number; rowCount?: number }
    const deleted = result.count ?? result.rowCount ?? 0
    if (deleted < HASH_ITEMS_DELETE_CHUNK) return
  }
  logger.error(
    { hashListId, max: HASH_ITEMS_DELETE_MAX_ITERATIONS, chunkSize: HASH_ITEMS_DELETE_CHUNK },
    'deleteHashItemsBatched hit max iterations - bailing to avoid unbounded transaction'
  )
  throw new Error(
    `deleteHashItemsBatched(${hashListId}) exceeded ${HASH_ITEMS_DELETE_MAX_ITERATIONS} iterations`
  )
}

export async function deleteHashList(
  id: number,
  projectId: number,
  actor: Actor = DEFAULT_SYSTEM_ACTOR
): Promise<DeleteResourceResult> {
  return cascadeDeleteResource({
    id,
    projectId,
    resourceLabel: 'hash list',
    referencedBy: 'one or more campaigns or attacks',
    entityType: 'hash_list',
    actor,
    table: hashLists,
    lookup: () => getHashListById(id, projectId),
    // Bounded-batch cascade: large hash lists (millions of items) get
    // chunked DELETEs instead of one unbounded statement, capping the
    // worst-case lock duration.
    cascade: (tx) => deleteHashItemsBatched(tx, id),
    deleteOwner: (runner) =>
      runner
        .delete(hashLists)
        .where(
          and(
            eq(hashLists.id, id),
            eq(hashLists.projectId, projectId),
            // Draft-only hard-delete guard (ADR-0019 / R2): a hash list that
            // has ever been referenced is permanent and archive-only. Folded
            // into the WHERE so a concurrent latch loses the race atomically
            // rather than deleting a now-permanent row.
            eq(hashLists.isPermanent, false)
          )
        )
        .returning({ id: hashLists.id })
        .then((rows) => rows.length),
  })
}

/**
 * Map a resource table to its audit entity type. Exported for reuse by
 * `resources-archive.ts` (ADR-0019 / issue #106 U3 archive/restore).
 */
export function entityTypeForTable(table: ResourceTable): AuditEntityType {
  if (table === wordLists) return 'word_list'
  if (table === ruleLists) return 'rule_list'
  return 'mask_list'
}

export async function deleteResource(
  table: ResourceTable,
  id: number,
  projectId: number,
  resourceType: string,
  actor: Actor = DEFAULT_SYSTEM_ACTOR
): Promise<DeleteResourceResult> {
  return cascadeDeleteResource({
    id,
    projectId,
    resourceLabel: resourceType,
    referencedBy: 'one or more attacks',
    entityType: entityTypeForTable(table),
    actor,
    table,
    lookup: () => getResourceById(table, id, projectId),
    deleteOwner: (runner) =>
      runner
        .delete(table)
        .where(
          and(
            eq(table.id, id),
            eq(table.projectId, projectId),
            // Draft-only hard-delete guard (ADR-0019 / R2): see deleteHashList.
            eq(table.isPermanent, false)
          )
        )
        .returning({ id: table.id })
        .then((rows) => rows.length),
  })
}

export async function getHashListById(id: number, projectId: number) {
  const [hl] = await db
    .select()
    .from(hashLists)
    .where(and(eq(hashLists.id, id), eq(hashLists.projectId, projectId)))
    .limit(1)
  return hl ?? null
}

export async function createHashList(
  data: {
    projectId: number
    name: string
    hashTypeId?: number | undefined
    source?: string | undefined
  },
  actor: Actor = DEFAULT_SYSTEM_ACTOR
) {
  return db.transaction(async (tx) => {
    const [hl] = await tx
      .insert(hashLists)
      .values({
        projectId: data.projectId,
        name: data.name,
        hashTypeId: data.hashTypeId ?? null,
        source: data.source ?? 'upload',
        status: 'uploading',
      })
      .returning()

    if (!hl) return null

    await recordAuditEvent(
      {
        actor,
        projectId: data.projectId,
        entityType: 'hash_list',
        entityId: hl.id,
        action: 'created',
        newRow: hl as Record<string, unknown>,
      },
      tx
    )

    return hl
  })
}

/**
 * Update the `hashTypeId` on an existing hash list. Project-scoped:
 * matches by `(id, projectId)` from the authenticated session and
 * returns `null` on miss (the route translates to 404) so a wrong-
 * project ID lookup cannot disclose existence. Mirrors the lookup
 * pattern in `deleteHashList(id, projectId)`.
 *
 * The FK from `hash_lists.hash_type_id → hash_types.id` validates the
 * target type at the database layer; a stale or missing hashTypeId
 * surfaces as a Postgres FK violation and bubbles to the caller.
 */
export async function setHashListType(
  id: number,
  projectId: number,
  hashTypeId: number,
  actor: Actor = DEFAULT_SYSTEM_ACTOR
) {
  return db.transaction(async (tx) => {
    const [oldRow] = await tx
      .select()
      .from(hashLists)
      .where(and(eq(hashLists.id, id), eq(hashLists.projectId, projectId)))
      .limit(1)

    if (!oldRow) return null

    const [updated] = await tx
      .update(hashLists)
      .set({ hashTypeId, updatedAt: new Date() })
      .where(and(eq(hashLists.id, id), eq(hashLists.projectId, projectId)))
      .returning()

    if (!updated) return null

    await recordAuditEvent(
      {
        actor,
        projectId,
        entityType: 'hash_list',
        entityId: id,
        action: 'updated',
        oldRow: oldRow as Record<string, unknown>,
        newRow: updated as Record<string, unknown>,
      },
      tx
    )

    return updated
  })
}

export async function uploadHashListFile(
  hashListId: number,
  projectId: number,
  file: File
): Promise<{ key: string; size: number }> {
  const hl = await getHashListById(hashListId, projectId)
  if (!hl) {
    throw new Error(`Hash list ${hashListId} not found`)
  }

  if (file.size > MAX_DIRECT_UPLOAD_BYTES) {
    throw new UploadTooLargeError(file.size, MAX_DIRECT_UPLOAD_BYTES)
  }

  const ext = extname(file.name)
  const key = `${hl.projectId}/hash-lists/${randomUUID()}${ext}`
  const buffer = Buffer.from(await file.arrayBuffer())
  await uploadFileDefault(key, buffer, file.type || 'application/octet-stream')

  await db
    .update(hashLists)
    .set({
      fileRef: {
        bucket: env.S3_BUCKET,
        key,
        contentType: file.type || 'application/octet-stream',
        size: file.size,
        name: file.name,
        uploadedAt: new Date().toISOString(),
      },
      status: 'uploaded',
      updatedAt: new Date(),
    })
    .where(eq(hashLists.id, hashListId))

  return { key, size: file.size }
}

export async function importHashList(hashListId: number, projectId: number) {
  const hl = await getHashListById(hashListId, projectId)
  if (!hl) {
    return null
  }

  // Check queue availability before marking as processing
  const { getQueueManager } = await import('../queue/context.js')
  const { QUEUE_NAMES } = await import('../config/queue.js')
  const qm = getQueueManager()
  if (!qm) {
    return { error: 'Queue unavailable - cannot process hash list' }
  }
  const health = await qm.getHealth()
  if (health.status === 'disconnected') {
    return { error: 'Queue unavailable - cannot process hash list' }
  }

  // Enqueue FIRST so the queue's success/failure is what gates the status
  // flip. If enqueue throws or returns false, status stays at 'uploaded'
  // and the caller can retry without a separate revert UPDATE that could
  // itself fail and leave the row stuck mid-flight.
  let enqueued = false
  try {
    enqueued = await qm.enqueue(QUEUE_NAMES.HASH_LIST_PARSING, {
      hashListId,
      projectId: hl.projectId,
    })
  } catch (err) {
    logger.warn({ err, hashListId }, 'Failed to enqueue hash list parsing job')
    return { error: 'Failed to enqueue hash list parsing job' }
  }

  if (!enqueued) {
    return { error: 'Failed to enqueue hash list parsing job' }
  }

  // Status-guarded UPDATE: only flip rows currently in 'uploaded'. Any
  // other state (already processing, ready, error) is left alone so a
  // duplicate import call can't corrupt the row.
  await db
    .update(hashLists)
    .set({ status: 'processing', updatedAt: new Date() })
    .where(and(eq(hashLists.id, hashListId), eq(hashLists.status, 'uploaded')))

  return { status: 'processing' as const, queued: true }
}

export async function getHashItems(
  hashListId: number,
  projectId: number,
  opts: {
    limit?: number | undefined
    offset?: number | undefined
    status?: 'all' | 'cracked' | 'uncracked' | undefined
    search?: string | undefined
  }
) {
  // Verify hash list belongs to project (IDOR prevention)
  const hl = await getHashListById(hashListId, projectId)
  if (!hl) return null

  const limit = opts.limit ?? 50
  const offset = opts.offset ?? 0

  const conditions: SQL[] = [eq(hashItems.hashListId, hashListId)]

  if (opts.status === 'cracked') {
    conditions.push(isNotNull(hashItems.crackedAt))
  } else if (opts.status === 'uncracked') {
    conditions.push(sql`${hashItems.crackedAt} IS NULL`)
  }

  if (opts.search) {
    const escaped = escapeLike(opts.search)
    conditions.push(sql`${hashItems.hashValue} ILIKE ${`%${escaped}%`} ESCAPE '\\'`)
  }

  const whereClause = and(...conditions)

  const [items, countResult] = await Promise.all([
    db
      .select()
      .from(hashItems)
      .where(whereClause)
      .limit(limit)
      .offset(offset)
      .orderBy(hashItems.id),
    db
      .select({ count: sql<number>`count(*)` })
      .from(hashItems)
      .where(whereClause),
  ])

  return { items, total: Number(countResult[0]?.count ?? 0), limit, offset }
}

/**
 * Escape LIKE/ILIKE metacharacters to prevent wildcard injection.
 */
export function escapeLike(value: string): string {
  return value.replace(/[%_\\]/g, '\\$&')
}

// ─── Hash List Statistics ────────────────────────────────────────────

/**
 * Computes live cracked/total/remaining counts for a hash list.
 * Uses a single COUNT + FILTER query (fast with composite index).
 */
export async function getHashListStats(hashListId: number): Promise<{
  totalCount: number
  crackedCount: number
  crackRate: number
}> {
  const [stats] = await db
    .select({
      total: count(),
      cracked: sql<number>`count(*) FILTER (WHERE ${hashItems.crackedAt} IS NOT NULL)`,
    })
    .from(hashItems)
    .where(eq(hashItems.hashListId, hashListId))

  const totalCount = Number(stats?.total ?? 0)
  const crackedCount = Number(stats?.cracked ?? 0)
  const crackRate = totalCount > 0 ? crackedCount / totalCount : 0
  return { totalCount, crackedCount, crackRate }
}

/**
 * Weak ETag for a hash list's freshness, derived from the most recent
 * crack recorded against it (issue #108 follow-up: hash-list freshness
 * ETag). An agent that already holds this hash list's uncracked-only set
 * sends this value back as `If-None-Match` on a later download-url fetch;
 * an unchanged etag means no new hashes were cracked since, and the agent
 * can reuse its cached set instead of re-downloading.
 *
 * There is no denormalized "last crack time" column on `hash_lists` —
 * sourcing it from `MAX(hash_items.cracked_at)` is cheap thanks to the
 * composite `hash_items_hash_list_cracked_idx` (hash_list_id, cracked_at)
 * index, and this deliberately does not touch the crack-write path
 * (`propagateCrack`). A hash list with no cracks yet reports epoch `0` so
 * the etag is stable (present, not absent) before the first crack.
 *
 * The value is a *weak* validator (`W/"..."`) because it identifies an
 * equivalent uncracked set, not a byte-identical representation.
 */
export async function computeHashListEtag(hashListId: number): Promise<string> {
  const [row] = await db
    .select({ lastCrackedAt: max(hashItems.crackedAt) })
    .from(hashItems)
    .where(eq(hashItems.hashListId, hashListId))

  const epochMillis = row?.lastCrackedAt ? new Date(row.lastCrackedAt).getTime() : 0
  return `W/"hl-${hashListId}-${epochMillis}"`
}

// ─── Generic Resource Lists (wordlists, rulelists, masklists) ───────

export type ResourceTable = typeof wordLists | typeof ruleLists | typeof maskLists

export async function listResources(
  table: ResourceTable,
  projectId: number,
  opts: { showArchived?: boolean | undefined } = {}
) {
  // Archived resources are excluded from active list views by default
  // (ADR-0019 / R10); pass showArchived to include them.
  const conditions = [eq(table.projectId, projectId)]
  if (!opts.showArchived) {
    conditions.push(isNull(table.archivedAt))
  }
  return db
    .select()
    .from(table)
    .where(and(...conditions))
    .orderBy(desc(table.createdAt))
}

/**
 * Paginated variant of `listResources` for the Control API. Same shape
 * as `listHashListsPaginated`. Returns `{ items, total }` with a
 * deterministic `(createdAt desc, id desc)` order so insertions during
 * pagination don't drop or duplicate rows across pages.
 */
export async function listResourcesPaginated(
  table: ResourceTable,
  projectId: number,
  opts: { limit: number; offset: number; showArchived?: boolean | undefined }
) {
  const conditions = [eq(table.projectId, projectId)]
  if (!opts.showArchived) {
    conditions.push(isNull(table.archivedAt))
  }
  const whereClause = and(...conditions)
  const [items, countResult] = await Promise.all([
    db
      .select()
      .from(table)
      .where(whereClause)
      .orderBy(desc(table.createdAt), desc(table.id))
      .limit(opts.limit)
      .offset(opts.offset),
    db.select({ value: count() }).from(table).where(whereClause),
  ])
  return { items, total: Number(countResult[0]?.value ?? 0) }
}

export async function getResourceById(table: ResourceTable, id: number, projectId: number) {
  const [row] = await db
    .select()
    .from(table)
    .where(and(eq(table.id, id), eq(table.projectId, projectId)))
    .limit(1)
  return row ?? null
}

export async function createResource(
  table: ResourceTable,
  data: { projectId: number; name: string },
  actor: Actor = DEFAULT_SYSTEM_ACTOR
) {
  const entityType = entityTypeForTable(table)
  return db.transaction(async (tx) => {
    const [row] = await tx.insert(table).values(data).returning()

    if (!row) return null

    await recordAuditEvent(
      {
        actor,
        projectId: data.projectId,
        entityType,
        entityId: row.id,
        action: 'created',
        newRow: row as Record<string, unknown>,
      },
      tx
    )

    return row
  })
}

/**
 * Map a chunked-upload `resourceType` string to the line-count worker's type,
 * or null for types the worker does not size (e.g. hash lists). Masklists ARE
 * worker-sized (#231) — they map to `'masklist'` and are sized by their summed
 * mask keyspace rather than a line count, so they are not excluded here.
 */
function lineCountTypeForResourceType(resourceType: string): LineCountResourceType | null {
  if (resourceType === 'wordlists') return 'wordlist'
  if (resourceType === 'rulelists') return 'rulelist'
  if (resourceType === 'masklists') return 'masklist'
  return null
}

/** Discriminate a resource table into the keyspace fan-out's resource type. */
function resourceTypeOf(table: ResourceTable): 'wordlist' | 'rulelist' | 'masklist' {
  if (table === wordLists) return 'wordlist'
  if (table === ruleLists) return 'rulelist'
  return 'masklist'
}

/**
 * The line-count predicate that sizes a resource for keyspace, or null when a
 * resource type's line count does not feed keyspace (masklists: one mask per
 * line, not a charset product).
 */
function lineCountPredicateFor(
  type: 'wordlist' | 'rulelist' | 'masklist'
): ((line: string) => boolean) | null {
  if (type === 'wordlist') return countsAsWordlistLine
  if (type === 'rulelist') return countsAsRuleLine
  return null
}

/**
 * Storage boundary `uploadResourceFile` needs beyond the guarded blob
 * delete it already threads through — injectable so real-DB tests can
 * exercise the content-addressed dedup decision (`headObject`) and the
 * conditional upload against a fake in-memory store instead of hitting S3.
 * Defaults to the real `config/storage.js` functions; production callers
 * never pass this.
 */
export interface UploadResourceStorageDeps {
  uploadFile: typeof uploadFileDefault
  headObject: typeof headObjectDefault
}

export async function uploadResourceFile(
  table: ResourceTable,
  resourceId: number,
  projectId: number,
  prefix: string,
  file: File,
  actor: Actor = DEFAULT_SYSTEM_ACTOR,
  deps: Partial<UploadResourceStorageDeps> = {}
) {
  const resource = await getResourceById(table, resourceId, projectId)
  if (!resource) {
    throw new Error(`Resource ${resourceId} not found in ${prefix}`)
  }

  if (file.size > MAX_DIRECT_UPLOAD_BYTES) {
    throw new UploadTooLargeError(file.size, MAX_DIRECT_UPLOAD_BYTES)
  }

  const uploadFileFn = deps.uploadFile ?? uploadFileDefault
  const headObjectFn = deps.headObject ?? headObjectDefault

  const resourceType = resourceTypeOf(table)
  const buffer = Buffer.from(await file.arrayBuffer())

  // Checksum computed from the RAW in-memory buffer, before compression and
  // before any storage read/write (issue #106 U12 / R12, #108 U2 + the
  // content-addressed dedup follow-up): a reclaimed-shell re-upload that
  // fails to match is rejected here, before any bytes are written to
  // storage or the row is touched — the resource stays exactly the shell it
  // was. Computing from the raw buffer (rather than the post-compression
  // bytes) also means the checksum is stable across a future change to the
  // compression algorithm/threshold — re-uploading the identical source
  // file always reproduces the same checksum regardless of how it happens
  // to get stored.
  const checksum = sha256HexFromBuffer(buffer)
  const isReclaimedShell = resource.blobReclaimedAt !== null
  if (isReclaimedShell && resource.fileChecksum && resource.fileChecksum !== checksum) {
    throw new ChecksumMismatchError(resourceId, resourceType)
  }

  // Content-addressed storage (#108 dedup follow-up): the blob lives at a
  // GLOBAL key derived purely from the raw checksum — `blobs/<checksum>`,
  // no extension (the download filename always comes from `fileRef.name`,
  // never the storage key). Identical raw content uploaded by ANY resource
  // in ANY project therefore dedups onto the exact same physical object.
  // This is safe because access is gated entirely by presigned-URL signing
  // (the route always verifies project ownership before a URL is ever
  // signed) — a physically-shared blob never leaks across projects just
  // because the object-store key itself carries no project scoping.
  //
  // `headObject` tells us whether some earlier upload (any project, any
  // resource) already stored this exact content. If so, this upload is a
  // pure dedup: no bytes are written to storage, and the compression
  // encoding is adopted from whichever live row already points at the key
  // — not recomputed — because the physical bytes were written exactly
  // once, by whichever writer got there first, and the encoding recorded
  // here must always describe those actual bytes.
  const blobKey = blobKeyForChecksum(checksum)
  let compressionEncoding: ResourceCompressionEncoding
  const existingBlob = await headObjectFn(blobKey)
  if (existingBlob.exists) {
    const existingEncoding = await findCompressionEncodingForKey(blobKey)
    if (existingEncoding === null) {
      logger.warn(
        { resourceType, resourceId, blobKey },
        'uploadResourceFile: content-addressed blob exists in storage but no live row references it; defaulting encoding to none'
      )
    }
    compressionEncoding = existingEncoding ?? 'none'
  } else {
    // Compress the raw buffer before storage (#108 U3): word/rule/mask
    // lists only (hash lists never reach this function — see
    // `ResourceTable`). Gzip specifically, and only when it actually
    // shrinks the payload; otherwise store the raw bytes unchanged.
    // `fileSize`/`fileChecksum` below always describe the RAW file — the
    // agent-facing contract and the reclaimed-shell checksum comparison
    // must never depend on which encoding a given upload happened to pick.
    const compressed = compressBufferForStorage(buffer)
    compressionEncoding = compressed.encoding
    await uploadFileFn(blobKey, compressed.bytes, file.type || 'application/octet-stream')
  }

  // Size the resource from the in-memory buffer (≤ MAX_DIRECT_UPLOAD_BYTES) so
  // the common upload path never needs the async worker, using the same utils
  // the worker uses so direct and worker sizing agree. Wordlists/rulelists are
  // sized by line count; a masklist by its summed mask keyspace (#231).
  const text = buffer.toString('utf8')
  let lineCount: number | null = null
  let masklistKeyspace: string | null = null
  if (resourceType === 'masklist') {
    masklistKeyspace = sumMasklistKeyspace(splitTextLines(text), MAX_LINE_LENGTH)
    if (masklistKeyspace === null) {
      logger.warn(
        { resourceType, resourceId },
        'masklist keyspace uncomputable (custom charsets / unknown tokens); dependent attacks fall back to single-task'
      )
    }
  } else {
    const predicate = lineCountPredicateFor(resourceType)
    lineCount = predicate ? countLinesInText(text, predicate) : null
  }

  const entityType = entityTypeForTable(table)
  const updateValues = {
    fileRef: {
      bucket: env.S3_BUCKET,
      key: blobKey,
      contentType: file.type || 'application/octet-stream',
      size: file.size,
      name: file.name,
      uploadedAt: new Date().toISOString(),
    },
    fileSize: file.size,
    compressionEncoding,
    ...(lineCount !== null ? { lineCount } : {}),
    ...(resourceType === 'masklist' ? { keyspace: masklistKeyspace } : {}),
    status: 'ready' as const,
    // Capture the checksum on every finalize (issue #106 U12) — including a
    // brand-new resource's first upload — so a future archive + reclaim of
    // THIS resource has something to verify a re-upload against. A matching
    // re-upload of a reclaimed shell clears blob_reclaimed_at, making the
    // resource usable again (R12); isReclaimedShell is false for a normal
    // (non-shell) upload, so this key is simply omitted there.
    fileChecksum: checksum,
    ...(isReclaimedShell ? { blobReclaimedAt: null } : {}),
    updatedAt: new Date(),
  }

  // Wrap DB write + audit record in a transaction so a failed audit rolls
  // back the metadata write (R4). The S3 upload above already succeeded and
  // is not transactional (S3 is not Postgres); on rollback the uploaded
  // object becomes an orphan. This is an acceptable trade-off — audit failure
  // is a configuration error, not a normal code path. The non-transactional
  // keyspace fan-out runs after commit so it is unaffected by the rollback.
  await db.transaction(async (tx) => {
    const [updated] = await tx
      .update(table)
      .set(updateValues)
      .where(eq(table.id, resourceId))
      .returning()

    await recordAuditEvent(
      {
        actor,
        projectId,
        entityType,
        entityId: resourceId,
        action: 'updated',
        oldRow: resource as Record<string, unknown>,
        newRow: (updated ?? { ...resource, ...updateValues }) as Record<string, unknown>,
      },
      tx
    )
  })

  // Best-effort: refresh keyspace for any attacks already referencing this
  // resource. The usual flow uploads before attacks exist (a no-op fan-out);
  // this covers the rarer create-attack-before-upload ordering. A failure here
  // must not fail the upload — the resource is already persisted as ready.
  //
  // A masklist ALWAYS fans out: its keyspace column is always rewritten (incl.
  // null), so a re-upload to an uncomputable file must propagate that null to
  // dependents rather than leave them on a stale value. Wordlists/rulelists fan
  // out only once a line count is known.
  const shouldFanOut = resourceType === 'masklist' || lineCount !== null
  if (shouldFanOut) {
    try {
      await recomputeKeyspaceForResource(resourceType, resourceId)
    } catch (err) {
      // The resource is already persisted `ready`; failing the upload would be
      // worse. But be honest about recovery: the resource's own sizing column is
      // now non-null, and the only re-triggers (the uncounted-resource sweep and
      // attack create/update) gate on a null sizing value — so an ALREADY-existing
      // dependent attack will NOT auto-recompute. Re-uploading the resource (or a
      // manual recompute) is the remedy. The ids are logged for that.
      logger.warn(
        { resourceType, resourceId, err },
        'keyspace recompute after direct upload failed; existing dependent attacks keep a stale keyspace until the resource is re-uploaded'
      )
    }
  }

  return { key: blobKey, size: file.size }
}

// ─── Presigned URLs ─────────────────────────────────────────────────

export async function getResourcePresignedUrl(fileRef: {
  bucket: string
  key: string
  name?: string
}): Promise<string> {
  return getPresignedUrl(fileRef.key, 3600, {
    bucket: fileRef.bucket,
    ...(fileRef.name ? { filename: fileRef.name } : {}),
  })
}

/**
 * Integrity metadata surfaced alongside an agent download URL (#108 U5).
 * Hash lists carry none of the `checksum`/`size`/`encoding` columns — out
 * of scope for #108 — so those three fields are `null` for
 * `resourceType === 'hash-lists'`. Word/rule/mask list rows carry real
 * values once `file_checksum` is captured at upload finalization; a
 * resource whose worker hasn't run yet (or was uploaded before #102/#108
 * shipped) reports `checksum: null` cleanly rather than surfacing a stale
 * or fabricated value.
 *
 * `etag` is the inverse case (#108 follow-up: hash-list freshness ETag):
 * it is `null` for word/rule/mask lists (they cache-skip by `checksum`
 * instead) and a real weak validator — see `computeHashListEtag` — only
 * for `resourceType === 'hash-lists'`.
 */
export interface AgentDownloadUrlResult {
  url: string
  expiresIn: number
  checksum: string | null
  size: number | null
  encoding: ResourceCompressionEncoding | null
  etag: string | null
}

/**
 * Generate a presigned download URL with extended expiry for large files.
 * Used by agents to download resources directly from S3.
 */
export async function getAgentDownloadUrl(
  resourceType: string,
  resourceId: number,
  projectId: number
): Promise<AgentDownloadUrlResult | null> {
  const isHashList = resourceType === 'hash-lists'
  const tableMap: Record<string, ResourceTable | typeof hashLists> = {
    'hash-lists': hashLists,
    wordlists: wordLists,
    rulelists: ruleLists,
    masklists: maskLists,
  }

  const table = tableMap[resourceType]
  if (!table) return null

  const [row] = await db
    .select()
    .from(table)
    .where(and(eq(table.id, resourceId), eq(table.projectId, projectId)))
    .limit(1)
  if (!row) return null

  const fileRef = row.fileRef as { bucket?: string; key?: string; name?: string } | null
  if (!fileRef?.bucket || !fileRef?.key) return null

  const expiresIn = 6 * 3600 // 6 hours for large files
  const url = await getPresignedUrl(fileRef.key, expiresIn, {
    bucket: fileRef.bucket,
    ...(fileRef.name ? { filename: fileRef.name } : {}),
  })

  // `table` is typed as a union including `hashLists`, which has none of
  // these columns — narrow on `resourceType` (not the row) since hash
  // lists are excluded from #108 scope entirely. The cast is safe: the
  // `!isHashList` branch only runs when `table` resolved to one of the
  // three resource tables above, which share this column shape exactly.
  const resourceRow = row as typeof wordLists.$inferSelect
  const checksum = isHashList ? null : (resourceRow.fileChecksum ?? null)
  const size = isHashList ? null : (resourceRow.fileSize ?? null)
  const encoding = isHashList
    ? null
    : ((resourceRow.compressionEncoding as ResourceCompressionEncoding | undefined) ?? 'none')
  const etag = isHashList ? await computeHashListEtag(resourceId) : null

  return { url, expiresIn, checksum, size, encoding, etag }
}

// ─── Chunked Upload (S3 Multipart) ─────────────────────────────────

const RESOURCE_TYPE_TABLE: Record<string, ResourceTable> = {
  wordlists: wordLists,
  rulelists: ruleLists,
  masklists: maskLists,
}

const DEFAULT_PART_SIZE = 64 * 1024 * 1024 // 64 MB

export async function initiateChunkedUpload(
  data: {
    resourceType: string
    name: string
    fileSize: number
    projectId: number
    contentType?: string | undefined
    /**
     * Restore-after-reclaim over chunked upload (issue #106 F3 code
     * review / R12). When supplied, this session targets an EXISTING
     * resource row that is a reclaimed shell (`blob_reclaimed_at IS NOT
     * NULL`) instead of creating a new row — the counterpart to
     * `uploadResourceFile`'s direct-upload restore guard, but for large
     * word/rule/mask lists, which always go through chunked upload.
     * Ownership + shell-state are verified up front here;
     * `completeChunkedUpload` does the checksum verification once the
     * upload actually lands. Hash lists have no blob-reclamation
     * lifecycle (`isHashList`), so this is rejected for that resource
     * type.
     */
    restoreResourceId?: number | undefined
  },
  actor: Actor = DEFAULT_SYSTEM_ACTOR
): Promise<{
  uploadId: string
  resourceId: number
  partSize: number
  key: string
}> {
  const { resourceType, name, fileSize, projectId, contentType, restoreResourceId } = data

  // Hash lists use the hashLists table with different create logic
  const isHashList = resourceType === 'hash-lists'
  const table: ResourceTable | typeof hashLists | undefined = isHashList
    ? hashLists
    : RESOURCE_TYPE_TABLE[resourceType]

  if (!table) {
    throw new Error(`Unknown resource type: ${resourceType}`)
  }
  if (isHashList && restoreResourceId != null) {
    throw new Error(
      'restoreResourceId is not supported for hash lists (no blob-reclamation lifecycle)'
    )
  }

  // Create DB record — OR, for a restore session, reuse an existing
  // reclaimed-shell row instead of creating a new one.
  let resourceId: number
  const isRestore = restoreResourceId != null
  if (isRestore) {
    const [existing] = await db
      .select()
      .from(table as ResourceTable)
      .where(
        and(eq((table as ResourceTable).id, restoreResourceId), eq(table.projectId, projectId))
      )
      .limit(1)
    if (!existing) throw new UploadResourceNotFoundError(restoreResourceId, resourceType)
    if (existing.blobReclaimedAt === null) {
      throw new ResourceNotReclaimedShellError(restoreResourceId, resourceType)
    }
    resourceId = existing.id
  } else if (isHashList) {
    const hl = await createHashList({ projectId, name, source: 'upload' }, actor)
    if (!hl) throw new Error('Failed to create hash list')
    resourceId = hl.id
  } else {
    const row = await createResource(table as ResourceTable, { projectId, name }, actor)
    if (!row) throw new Error(`Failed to create ${resourceType}`)
    resourceId = row.id
  }

  // Generate S3 key. A restore session always mints a fresh key: the
  // ORIGINAL blob (whatever key the shell's fileRef used to point at) was
  // already deleted by the blob-reclamation sweep, so there's nothing to
  // reuse — the re-upload lands at a new location and fileRef is
  // overwritten to point at it on completion.
  const prefix = isHashList ? 'hash-lists' : resourceType
  const key = `${projectId}/${prefix}/${randomUUID()}`
  const ct = contentType ?? 'application/octet-stream'

  // Initiate S3 multipart upload - clean up orphan DB record on failure.
  // A restore session's resource row is NOT an orphan (it pre-existed as
  // a reclaimed shell) — never delete it here, only the fileRef/status
  // update below is skipped by simply not touching it further, so the row
  // is left exactly as it was (still a shell, uninitiated retry-safe).
  let s3UploadId: string
  try {
    s3UploadId = await createMultipartUpload(key, ct)
  } catch (err) {
    logger.error(
      { err, resourceId, resourceType, isRestore },
      isRestore
        ? 'S3 multipart initiation failed for a restore session; leaving the reclaimed-shell row untouched'
        : 'S3 multipart initiation failed, removing orphan DB record'
    )
    if (!isRestore) {
      await db.delete(table).where(eq(table.id, resourceId))
    }
    throw err
  }

  await db
    .update(table)
    .set({
      status: 'uploading',
      fileRef: {
        bucket: env.S3_BUCKET,
        key,
        contentType: ct,
        name,
        s3UploadId,
        fileSize,
      },
      updatedAt: new Date(),
    })
    .where(eq(table.id, resourceId))

  logger.info({ resourceId, resourceType, s3UploadId, fileSize }, 'Chunked upload initiated')

  return { uploadId: s3UploadId, resourceId, partSize: DEFAULT_PART_SIZE, key }
}

export async function uploadChunkPart(
  s3UploadId: string,
  partNumber: number,
  body: Uint8Array,
  resourceId: number,
  resourceType: string,
  projectId: number
): Promise<{ etag: string }> {
  // Look up the S3 key from the resource's fileRef
  const isHashList = resourceType === 'hash-lists'
  const table = isHashList ? hashLists : RESOURCE_TYPE_TABLE[resourceType]
  if (!table) throw new Error(`Unknown resource type: ${resourceType}`)

  const [row] = await db
    .select()
    .from(table)
    .where(and(eq(table.id, resourceId), eq(table.projectId, projectId)))
    .limit(1)
  if (!row) throw new UploadResourceNotFoundError(resourceId, resourceType)

  const fileRef = row.fileRef as { key?: string } | null
  if (!fileRef?.key) throw new Error('Resource has no file reference')

  const etag = await uploadPart(fileRef.key, s3UploadId, partNumber, body)

  // Update timestamp
  await db.update(table).set({ updatedAt: new Date() }).where(eq(table.id, resourceId))

  return { etag }
}

export async function completeChunkedUpload(
  s3UploadId: string,
  parts: ReadonlyArray<{ partNumber: number; etag: string }>,
  resourceId: number,
  resourceType: string,
  projectId: number,
  actor: Actor = DEFAULT_SYSTEM_ACTOR
): Promise<{ resourceId: number }> {
  const isHashList = resourceType === 'hash-lists'
  const table = isHashList ? hashLists : RESOURCE_TYPE_TABLE[resourceType]
  if (!table) throw new Error(`Unknown resource type: ${resourceType}`)

  const [row] = await db
    .select()
    .from(table)
    .where(and(eq(table.id, resourceId), eq(table.projectId, projectId)))
    .limit(1)
  if (!row) throw new UploadResourceNotFoundError(resourceId, resourceType)

  const fileRef = row.fileRef as {
    key?: string
    bucket?: string
    contentType?: string
    name?: string
    fileSize?: number
  } | null
  if (!fileRef?.key) throw new Error('Resource has no file reference')

  // F3 (issue #106 code review): a chunked-upload session started by
  // `initiateChunkedUpload`'s restore path (`restoreResourceId`) targets
  // an EXISTING reclaimed-shell row, so — unlike the historical
  // "always-fresh-row" assumption — completion here CAN be a restore.
  // `row.blobReclaimedAt` is the ground truth (set independently of which
  // init path was used), so this is derived directly rather than threaded
  // through as a separate flag, mirroring `uploadResourceFile`'s
  // `isReclaimedShell` check on the direct-upload path.
  //
  // `table` (and therefore `row`) is typed as a union that includes
  // `hashLists`, which carries neither column — cast defensively; the
  // `!isHashList` guard is what actually makes this safe at runtime.
  const reclaimableRow = row as unknown as {
    blobReclaimedAt: Date | null
    fileChecksum: string | null
  }
  const isReclaimedShell = !isHashList && reclaimableRow.blobReclaimedAt !== null

  // Complete S3 multipart upload
  await completeMultipartUpload(fileRef.key, s3UploadId, parts)

  // Checksum capture / verification (issue #106 U12, F3). Word/rule/mask
  // lists only (hash lists carry no `file_checksum` column; reclamation is
  // word/rule/mask only). Computed by streaming the just-completed object
  // rather than buffering it — chunked upload's entire purpose is avoiding
  // a server-side buffer for files too large for the direct-upload path.
  //
  // Two distinct policies depending on whether this is a restore:
  //   - NOT a reclaimed shell (the common case): checksum capture is NOT
  //     computed here at all (issue #108 U4). It used to be a best-effort
  //     re-download-and-hash of the object that had just finished
  //     uploading — for the 100GB+ files chunked upload exists to support,
  //     that redundant full pass is wasteful. The resource-compression
  //     worker (enqueued below) is now the authoritative source: it hashes
  //     the raw bytes in the SAME streaming pass it uses to (maybe) gzip
  //     the object, and writes `file_checksum` directly. Until that worker
  //     runs, the resource simply never becomes a blob-reclamation
  //     candidate (U11's candidate predicate requires `file_checksum IS
  //     NOT NULL`), which is a safe degrade — and `file_checksum IS NOT
  //     NULL` doubles as this worker's own idempotency guard.
  //   - A reclaimed shell (restore-after-reclaim, R12): verification is
  //     load-bearing, not best-effort. Unlike the direct-upload path
  //     (`uploadResourceFile`), the checksum can only be computed AFTER
  //     the bytes already landed in S3 — chunked upload streams parts
  //     straight through, there is no in-memory buffer to hash first. A
  //     mismatch (including a checksum-computation failure, which can't
  //     be distinguished from "unverifiable" here) throws
  //     `ChecksumMismatchError` and the mismatched object is best-effort
  //     deleted so it doesn't linger as an orphan; the row is left
  //     exactly as it was (still a shell) and no DB write happens below.
  let checksum: string | null = null
  if (isReclaimedShell) {
    let computedChecksum: string
    try {
      computedChecksum = await sha256HexFromObject(fileRef.key, fileRef.bucket ?? env.S3_BUCKET)
    } catch (err) {
      logger.error(
        { err, resourceId, resourceType },
        'checksum verification failed for a reclaimed-shell restore; rejecting the re-upload'
      )
      // #108 safety foundation: guarded delete keyed on `fileRef.key` — the
      // content is unverifiable, so there's no checksum in play anyway; the
      // guard only ever cares about the key. A no-op today (this key is a
      // fresh UUID minted by `initiateChunkedUpload`'s restore path, never
      // shared with any other row), but future-safe if dedup ever lets a
      // restore land on a key another live resource also references.
      await deleteBlobIfUnreferenced({
        table: table as ResourceTable,
        resourceId,
        key: fileRef.key,
        ...(fileRef.bucket ? { bucket: fileRef.bucket } : {}),
      })
      throw new ChecksumMismatchError(resourceId, resourceType)
    }
    if (reclaimableRow.fileChecksum && reclaimableRow.fileChecksum !== computedChecksum) {
      // #108 safety foundation: guarded delete keyed on `fileRef.key`, same
      // as above — the mismatched upload is rejected regardless of whose
      // checksum it doesn't match; only key-sharing determines whether the
      // object survives.
      await deleteBlobIfUnreferenced({
        table: table as ResourceTable,
        resourceId,
        key: fileRef.key,
        ...(fileRef.bucket ? { bucket: fileRef.bucket } : {}),
      })
      throw new ChecksumMismatchError(resourceId, resourceType)
    }
    checksum = computedChecksum
  }
  // NOT a reclaimed shell: `checksum` stays null here (see the docblock
  // above) — the resource-compression worker enqueued below captures it.

  // Update resource status to ready
  const updatedFileRef = {
    bucket: fileRef.bucket ?? env.S3_BUCKET,
    key: fileRef.key,
    contentType: fileRef.contentType ?? 'application/octet-stream',
    size: fileRef.fileSize,
    name: fileRef.name,
    uploadedAt: new Date().toISOString(),
  }
  const updateValues = {
    status: isHashList ? ('uploaded' as const) : ('ready' as const),
    fileRef: updatedFileRef,
    ...(isHashList ? {} : { fileSize: fileRef.fileSize }),
    ...(checksum !== null ? { fileChecksum: checksum } : {}),
    // A checksum-verified match clears the shell (R12) — the resource is
    // usable again. Only reachable when isReclaimedShell is true AND the
    // checksum comparison above didn't throw.
    ...(isReclaimedShell ? { blobReclaimedAt: null } : {}),
    updatedAt: new Date(),
  }

  if (isReclaimedShell) {
    // Restore path: wrap the write in a transaction with an audit event
    // (mirroring `uploadResourceFile`'s reclaimed-shell restore) so the
    // shell-clearing is captured in the audit trail the same way whether
    // the re-upload came through the direct or chunked path.
    await db.transaction(async (tx) => {
      const [updated] = await tx
        .update(table)
        .set(updateValues)
        .where(eq(table.id, resourceId))
        .returning()

      await recordAuditEvent(
        {
          actor,
          projectId,
          entityType: entityTypeForTable(table as ResourceTable),
          entityId: resourceId,
          action: 'updated',
          oldRow: row as Record<string, unknown>,
          newRow: (updated ?? { ...row, ...updateValues }) as Record<string, unknown>,
        },
        tx
      )
    })
  } else {
    await db.update(table).set(updateValues).where(eq(table.id, resourceId))
  }

  logger.info({ resourceId, resourceType, isReclaimedShell }, 'Chunked upload completed')

  // A chunked upload streams parts straight to S3 and never buffers the file
  // to count lines, so a wordlist/rulelist arrives ready with a null line
  // count. Enqueue the count job (best-effort, deduped) so keyspace can be
  // computed and fanned out to dependent attacks.
  const lineCountType = lineCountTypeForResourceType(resourceType)
  if (lineCountType) {
    await enqueueLineCount(lineCountType, resourceId, projectId)

    // The normal (non-restore) completion path never buffers the file
    // server-side, so it also never had a chance to gzip it inline (#108
    // U3's compress-then-upload flow needs an in-memory buffer, which is
    // exactly what MAX_DIRECT_UPLOAD_BYTES bounds). Enqueue the background
    // compression worker (best-effort, deduped) to gzip the object and
    // capture the authoritative raw checksum in one streaming pass (#108
    // U4). Skipped for a reclaimed-shell restore: that branch already
    // verified and captured the checksum synchronously above, and
    // recompressing a just-restored object is out of scope for this unit.
    //
    // Best-effort by design: `enqueueResourceCompression` swallows its own
    // failures (missing queue manager, enqueue throw) and returns `false`
    // rather than rejecting, so it can never fail this upload. If the
    // enqueue never lands, the resource simply keeps serving raw and
    // checksum-less indefinitely -- still fully servable to agents (see
    // `docs/agent-resource-protocol.md`'s null-checksum handling), just
    // without the compression bandwidth win, and it is not a candidate for
    // blob reclamation while `file_checksum` stays null. Recovery is a
    // fresh upload (which re-enqueues); no backfill/retry sweep exists.
    if (!isReclaimedShell) {
      await enqueueResourceCompression(lineCountType, resourceId, projectId)
    }
  }

  return { resourceId }
}

export async function abortChunkedUpload(
  s3UploadId: string,
  resourceId: number,
  resourceType: string,
  projectId: number
): Promise<void> {
  const isHashList = resourceType === 'hash-lists'
  const table = isHashList ? hashLists : RESOURCE_TYPE_TABLE[resourceType]
  if (!table) throw new Error(`Unknown resource type: ${resourceType}`)

  const [row] = await db
    .select()
    .from(table)
    .where(and(eq(table.id, resourceId), eq(table.projectId, projectId)))
    .limit(1)
  if (!row) return

  const fileRef = row.fileRef as { key?: string } | null
  if (fileRef?.key) {
    await abortMultipartUpload(fileRef.key, s3UploadId).catch((err) => {
      logger.warn({ err, s3UploadId }, 'Failed to abort S3 multipart upload')
    })
  }

  await db
    .update(table)
    .set({ status: 'error', updatedAt: new Date() })
    .where(eq(table.id, resourceId))

  logger.info({ resourceId, resourceType, s3UploadId }, 'Chunked upload aborted')
}

export async function getChunkedUploadStatus(
  s3UploadId: string,
  resourceId: number,
  resourceType: string,
  projectId: number
): Promise<{
  status: string
  completedParts: Array<{ partNumber: number; etag: string; size: number }>
} | null> {
  const isHashList = resourceType === 'hash-lists'
  const table = isHashList ? hashLists : RESOURCE_TYPE_TABLE[resourceType]
  if (!table) return null

  const [row] = await db
    .select()
    .from(table)
    .where(and(eq(table.id, resourceId), eq(table.projectId, projectId)))
    .limit(1)
  if (!row) return null

  const fileRef = row.fileRef as { key?: string } | null
  if (!fileRef?.key) return null

  const completedParts = await listParts(fileRef.key, s3UploadId)

  return { status: row.status, completedParts }
}
