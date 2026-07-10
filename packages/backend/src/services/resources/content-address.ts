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
 * that FIRST landed this content use?" so a deduping upload/worker adopts
 * the existing object's real encoding instead of guessing or recomputing
 * it — the physical bytes at a shared key were written exactly once, by
 * whichever writer got there first, and every subsequent reader (including
 * the agent download path, which trusts `compressionEncoding` to know how
 * to decode the bytes) must agree on what encoding those bytes actually
 * are.
 */
import type { ResourceCompressionEncoding } from '@hashhive/shared'

import { and, isNull, sql } from 'drizzle-orm'

import { db } from '../../db/index.js'
import { CHECKABLE_TABLES } from './blob-lifecycle.js'

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
 */
export async function findCompressionEncodingForKey(
  key: string
): Promise<ResourceCompressionEncoding | null> {
  for (const table of CHECKABLE_TABLES) {
    // oxlint-disable-next-line no-await-in-loop -- three small point lookups against distinct tables; not a hot path
    const [row] = await db
      .select({ compressionEncoding: table.compressionEncoding })
      .from(table)
      .where(and(sql`${table.fileRef} ->> 'key' = ${key}`, isNull(table.blobReclaimedAt)))
      .limit(1)
    if (row) return row.compressionEncoding as ResourceCompressionEncoding
  }
  return null
}
