/**
 * Reference-aware guarded blob delete (issue #108 safety foundation for
 * content-addressed blob storage).
 *
 * The physical object in the store is identified by its `fileRef.key`, not
 * by content checksum -- two resources share a physical blob IF AND ONLY IF
 * they point at the same key. `deleteBlobIfUnreferenced` therefore guards
 * purely on key: delete the object at key `K` unless some OTHER live
 * resource (across word_lists/rule_lists/mask_lists, `blob_reclaimed_at IS
 * NULL`) still points at that same key `K`.
 *
 * Today every resource's object-store blob lives at a unique per-resource
 * UUID key, so no two live resources ever point at the same blob and this
 * guard is a no-op: `deleteBlobIfUnreferenced` always finds zero other live
 * references and deletes exactly as the direct `deleteFile` calls it
 * replaces did. It exists so a LATER step (deduping identical uploads onto
 * one shared blob keyed as `blobs/<checksum>`) can land without
 * re-auditing every delete site in the codebase: from this point on,
 * "delete a resource's blob" always means "delete it IF no other live
 * resource still needs it", never a bare `deleteFile`.
 *
 * The caller's own row is always excluded from its "is this shared" check
 * by `(table, resourceId)` identity, independent of that row's own
 * `blobReclaimedAt` state at call time -- callers may invoke this before or
 * after their own row has been stamped, updated, or deleted (see the call
 * sites: `blob-reclamation.ts`'s `reclaimOne` calls this AFTER its
 * intent-stamp transaction commits; `resources.ts`'s `cascadeDeleteResource`
 * calls this AFTER the owning row has already been deleted;
 * `completeChunkedUpload`'s reclaimed-shell mismatch cleanup calls this
 * BEFORE any write, while the row is still fully live).
 *
 * Hash lists have no reclamation lifecycle (no `blob_reclaimed_at` column)
 * and are therefore never one of the tables scanned for "other live
 * references" -- but `cascadeDeleteResource` is shared between hash lists
 * and word/rule/mask lists, so `table` accepts `typeof hashLists` too. A
 * hash list's key will simply never match anything in `CHECKABLE_TABLES`,
 * which is the correct, safe no-op for a resource type outside the dedup
 * pool.
 *
 * ── Delete/adopt race (#108 T12/T13) ─────────────────────────────────
 *
 * Content-addressing means TWO independent operations can now race on the
 * SAME physical key `K = blobs/<checksum>`: this module's guarded delete
 * (scan for other live referrers, then physically delete `K`) and a
 * concurrent upload's dedup decision (does `K` already exist? adopt/re-use
 * it; if not, write it) followed by that upload's own row commit pointing
 * at `K`. Interleaved without coordination, the delete's scan can run
 * before the adopting upload's row has committed (finding zero live
 * referrers, since the adopter isn't live yet) and physically remove `K` --
 * and the adopting row then commits pointing at a blob that no longer
 * exists. Silent data loss, invisible until the next download.
 *
 * `withBlobKeyLock` closes this by serializing every critical section that
 * touches a given key `K` behind a transaction-scoped Postgres advisory
 * lock keyed on `K` (`pg_advisory_xact_lock`, auto-released on commit or
 * rollback -- never needs an explicit unlock, even on throw). Every call
 * site that (a) decides whether to physically delete `K`, or (b) decides
 * whether to adopt vs. write `K` and then commits a row pointing at it,
 * MUST run that entire decision-through-commit sequence inside
 * `withBlobKeyLock(K, ...)`. With both sides locked on the same key, the two
 * critical sections can never interleave: whichever acquires the lock first
 * runs to completion (visible to everyone) before the other's decision
 * logic (e.g. `headObject`) even executes, so the loser always observes the
 * winner's already-committed reality instead of racing it.
 *
 * Single lock key per blob -- no cross-key lock ordering, so no deadlock
 * risk. See `services/tasks/preemption.ts`'s `PREEMPTION_LOCK_NAMESPACE` for
 * the sibling per-issue advisory-lock-namespace convention this mirrors.
 */
import { hashLists, maskLists, ruleLists, wordLists } from '@hashhive/shared'
import { and, isNull, ne, sql } from 'drizzle-orm'

import type { ResourceTable } from '../resources.js'

import { logger } from '../../config/logger.js'
import { deleteFile } from '../../config/storage.js'
import { db } from '../../db/index.js'

/**
 * First key of the two-int `pg_advisory_xact_lock(key1, key2)` call. Pinned
 * to the issue number so this lock namespace never collides with any other
 * advisory-lock site (e.g. `tasks/preemption.ts`'s `PREEMPTION_LOCK_NAMESPACE`
 * uses `97`); the second key is `hashtext(blobKey)` -- Postgres advisory
 * locks take integers, not arbitrary text, so the blob key (a string) is
 * folded into an int4 via `hashtext`.
 */
const BLOB_KEY_LOCK_NAMESPACE = 108

/** Drizzle transaction handle inferred from `db.transaction`. */
export type DbTx = Parameters<Parameters<typeof db.transaction>[0]>[0]

/**
 * Run `fn` inside a Postgres transaction holding a transaction-scoped
 * advisory lock keyed on `key`. See the module docblock's "Delete/adopt
 * race" section for why every critical section touching a shared blob key
 * MUST go through this helper. The lock is released automatically when the
 * transaction commits OR rolls back (an exception thrown from `fn`
 * propagates out of `db.transaction`, which rolls back and releases the
 * lock -- there is no separate unlock path to forget).
 */
export async function withBlobKeyLock<T>(key: string, fn: (tx: DbTx) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(${BLOB_KEY_LOCK_NAMESPACE}, hashtext(${key}))`
    )
    return fn(tx)
  })
}

/**
 * The three tables eligible to share a blob once content-addressing lands.
 * Exported for reuse by `content-address.ts`, which needs the same table
 * list to look up an existing blob's `compressionEncoding` by key.
 */
export const CHECKABLE_TABLES = [wordLists, ruleLists, maskLists] as const

/** Any table a resource's blob-delete call site may originate from. */
export type BlobOwnerTable = ResourceTable | typeof hashLists

export type DeleteBlobFn = (key: string, bucket?: string) => Promise<unknown>

export type DeleteBlobIfUnreferencedResult =
  | { deleted: true }
  | { deleted: false; reason: 'shared' | 'error' }

export interface DeleteBlobIfUnreferencedArgs {
  /** The Drizzle table the resource being deleted/reclaimed belongs to. */
  table: BlobOwnerTable
  /** The resource's own id -- excluded from the "other live reference" scan. */
  resourceId: number
  /** The object-store key the physical delete would target. */
  key: string
  bucket?: string
  /** Override for tests / DI seams. Defaults to the real `deleteFile`. */
  deleteFn?: DeleteBlobFn
}

/**
 * Delete a resource's object-store blob, but only if no OTHER live resource
 * still shares it. See the module docblock for the full guard design.
 *
 * The reference-scan and the physical delete both run inside
 * `withBlobKeyLock(key, ...)` (#108 T12/T13): serialized against any
 * concurrent upload dedup decision for the SAME key, so a concurrent
 * adopter can never commit a live row pointing at `key` in the window
 * between this scan and this delete.
 */
export async function deleteBlobIfUnreferenced(
  args: DeleteBlobIfUnreferencedArgs
): Promise<DeleteBlobIfUnreferencedResult> {
  const { table, resourceId, key, bucket, deleteFn = deleteFile } = args

  // The reference-scan SELECT and the physical delete are both inside this
  // try/catch (#108 review Fix 2): callers like `cascadeDeleteResource`
  // invoke this AFTER the owning row's DELETE has already committed, so a
  // transient failure in EITHER query (pool exhaustion, connection reset)
  // must not throw past this guard -- that would surface a client 500 for
  // an operation that already succeeded, and skip blob cleanup with no log
  // trail. Both failure modes share the same best-effort contract: log and
  // report `{ deleted: false, reason: 'error' }` rather than propagating.
  // The try/catch wraps the WHOLE locked transaction, not just its body --
  // a thrown error rolls the transaction back (releasing the lock) before
  // this catch ever runs.
  try {
    return await withBlobKeyLock(key, async (tx) => {
      const isShared = await hasOtherLiveResourceWithKey(tx, table, resourceId, key)
      if (isShared) {
        return { deleted: false, reason: 'shared' }
      }

      await deleteFn(key, bucket)
      return { deleted: true }
    })
  } catch (err) {
    // A resource marked reclaimed/deleted while its blob may still exist
    // needs operator attention -- more so now that keys are shared across
    // resources (#108 review Fix 3: bumped from warn to error).
    logger.error(
      { err, table: tableLabel(table), resourceId, key },
      'deleteBlobIfUnreferenced: reference check or physical delete failed; continuing'
    )
    return { deleted: false, reason: 'error' }
  }
}

async function hasOtherLiveResourceWithKey(
  tx: DbTx,
  table: BlobOwnerTable,
  resourceId: number,
  key: string
): Promise<boolean> {
  for (const candidateTable of CHECKABLE_TABLES) {
    const isSelfTable = (candidateTable as BlobOwnerTable) === table
    // oxlint-disable-next-line no-await-in-loop -- three small point lookups against distinct tables; not a hot path
    const [row] = await tx
      .select({ id: candidateTable.id })
      .from(candidateTable)
      .where(
        and(
          sql`${candidateTable.fileRef} ->> 'key' = ${key}`,
          isNull(candidateTable.blobReclaimedAt),
          isSelfTable ? ne(candidateTable.id, resourceId) : undefined
        )
      )
      .limit(1)
    if (row) return true
  }
  return false
}

function tableLabel(table: BlobOwnerTable): string {
  if (table === wordLists) return 'word_lists'
  if (table === ruleLists) return 'rule_lists'
  if (table === maskLists) return 'mask_lists'
  return 'hash_lists'
}
