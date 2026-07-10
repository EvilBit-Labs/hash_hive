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
 */
import { hashLists, maskLists, ruleLists, wordLists } from '@hashhive/shared'
import { and, isNull, ne, sql } from 'drizzle-orm'

import type { ResourceTable } from '../resources.js'

import { logger } from '../../config/logger.js'
import { deleteFile } from '../../config/storage.js'
import { db } from '../../db/index.js'

/**
 * The three tables eligible to share a blob once content-addressing lands.
 * Exported for reuse by `content-address.ts`, which needs the same table
 * list to look up an existing blob's `compressionEncoding` by key.
 */
export const CHECKABLE_TABLES = [wordLists, ruleLists, maskLists] as const

/** Any table a resource's blob-delete call site may originate from. */
export type BlobOwnerTable = ResourceTable | typeof hashLists

type DeleteBlobFn = (key: string, bucket?: string) => Promise<unknown>

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
 */
export async function deleteBlobIfUnreferenced(
  args: DeleteBlobIfUnreferencedArgs
): Promise<DeleteBlobIfUnreferencedResult> {
  const { table, resourceId, key, bucket, deleteFn = deleteFile } = args

  const isShared = await hasOtherLiveResourceWithKey(table, resourceId, key)

  if (isShared) {
    return { deleted: false, reason: 'shared' }
  }

  try {
    await deleteFn(key, bucket)
    return { deleted: true }
  } catch (err) {
    // Mirrors the best-effort delete semantics every call site already had
    // before this guard existed: a physical-delete failure is logged and
    // swallowed, never thrown back at the caller. The row-level operation
    // (stamp/delete/restore-reject) that triggered this must not fail just
    // because the object store is unreachable.
    logger.warn(
      { err, table: tableLabel(table), resourceId, key },
      'deleteBlobIfUnreferenced: physical delete failed; continuing'
    )
    return { deleted: false, reason: 'error' }
  }
}

async function hasOtherLiveResourceWithKey(
  table: BlobOwnerTable,
  resourceId: number,
  key: string
): Promise<boolean> {
  for (const candidateTable of CHECKABLE_TABLES) {
    const isSelfTable = (candidateTable as BlobOwnerTable) === table
    // oxlint-disable-next-line no-await-in-loop -- three small point lookups against distinct tables; not a hot path
    const [row] = await db
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
