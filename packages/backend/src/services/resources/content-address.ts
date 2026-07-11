/**
 * Content-addressed blob key derivation + existing-blob lookup (issue #108
 * follow-up: identical raw content across ANY project dedups onto ONE
 * physical object at a GLOBAL key `blobs/<rawChecksum>` — no extension; the
 * download filename always comes from `fileRef.name`, never the storage
 * key). The raw checksum is the resource's existing canonical identity
 * (`fileChecksum`, captured since issue #106 U12) — this module just derives
 * the storage key from it and answers "has this content already landed?".
 *
 * Access to a blob is gated entirely by presigned-URL signing (the
 * dashboard/agent download routes verify project ownership before ever
 * signing a URL for a key) — a physically-shared blob therefore never leaks
 * across projects even though the underlying object-store key itself
 * carries no project scoping.
 *
 * `findCompressionEncodingForKey` answers "what encoding did the upload
 * that FIRST landed this content use?" — it is the FAST PATH for a dedup hit
 * when a live row ALREADY references the key: adopt that row's real encoding
 * instead of recomputing or reusing this run's own value, since the physical
 * bytes at a shared key were written exactly once and every subsequent
 * reader (including the agent download path, which trusts
 * `compressionEncoding` to know how to decode the bytes) must agree on what
 * encoding those bytes actually are. Both dedup call sites use it the same
 * way: the direct upload (`resources.ts`'s `uploadResourceFile`) and the
 * chunked-upload worker (`resource-compression.ts`'s
 * `compressChunkedResourceObject`, via its `resolveContentAddressedKey`
 * helper).
 *
 * When this returns `null` (a dedup hit with NO live row referencing the
 * key — an unexpected but possible state, e.g. a prior orphaned delete or
 * policy drift), neither call site guesses: they OVERWRITE the
 * content-addressed key with this run's own freshly-produced bytes (the
 * direct-upload path re-uploads the in-memory buffer; the chunked worker
 * relocates its temp object via server-side copy) and record this run's own
 * computed encoding, so the stored bytes and the recorded encoding always
 * agree.
 */
import type { ResourceCompressionEncoding } from '@hashhive/shared'

import { and, isNull, sql } from 'drizzle-orm'

import { CHECKABLE_TABLES, type DbTx } from './blob-lifecycle.js'

/** The GLOBAL, project-agnostic key a resource's raw-content checksum maps to. */
export function blobKeyForChecksum(checksum: string): string {
  return `blobs/${checksum}`
}

/**
 * Look up the `compressionEncoding` of a live (non-reclaimed) word/rule/mask
 * list row that already points its `fileRef.key` at `key`. Returns `null`
 * when no live row references the key — callers should treat that as
 * "unknown, degrade safely" rather than throw, since `headObject` finding
 * the physical object but no live DB row referencing it is an unexpected
 * (though not impossible — e.g. a race with a concurrent reclaim) state.
 *
 * `tx` is REQUIRED, not defaulted to the module-level `db` (#108 T12/T13):
 * every caller's dedup decision (`uploadResourceFile`'s direct-upload path,
 * and `compressChunkedResourceObject`'s `resolveContentAddressedKey` for the
 * chunked-upload worker) always runs inside `withBlobKeyLock`'s transaction,
 * and this read must happen on that SAME transaction/connection to see a
 * consistent, lock-serialized view of the key's live referrers.
 */
export async function findCompressionEncodingForKey(
  key: string,
  tx: DbTx
): Promise<ResourceCompressionEncoding | null> {
  for (const table of CHECKABLE_TABLES) {
    // oxlint-disable-next-line no-await-in-loop -- three small point lookups against distinct tables; not a hot path
    const [row] = await tx
      .select({ compressionEncoding: table.compressionEncoding })
      .from(table)
      .where(and(sql`${table.fileRef} ->> 'key' = ${key}`, isNull(table.blobReclaimedAt)))
      .limit(1)
    if (row) return row.compressionEncoding as ResourceCompressionEncoding
  }
  return null
}
