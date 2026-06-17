/**
 * Backfill script: compute and persist the summed keyspace for masklists that
 * were uploaded before masklist-keyspace support landed (issue #231).
 *
 * The upload-triggered worker only fires on new uploads, so already-uploaded
 * masklists keep a null `keyspace` (and their mode-3 attacks keep a null
 * `attacks.keyspace`) until something re-touches them. This one-shot streams
 * each such masklist, sums its per-line mask keyspace, persists it, and fans
 * the recompute out to dependent attacks — the same work the worker does (via
 * the shared `computeAndPersistMasklistKeyspace`), run inline so no Redis or
 * worker is required.
 *
 * Mostly idempotent — the candidate query selects masklists with a null
 * keyspace and a file reference, so re-running re-processes still-null rows.
 * Caveat: `computeAndPersistMasklistKeyspace` persists the keyspace BEFORE
 * fanning out to dependents, so a row whose keyspace write succeeds but whose
 * fan-out then fails has a non-null keyspace and is EXCLUDED from a re-run while
 * its dependent attacks stay stale. Such a row is logged with its id below; the
 * durable fix for that window is the `keyspace_state` follow-up tracked in
 * `docs/residual-review-findings/feat-masklist-keyspace.md`.
 *
 * Resilient — a single row's storage-read or write failure is logged (with the
 * masklist id) and the run continues to the next row, so one unreadable masklist
 * cannot abort the whole backfill. The process exits non-zero if any row failed,
 * so a caller (or CI) can tell a clean run from a partial one.
 *
 * Usage:
 *   bun packages/backend/src/scripts/backfill-masklist-keyspace.ts
 */
import { maskLists } from '@hashhive/shared'
import { and, isNotNull, isNull } from 'drizzle-orm'

import { logger } from '../config/logger.js'
import { client, db } from '../db/index.js'
import { computeAndPersistMasklistKeyspace } from '../services/resources/masklist-keyspace.js'

async function backfill(): Promise<number> {
  const rows = await db
    .select({ id: maskLists.id, fileRef: maskLists.fileRef })
    .from(maskLists)
    .where(and(isNull(maskLists.keyspace), isNotNull(maskLists.fileRef)))

  logger.info({ count: rows.length }, 'masklist keyspace backfill: candidates found')

  let computed = 0
  const skippedIds: number[] = []
  const failedIds: number[] = []
  for (const row of rows) {
    const fileRef = row.fileRef as { bucket?: string; key?: string } | null
    if (!fileRef?.key) {
      // A row with a fileRef but no usable key is a data-integrity signal, not
      // just a tally — name it so an operator can investigate.
      skippedIds.push(row.id)
      continue
    }

    try {
      const keyspace = await computeAndPersistMasklistKeyspace(row.id, {
        key: fileRef.key,
        ...(fileRef.bucket ? { bucket: fileRef.bucket } : {}),
      })
      if (keyspace !== null) computed++
      logger.info({ masklistId: row.id, keyspace }, 'masklist keyspace backfilled')
    } catch (err) {
      // One row's failure must not abort the whole run — log its id and continue.
      // If the failure came AFTER the keyspace write (fan-out), the row now has a
      // non-null keyspace and a re-run will NOT re-process it (its dependents
      // stay stale); the id below is the only record of that — see the header.
      failedIds.push(row.id)
      logger.error(
        { masklistId: row.id, err },
        'masklist keyspace backfill: row failed, continuing (may be persisted-but-not-fanned-out)'
      )
    }
  }

  logger.info(
    {
      total: rows.length,
      computed,
      failed: failedIds.length,
      uncomputableOrSkipped: rows.length - computed - failedIds.length,
    },
    'masklist keyspace backfill complete'
  )
  if (failedIds.length > 0) {
    logger.warn(
      { failedIds },
      'masklist keyspace backfill: rows failed (inspect for stale dependents)'
    )
  }
  if (skippedIds.length > 0) {
    logger.warn(
      { skipped: skippedIds.length, skippedIds },
      'masklist keyspace backfill: rows skipped (file reference has no key)'
    )
  }
  return failedIds.length
}

backfill()
  .then(async (failed) => {
    await client.end()
    // Non-zero exit when any row failed so partial runs are detectable.
    if (failed > 0) process.exit(1)
  })
  .catch(async (err) => {
    logger.error({ err }, 'masklist keyspace backfill failed')
    await client.end()
    process.exit(1)
  })
