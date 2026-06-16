/**
 * Compute-and-persist for masklist keyspace (issue #231), shared by the async
 * line-count worker (`queue/workers/line-count.ts`) and the one-shot backfill
 * (`scripts/backfill-masklist-keyspace.ts`) so the two cannot drift.
 *
 * Streams the masklist from object storage and sums its per-line mask keyspace
 * WITHOUT buffering the whole file (an adversarially large `.hcmask` cannot OOM
 * the worker), persists the result to `mask_lists.keyspace` — including `null`
 * when the file is uncomputable, so the column always reflects the current
 * file — then fans the recompute out to every dependent mode-3 attack.
 *
 * The streaming read runs BEFORE the write, so a storage-read failure throws
 * (and the job retries) without leaving a partial value behind.
 */

import { maskLists } from '@hashhive/shared'
import { eq } from 'drizzle-orm'

import { logger } from '../../config/logger.js'
import { db } from '../../db/index.js'
import { recomputeKeyspaceForResource } from '../attacks/complexity.js'
import { sumMasklistKeyspaceFromStream } from '../keyspace.js'
import { MAX_LINE_LENGTH, streamLines } from './line-count.js'

/**
 * Sum, persist, and fan out the keyspace for a single masklist. Returns the
 * computed value (null when uncomputable). Fan-out is unconditional: a null
 * keyspace must propagate to dependents so an attack against a now-uncomputable
 * masklist falls back to the single-task path instead of keeping a stale value.
 */
export async function computeAndPersistMasklistKeyspace(
  resourceId: number,
  fileRef: { bucket?: string; key: string }
): Promise<string | null> {
  const keyspace = await sumMasklistKeyspaceFromStream(
    streamLines(fileRef.key, fileRef.bucket),
    MAX_LINE_LENGTH
  )

  await db
    .update(maskLists)
    .set({ keyspace, updatedAt: new Date() })
    .where(eq(maskLists.id, resourceId))

  if (keyspace === null) {
    logger.warn(
      { resourceId },
      'masklist keyspace uncomputable (custom charsets / unknown tokens); dependent attacks fall back to single-task'
    )
  }

  await recomputeKeyspaceForResource('masklist', resourceId)
  return keyspace
}
