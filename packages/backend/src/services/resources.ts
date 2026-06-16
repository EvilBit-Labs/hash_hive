import { hashItems, hashLists, hashTypes, maskLists, ruleLists, wordLists } from '@hashhive/shared'
import { and, count, desc, eq, isNotNull, type SQL, sql } from 'drizzle-orm'
import { randomUUID } from 'node:crypto'
import { extname } from 'node:path'

import { env } from '../config/env.js'
import { logger } from '../config/logger.js'
import {
  abortMultipartUpload,
  completeMultipartUpload,
  createMultipartUpload,
  deleteFile,
  getPresignedUrl,
  listParts,
  uploadFile,
  uploadPart,
} from '../config/storage.js'
import { db } from '../db/index.js'
import { recomputeKeyspaceForResource } from './attacks/complexity.js'
import { sumMasklistKeyspace } from './keyspace.js'
import { enqueueLineCount, type LineCountResourceType } from './resources/line-count-trigger.js'
import {
  MAX_LINE_LENGTH,
  countLinesInText,
  countsAsRuleLine,
  countsAsWordlistLine,
  splitTextLines,
} from './resources/line-count.js'

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

// ─── Hash Types ──────────────────────────────────────────────────────

export async function listHashTypes() {
  return db.select().from(hashTypes).orderBy(hashTypes.hashcatMode)
}

export async function getHashTypeById(id: number) {
  const [ht] = await db.select().from(hashTypes).where(eq(hashTypes.id, id)).limit(1)
  return ht ?? null
}

// ─── Hash Lists ─────────────────────────────────────────────────────

export async function listHashLists(projectId: number) {
  return db
    .select()
    .from(hashLists)
    .where(eq(hashLists.projectId, projectId))
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
  opts: { limit: number; offset: number }
) {
  const whereClause = eq(hashLists.projectId, projectId)
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

/**
 * Shared cascade-delete flow for resource tables. Steps:
 *   1. Ownership check (404 if not in project) - handled by the caller via
 *      `lookup`.
 *   2. DB delete FIRST (inside a tx when `cascade` is supplied so a late
 *      FK violation rolls back the children).
 *   3. Best-effort S3 object delete on the row's fileRef.
 *
 * Throws `ResourceInUseError` if a FK from another table still references
 * the row. Idempotent: returns `false` when the row was already gone.
 */
type DbTx = Parameters<Parameters<typeof db.transaction>[0]>[0]
type DbRunner = DbTx | typeof db

async function cascadeDeleteResource<TRow extends { fileRef?: unknown }>(args: {
  id: number
  projectId: number
  resourceLabel: string
  referencedBy: string
  lookup: () => Promise<TRow | null>
  cascade?: (tx: DbTx) => Promise<void>
  deleteOwner: (runner: DbRunner) => Promise<void>
}): Promise<boolean> {
  const row = await args.lookup()
  if (!row) return false

  try {
    if (args.cascade) {
      await db.transaction(async (tx) => {
        await args.cascade!(tx)
        await args.deleteOwner(tx)
      })
    } else {
      await args.deleteOwner(db)
    }
  } catch (err) {
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
    try {
      await deleteFile(fileRef.key, fileRef.bucket)
    } catch (err) {
      logger.warn(
        { resourceLabel: args.resourceLabel, resourceId: args.id, err },
        'Failed to delete resource S3 object; continuing'
      )
    }
  }
  return true
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

export async function deleteHashList(id: number, projectId: number): Promise<boolean> {
  return cascadeDeleteResource({
    id,
    projectId,
    resourceLabel: 'hash list',
    referencedBy: 'one or more campaigns or attacks',
    lookup: () => getHashListById(id, projectId),
    // Bounded-batch cascade: large hash lists (millions of items) get
    // chunked DELETEs instead of one unbounded statement, capping the
    // worst-case lock duration.
    cascade: (tx) => deleteHashItemsBatched(tx, id),
    deleteOwner: (runner) =>
      runner
        .delete(hashLists)
        .where(and(eq(hashLists.id, id), eq(hashLists.projectId, projectId)))
        .then(() => undefined),
  })
}

export async function deleteResource(
  table: ResourceTable,
  id: number,
  projectId: number,
  resourceType: string
): Promise<boolean> {
  return cascadeDeleteResource({
    id,
    projectId,
    resourceLabel: resourceType,
    referencedBy: 'one or more attacks',
    lookup: () => getResourceById(table, id, projectId),
    deleteOwner: (runner) =>
      runner
        .delete(table)
        .where(and(eq(table.id, id), eq(table.projectId, projectId)))
        .then(() => undefined),
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

export async function createHashList(data: {
  projectId: number
  name: string
  hashTypeId?: number | undefined
  source?: string | undefined
}) {
  const [hl] = await db
    .insert(hashLists)
    .values({
      projectId: data.projectId,
      name: data.name,
      hashTypeId: data.hashTypeId ?? null,
      source: data.source ?? 'upload',
      status: 'uploading',
    })
    .returning()

  return hl ?? null
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
export async function setHashListType(id: number, projectId: number, hashTypeId: number) {
  const [updated] = await db
    .update(hashLists)
    .set({ hashTypeId, updatedAt: new Date() })
    .where(and(eq(hashLists.id, id), eq(hashLists.projectId, projectId)))
    .returning()
  return updated ?? null
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
  await uploadFile(key, buffer, file.type || 'application/octet-stream')

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

// ─── Generic Resource Lists (wordlists, rulelists, masklists) ───────

export type ResourceTable = typeof wordLists | typeof ruleLists | typeof maskLists

export async function listResources(table: ResourceTable, projectId: number) {
  return db
    .select()
    .from(table)
    .where(eq(table.projectId, projectId))
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
  opts: { limit: number; offset: number }
) {
  const whereClause = eq(table.projectId, projectId)
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
  data: { projectId: number; name: string }
) {
  const [row] = await db.insert(table).values(data).returning()
  return row ?? null
}

/**
 * Map a chunked-upload `resourceType` string to the line-count worker's type,
 * or null when the resource type's line count is not a keyspace input
 * (masklists, hash lists).
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

export async function uploadResourceFile(
  table: ResourceTable,
  resourceId: number,
  projectId: number,
  prefix: string,
  file: File
) {
  const resource = await getResourceById(table, resourceId, projectId)
  if (!resource) {
    throw new Error(`Resource ${resourceId} not found in ${prefix}`)
  }

  if (file.size > MAX_DIRECT_UPLOAD_BYTES) {
    throw new UploadTooLargeError(file.size, MAX_DIRECT_UPLOAD_BYTES)
  }

  const ext = extname(file.name)
  const key = `${resource.projectId}/${prefix}/${randomUUID()}${ext}`
  const buffer = Buffer.from(await file.arrayBuffer())
  await uploadFile(key, buffer, file.type || 'application/octet-stream')

  // Size the resource from the in-memory buffer (≤ MAX_DIRECT_UPLOAD_BYTES) so
  // the common upload path never needs the async worker, using the same utils
  // the worker uses so direct and worker sizing agree. Wordlists/rulelists are
  // sized by line count; a masklist by its summed mask keyspace (#231).
  const resourceType = resourceTypeOf(table)
  const text = buffer.toString('utf8')
  let lineCount: number | null = null
  let maskKeyspace: string | null = null
  if (resourceType === 'masklist') {
    maskKeyspace = sumMasklistKeyspace(splitTextLines(text), MAX_LINE_LENGTH)
  } else {
    const predicate = lineCountPredicateFor(resourceType)
    lineCount = predicate ? countLinesInText(text, predicate) : null
  }

  await db
    .update(table)
    .set({
      fileRef: {
        bucket: env.S3_BUCKET,
        key,
        contentType: file.type || 'application/octet-stream',
        size: file.size,
        name: file.name,
        uploadedAt: new Date().toISOString(),
      },
      fileSize: file.size,
      ...(lineCount !== null ? { lineCount } : {}),
      ...(resourceType === 'masklist' ? { keyspace: maskKeyspace } : {}),
      status: 'ready',
      updatedAt: new Date(),
    })
    .where(eq(table.id, resourceId))

  // Best-effort: refresh keyspace for any attacks already referencing this
  // resource. The usual flow uploads before attacks exist (a no-op fan-out);
  // this covers the rarer create-attack-before-upload ordering. A failure here
  // must not fail the upload — the resource is already persisted as ready.
  const didComputeSizing = resourceType === 'masklist' ? maskKeyspace !== null : lineCount !== null
  if (didComputeSizing) {
    try {
      await recomputeKeyspaceForResource(resourceType, resourceId)
    } catch (err) {
      logger.warn(
        { resourceType, resourceId, err },
        'keyspace recompute after direct upload failed; dependent attacks will recompute on next trigger'
      )
    }
  }

  return { key, size: file.size }
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
 * Generate a presigned download URL with extended expiry for large files.
 * Used by agents to download resources directly from S3.
 */
export async function getAgentDownloadUrl(
  resourceType: string,
  resourceId: number,
  projectId: number
): Promise<{ url: string; expiresIn: number } | null> {
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

  return { url, expiresIn }
}

// ─── Chunked Upload (S3 Multipart) ─────────────────────────────────

const RESOURCE_TYPE_TABLE: Record<string, ResourceTable> = {
  wordlists: wordLists,
  rulelists: ruleLists,
  masklists: maskLists,
}

const DEFAULT_PART_SIZE = 64 * 1024 * 1024 // 64 MB

export async function initiateChunkedUpload(data: {
  resourceType: string
  name: string
  fileSize: number
  projectId: number
  contentType?: string | undefined
}): Promise<{
  uploadId: string
  resourceId: number
  partSize: number
  key: string
}> {
  const { resourceType, name, fileSize, projectId, contentType } = data

  // Hash lists use the hashLists table with different create logic
  const isHashList = resourceType === 'hash-lists'
  const table: ResourceTable | typeof hashLists | undefined = isHashList
    ? hashLists
    : RESOURCE_TYPE_TABLE[resourceType]

  if (!table) {
    throw new Error(`Unknown resource type: ${resourceType}`)
  }

  // Create DB record
  let resourceId: number
  if (isHashList) {
    const hl = await createHashList({ projectId, name, source: 'upload' })
    if (!hl) throw new Error('Failed to create hash list')
    resourceId = hl.id
  } else {
    const row = await createResource(table as ResourceTable, { projectId, name })
    if (!row) throw new Error(`Failed to create ${resourceType}`)
    resourceId = row.id
  }

  // Generate S3 key
  const prefix = isHashList ? 'hash-lists' : resourceType
  const key = `${projectId}/${prefix}/${randomUUID()}`
  const ct = contentType ?? 'application/octet-stream'

  // Initiate S3 multipart upload - clean up orphan DB record on failure
  let s3UploadId: string
  try {
    s3UploadId = await createMultipartUpload(key, ct)
  } catch (err) {
    logger.error(
      { err, resourceId, resourceType },
      'S3 multipart initiation failed, removing orphan DB record'
    )
    await db.delete(table).where(eq(table.id, resourceId))
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
  projectId: number
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

  // Complete S3 multipart upload
  await completeMultipartUpload(fileRef.key, s3UploadId, parts)

  // Update resource status to ready
  const updatedFileRef = {
    bucket: fileRef.bucket ?? env.S3_BUCKET,
    key: fileRef.key,
    contentType: fileRef.contentType ?? 'application/octet-stream',
    size: fileRef.fileSize,
    name: fileRef.name,
    uploadedAt: new Date().toISOString(),
  }

  await db
    .update(table)
    .set({
      status: isHashList ? 'uploaded' : 'ready',
      fileRef: updatedFileRef,
      ...(isHashList ? {} : { fileSize: fileRef.fileSize }),
      updatedAt: new Date(),
    })
    .where(eq(table.id, resourceId))

  logger.info({ resourceId, resourceType }, 'Chunked upload completed')

  // A chunked upload streams parts straight to S3 and never buffers the file
  // to count lines, so a wordlist/rulelist arrives ready with a null line
  // count. Enqueue the count job (best-effort, deduped) so keyspace can be
  // computed and fanned out to dependent attacks.
  const lineCountType = lineCountTypeForResourceType(resourceType)
  if (lineCountType) {
    await enqueueLineCount(lineCountType, resourceId, projectId)
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
